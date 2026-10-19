// Minimal real JSON-RPC MCP peer. No SDK, model network, or production adapter code.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createServer } from "node:http";

const options = JSON.parse(process.argv[2]);
const log = (event, extra = {}) => appendFileSync(options.log, JSON.stringify({ event, pid: process.pid, id: options.id, ...extra }) + "\n");
const tools = options.tools ?? ["echo", "a-b", "a_b", "long_" + "x".repeat(90), "unselected"];
log("start");
async function reply(request) {
  log(request.method, { name: request.params?.name });
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "m0-fixture", version: "1" } };
  else if (request.method === "tools/list") {
    await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 0));
    result = { tools: tools.map(name => ({ name, description: `raw:${name}`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })) };
  } else if (request.method === "tools/call") result = { content: [{ type: "text", text: `${options.id}:${request.params.name}` }], structuredContent: { server: options.id, rawName: request.params.name } };
  else if (request.method === "resources/list") result = { resources: [{ uri: "fixture://secret", name: "not-authorized" }] };
  else if (request.method === "resources/templates/list") result = { resourceTemplates: [] };
  else if (request.method === "ping") result = {};
  else return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
  return { jsonrpc: "2.0", id: request.id, result };
}
if (options.http) {
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { log("http-close"); res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const response = await reply(JSON.parse(body));
    if (!response) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "m0-fixture-session" });
    res.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp` }) + "\n"));
  process.on("SIGTERM", () => { log("stop"); server.closeAllConnections(); server.close(() => process.exit(0)); });
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => { void reply(JSON.parse(line)).then(response => { if (response) process.stdout.write(JSON.stringify(response) + "\n"); }); });
  lines.on("close", () => { log("stop"); process.exit(0); });
  process.on("SIGTERM", () => { log("stop"); process.exit(0); });
}
