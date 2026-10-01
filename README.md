# RP 大总结 / Big Memory v0.2.0

面向长篇 SillyTavern RP 的独立记忆压缩面板。

## v0.2.0

- 重做 UI：不再塞进 Extensions 设置页。
- 右下角独立 `🧠` 悬浮按钮，点击打开 Big Memory 面板；移动端使用大尺寸底部面板。
- 新增 **直连副 API**：填写 OpenAI-compatible Base URL、API Key，拉取 `/models` 模型列表并选择模型。
- API Key **不写入 extensionSettings**，仅当前网页会话保留，刷新即清空。
- 保留 **Connection Profile** 模式作为兼容/备用方案。
- 双层记忆：长期记忆 + 当前篇章，可随时手工编辑。
- 超长聊天自动分块总结，再合并。
- 总结成功后才隐藏旧楼，失败不动原文。
- 保留版本回滚、恢复隐藏楼层、旧历史编辑/删除/Swipe 后失效检测。
- 兼容 SillyTavern 1.15.0+。

## 直连副 API

直连模式按 OpenAI-compatible API 使用：

- 模型列表：`<Base URL>/models`
- 聊天生成：`<Base URL>/chat/completions`
- 鉴权：`Authorization: Bearer <API Key>`

Base URL 示例：

```text
https://openrouter.ai/api/v1
https://api.openai.com/v1
https://generativelanguage.googleapis.com/v1beta/openai
```

如果服务商禁止浏览器跨域请求（CORS），请改用 Connection Profile 模式。

> SillyTavern 官方明确不建议把 API Key 保存在 UI 扩展的 `extensionSettings` 中，因为它是明文客户端设置。v0.2.0 因此只在当前网页会话保存直连 Key。若未来需要安全的长期保存，需要配合 server plugin。

## 使用

1. 安装扩展并刷新 SillyTavern。
2. 右下角点击 `🧠`。
3. 打开「副 API」。
4. 选择「地址 + Key」。
5. 填 Base URL 和 API Key，点「拉取模型」。
6. 选择模型，点「测试连接」。
7. 回到「总结」，点「总结并压缩」。

总结内容存入当前聊天 `chatMetadata`，并通过 extension prompt 注入主 RP。原聊天不会被删除。
