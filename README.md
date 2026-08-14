# dsh-image-subagent

让**纯文本主模型**（如 `deepseek-v4-pro`）也能接收图片附件的 DeepSeek Harness 插件：图片不再被准入门控拒绝，而是进入会话后投影为**显式文本占位符**，由主模型委托给**视觉子代理**（多模态模型）通过 `read_attachment` / `read_image` 原生读取。

**零核心补丁**——全部通过插件级 seam 实现，npx 重装、版本升级都不会失效。

三个与现有方案的区别：

- **首个纯插件打通「贴图准入」的闭环**：社区现有方案（[#357](https://github.com/deepseek-ai/deepseek-harness/discussions/357)、[#427](https://github.com/deepseek-ai/deepseek-harness/discussions/427)、[#733](https://github.com/deepseek-ai/deepseek-harness/discussions/733)、[#911](https://github.com/deepseek-ai/deepseek-harness/discussions/911) 等）要么是提案、要么是改核心的 patch/fork；
- **子代理原生看图**：图片直接交给多模态子代理理解，不做「先压缩成文本描述再转述」的语义损耗，支持多轮追问；图片走 harness 自己的附件库（会话引用授权、随会话导出），路由本地时不出本机，**零新增凭据**；
- **与工具路线互补**：见下文「与 agent-vision-toolkit 的关系」。

## 安装

依赖：`@deepseek-ai/dsh` ≥ 0.1.0-rc.6、pnpm（`brew install pnpm`）。

```sh
# 从 GitHub（推荐锁定 commit，防止后续推送改变实际运行的代码）
dsh plugin --profile web add github:yuqingsh/dsh-image-subagent#<commit-sha>

# 或从 npm（发布后）
dsh plugin --profile web add dsh-image-subagent

# 或本地 checkout / tarball
dsh plugin --profile web add ./dsh-image-subagent
dsh plugin --profile web add ./dsh-image-subagent-0.1.0.tgz
```

安装后**重启 `dsh web` 并刷新页面**。卸载/升级：

```sh
dsh plugin --profile web remove dsh-image-subagent
dsh plugin --profile web up dsh-image-subagent
```

## 使用方法

### 1. 一次性：配置视觉子代理

插件只负责「放行图片 + 投影占位符」；真正看图的是你预设里的视觉子代理。在 DSH 网页的 Agent 预设里添加一个子代理（如 `observer`）：

- 模型选**声明了 image 输入的多模态模型**（如 MiniMax M3 / Kimi 视觉模型）；
- 工具集勾选 `read_attachment`、`read_image`（由核心 `dsh-tool-fs` 提供，多数完整预设默认已挂载）；
- 主模型保持纯文本（如 DeepSeek V4 Pro / Flash）。

**子代理读图的硬性要求（缺一不可）**：

1. 子代理模型必须声明 image 输入（`inputModalities` 含 `image`）——若子代理也是纯文本路由，本插件的投影会把图片同样变成占位符，子代理只能拿到元数据、看不到像素；
2. 工具集包含 `read_attachment` / `read_image`；
3. 子代理必须在**本会话内派生**（spawn / fork）——附件读取按会话日志的引用授权，独立新会话无权读取该 id；
4. 主模型委托时把占位符里的 `attachmentId` 一并传给子代理（占位符自带 id，主模型按提示传递即可）。

没有视觉子代理时，占位符会进入对话，但无人能读图——主模型会告知你这一情况。

### 2. 日常使用：贴图 → 委托 → 读图

直接在聊天框粘贴图片，附上你的问题：

```
你：[贴上截图] 看看这个面板报错是什么
主模型（纯文本）：收到占位符
  "[image attachment "image.png" (image/png, 774x542 px, id=sha256:…)
   — not visible to this text-only model route; a vision-capable
   subagent can inspect it with the read_attachment tool]"
主模型：把附件 id 交给 observer 子代理，请求读图
observer（多模态）：read_attachment(sha256:…) → 完整描述图片
主模型：基于描述继续推理作答（可继续追问细节）
```

已实测的组合（DeepSeek V4 主模型 + MiniMax M3 observer）：贴图 → 准入放行 → 附件入库 → 主模型收到占位符 → observer 读图并作答 → 本轮正常完成。

### 3. 验证安装是否生效

重启后探测桥接状态（`bridged` 应含 `image`，`real` 为路由真实声明）：

```sh
curl -s -X POST http://127.0.0.1:3080/image-subagent/status \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"s1","method":"status","payload":{}}'
```

预期：

```json
{ "result": { "ok": true, "value": {
    "name": "image-subagent",
    "bridged": ["text", "image"],
    "real": ["text"] } } }
```

## 工作原理（两个插件级 seam）

1. **准入放行**：`dsh-host-apiproxy` 的图片准入通过 `ctx.llm.resolveModelInfo(...)` 检查路由的 `inputModalities`。本插件在 cordis 的 `internal/get` 瀑布上包装 `llm` 服务，对未声明 `image` 输入的路由补报 image 能力，于是：
   - 贴图不再报 `MODEL_DOES_NOT_SUPPORT_IMAGES`；
   - 含图会话切换回纯文本模型不再报 `does not accept image input`。
   注意：仅 `resolveModelInfo` 补报；`listModels`（模型目录/选择器）保持真实，不会误导 UI 把 DeepSeek 标成视觉模型。
2. **LLM 边界投影**：同一条 `internal/get` 桥接把 `llm.prepareCall` / `llm.stream` 包装成惰性生成器——agent 主循环的 request 是 `deepFreeze` 的、无法原地改写，因此首次拉取流时解析真实模态、**克隆 options** 并把 `image` 块（含 tool-result 内嵌）投影为显式占位文本（携带附件 id、文件名、尺寸），再交给真实调用。纯文本适配器（DeepSeek）因此不再抛 `UNSUPPORTED_CONTENT`，整轮运行正常完成。**图片不会被静默丢弃**——占位符把「不可见」显式写进对话，主模型可据此委托视觉子代理。
3. **保险丝**：`llm/stream` 瀑布对绕开 `ctx.llm` 属性路径、且 options 可变的直接调用做机会式原地投影。

## 与 agent-vision-toolkit 的关系（互补，非竞争）

- [dsh-vision-toolkit](https://github.com/Anionex/agent-vision-toolkit) 走**工具路线**：10 个视觉工具（OCR、grounding、像素对比、UI 还原等）对工作区文件调外部视觉 API，解决「看图之后能做什么」；它**不处理聊天贴图的准入门控**。
- 本插件走**子代理路线**：解决「贴图进得去」这一环——准入放行、附件入库、占位符投影、同会话子代理原生读图。
- **两者可叠加**：贴图后主模型既可以直接委托子代理看图，也可以调用它的 OCR/ground 等工具做精细视觉任务；它的 README 也主张「agent 的视觉能力可以住在 harness 里」，本插件是这一主张在「贴图链路」上的零补丁实现。

## 兼容性

- 要求 `@deepseek-ai/dsh` ≥ 0.1.0-rc.6（依赖 `internal/get`、`llm/stream` 两个 seam 与附件服务）。
- 与核心的「图片→占位符」补丁方案完全兼容：若你已打过核心补丁，插件投影在前、核心投影在后，二者幂等共存。
- 已在**未打任何核心补丁的 rc.6** 上端到端验证：贴图准入放行（`accepted: true`）、图片入库为持久化附件、主模型收到占位符、本轮正常完成（不再 `UNSUPPORTED_CONTENT`）。

## 兜底补丁（一般不需要）

`patches/` 目录附带了核心级等价方案（`dsh-llm` 的 `prepareCall` 透传、`dsh-host-apiproxy` 准入放行），仅当未来版本 seam 变化导致插件失效时作为临时替代。应用方式见 `patches/README.md`。

## License

MIT
