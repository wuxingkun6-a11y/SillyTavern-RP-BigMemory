# RP 大总结 / Big Memory v0.1.1

一个面向长篇 SillyTavern RP 的聊天压缩扩展。它使用 **独立 Connection Profile（副 API）** 总结旧聊天，把摘要存进当前聊天的 `chatMetadata`，再通过 extension prompt 注入主 RP；总结成功后可用 SillyTavern 原生 `/hide` 隐藏已总结旧楼层。

## v0.1.1 已实现

- 独立副 API：选择 SillyTavern Connection Manager 中已有的 Connection Profile。
- 两种副 API 预设模式：
  - 跟随该 Profile 绑定的 Settings Preset / Instruct；
  - 不带 Profile 预设，仅使用插件自己的总结 Prompt。
- 可编辑总结 Prompt。
- 超长历史自动按字符数分块，再做一次合并总结。
- 双层记忆：
  - 长期记忆：只自动追加新的稳定事实；可手工编辑。
  - 当前篇章：每次总结刷新；可手工编辑。
- 注入位置可调：默认长期记忆 D16、当前篇章 D6。
- 默认保留最近 10 条原文。
- 总结成功后可自动 `/hide` 已总结范围；不会删除聊天原文。
- 总结/API 失败时不隐藏消息。
- 保存最近 8 个版本，可回滚上一版。
- 可以恢复由插件记录的隐藏楼层。
- 已总结旧楼被编辑 / 删除 / Swipe 后，会标记记忆可能过期并阻止继续增量总结。
- 每个聊天独立保存记忆与进度。

## 安装

### 推荐：SillyTavern 扩展链接安装

在 SillyTavern 的扩展安装界面粘贴：

```text
https://github.com/wuxingkun6-a11y/SillyTavern-RP-BigMemory
```

也可以手动将整个 `SillyTavern-RP-BigMemory` 文件夹放到：

```text
SillyTavern/data/<你的用户>/extensions/SillyTavern-RP-BigMemory
```

然后刷新 SillyTavern。扩展设置中会出现 **🧠 RP 大总结 / Big Memory**。

> 如果你的安装方式使用 `public/scripts/extensions/third-party/` 目录，也可以放进对应的第三方扩展目录；以你当前 ST 版本的第三方扩展安装方式为准。

## 使用前

1. 在 SillyTavern 的 **Connection Manager** 新建一个用于总结的 Profile。
2. 在插件里选择这个 Profile。
3. 如果你希望副 API 使用你自己的生成参数 / Instruct，就把它们绑定到这个 Profile，并勾选“使用该 Connection Profile 绑定的 Settings Preset / Instruct”。
4. 如果不想带 Profile 的生成预设，就取消这个勾选；插件会只发送自己的总结 Prompt。

> 注意：Connection Profile 的 Settings Preset 并不等于“把主 RP 的整套 Prompt Manager 提示词栈复制给副 API”。如果你需要专门的成人内容总结前置、角色规则或其它 system 指令，请直接写入插件的“总结专用 Prompt”。
5. 点击“测试”确认副 API 可用。
6. 点击“🧠 总结并压缩”。

## 记忆结构

### 长期记忆
稳定关系、长期习惯、重要承诺、角色认知差、未来仍有影响的重要事件、稳定亲密偏好等。插件只会自动追加新条目，不自动重写已有条目；你可以直接编辑。

### 当前篇章
最近正在发生什么、当前人物状态、关系气氛、计划、未完成事项与场景连续性。每次总结都会刷新。

## 重要说明

- `/hide` 是“从主模型 prompt 排除”，不是删除。原聊天仍在。
- 如果恢复隐藏楼层，同时又保持记忆注入，会出现“原文 + 摘要”同时进入 prompt 的重复信息；需要时可关闭“将记忆注入主 RP Prompt”。
- v0.1.1 还没有自动 token 阈值提醒、世界书同步、逐条锁定长期记忆、Diff 审核、分支继承 UI。这些适合后续版本。
- 不同副模型/服务商可能对输入内容有自己的限制；副 API 拒绝或返回异常时，插件不会隐藏原文。

## 推荐初始设置

- 保留最近消息：10
- 长期记忆：D16
- 当前篇章：D6
- 单块最大字符数：90000
- 总结最大输出：6000 tokens

对于单条非常长的 RP，可适当把“保留最近消息数”提高到 12–16，或把单块字符数根据副模型上下文能力调整。


### v0.1.1 修复

- 修复第三方扩展安装成功但设置面板不出现：入口脚本现在会自行初始化，不再只依赖 manifest hook。
- 设置面板改为等待 SillyTavern 扩展设置 DOM 出现，改善手机端/延迟加载场景。
