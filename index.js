const name = "image-subagent";
const inject = ["connection", "llm"];
/**
 * dsh-image-subagent — 让纯文本主模型（如 deepseek-v4-pro）也能接收图片附件：
 * 图片不是发给主模型，而是进入会话后投影为显式占位文本，由主模型委托给
 * 具备视觉能力的子代理（多模态模型）通过 read_attachment / read_image 读取。
 *
 * 两个机制（均为插件级 seam，不修改核心）：
 * 1. `internal/get` 瀑布：包装 `ctx.llm` 服务 ——
 *    a) resolveModelInfo 对未声明 image 输入的路由补报 image 能力，放行
 *       apiproxy 的图片准入门控（MODEL_DOES_NOT_SUPPORT_IMAGES）；
 *    b) prepareCall/stream 包装为惰性生成器：agent 主循环的 request 是
 *       deepFreeze 的，无法原地改写，因此首次拉取时解析真实模态、克隆
 *       options 并把 image 块投影为显式占位文本（携带 attachmentId），
 *       再交给真实调用 —— 纯文本适配器不再抛 UNSUPPORTED_CONTENT。
 * 2. `llm/stream` 瀑布：对绕开 `ctx.llm` 属性路径、且 options 可变的直接调用，
 *    做机会式的原地投影（保险丝；主流路径由机制 1 覆盖）。
 */
