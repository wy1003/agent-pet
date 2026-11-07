# 用 AI 填写记事板

记事板同时支持手动填写和 AI 工具写入。AI 负责整理内容，Agent Pet 负责校验、保存和刷新窗口。此功能不需要数据库，也不自动调用收费模型；使用的是你所连接 AI 应用的模型。应用内的一键 AI 补充和微信自动收集暂未接入。

## 连接

1. 启动 Agent Pet，打开「设置 → 记事板 → AI 写入」。
2. 使用 Codex：点击「一键连接 Codex」，自动填写配置。按提示在 Codex 的 MCP 列表中重启连接，或重启 Codex。
3. 使用 Claude Code（CLI / VS Code）：点击「一键连接 Claude Code」，与 Codex 一样直接配置，并在页面内显示结果，不额外弹窗。完成后新开会话或重载扩展，让客户端加载工具。
4. 使用其他 AI 应用：点击「其他 AI：复制配置」。在支持本地 STDIO MCP 的应用中添加该配置；支持 JSON 导入的客户端使用 `mcpServers` 内容，分字段填写时分别填写 `command`、`args`、`env`，每个参数一个条目。
5. 两种一键连接可以同时配置，共用同一份记事板，无需选择唯一来源。使用时保持 Agent Pet 运行；记事板窗口可以隐藏。配置完成表示配置已就绪，客户端发现工具后才表示可以使用。

配置绑定当前应用的安装位置和用户资料目录，不包含访问密钥。应用正常重启会自动更新内部连接信息，无需重配；移动开发目录或更换安装位置后，重新点击连接或复制配置。

### Codex

「一键连接 Codex」仅在点击时通过本机 Codex App Server 修改 `agent-pet-notebook` 的启动配置，保留其他 MCP、模型及已有工具权限。重复点击不会重复添加。修改前备份原配置到 Agent Pet 用户资料目录中的 `mcp-config-backups`；备份失败或检测到并发修改时停止写入。同名连接指向其他服务时不会覆盖。

也可手动通过 `codex mcp add` 或 `[mcp_servers.<名称>]` 配置 `command`、`args`、`env`。参见 [OpenAI 官方 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=desktop)。

例如在 `~/.codex/config.toml` 增加以下内容，三个路径必须使用 Agent Pet 复制出来的实际值：

```toml
[mcp_servers.agent-pet-notebook]
command = 'D:\应用位置\Agent Pet.exe'
args = ['D:\应用位置\resources\app.asar\desktop\notebook\mcp\stdio.mjs', '--connection', 'C:\Users\你的用户名\AppData\Roaming\Agent Pet\notebook-mcp-connection.json']

[mcp_servers.agent-pet-notebook.env]
ELECTRON_RUN_AS_NODE = '1'
```

开发版的 `command` 是项目内 Electron 可执行文件，入口直接位于项目的 `desktop/notebook/mcp/stdio.mjs`。查看设置和复制配置都不会修改 AI 客户端配置；只有点击对应的一键连接才写入配置，其他 AI 应用仍需自行添加。

### Claude Code

「一键连接 Claude Code」只配置记事板 MCP，不安装 Hook、状态栏或改变登录、模型与权限。它与 Codex 连接独立，保留 Claude 中其他 MCP 配置；修改前备份，重复连接不重复注册，遇到同名无关服务、用户改写或并发修改时不覆盖。

Claude 与 Codex 中的服务名称统一为 `agent-pet-notebook`。Claude 的完整接入和独立记事板连接共用这一项；显式建立独立记事板连接后，移除完整接入不会误删它。旧版受管的 `agent-pet` 在点击连接或安装完整接入时迁移，查看状态不迁移。迁移前核对安装记录和实际配置；遇到用户改写、目标名称被占用或归属不一致时停止，不覆盖或删除无法确认归属的服务。

两个按钮使用一致的配置流程：显示“正在配置…”，完成后在页面内区分“配置已完成”和“无需重复添加”，按钮变为“检查连接配置”。再次点击不会额外弹窗。智能体设置中的完整 Hook/MCP 增强安装与移除仍保留原有确认。

