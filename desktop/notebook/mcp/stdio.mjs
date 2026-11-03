import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { notebookTools } from "./notebook-tools.mjs";

export async function callNotebookBridge(connectionFile, name, args) {
  // Re-read on every call: the running app can restart without reconfiguring the AI client.
  let connection;
  try { connection = JSON.parse(await readFile(connectionFile, "utf8")); }
  catch { throw new Error("请先启动 Agent Pet，再重试记事板工具。"); }
  if (connection.version !== 1 || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
    || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error("记事板连接配置无效，请重新启动 Agent Pet。");
  let response;
  try { response = await fetch(`http://127.0.0.1:${connection.port}/tools/call`, { method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error("无法连接 Agent Pet。请确认应用正在运行；新增操作重试时复用 requestId。"); }
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || "记事板操作失败。");
  return body.result;
}

export function createNotebookMcpServer({ connectionFile, version = "0.9.0" }) {
  const server = new McpServer({ name: "agent-pet-notebook", version }, { instructions:
    "Agent Pet 本机记事板。用户要求记录时，可添加计划或灵感；写入时间由软件生成，截止时间可选。保留用户原话，AI 不擅自设置期限或重要性。修改前先查询 revision，版本冲突时不得盲目重试覆盖。返回 saved:true 才表示保存成功。不会自动完成、归档或删除内容。" });
  for (const tool of notebookTools) server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema,
    annotations: { readOnlyHint: Boolean(tool.readOnly), destructiveHint: tool.name.startsWith("notebook_update"),
      idempotentHint: Boolean(tool.readOnly) || tool.name.startsWith("notebook_add"), openWorldHint: false } }, async args => {
    try {
      const result = await callNotebookBridge(connectionFile, tool.name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error.message }] }; }
  });
  return server;
}

// This entry runs in Node (or Electron's Node mode), never starts a second desktop app.
if (process.argv.includes("--connection")) {
  const index = process.argv.indexOf("--connection"), connectionFile = process.argv[index + 1];
  if (!connectionFile) { process.stderr.write("Missing --connection path\n"); process.exitCode = 1; }
  else {
    const { version } = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
    const server = createNotebookMcpServer({ connectionFile, version });
    await server.connect(new StdioServerTransport());
  }
}