function apply(ctx) {
  // ── 占位符与投影（与官方核心补丁方案保持同一文案）──────────────────────
  function imagePlaceholderText(attachment) {
    const name = typeof attachment?.name === "string" && attachment.name.length > 0 ? ` "${attachment.name}"` : "";
    const mediaType = typeof attachment?.mediaType === "string" && attachment.mediaType.length > 0 ? attachment.mediaType : "image";
    const dimensions = Number.isInteger(attachment?.width) && Number.isInteger(attachment?.height) ? `, ${attachment.width}x${attachment.height} px` : "";
    const bytes = Number.isSafeInteger(attachment?.bytes) ? `, ${attachment.bytes} bytes` : "";
    const id = typeof attachment?.attachmentId === "string" && attachment.attachmentId.length > 0 ? `, id=${attachment.attachmentId}` : "";
    return `[image attachment${name} (${mediaType}${dimensions}${bytes}${id}) — not visible to this text-only model route; a vision-capable subagent can inspect it with the read_attachment tool]`;
  }
  function projectContent(content) {
    let changed = false;
    const projected = (content || []).map((block) => {
      if (block && block.type === "image") {
        changed = true;
        return { type: "text", text: imagePlaceholderText(block.attachment) };
      }
      if (block && block.type === "tool-result") {
        const nested = projectContent(block.content);
        if (nested !== block.content) {
          changed = true;
          return { ...block, content: nested };
        }
      }
      return block;
    });
    return changed ? projected : content;
  }
  function projectMessages(messages) {
    let changed = false;
    const projected = (messages || []).map((message) => {
      const content = projectContent(message.content);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    });
    return changed ? projected : messages;
  }

  // ── 机制 2（保险丝）：llm/stream 机会式投影 ──────────────────────────────
  // 对绕开 ctx.llm 属性路径的直接调用，若 options 可变则原地改写 messages。
  // 主流路径（agent 主循环等经 ctx.llm 的调用）由机制 1 的桥接克隆覆盖。
  ctx.on("llm/stream", (options, next) => {
    const src = next();
    return (async function* () {
      try {
        const llm = ctx.get("llm");
        if (llm !== void 0 && options && Array.isArray(options.messages) && typeof options.provider === "string" && typeof options.model === "string") {
          const info = await llm.resolveModelInfo(options.provider, options.model);
          // 仅在路由明确声明 inputModalities 且不含 image 时投影；
          // undefined 时放行（适配器自身守卫保持权威），避免误伤未声明的多模态适配器。
          if (info !== void 0 && Array.isArray(info.inputModalities) && !info.inputModalities.includes("image")) {
            const projected = projectMessages(options.messages);
            if (projected !== options.messages) options.messages = projected;
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`image-subagent: projection skipped for ${String(options?.provider)}/${String(options?.model)}: ${String(error)}`);
      }
      yield* src;
    })();
  });

  // ── 机制 1：internal/get 包装 llm 服务 ────────────────────────────────────
  // 三个能力：
  // 1) resolveModelInfo 补报 image 输入 → 放行 apiproxy 的图片准入门控；
  // 2) prepareCall/stream 包装为惰性生成器：首次拉取时解析真实模态并克隆
  //    options（agent 主循环的 request 是 deepFreeze 的，无法原地改写），
  //    把 image 块投影为占位文本后再交给真实调用；
  // 3) 其余属性原样绑定转发（this 指向真实服务）。
  // 准入层（dsh-host-apiproxy）以 `ctx.llm.*` 属性方式读取服务，均经过本桥。
  const bridges = /* @__PURE__ */ new WeakMap();
  const modalityCache = /* @__PURE__ */ new Map();

  async function inputModalitiesFor(real, provider, model) {
    const key = String(provider) + "\u0000" + String(model);
    if (modalityCache.has(key)) return modalityCache.get(key);
    let mods;
    try {
      mods = (await real.resolveModelInfo(provider, model)).inputModalities;
    } catch (error) {
      mods = void 0;
    }
    modalityCache.set(key, mods);
    return mods;
  }

  /** 仅当路由明确声明且不含 image 时投影；未声明(undefined)时原样放行。 */
  function projectedOptions(real, options, mods) {
    if (mods === void 0 || mods.includes("image")) return options;
    const projected = projectMessages(options.messages);
    if (projected === options.messages) return options;
    return { ...options, messages: projected };
  }

  function lazyStream(real, dispatch) {
    return (options) => (async function* () {
      const mods = await inputModalitiesFor(real, options.provider, options.model);
      yield* dispatch(projectedOptions(real, options, mods));
    })();
  }

  ctx.on("internal/get", (targetCtx, prop, error, next) => {
    const real = next();
    if (prop !== "llm" || real === void 0 || typeof real !== "object") return real;
    const existing = bridges.get(real);
    if (existing !== void 0) return existing;
    const bridge = new Proxy(real, {
      get(target, p, receiver) {
        if (p === "resolveModelInfo") {
          return async function resolveModelInfoBridged(provider, model, signal) {
            const info = await target.resolveModelInfo(provider, model, signal);
            if (info !== void 0 && Array.isArray(info.inputModalities) && !info.inputModalities.includes("image")) {
              return { ...info, inputModalities: [...info.inputModalities, "image"] };
            }
            return info;
          };
        }
        if (p === "prepareCall") {
          return async function prepareCallBridged(config, signal) {
            const prepared = await target.prepareCall(config, signal);
            if (prepared === void 0) return prepared;
            return { ...prepared, stream: lazyStream(target, (opts) => prepared.stream(opts)) };
          };
        }
        if (p === "stream") {
          return function streamBridged(options) {
            return lazyStream(target, (opts) => target.stream(opts))(options);
          };
        }
        const value = Reflect.get(target, p, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    bridges.set(real, bridge);
    return bridge;
  });

  // ── 诊断通道（可选）：查看桥接效果 ───────────────────────────────────────
  // 注意：web 宿主的 connection 服务带 inject: [webRuntime]，在本插件 apply 时
  // fiber 尚未激活（严格与非严格 get 均不可见），因此延后到组合完成后再注册。
  function registerDiagnostics() {
    const connection = ctx.get("connection");
    if (connection === void 0) return; // headless/base profile：无连接服务，跳过
    connection.rpc.handle("/image-subagent", async (endpoint) => {
      if (endpoint === "status") {
        let bridged = null;
        let real = null;
        try {
          // 属性访问走 internal/get 瀑布 → 桥接后的视图（准入层看到的）。
          bridged = (await ctx.llm.resolveModelInfo("deepseek-official", "deepseek-v4-pro")).inputModalities;
        } catch (error) {
          bridged = "error: " + String(error.message || error);
        }
        try {
          // ctx.get 走隔离存储直读，绕开包装，得到真实声明。
          const raw = ctx.get("llm");
          real = raw === void 0 ? null : (await raw.resolveModelInfo("deepseek-official", "deepseek-v4-pro")).inputModalities;
        } catch (error) {
          real = "error: " + String(error.message || error);
        }
        return { ok: true, value: { name, bridged, real } };
      }
      throw new Error("image-subagent: unknown endpoint " + JSON.stringify(endpoint));
    }, { authority: "loopback" });
  }
  registerDiagnostics();
}
export { apply, inject, name };
