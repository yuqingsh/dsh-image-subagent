# dsh-image-subagent

让**纯文本主模型**（如 `deepseek-v4-pro`）也能接收图片附件的 DeepSeek Harness 插件：图片不再被准入门控拒绝，而是进入会话后投影为**显式文本占位符**，由主模型委托给**视觉子代理**（多模态模型）通过 `read_attachment` / `read_image` 读取。

**零核心补丁**——全部通过插件级 seam 实现，npx 重装、版本升级都不会失效。

## 用法

```
你：[贴上截图] 看看这个面板报错是什么
主模型（纯文本）：收到占位符 "[image attachment ... id=sha256:...]"
主模型：委托 observer 视觉子代理读图
observer（多模态模型）：read_attachment → 返回图片内容描述
主模型：基于描述继续推理作答
```

## 安装

```sh
# 需要 pnpm（brew install pnpm）
dsh plugin --profile web add github:yuqingsh/dsh-image-subagent
```

发布到 npm 后：`dsh plugin --profile web add dsh-image-subagent`

安装后重启 `dsh web` 并刷新页面。

## 前提：配置一个视觉子代理

插件只负责「放行图片 + 投影占位符」；真正看图的是你预设里的视觉子代理。在 DSH 网页的 Agent 预设里添加一个子代理，例如：

- **observer**：模型选支持多模态的（如 MiniMax M3 / Kimi 视觉模型），勾选 `read_attachment`、`read_image` 工具；
- 主模型保持纯文本（如 DeepSeek V4 Pro / Flash）。

没有视觉子代理时，占位符会进入对话，但无人能读图——主模型会告知你这一情况。

## 工作原理（两个插件级 seam）

1. **准入放行**：`dsh-host-apiproxy` 的图片准入通过 `ctx.llm.resolveModelInfo(...)` 检查路由的 `inputModalities`。本插件在 cordis 的 `internal/get` 瀑布上包装 `llm` 服务，对未声明 `image` 输入的路由补报 image 能力，于是：
   - 贴图不再报 `MODEL_DOES_NOT_SUPPORT_IMAGES`；
   - 含图会话切换回纯文本模型不再报 `does not accept image input`。
   注意：仅 `resolveModelInfo` 补报；`listModels`（模型目录/选择器）保持真实，不会误导 UI 把 DeepSeek 标成视觉模型。
2. **LLM 边界投影**：同一条 `internal/get` 桥接把 `llm.prepareCall` / `llm.stream` 包装成惰性生成器——agent 主循环的 request 是 `deepFreeze` 的、无法原地改写，因此首次拉取流时解析真实模态、**克隆 options** 并把 `image` 块（含 tool-result 内嵌）投影为显式占位文本（携带附件 id、文件名、尺寸），再交给真实调用。纯文本适配器（DeepSeek）因此不再抛 `UNSUPPORTED_CONTENT`，整轮运行正常完成。**图片不会被静默丢弃**——占位符把「不可见」显式写进对话，主模型可据此委托视觉子代理。
3. **保险丝**：`llm/stream` 瀑布对绕开 `ctx.llm` 属性路径、且 options 可变的直接调用做机会式原地投影。

## 兼容性

- 要求 `@deepseek-ai/dsh` ≥ 0.1.0-rc.6（依赖 `internal/get`、`llm/stream` 两个 seam 与附件服务）。
- 与核心的「图片→占位符」补丁方案完全兼容：若你已打过核心补丁（如本项目作者的方案），插件投影在前、核心投影在后，二者幂等共存。
- 已在**未打任何核心补丁的 rc.6** 上端到端验证：贴图准入放行（`accepted: true`）、图片入库为持久化附件、主模型收到占位符、本轮正常完成（不再 `UNSUPPORTED_CONTENT`）。

## 兜底补丁（一般不需要）

`patches/` 目录附带了核心级等价方案（`dsh-llm` 的 `prepareCall` 透传、`dsh-host-apiproxy` 准入放行），仅当未来版本 seam 变化导致插件失效时作为临时替代。应用方式见 `patches/README.md`。

## License

MIT
