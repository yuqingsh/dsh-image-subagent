const name = "image-subagent";
const inject = ["connection", "llm"];

/**
 * dsh-image-subagent v0.2.0 — 适配 dsh ≥ 0.1.1-rc.2 的图片桥接插件：
 * 让纯文本主模型（如 deepseek-v4-pro）也能接收图片附件：图片进入会话后投影为
 * 显式占位文本（携带完整 attachmentId），由主模型委托视觉子代理读取。
 *
 * 0.1.1 相对 rc.6 的变化（决定本版适配策略）：
 * - 准入门禁（dsh-host-apiproxy）只拒绝「显式声明 inputModalities 且不含 image」
 *   的路由；声明省略（undefined）视为负能力，直接放行。
 * - 官方适配器对纯文本路由有原生占位投影
 *   `[image omitted because this model accepts text only; attachment sha256:前8位]`，
 *   但只含 8 位摘要；本插件在主循环路径上投影为携带完整 attachmentId 的富占位。
 *
 * 因此 0.2.0 把旧版的「给纯文本路由补报 image 能力」改为「抹除纯文本路由的
 * inputModalities 声明」，三个效果：
 * - 门禁：undefined → 放行，贴图不再被拒绝；
 * - 适配器：仍按纯文本路由处理 → 插件富占位投影优先，漏网路径由官方原生占位
 *   兜底，不存在把图片当真发给纯文本端点的失败模式；
 * - read_image 工具门禁：主模型路由 undefined → 仍拒绝（委托流保持不变）；
 *   视觉路由（如 deepseek-v4-flash-vision-exp）完全不受影响，原生直读。
 *
 * 两个机制（均为插件级 seam，不修改核心）：
 * 1. `internal/get` 瀑布：包装 `ctx.llm` 服务 ——
 *    a) resolveModelInfo 对纯文本路由抹除 inputModalities，放行
 *       apiproxy 的图片准入门控（MODEL_DOES_NOT_SUPPORT_IMAGES）；
 *    b) prepareCall/stream 包装为惰性生成器：agent 主循环的 request 是
 *       deepFreeze 的，无法原地改写，因此首次拉取时解析真实模态、克隆
 *       options 并把 image 块投影为显式占位文本，再交给真实调用。
 * 2. `llm/stream` 瀑布：对绕开 `ctx.llm` 属性路径、且 options 可变的直接调用，
 *    做机会式的原地投影（保险丝；主流路径由机制 1 覆盖）。
 */
function apply(ctx) {
  // ── 占位符与投影 ───────────────────────────────────────────────────────
  // 0.1.1 的附件对象存于 ~/.dsh/attachments/v1/objects/<id前2位hex>/<64位hex>，
  // 占位符携带完整 id 后，主模型可直接推导文件路径交给视觉子代理 read_image。
  function imagePlaceholderText(attachment) {
    const name = typeof attachment?.name === "string" && attachment.name.length > 0 ? ` "${attachment.name}"` : "";
    const mediaType = typeof attachment?.mediaType === "string" && attachment.mediaType.length > 0 ? attachment.mediaType : "image";
    const dimensions = Number.isInteger(attachment?.width) && Number.isInteger(attachment?.height) ? `, ${attachment.width}x${attachment.height} px` : "";
    const bytes = Number.isSafeInteger(attachment?.bytes) ? `, ${attachment.bytes} bytes` : "";
    const id = typeof attachment?.attachmentId === "string" && attachment.attachmentId.length > 0 ? attachment.attachmentId : "";
    const idTag = id.length > 0 ? `, id=${id}` : "";
    const ext = mediaType === "image/jpeg" ? ".jpg" : mediaType === "image/webp" ? ".webp" : ".png";
    const hint = id.startsWith("sha256:")
      ? ` To inspect it, use the subagent_observer tool if it exists in your toolset (NOT a generic subagent — it inherits this text-only route and cannot read images): the stored object at ~/.dsh/attachments/v1/objects/${id.slice(7, 9)}/${id.slice(7)} has no extension — have the subagent copy it to a writable path with extension ${ext}, then read that copy with read_image. If no vision-capable subagent tool exists, do not spawn a generic subagent; instead ask the user to switch the session model to an image-capable one (e.g. deepseek-v4-flash-vision-exp).`
      : "";
    return `[image attachment${name} (${mediaType}${dimensions}${bytes}${idTag}) — not visible to this text-only model route.${hint}]`;
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
  // 1) resolveModelInfo 对纯文本路由抹除 inputModalities → 放行 apiproxy 的
  //    图片准入门控（0.1.1 门禁只拒绝「显式声明且不含 image」）；
  //    抹除而非补报：适配器仍按纯文本路由走原生占位兜底，不会把图片当真
  //    发给纯文本端点，read_image 工具门禁也对主模型保持拒绝。
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
            // 0.2.0：纯文本路由抹除声明（undefined = 负能力 → 门禁放行），
            // 视觉路由与未声明路由原样返回。
            if (info !== void 0 && Array.isArray(info.inputModalities) && !info.inputModalities.includes("image")) {
              const { inputModalities: _omitted, ...rest } = info;
              return rest;
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
          const mods = (await ctx.llm.resolveModelInfo("deepseek-official", "deepseek-v4-pro")).inputModalities;
          bridged = mods === void 0 ? "(omitted — paste gate passes)" : mods;
        } catch (error) {
          bridged = "error: " + String(error.message || error);
        }
        try {
          // 非 runtime 上下文直读，绕开包装，得到真实声明。
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
