# dsh-image-subagent

让纯文本主模型（如 deepseek-v4-pro）也能接收图片附件：图片进入会话后投影为携带完整 `attachmentId` 的显式文本占位符，由主模型委托视觉子代理读取。

> **版本与 dsh 的对应关系**：
> - `v0.1.x` —— dsh `0.1.0-rc.x`（rc.6 时代，通过"补报 image 能力"放行门禁）；
> - `v0.2.0` —— dsh `≥ 0.1.1-rc.2`（0.1.1 适配版，通过"抹除模态声明"放行门禁，详见下文"适配策略"）。

## 适配策略（v0.2.0 为什么这样改）

0.1.1 的图片准入门禁只拒绝**显式声明 `inputModalities` 且不含 `image`** 的路由，声明省略（`undefined`）视为负能力直接放行；同时官方适配器对纯文本路由已有原生占位投影（只含 sha256 前 8 位摘要）。因此本版把旧版的"补报 image 能力"改为"**抹除纯文本路由的 `inputModalities` 声明**"：

- **门禁**：`undefined` → 放行，贴图不再被拒绝；
- **适配器**：仍按纯文本路由处理 → 本插件在主循环路径投影为**富占位**（完整 id + 委托提示），漏网路径由官方原生占位兜底——不存在把图片当真发给纯文本端点的失败模式；
- **`read_image` 工具门禁**：主模型路由 `undefined` → 仍拒绝（主模型不能自己读图，委托流保持不变）；
- **视觉路由**（如 `deepseek-v4-flash-vision-exp`）完全不受影响：声明含 image，插件旁路，原生直读。

## 安装

```sh
# 本地 checkout（推荐，方便跟进改动）
dsh plugin --profile web add ./dsh-image-subagent

# 或按 git 标签
dsh plugin --profile web add github:yuqingsh/dsh-image-subagent#v0.2.0
```

需要 pnpm（`brew install pnpm`）。安装后重启 `dsh web` 并刷新页面。

### 用 Prompt 安装

把下面这段发给你的 DSH 会话，让 Agent 代装：

> 请安装 dsh-image-subagent 插件：在 /Users/kane/Documents/OpenCode 下运行 `dsh plugin --profile web add ./dsh-image-subagent`。完成后重启 dsh web 进程，刷新浏览器页面。

## 使用

### 前置条件

- 预设里有一个视觉子代理（如 `subagent_observer`），其模型声明 image 输入（如 `deepseek-v4-flash-vision-exp` 或 MiniMax-M3）；
- 该子代理的工具集包含 `read_image`；
- 贴图进入会话后，主模型会收到富占位文本（含 `id=sha256:<64位hex>`），委托时把占位符里给出的附件对象路径传给子代理。

### 日常使用

贴图并附上问题 → 门禁放行 → 主模型收到富占位符（含完整 `id=sha256:…` 和附件对象路径）→ 委托 `subagent_observer` 用 `read_image` 读该路径 → 返回像素级描述 → 主模型作答。

附件对象路径规则：`~/.dsh/attachments/v1/objects/<id 前 2 位 hex>/<64 位 hex>`。

### 验证安装

```sh
curl -s -X POST http://127.0.0.1:3080/image-subagent/status \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"s1","method":"status","payload":{}}'
```

预期（v0.2.0）：`bridged` 为 `"(omitted — paste gate passes)"`，`real` 为 `["text"]`（路由真实声明）。旧版 v0.1.x 的预期是 `bridged` 含 `"image"`。

## License

MIT
