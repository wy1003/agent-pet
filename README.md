---
output:
  word_document:
    reference_doc: C:/Users/ASJ/custom-reference.docx
---

# Agent Pet

**给 Codex / Claude Code 养只桌宠，把任务、计划和灵感留在桌面。**

Agent Pet 是一款 Windows 桌面宠物助手。宠物显示 Codex 与 Claude Code 的工作状态，在任务完成或需要你回答时提醒；独立记事板用来安排计划、记录灵感，既能手动填写，也能让 AI 帮你整理和写入。离开电脑后，还可以通过微信查看任务结果、继续下指令。

[下载安装](https://github.com/wy1003/agent-pet/releases) · [使用指南](docs/USAGE.md) · [AI 写入记事板](docs/NOTEBOOK_MCP.md) · [微信指令](docs/WEIXIN_REMOTE_CONTROL.md)

[![CI](https://github.com/wy1003/agent-pet/actions/workflows/ci.yml/badge.svg)](https://github.com/wy1003/agent-pet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<table>
  <tr>
    <td align="center"><img src="public/assets/pets/builtin-default/builtin-default-running.gif" width="112" alt="宠物工作动画"><br><b>正在工作</b></td>
    <td align="center"><img src="public/assets/pets/builtin-default/builtin-default-review.gif" width="112" alt="宠物等待确认动画"><br><b>等你确认</b></td>
    <td align="center"><img src="public/assets/pets/builtin-default/builtin-default-waving.gif" width="112" alt="宠物完成任务动画"><br><b>任务完成啦</b></td>
  </tr>
</table>

## 它能帮你做什么

- **不用一直盯着 Codex / Claude code**：桌宠显示任务状态，点击即可查看多个项目的任务。
- **把计划和灵感留在桌面**：记事板独立悬浮，支持详细事项、重要标记、可选截止日期与时间，以及完成记录和手动归档。
- **让 AI 帮你记录**：通过 MCP 查询、添加和修改计划或灵感，保留原话与修改历史；自己也能随时新增和编辑。
- **做完了叫你一声**：支持桌面通知、语音播报和微信提醒。
- **离开电脑也能继续**：在微信中向原会话追加要求，或在指定项目新建任务，结果返回微信。
- **按自己的习惯布置桌面**：宠物卡片预览与切换，任务列表和额度卡片分别开关，记事板可选择原有或液态玻璃样式。

## 开始使用

本文介绍源码 **0.12.3** 的功能，对应安装包尚未发布。下载时请查看 [Releases](https://github.com/wy1003/agent-pet/releases) 中所选版本的发布说明；体验当前源码可按下方步骤运行。

1. 从 [Releases](https://github.com/wy1003/agent-pet/releases) 下载 **Windows x64 安装版**（`Setup`）或免安装版（`Portable`）。
2. 打开 Codex / Claude Code 和 Agent Pet，桌宠会同时自动跟踪两种来源的本机会话，无需二选一。
3. 点击宠物查看任务；右键宠物或使用系统托盘进入设置、打开记事板或查看今日工作总结。
4. 在设置中开启需要的窗口与通知。使用记事板、AI 写入和微信续问的方法见下文。

### 计划与灵感

在 **设置 → 记事板 → 显示与外观** 开启记事板。它是独立窗口，可单独置顶，不随宠物点击或失去焦点收起；点击右上角的“−”可缩成显示未完成计划数量的圆球，单击圆球恢复。

- **计划**：列表展示标题，点击查看详细事项并在原页编辑。写入时间自动记录，截止日期和具体时间可选；重要项优先，同级按写入时间从新到旧排列。
- **灵感**：随手记下一句话，之后再补充内容，也可以转为计划。
- **完成与归档**：勾选完成后仍留在列表，误勾可取消；手动点击“归档已完成”才移入归档，保留完整内容、完成快照和相关时间，也可移回计划。

内容以独立 JSON 文件保存在本机，无需数据库。在 **设置 → 记事板 → 本地存档** 打开目录，退出应用后复制整个 `notebook` 文件夹即可备份。

记事板可选择原有样式或液态玻璃。玻璃根据窗口所在位置读取桌面壁纸画面并处理，不包含其他应用窗口；背景不可用时会使用备用外观。

### 让 AI 帮你填写

1. 启动 Agent Pet，打开 **设置 → 记事板 → AI 写入**。
2. 点击 **一键连接 Codex** 或 **一键连接 Claude Code**，两者均直接配置并在页面内显示结果，服务名称统一为 `agent-pet-notebook`，可同时使用同一份记事板。Codex 按提示重新加载连接；Claude 配置完成后新开会话或重载扩展。其他支持本地 STDIO MCP 的 AI 应用可使用“其他 AI：复制配置”。
3. 连接后，直接在 AI 对话里表达你想记录的内容，例如：

```text
添加一个计划到 Agent Pet 记事板：整理本周工作。
具体事项是回顾进度、列出三项重点，不设截止时间。
```

```text
记一个灵感到记事板：做一个每周复盘模板。
保留这句原话，帮我补充两三条下一步建议。
```

不需要固定开头。AI 保存成功后，记事板会自动刷新；使用时保持 Agent Pet 运行，窗口可以隐藏。手动新增和编辑仍然可用，AI 工具只提供查询、新增与修改，完成和归档由你操作。[查看连接、工具与排错说明](docs/NOTEBOOK_MCP.md)

AI 写入由所连接的 AI 应用完成；应用内一键补充和微信灵感自动同步尚未接入。播报文案和工作总结使用的模型则在 **设置 → 智能体与 AI → 文本生成** 中选择，支持 Codex、Claude Code、DeepSeek 和兼容接口。

### 微信里继续一个任务

在 **设置 → 远程通知** 扫码连接微信，开启“发送远程通知”；需要续问时，再开启默认关闭的“指令操作”。

先发送 `/sessions` 查看会话编号，再发送：

```text
/S0001 帮我给刚才的功能补上测试
```

**微信发出要求 → Codex 原会话继续执行 → 微信收到结果。**

将 `S0001` 换成自己的会话编号；电脑需保持联网并运行 Agent Pet。[查看完整连接步骤与指令](docs/WEIXIN_REMOTE_CONTROL.md)

## 按需设置桌面

设置自动保存，菜单按用途分组：

| 分组 | 内容 |
| --- | --- |
| 应用 | 通用、智能体与 AI：主题、启动方式、任务来源与文本生成 |
| 桌面 | 宠物、任务与额度、记事板：宠物库、显示方式、置顶、外观、AI 写入与存档 |
| 通知 | 提醒规则、系统通知、语音播报、远程通知：提醒事件、免打扰与各通知渠道 |

任务列表与额度卡片在“任务与额度”中分别选择是否随宠物点击出现；记事板单独控制显示与置顶。宠物库支持拖入 ZIP 导入 Codex 精灵表或状态 GIF，通过卡片切换和管理宠物。

## 从源码运行

需要 Windows 和 Node.js 20 或更高版本：

```powershell
git clone https://github.com/wy1003/agent-pet.git
cd agent-pet
npm ci
npm run companion
```

运行检查：`npm test`；仅检查微信远程指令：`npm run test:commands`。这些指令测试使用本地模拟链路，不代替真实微信或安装包验收。

## 更多

- [使用指南](docs/USAGE.md)：完整设置、记事板、任务收件箱、语音、宠物与本地数据说明。
- [记事板 MCP 指南](docs/NOTEBOOK_MCP.md)：AI 接入、工具能力、手动编辑与版本冲突处理。
- [微信指令指南](docs/WEIXIN_REMOTE_CONTROL.md)：连接、续问、新任务、状态查询和故障处理。
- [窗口架构](docs/WINDOW_ARCHITECTURE.md)：按窗口封装的 Facade、接口契约及窗口协调策略。
- [更新记录](CHANGELOG.md)：源码变更、验证范围与安装包发布状态。
- [反馈问题](https://github.com/wy1003/agent-pet/issues) · QQ 交流群：`650561994`

当前源码同时提供 Codex 与 Claude Code 日志自动发现，自动维护最小生命周期 Hook，另有可选增强及受控 SDK 执行；验证结果与 Claude 原窗口控制的边界见[验证摘要](docs/CLAUDE_VERIFICATION.md)。开源协议：[MIT](LICENSE)。
