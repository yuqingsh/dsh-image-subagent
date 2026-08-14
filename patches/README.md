# 兜底核心补丁（一般不需要）

本插件正常工作时**不需要**这些补丁。仅当未来 DSH 版本移除/改变了
`internal/get` 或 `llm/stream` 行为、插件机制失效时，作为临时替代方案。

## 作用

- `dsh-llm.patch` — 在 `prepareCall` 的 prepared 对象中透传 `inputModalities`，
  使核心自带的「图片→占位符」投影（同仓库 `patched-dsh-llm-index.js` 曾合入的
  方案）覆盖 agent 主循环路径。
- `dsh-host-apiproxy.patch` — 移除两处图片准入门控（贴图 / 切换模型），改为仅
  校验附件存储可用。

## 应用

先定位 npx 缓存的安装目录（`dsh web` 实际加载的包），然后：

```sh
cd ~/.npm/_npx/*/node_modules/@deepseek-ai/dsh-llm
patch -p1 < /path/to/dsh-llm.patch

cd ~/.npm/_npx/*/node_modules/@deepseek-ai/dsh-host-apiproxy
patch -p1 < /path/to/dsh-host-apiproxy.patch
```

重启 `dsh web` 生效。注意：npx 缓存被重装（升级版本、清理缓存）后补丁会丢失，
需要重新应用——这正是默认方案采用插件实现的原因。
