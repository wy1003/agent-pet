# Agent Pet 交接文档

> 更新时间：2026-08-02  
> 新项目目录：`D:\project\CodexActivityCompanion`  
> 当前版本：`0.1.0`（MVP）

> 当前开发优先级、语音功能进度和最新产品决策以根目录的 [TASKS.md](TASKS.md) 为准；本文主要保留架构与交接背景。

## 1. 项目目标

Agent Pet 是一个运行在 Windows 本地、面向 AI 编程助手的桌面宠物与任务通知工具。当前首个适配器统一读取 Codex Desktop 和 PyCharm CC GUI 产生的 Codex 会话记录，将每次提问转换为独立任务，并通过任务列表、桌面宠物和通知展示任务当前状态。

当前阶段只解决“可靠采集多处发起的任务内容与状态”以及“任务完成后由用户手动签收”两个核心问题，不修改 Codex 原始会话文件，也不尝试侵入或替换 Codex 原生桌宠。

## 2. 已完成能力

- 增量监听 `%USERPROFILE%\.codex\sessions\**\*.jsonl`。
- 同时识别 Codex Desktop 与使用 Codex TypeScript SDK 的 CC GUI 会话。
- 使用 `session_id` 区分会话，使用 `turn_id` 区分同一会话中的每次任务。
- 将工作目录最后一级作为项目名，例如 `D:\project\LianYi\v3` 显示为 `v3`。
- 采集问题、回复摘要、来源、项目、执行状态与执行阶段。
- 当前任务列表只展示运行中的任务和尚未签收的终态任务，不展示全部历史记录。
- 任务完成、失败或中断后继续保留；用户点击“✓”签收后才从当前列表移除。
- 未签收任务 ID 持久化，采集器重启后仍能恢复。
- 提供 REST API 与 SSE 实时事件流。
- 提供浏览器任务列表 UI。
- 提供 Electron 桌面伴生层：透明置顶徽标、点击展开任务列表、拖动、托盘、终态通知和单实例运行。
- 任务面板会根据内容自动调整高度。
- 提供独立 Web 技术设置窗口，可从任务面板齿轮和托盘菜单打开；左侧分类导航只展示当前分类内容。
- 设置自动持久化并经过白名单校验；损坏配置会回退到默认值。
- 已提供事件级提醒规则、系统通知、语音、远程通知、免打扰、外观与启动设置框架；提醒事件与通知通道彼此分离。
- 语音设置已能通过隐藏 Electron 语音宿主页枚举系统音色，并支持语速、音调、音量和自定义文本试听；另已加入 GPT-SoVITS 本地服务适配，可选择 `.ckpt`、`.pth` 和参考音频，测试连接、加载音色并试听返回的 WAV；尚未连接真实任务事件。

## 3. 核心语义

### 会话与任务

- 一个 Codex `session_id` 表示一段会话。
- 同一会话中的每个 `turn_id` 表示一项独立任务。
- 对外任务 ID 格式为：`codex:{sessionId}:{turnId}`。
- 同一项目目录可以同时存在多个不同会话；项目路径不能作为会话 ID。

### 任务生命周期

任务状态：

- `submitted`：已捕获用户问题，尚未看到正式开始事件。
- `queued`：等待开始超过配置阈值。
- `running`：任务正在执行。
- `needs_input`：等待用户批准、回答或其他输入。
- `completed`：成功完成。
- `failed`：执行失败。
- `interrupted`：被用户或客户端中止。
- `unknown`：任务缺少明确结束事件，并且长时间没有活动。

执行阶段 `phase` 用于提供更细的展示：

- `waiting_start`
- `reasoning`
- `tool_running`
- `responding`
- `waiting_approval`
- `waiting_answer`
- `finished`
- `unknown`

任务终态不会自动变成 `idle`。`idle` 只适合未来的桌宠聚合状态，不属于单项任务状态。

### 当前任务列表与签收

- 任务开始后进入当前任务列表。
- 运行中、排队中或等待输入的任务不能签收。
- `completed`、`failed`、`interrupted` 等可签收终态继续保留。
- 用户点击“✓”后，任务从当前任务列表移除。
- 签收不会修改或删除 Codex 原始 JSONL，也不会删除历史任务数据。

## 4. 系统结构

```text
Codex Desktop / PyCharm CC GUI
              │
              ▼
%USERPROFILE%\.codex\sessions\**\*.jsonl
              │
              ▼
src/collector.mjs + src/model.mjs
              │
              ▼
REST API + SSE（src/server.mjs）
              │
        ┌─────┴────────┐
        ▼              ▼
 浏览器任务列表     Electron 伴生层
 public/*          desktop/*
```

