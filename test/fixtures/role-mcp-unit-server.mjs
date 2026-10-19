// Adapter unit peer: real JSON-RPC only, intentionally independent of the native client.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const options = JSON.parse(process.argv[2]);
const log = (event, fields = {}) => appendFileSync(options.log, JSON.stringify({ event, pid: process.pid, ...fields }) + "\n");
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const tool = (name, parameters = { type: "object", properties: {} }) => ({ name, description: `tool:${name}`, inputSchema: parameters, annotations: { readOnlyHint: true } });
let rejectRefresh = false;
let malformedRefresh;
let tools = (options.tools ?? ["echo", "a-b", "a_b", "unselected"]).map(n => tool(n, options.schema));
log("start", { cwd: process.cwd(), args: process.argv.slice(3), credential: process.env.ROLE_MCP_UNIT_TOKEN });
const timers = new Map();
const lines = createInterface({ input: process.stdin });
lines.on("line", async line => {
  const request = JSON.parse(line);
  log(request.method, { name: request.params?.name });
  const result = value => send({ id: request.id, result: value });
  if (request.method === "notifications/cancelled") {
    clearInterval(timers.get(request.params.requestId)); timers.delete(request.params.requestId); return;
  }
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    if (options.initDelay) await new Promise(resolve => setTimeout(resolve, options.initDelay));
    result({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "unit", version: "1" } });
  } else if (request.method === "tools/list") {
    if (malformedRefresh) { result(malformedRefresh === "cursor" ? { tools, nextCursor: 0 } : malformedRefresh === "entry" ? { tools: [...tools, { name: "unselected_bad", inputSchema: [] }] } : { tools, nextCursor: "repeat" }); return; }
    if (rejectRefresh) { send({ id: request.id, error: { code: -32001, message: "Refresh unavailable" } }); return; }
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    result({ tools });
  } else if (request.method === "resources/list") result({ resources: [{ uri: "secret://resource", name: "not-authorized" }] });
  else if (request.method === "resources/templates/list") result({ resourceTemplates: [] });
  else if (request.method === "tools/call") {
    const mode = request.params.arguments.mode;
    if (["add", "remove", "schema", "refresh_error", "malformed_cursor", "malformed_entry", "repeated_cursor", "unchanged", "reorder"].includes(mode)) {
      if (mode === "malformed_cursor") malformedRefresh = "cursor";
      if (mode === "malformed_entry") malformedRefresh = "entry";
      if (mode === "repeated_cursor") malformedRefresh = "repeat";
      if (mode === "refresh_error") { rejectRefresh = true; tools = tools.map(t => tool(t.name, { type: "object", properties: { changed: { type: "boolean" } } })); }
      if (mode === "reorder") tools.reverse();
      if (mode === "add") tools.push(tool("late"));
      if (mode === "remove") tools = tools.filter(t => t.name !== "echo");
      if (mode === "schema") tools = tools.map(t => t.name === "echo" ? tool("echo", { type: "object", properties: { changed: { type: "string" } } }) : t);
      result({ content: [{ type: "text", text: "changed" }] });
      send({ method: "notifications/tools/list_changed" });
    } else if (mode === "protocol") send({ id: request.id, error: { code: -32001, message: "Protocol failure", data: { detail: 1 } } });
    else if (mode === "wait" || mode === "progress") {
      if (mode === "progress") timers.set(request.id, setInterval(() => send({ method: "notifications/progress", params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2, message: "working" } }), 15));
    } else result({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], structuredContent: { credential: process.env.ROLE_MCP_UNIT_TOKEN, cwd: process.cwd(), args: process.argv.slice(3), rawName: request.params.name }, ...(mode === "error" ? { isError: true } : {}) });
  } else result({});
});
lines.on("close", () => { log("stop"); process.exit(0); });
process.on("SIGTERM", () => { log("stop"); process.exit(0); });