默认写入用户主目录的 `.claude.json`；使用 `CLAUDE_CONFIG_DIR` 时沿用对应配置根下的 `.claude.json`。无需手动填写路径。如果本应用原先管理的记事板 MCP 被删除、但有效归属记录仍在，再次点击连接会安全重建 `agent-pet-notebook` 并更新程序路径；仅查看状态不会写入。未知同名项、用户改写或归属记录不一致仍显示冲突，不会覆盖。连接成功后请新开 Claude Code 会话或重载 VS Code 扩展，配置状态不是实时在线状态。本入口不配置 Claude 网页版或 Claude Desktop。

## 可以这样说

- “把刚才的方案整理成计划，写到 Agent Pet 记事板，不设截止日期。”
- “记一个灵感：通过微信随手记东西。保留这句原话，补充两三条下一步建议。”
- “先查一下记事板里关于微信的计划，把收集范围补充进去。”

AI 必须收到成功结果后才表示已保存。失败、版本冲突或磁盘问题会作为工具错误返回，不会假报成功。

## 工具能力

| 工具 | 参数与行为 |
| --- | --- |
| `notebook_list` | 按 `kind`（plan/idea/all）、`scope`（active/archived/all）、`query` 查询摘要；支持 offset 和 limit 分页，最多 100 条。 |
| `notebook_get` | 按 kind 和 id 获取全文、revision、原话和历史。 |
| `notebook_add_plan` | requestId、title 必填；detail、deadline、deadlineTime、important、originalText 可选。 |
| `notebook_add_idea` | requestId、originalText 和 content 必填；content 首行是标题，其余为整理内容。 |
| `notebook_update_plan` | id、revision、changes 必填；只修改明确提供的字段，不能修改归档计划。 |
| `notebook_update_idea` | id、revision、content 必填；原话不可覆盖。 |

`requestId` 是新增操作的唯一编号，建议使用 UUID。同一操作重试复用原编号，避免重复记录；相同编号用于不同内容会被拒绝。日期使用本机日期 `YYYY-MM-DD`，时间使用 `HH:mm`，不填表示不设置；写入时间自动生成。未明确要求时，AI 应保留空截止日期和非重要状态。

## 手动编辑与历史

- 「＋」和计划页内编辑保持可用；灵感卡片新增编辑入口，AI 内容也可手动修改。
- 原话独立保存，AI 补充和手动修改都有修改前后快照与操作时间。旧文件可直接读取，旧版本未记录的历史无法补回。
- 窗口接到外部保存通知后刷新列表和详情，已打开的计划草稿与灵感编辑框不会被刷新覆盖。
- 保存时校验 revision。其他来源已经修改同一记录时，保留草稿并提示冲突；复制需要保留的内容，取消编辑、读取最新内容后再合并保存。
- AI 只开放查询、新增和修改，不开放完成、归档和永久删除。计划完成快照和归档流程继续由现有功能管理。

## 本地连接与排错

MCP 入口使用官方 TypeScript SDK 的 STDIO 传输。它通过带随机密钥的本机回环连接调用正在运行的 Agent Pet，不直接打开记事存档；主进程始终是唯一写入者。桥接服务拒绝浏览器 Origin 和未授权请求，连接文件放在用户资料目录；画面和其他应用数据不在这些工具能力范围内。

- **提示先启动应用**：启动 Agent Pet，再重试工具。新增重试保持相同 requestId。
- **找不到工具**：检查客户端是否支持本机 STDIO，并确认 command、args、env 已分别配置；按客户端说明重新加载。
- **原应用关闭后调用失败**：正常行为。MCP 入口不会偷偷启动另一个写入者。
- **版本冲突**：先读取最新记录并合并，不要只替换 revision 强行重试。
- **配置失效**：应用移动位置后重新复制配置。不要手动编辑连接文件或把它提交到仓库。

源码验证覆盖真实 SDK 客户端 → STDIO 子进程 → 本机桥接 → 存档。安装包中的运行程序和具体第三方 AI 客户端仍需分别验收。