## 5. 目录说明

```text
CodexActivityCompanion/
├─ desktop/
│  ├─ main.mjs              Electron 主进程、窗口、托盘、通知、内嵌服务
│  ├─ preload.cjs           安全 IPC 桥接
│  ├─ preferences.mjs       设置默认值、校验、持久化与损坏恢复
│  └─ window-layout.mjs     徽标拖动、窗口定位与屏幕边界计算
├─ public/
│  ├─ index.html            任务收件箱页面
│  ├─ app.css               普通页面与 companion 模式样式
│  ├─ app.js                任务渲染、SSE、签收、面板自适应高度
│  ├─ companion-badge.html  桌面徽标页面
│  ├─ companion-badge.css   徽标样式
│  ├─ companion-badge.js    徽标聚合状态、拖动和终态通知
│  ├─ settings.html         独立设置页面
│  ├─ settings.css          设置页面样式
│  ├─ settings.js           设置读取、自动保存与恢复默认
│  ├─ speech.html           隐藏语音宿主页
│  └─ speech.js             系统音色枚举与 Web Speech 播放
├─ src/
│  ├─ model.mjs             JSONL 事件归并、来源识别、状态机与 DTO
│  ├─ collector.mjs         增量扫描、当前工作集、签收持久化与事件发布
│  ├─ server.mjs            HTTP、静态资源与 SSE 服务
│  └─ cli.mjs               命令行入口和参数解析
├─ test/                    Node 内置测试，共 26 项
├─ package.json
├─ package-lock.json
├─ README.md
└─ HANDOFF.md               本文档
```

## 6. 来源识别

来源主要依据 JSONL 开头的 `session_meta`：

- `originator = "Codex Desktop"`：显示为 `Codex Desktop`。
- `originator = "codex_sdk_ts"` 且 `source = "exec"`：识别为 CC GUI 场景，显示为 `CC GUI`。
- 其他来源保留原始 `originator`，无法识别时显示为未知 Codex 客户端。

这意味着 CC GUI 是否能被识别，取决于它是否继续使用 Codex SDK 并把会话写入同一套 Codex JSONL 目录。若未来客户端格式改变，应优先扩展 `src/model.mjs` 的来源与事件适配逻辑。

## 7. 本地运行

环境要求：Node.js 20 或更高版本。

```powershell
cd D:\project\CodexActivityCompanion
npm.cmd install
npm.cmd test
```

启动独立采集服务与浏览器 UI：

```powershell
npm.cmd start
```

默认地址：

```text
http://127.0.0.1:43123/
```

启动桌面伴生层：

```powershell
npm.cmd run companion
```

Electron 会先检查 `http://127.0.0.1:43123/healthz`：如果已经存在健康的采集服务，就复用它；否则启动内嵌采集服务。应用启用了单实例，重复启动只会唤起任务面板。

常用 CLI 参数：

```text
--port PORT          HTTP 端口，默认 43123
--poll-ms MS         文件扫描间隔，默认 750ms
--stale-ms MS        失联任务降级时间，默认 900000ms（15 分钟）
--state-file PATH    未签收任务 ID 状态文件
--once               只扫描并输出一次
```

## 8. API

### 健康检查

```http
GET /healthz
```

`/health` 是兼容别名。

### 当前任务列表

```http
GET /api/v1/tasks
```

默认 `scope=current`，返回运行中的任务和未签收终态任务。

其他范围：

```http
GET /api/v1/tasks?scope=active
GET /api/v1/tasks?scope=all
```

- `active`：只返回非终态任务。
- `all`：返回完整历史任务，主要用于诊断。

### 单项任务

```http
GET /api/v1/tasks/{encodedTaskId}
```

### 签收任务

```http
POST /api/v1/tasks/{encodedTaskId}/acknowledge
```

- 只有 `canAcknowledge=true` 的终态任务可以签收。
- 非终态任务返回 HTTP `409 task_not_terminal`。
- `/dismiss` 保留为兼容别名。

### 实时事件

```http
GET /api/v1/events
```

SSE 首先发送完整 `snapshot`，随后发送：

- `task.created`
- `task.updated`
- `task.removed`

### 旧会话接口

```http
GET /api/v1/sessions
```

该接口为早期兼容层。新功能应以 `/api/v1/tasks` 为主。

## 9. 状态持久化

独立 CLI 默认使用：

