# Agent Pet

## 安装与更新

Windows 用户可以从 [GitHub Releases](https://github.com/wy1003/agent-pet/releases) 下载：

- `Agent-Pet-Setup-<version>-x64.exe`：推荐的安装版，支持应用内检查和下载更新。
- `Agent-Pet-Portable-<version>-x64.exe`：免安装便携版，需要手动下载后续版本。

设置窗口左侧会显示当前版本。正式安装版启动后会检查 GitHub Releases，发现新版本时由用户确认下载，并在下载完成后选择“重启更新”。本机设置、微信连接凭据、宠物和通知记录位于用户数据目录，覆盖升级不会删除这些数据。

维护者发布新版本时，需要先更新 `package.json` 中的版本号，再推送同名标签，例如 `v0.2.0`。GitHub Actions 会运行测试、生成 Windows 安装包并发布 Release。

## 许可证

本项目使用 [MIT License](LICENSE)。允许个人和公司使用、修改、分发、闭源集成及商业销售，但必须保留原版权和许可证声明。

Agent Pet 是一个面向 AI 编程助手的开源桌面宠物与任务通知工具。它把不同任务来源的执行状态统一映射为宠物动作、紧凑任务列表、系统通知和语音播报。

当前第一套任务来源适配器支持 Codex Desktop 与 CC GUI / Codex TypeScript SDK，监听 `%USERPROFILE%\.codex\sessions\**\*.jsonl`。项目不会修改 Codex 原始文件；后续可以继续增加 Claude Code、Cursor 等来源适配器，而无需改变宠物与通知层。

项目文档：

- [开发任务清单](TASKS.md)：当前优先级、验收标准和已经确定的产品决策。
- [交接文档](HANDOFF.md)：项目背景、架构、接口与接手说明。

## 核心语义

- 一个 Codex `session_id` 表示一段会话。
- 会话内每个 `turn_id` 表示一项独立任务。
- 同一会话后续提出新问题时，旧任务仍保留自己的最终结果。
- 任务终态只有 `completed`、`failed`、`interrupted`，不会自动变成 `idle`。
- `idle` 将来只用于桌宠的聚合展示，不属于任务接口。

任务状态：

- `submitted`：已捕获问题，尚未看到开始事件。
- `queued`：问题等待开始超过配置阈值。
- `running`：任务正在执行。
- `needs_input`：等待用户批准或回答。
- `completed`：成功完成。
- `failed`：执行失败。
- `interrupted`：被中止。
- `unknown`：缺失结束事件且长时间没有活动。

执行阶段通过 `phase` 进一步区分：`waiting_start`、`reasoning`、`tool_running`、`responding`、`waiting_approval`、`waiting_answer`、`finished`、`unknown`。

## 运行

需要 Node.js 20 或更高版本，无第三方依赖：

```powershell
node .\src\cli.mjs
```

默认地址为 `http://127.0.0.1:43123`，默认每 750ms 增量扫描一次。只扫描并输出一次：

```powershell
node .\src\cli.mjs --once
```

可用参数：

```powershell
node .\src\cli.mjs --help
```

## 任务列表界面

服务启动后直接打开：

```text
http://127.0.0.1:43123/
```

页面通过 SSE 实时接收任务变化，只展示当前未确认任务。运行中展示来源、项目与执行阶段；终态任务展示最终回复摘要和“✓”按钮。点击“✓”后确认并从列表移除。页面断线时会自动重连，也可手动点击“重新连接”。

## Agent Pet 桌面程序

启动透明置顶的任务徽标：

```powershell
npm.cmd run companion
```

伴生层会优先复用 `http://127.0.0.1:43123` 上已经运行的采集服务；如果服务不存在，会自行启动内置采集器。功能包括：

- 透明、无边框、始终置顶的任务徽标
- 拖动徽标并自动记住屏幕位置
- 显示当前未确认任务数量和聚合提示状态
- 点击徽标展开任务列表，失焦后自动收起
- 任务完成、失败或中断时发送系统通知
- 托盘菜单、单实例运行和正式打包后的开机启动

徽标顶部的小横条用于拖动，宠物脸区域用于打开或关闭任务列表。

## 设置

可以通过任务列表右上角的齿轮或托盘菜单中的“设置…”打开独立设置窗口。设置会自动保存到 Electron `userData/preferences.json`，损坏或缺少配置文件时会安全回退到默认值。

当前设置页包括提醒规则、Windows 系统通知、语音播报、远程通知、免打扰、外观与启动和参与共建。Windows 通知、语音与微信远程通知都接入同一套真实任务事件；提醒规则只决定哪些任务事件需要通知，各渠道在自己的页面中独立启用。语音页面支持 Windows 系统音色和用户自行运行的 GPT-SoVITS 本地服务。GPT-SoVITS 音色通过独立弹窗添加，每个音色选择一个 `.ckpt`、一个 `.pth` 和一个参考音频；应用验证复制结果后，将文件存入受管音色库，并在下拉框中按用户填写的名称显示。服务地址和播报语言位于“高级设置”。项目不附带或分发任何第三方角色音色。

“参与共建”页面提供 Agent Pet 爱好者 QQ 群二维码和群号 `650561994`，方便交流宠物素材、产品体验和代码贡献。

受管音色库存放在：

```text
%LOCALAPPDATA%\AgentPet\voices
```

早期开发版本已经创建 `%LOCALAPPDATA%\CodexTaskCompanion` 时，Agent Pet 会原地继续使用该目录，不会复制或移动其中的音色、宠物和大型语音引擎。实际数据根记录在 `%APPDATA%\Agent Pet\data-location.json`。

导入使用复制而不是移动，因此原文件之后可以改名、移动或删除。删除音色只会删除应用音色库中的副本，不会影响原始文件。

### 微信远程通知

远程通知第一版直接接入腾讯 [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 使用的 iLink 协议，不要求安装 OpenClaw、AstrBot 或其他常驻服务。在“远程通知”中打开微信卡片并扫码；微信仅在需要时要求额外输入数字验证码。手机确认后，在微信里向 Agent Pet 发送任意一条消息，应用收到该消息并取得会话上下文后才会确认连接成功。此后任务完成、失败、等待输入等状态即可按提醒规则发送到该微信。

- 登录令牌、接收者标识和会话令牌使用 Electron `safeStorage` 加密后存放在本机，不写入 `preferences.json`，也不会通过设置页面返回给渲染进程。
- Agent Pet 只向腾讯 iLink HTTPS 服务发送用户选择的通知内容；“简略 / 标准 / 完整”可控制远程消息包含的信息量。
- 远程消息使用串行队列发送，临时网络错误会有限重试；失效会话不会循环重试，并会提示重新扫码。
- 第一版只把微信作为通知出口，不读取微信消息执行本机命令。用于完成绑定的入站消息只保存发送目标和最新会话上下文。
- 解除绑定会清除本机保存的微信连接凭据。若操作系统安全加密不可用，应用会拒绝保存凭据，不会降级为明文。

### GPT-SoVITS 按需安装

主程序不会捆绑 Python、PyTorch、FFmpeg 或 GPT-SoVITS 模型，因此安装包保持轻量。需要 GPT-SoVITS 时，可以在语音设置中点击“安装或启动”，也可以直接双击仓库根目录的：

```text
setup-gpt-sovits.cmd
```

脚本会先显示安装来源、固定源码提交、设备类型、下载源、安装目录和空间提示，只有用户输入 `YES` 后才开始下载。它会自行下载固定版本的便携式 micromamba、校验运行文件的 SHA-256，并将 GPT-SoVITS 源码、独立 Python 环境、PyTorch、官方基础模型和全部缓存集中安装到：

```text
%LOCALAPPDATA%\AgentPet\engines\GPT-SoVITS
```

安装脚本不要求系统预先安装 Git、Python 或 Conda，也不会修改用户或系统 `PATH`、注册表、PowerShell 配置和 Conda 配置。安装完成后，可以从设置页再次点击“安装或启动”，或者双击：

选择 ModelScope 或 Hugging Face 镜像时，普通 Python 依赖会在当前安装进程中临时使用清华 TUNA PyPI 镜像，并实时显示 pip 下载进度；这个设置不会写入用户的全局 pip 配置。安装中断后可以重新运行脚本，已经完成的独立环境、模型和依赖会被保留并复用。

```text
start-gpt-sovits.cmd
```

本地 API 默认监听 `http://127.0.0.1:9880`。安装完成后，设置页会由 Electron 在隐藏后台进程中启动和停止服务，不再显示日常运行用的 CMD 窗口；运行日志保存在受管引擎目录的 `logs/service.log`。设置页会显示未安装、已停止、启动中、运行中或启动失败，也可开启“随应用自动启动”，让服务跟随 Agent Pet 启停。角色音色包仍由用户自行准备；按需安装过程只获取 GPT-SoVITS 官方运行代码、依赖和推理所需的官方基础模型。

不再需要本地服务时，先关闭服务窗口，再双击：

```text
remove-gpt-sovits.cmd
```

输入 `REMOVE` 后，脚本只会删除上述受管运行目录，包括便携运行时、Python 环境、源码、官方基础模型和缓存。设置与用户导入的角色音色位于其他目录，不会被这个清理脚本删除。由于安装过程不产生持久的系统级配置，清理后无需恢复系统 Python、环境变量或注册表。未来的正式应用卸载器可以另行提供“同时删除设置和音色库”选项，用于彻底清除用户数据。

## 任务接口

获取全部任务：

```http
GET http://127.0.0.1:43123/api/v1/tasks
```

该接口默认只返回桌宠的“当前工作集”：服务启动时已经结束的历史任务不会进入列表；新任务会立即出现，完成、失败或中断后保留最终结果，直到用户关闭它。

仅查看仍在执行或等待输入的任务：

```http
GET http://127.0.0.1:43123/api/v1/tasks?scope=active
```

完整历史只用于诊断：

```http
GET http://127.0.0.1:43123/api/v1/tasks?scope=all
```

获取单项任务（`taskId` 需要 URL 编码）：

```http
GET http://127.0.0.1:43123/api/v1/tasks/{taskId}
```

用户点击“√”确认一项终态任务：

```http
POST http://127.0.0.1:43123/api/v1/tasks/{taskId}/acknowledge
```

只有 `canAcknowledge=true` 的终态任务可以确认。运行中或等待输入的任务会返回 HTTP `409 task_not_terminal`，不会从列表移除。`/dismiss` 作为兼容别名保留。

订阅实时变化：

```http
GET http://127.0.0.1:43123/api/v1/events
Accept: text/event-stream
```

SSE 首先发送 `snapshot`，随后发送 `task.created`、`task.updated`、`task.removed`。快照中同时暂时保留旧的 `sessions` 字段作为兼容层。

任务对象示例：

```json
{
  "taskId": "codex:<sessionId>:<turnId>",
  "sessionId": "...",
  "turnId": "...",
  "sourceLabel": "Codex Desktop",
  "projectName": "x-z",
  "question": "请实现任务采集 MVP",
  "latestResponse": "已经完成……",
  "status": "completed",
  "phase": "finished",
  "submittedAt": "2026-08-02T10:00:00.000Z",
  "startedAt": "2026-08-02T10:00:01.000Z",
  "completedAt": "2026-08-02T10:02:00.000Z"
}
```

旧会话接口仍可用于诊断：

```http
GET http://127.0.0.1:43123/api/v1/sessions
```

## 测试

### 导入 GIF 宠物压缩包

第一版在“设置 → 外观与启动 → 宠物库”中提供 ZIP 拖拽导入。压缩包需要包含同一英文前缀的 11 个状态文件，例如 `yijian-idle.gif`、`yijian-running.gif` 和 `yijian-failed.gif`。应用会校验标准状态、画布尺寸和帧数，再将文件原子复制到：

```text
%LOCALAPPDATA%\AgentPet\pets
```

导入完成后可以移动或删除原 ZIP；切换和删除操作只影响应用管理的宠物副本。第一版不联网下载宠物，也不会修改 Codex 自身的宠物目录。

```powershell
npm.cmd test
```

测试覆盖设置持久化与迁移、桌面窗口定位、任务列表页面、当前工作集、宠物与音色库、语音与远程通知队列、微信 iLink 协议、安全凭据、任务状态、增量 JSONL、HTTP 与 SSE。

## 当前边界

- CC GUI 来源依据 `originator=codex_sdk_ts + source=exec` 推断，因此 `sourceConfidence` 为 `inferred`。
- `needs_input` 只有在 JSONL 中出现明确请求事件时才能识别；后续可增加 App Server 或 CC GUI 插件实时适配器。
- 当前覆盖同一 Windows 用户、同一个 `CODEX_HOME` 下的任务。WSL、远程服务器和其他电脑需要额外采集代理。
- 微信远程通知依赖腾讯 iLink 服务及其当前协议；第一版仅支持绑定一个个人微信接收文本通知。
