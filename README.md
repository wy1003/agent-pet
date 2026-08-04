# Agent Pet

<div align="center">

**让 AI 编程任务变成一只有状态、会提醒、能陪伴你的桌面宠物。**

[下载 Agent Pet](https://github.com/wy1003/agent-pet/releases) · [功能介绍](#主要功能) · [快速开始](#快速开始) · [参与共建](#参与共建)

[![CI](https://github.com/wy1003/agent-pet/actions/workflows/ci.yml/badge.svg)](https://github.com/wy1003/agent-pet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

Agent Pet 是一个面向 AI 编程助手的开源 Windows 桌面宠物。它会跟随 Codex 任务的运行、等待、完成、失败等状态播放不同动画，并通过任务收件箱、系统通知、语音和微信提醒，让你离开电脑后也不会错过任务进展。

当前第一版支持 **Codex Desktop**，并兼容由 Codex TypeScript SDK 驱动的 CC GUI 任务。

## 主要功能

- 🐾 **状态桌宠**：根据任务状态切换待机、运行、等待、完成和失败动画。
- 📥 **任务收件箱**：同时查看多个项目和会话的任务，完成后手动确认，不会被新问题覆盖。
- 🔔 **多渠道提醒**：支持 Windows 系统通知、语音播报和微信远程通知。
- 🗣️ **可选语音引擎**：可使用 Windows 系统音色，也可按需安装并连接本地 GPT-SoVITS。
- 💬 **微信通知**：扫码连接个人微信，在手机上接收任务完成、失败和等待输入提醒。
- 🌙 **免打扰与提醒规则**：分别控制需要提醒的任务状态、通知渠道和安静时段。
- 🎨 **自定义宠物**：支持导入符合 Agent Pet 格式的 GIF 宠物包，并在宠物库中切换。
- 📝 **每日工作总结**：按项目整理当天完成的任务，支持编辑、复制和重新生成。
- 🔒 **本地优先**：设置、宠物、音色和通知记录保存在本机；敏感连接凭据使用系统安全存储。

## 快速开始

### 1. 下载

前往 [GitHub Releases](https://github.com/wy1003/agent-pet/releases) 下载适合你的 Windows x64 版本：

- `Agent-Pet-Setup-<version>-x64.exe`：推荐的安装版，支持应用内更新。
- `Agent-Pet-Portable-<version>-x64.exe`：免安装便携版，后续版本需要手动下载。

### 2. 启动

运行 Agent Pet 后，它会自动发现当前 Windows 用户下的 Codex 任务。宠物会显示在桌面右侧，也可以通过系统托盘打开任务列表和设置。

### 3. 按需设置提醒

在设置中可以分别开启：

- Windows 系统通知
- Windows 系统语音或 GPT-SoVITS
- 微信远程通知
- 免打扰时段与紧急提醒

所有设置都会自动保存在本机，覆盖安装新版本不会删除现有设置、微信连接、宠物、音色或通知记录。

## 功能说明

### 桌宠与任务收件箱

每次向 Codex 提交的问题都会作为一项独立任务显示。任务运行时可以看到当前阶段；任务完成、失败或中断后会保留结果，直到你手动确认。

宠物支持拖动、位置记忆、惯性甩动和屏幕边缘反弹。多屏幕或系统缩放变化后，应用会尽量将宠物恢复到可见区域。

### 微信远程通知

在“设置 → 远程通知”中连接微信：

1. 使用手机微信扫描二维码。
2. 如微信要求验证，在 Agent Pet 中输入手机显示的数字验证码。
3. 扫码确认后，在微信中向 Agent Pet 发送任意一条绑定消息。
4. Agent Pet 明确显示“微信已连接”后，即可接收任务提醒。

第一版只把微信作为通知出口，不会通过微信消息执行本机命令。登录凭据经系统安全存储加密后保存在本机，解除连接时会一并清除。

### 语音播报

Agent Pet 可以直接使用 Windows 已安装的系统音色。需要更自然或自定义的声音时，可以在语音设置中按需安装本地 GPT-SoVITS 运行环境，并导入自己有权使用的模型与参考音频。

GPT-SoVITS 不会打进 Agent Pet 主安装包，也不会修改系统 Python、PATH 或 Conda 配置。项目不附带或分发第三方角色音色。

### 自定义 GIF 宠物

在“设置 → 外观与启动 → 宠物库”中拖入或选择宠物 ZIP。压缩包需要包含同一英文前缀的 11 个标准状态 GIF，例如：

```text
my-pet-idle.gif
my-pet-running.gif
my-pet-failed.gif
```

Agent Pet 会在导入前检查文件结构、画布尺寸和动画帧数。导入后使用的是应用管理的副本，原 ZIP 可以移动或删除。

## 隐私与安全

- Agent Pet 只读取本机 Codex 生成的任务记录，不会修改 Codex 原始文件。
- 设置、宠物、音色、日报和通知记录默认保存在本机用户数据目录。
- 微信连接凭据使用 Electron `safeStorage` 调用操作系统能力加密，不会写入普通设置文件。
- 微信通知内容可以选择简略、标准或完整级别。
- 第一版不支持通过远程消息控制电脑或执行命令。

## 当前支持范围

| 项目 | 第一版支持情况 |
| --- | --- |
| 操作系统 | Windows x64 |
| AI 编程助手 | Codex Desktop |
| 兼容来源 | CC GUI / Codex TypeScript SDK |
| 桌面通知 | Windows 系统通知 |
| 语音 | Windows 系统音色、GPT-SoVITS |
| 远程通知 | 个人微信文本通知 |
| 宠物格式 | Agent Pet 标准 GIF ZIP |

## 参与共建

欢迎提交 [Issue](https://github.com/wy1003/agent-pet/issues) 或 Pull Request，分享使用反馈、宠物素材建议和功能想法。

Agent Pet 爱好者 QQ 群：`650561994`

如果要从源码参与开发：

```powershell
git clone https://github.com/wy1003/agent-pet.git
cd agent-pet
npm install
npm run companion
```

运行测试：

```powershell
npm test
```

需要 Node.js 20 或更高版本。

## 许可证

Agent Pet 使用 [MIT License](LICENSE)。允许个人和公司使用、修改、分发、闭源集成和商业使用，但必须保留原版权及许可证声明。