```text
.data/collector-state.json
```

文件只保存未签收任务 ID，不复制 Codex 原始内容。Electron 内嵌模式使用 Electron `userData` 目录保存自己的采集状态和 `companion-window.json` 窗口位置。

迁移到 `D:\project\CodexActivityCompanion` 时没有复制旧目录的 `.data`、日志或 `node_modules`；依赖已经在新目录重新安装。Codex 原始会话仍来自用户目录，因此不会因项目迁移而丢失。

## 10. 当前验证结果

迁移完成后已在新目录执行：

```powershell
npm.cmd test
```

结果：26 项测试全部通过，0 失败。

迁移时对 21 个源码和配置文件进行了 SHA-256 比对，旧目录与新目录差异为 0。

测试覆盖：

- JSONL 增量读取。
- Desktop 与 CC GUI 会话归并。
- 同一会话多任务。
- 排队、运行、等待输入与终态。
- 失联任务降级。
- 当前工作集与历史任务隔离。
- 终态签收和重启恢复。
- REST API 与 SSE。
- 任务列表静态页面。
- 徽标、面板定位和无反馈放大的拖动算法。
- 设置默认值校验、持久化、并发更新与损坏恢复。
- 设置页面静态资源路由。

## 11. 已知限制

- 当前只适配会写入 Codex JSONL 的客户端；Claude Code、Gemini、OpenCode 等尚未接入。
- CC GUI 来源识别依赖现有 `session_meta` 格式，客户端升级后需要重新验证。
- 缺少明确结束事件且长期无活动的任务只能降级为 `unknown`；这是容错状态，不等同于确认失败。
- 当前桌面层是独立透明 Electron 窗口，并非 Codex 原生桌宠的插件或 UI 扩展。
- 尚未制作 Windows 安装包、自动更新和正式应用图标。
- 尚未加入端到端 UI 自动化测试，目前主要依靠模型、采集器、HTTP 与窗口布局单元测试。
- 语音试听已可用，但尚未连接真实任务状态；Bark、ntfy 等远程推送目前只有设置模型和界面。

## 12. 下一步建议

建议按以下顺序推进：

1. **完成路径切换**：用 IDE 打开 `D:\project\CodexActivityCompanion`，停止旧路径启动的伴生进程，再从新目录运行 `npm.cmd run companion`。
2. **确认双端验收流程**：分别在 Codex Desktop 和 PyCharm CC GUI 启动任务，验证创建、运行、完成/失败、保留和手动签收。
3. **接入语音播报**：枚举 Windows 已安装语音，实现试听、防重复与免打扰规则。
4. **接入手机推送**：优先实现 Bark 与 ntfy，密钥使用系统安全存储，并提供测试和失败诊断。
5. **优化任务收件箱视觉**：完善多任务密度、滚动、状态层级、失败/等待输入提示和空状态。
6. **完善桌宠聚合状态**：基于任务优先级计算 `needs_input > failed > terminal_attention > running > idle`，但保持任务状态与桌宠状态分离。
7. **打包发布**：补充应用图标、产品名和 Electron Builder/Forge 配置，生成 Windows 安装包。
8. **扩展适配器**：将不同客户端的采集逻辑隔离为 adapter，再接入其他 AI 编程工具。

## 13. 迁移注意事项

旧项目目录目前仍保留在：

```text
C:\Users\wwwY\Documents\Codex\2026-07-31\x-z
```

保留原因是创建本文档时，当前 Codex 会话和已启动的伴生程序仍可能引用旧路径。确认新目录能够启动后，可以停止旧进程并删除旧目录。不要同时长期运行新旧两个内嵌采集器；虽然服务通常会复用 43123 端口，但会增加排查来源和运行版本的难度。

## 14. 快速接手检查清单

- [ ] IDE 已打开 `D:\project\CodexActivityCompanion`。
- [ ] `npm.cmd install` 成功。
- [ ] `npm.cmd test` 显示 26 项通过。
- [ ] `npm.cmd run companion` 能显示置顶徽标。
- [ ] 点击徽标能打开任务列表。
- [ ] 任务面板齿轮和托盘菜单都能打开设置窗口，修改后重启仍能恢复。
- [ ] 徽标拖动时脸部、拖动条和任务面板保持同步。
- [ ] Codex Desktop 新任务能进入列表并实时更新。
- [ ] PyCharm CC GUI 新任务能进入列表并实时更新。
- [ ] 终态任务保留，点击“✓”后移除。
- [ ] 新路径验证完成后清理旧项目目录。
