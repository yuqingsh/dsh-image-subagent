# dsh-image-subagent

让纯文本主模型（如 deepseek-v4-pro）也能接收图片附件：图片进入会话后投影为显式文本占位符，由主模型委托视觉子代理（多模态模型）读取。

## 安装

### 常规安装

```sh
dsh plugin --profile web add github:yuqingsh/dsh-image-subagent#v0.1.1
```

发布到 npm 后：`dsh plugin --profile web add dsh-image-subagent`。本地 checkout：`dsh plugin --profile web add ./dsh-image-subagent`。

需要 pnpm（`brew install pnpm`）。安装后重启 `dsh web` 并刷新页面。

### 用 Prompt 安装

把下面这段发给你的 DSH 会话，让 Agent 代装：

> 请安装 dsh-image-subagent 插件：运行 `dsh plugin --profile web add github:yuqingsh/dsh-image-subagent#v0.1.1`。完成后重启 dsh web 进程，刷新浏览器页面。

## 使用

### 前置条件（缺一不可）

- 预设里有一个视觉子代理（如 observer），其模型声明 image 输入（如 MiniMax-M3）；
- 该子代理的工具集包含 `read_attachment` / `read_image`；
- 子代理须在本会话内派生（spawn / fork）——附件读取按会话日志授权；
- 主模型委托时，把占位符中的 `attachmentId` 一并传给子代理。

### 日常使用

贴图并附上问题 → 主模型收到占位符（含 `id=sha256:…`）→ 委托 observer 读图 → observer 用 `read_attachment` 返回像素级描述 → 主模型作答。

### 验证安装

```sh
curl -s -X POST http://127.0.0.1:3080/image-subagent/status \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"s1","method":"status","payload":{}}'
```

预期 `bridged` 含 `"image"`，`real` 为路由真实声明。

## License

MIT
