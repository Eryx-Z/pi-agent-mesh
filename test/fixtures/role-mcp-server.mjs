// Deterministic MCP peer for role integration tests. No SDK or external services.
// argv[2] is RoleMcpPeerOptions (see role-mcp-peer.ts). Never log request values,
// environment values, credentials, or caller-supplied cancellation reasons.
import { appendFileSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const options = JSON.parse(process.argv[2] ?? "{}");
const log = (event, extra = {}) => {
  if (options.log) appendFileSync(options.log, JSON.stringify({ event, pid: process.pid, id: options.id, ...extra }) + "\n");
};
const defaultTools = ["echo", "mixed", "result_error", "protocol_error", "slow", "hang", "progress", "change_list", "unselected"];
const defaultSchema = { type: "object", properties: { mode: { type: "string" }, delayMs: { type: "number" }, value: {} }, additionalProperties: true };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const cancelled = Symbol("cancelled");
const active = new Map();
const sessions = new Map();
const sockets = new Set();
const responses = new Set();
let nextSession = 0;
let expiredOnce = false;
let stopped = false;
let initialized = false;
const listedSessions = new Set();
let fileBehavior = {};
let controlBehavior = {};
let server;

function readBehavior() {
  if (options.behaviorFile) {
    try { fileBehavior = JSON.parse(readFileSync(options.behaviorFile, "utf8")); }
    catch (error) { log("behavior-read-error", { code: error.code ?? "INVALID_JSON" }); }
  }
  return { ...options, ...fileBehavior, ...controlBehavior };
}
function inventory() {
  const behavior = readBehavior();
  return (behavior.tools ?? defaultTools).map(tool => {
    const definition = typeof tool === "string" ? { name: tool } : tool;
    return {
      description: `raw:${definition.name}`,
      inputSchema: behavior.schema ?? defaultSchema,
      annotations: behavior.annotations ?? { readOnlyHint: true },
      ...definition,
    };
  });
}
let lastInventory = JSON.stringify(inventory());
function sendStdio(message) { if (!stopped) process.stdout.write(JSON.stringify(message) + "\n"); }
function sse(res, message) {
  if (!res.destroyed && !res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}
function listChanged(extraSend) {
  const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
  log("notifications/tools/list_changed");
  if (!options.http) { if (initialized) sendStdio(notification); }
  else {
    for (const session of sessions.values()) for (const channel of session.channels) sse(channel, notification);
    extraSend?.(notification);
  }
}
function observeInventory(extraSend) {
  const current = JSON.stringify(inventory());
  if (current !== lastInventory) { lastInventory = current; listChanged(extraSend); }
}
if (options.behaviorFile) {
  // watchFile observes atomic replacement as well as in-place writes. Its timer
  // is unref'd (persistent:false), so the observer cannot keep a dead peer alive.
  watchFile(options.behaviorFile, { interval: 25, persistent: false }, () => observeInventory());
}
const token = options.tokenEnv ? process.env[options.tokenEnv] : undefined;
const tokenPresent = Boolean(token);
const expectedToken = readBehavior().expectedToken;
const tokenMatches = expectedToken === undefined ? tokenPresent : token === expectedToken;
log("start", { cwd: process.cwd(), tokenPresent, tokenMatches });

function pending(key, request, session) {
  let resolveCancel;
  const state = { key, requestId: request.id, session, cancelled: false, onCancel: new Promise(resolve => { resolveCancel = resolve; }) };
  state.cancel = () => { if (!state.cancelled) { state.cancelled = true; resolveCancel(cancelled); } };
  active.set(key, state);
  return state;
}
async function wait(ms, state) {
  let timer;
  try { return await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, ms)); }), state.onCancel]); }
  finally { clearTimeout(timer); }
}
function echo(request) {
  const args = request.params?.arguments ?? {};
  return {
    content: [{ type: "text", text: args.value === undefined ? `${options.id}:${request.params.name}` : typeof args.value === "string" ? args.value : JSON.stringify(args.value) }],
    structuredContent: { server: options.id, rawName: request.params.name, ...(args.value === undefined ? {} : { value: args.value }) },
  };
}
async function result(request, state, send) {
  const args = request.params?.arguments ?? {};
  if (request.method === "initialize") {
    if (options.tokenEnv && !tokenMatches) throw { code: -32002, message: "Fixture credential mismatch" };
    if (await wait(readBehavior().initDelayMs ?? 0, state) === cancelled) return cancelled;
    return { protocolVersion: request.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: "role-mcp-fixture", version: "1" } };
  }
  if (request.method === "tools/list") {
    const delay = listedSessions.has(state.session) ? 0 : readBehavior().delayMs ?? 0;
    listedSessions.add(state.session);
    if (await wait(delay, state) === cancelled) return cancelled;
    observeInventory();
    return { tools: inventory() };
  }
  if (request.method === "ping") return {};
  if (request.method === "resources/list") return { resources: [{ uri: "fixture://secret", name: "not-authorized", mimeType: "text/plain" }] };
  if (request.method === "resources/templates/list") return { resourceTemplates: [{ uriTemplate: "fixture://secret/{name}", name: "not-authorized-template" }] };
  if (request.method === "resources/read") return { contents: [{ uri: request.params?.uri, mimeType: "text/plain", text: "fixture resource must not be automatically authorized" }] };
  if (request.method !== "tools/call") throw { code: -32601, message: "Method not found" };
  const name = request.params?.name;
  if (!inventory().some(tool => tool.name === name)) throw { code: -32602, message: "Unknown fixture tool" };
  const mode = args.mode ?? name;
  log("call-start", { name, requestId: request.id, mode: ["mixed", "result_error", "protocol_error", "slow", "hang", "progress", "change_list"].includes(mode) ? mode : "echo" });
  if (mode === "protocol_error") throw { code: -32001, message: "Fixture protocol error" };
  if (mode === "hang") return state.onCancel;
  if (mode === "slow" || (args.delayMs > 0 && mode !== "progress")) {
    if (await wait(args.delayMs ?? 5000, state) === cancelled) return cancelled;
  }
  if (mode === "progress") {
    const progressToken = request.params?._meta?.progressToken;
    let progress = 0;
    const deadline = args.delayMs > 0 ? Date.now() + args.delayMs : Infinity;
    while (!state.cancelled && !readBehavior().stopProgress && Date.now() < deadline) {
      if (progressToken !== undefined) {
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++progress, message: "Fixture progress" } });
        log("progress", { requestId: request.id, progress });
      }
      if (await wait(Math.max(5, args.progressIntervalMs ?? 25), state) === cancelled) return cancelled;
    }
    if (state.cancelled) return cancelled;
  }
  if (mode === "change_list") {
    for (const key of ["tools", "schema", "annotations", "stopProgress"]) if (args[key] !== undefined) controlBehavior[key] = args[key];
    observeInventory(send);
  }
  const response = echo(request);
  if (mode === "mixed") response.content = [{ type: "text", text: `first:${options.id}:${name}` }, { type: "text", text: `second:${options.id}:${name}` }, { type: "image", mimeType: "image/png", data: png }];
  if (mode === "result_error") { response.isError = true; response.content = [{ type: "text", text: "Fixture result error" }]; }
  return response;
}
async function dispatch(request, session, send) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  log(request.method, { ...(request.params?.name === undefined ? {} : { name: request.params.name }), ...(request.id === undefined ? {} : { requestId: request.id }) });
  if (request.method === "notifications/initialized") { initialized = true; return; }
  if (request.method === "notifications/cancelled") {
    const state = active.get(`${session}:${JSON.stringify(request.params?.requestId)}`);
    if (state) { state.cancel(); log("call-cancelled", { requestId: state.requestId }); }
    return;
  }
  if (request.id === undefined) return;
  const key = `${session}:${JSON.stringify(request.id)}`;
  const state = pending(key, request, session);
  try {
    const value = await result(request, state, send);
    if (value === cancelled) return { jsonrpc: "2.0", id: request.id, error: { code: -32800, message: "Fixture request cancelled" } };
    return { jsonrpc: "2.0", id: request.id, result: value };
  } catch (error) {
    return { jsonrpc: "2.0", id: request.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: Number.isInteger(error.code) ? error.message : "Fixture internal error" } };
  } finally {
    active.delete(key);
    if (request.method === "tools/call") log("call-end", { name: request.params?.name, requestId: request.id, cancelled: state.cancelled });
  }
}
function shutdown(reason) {
  if (stopped) return;
  stopped = true;
  log("stop", { reason });
  if (options.behaviorFile) unwatchFile(options.behaviorFile);
  for (const state of active.values()) state.cancel();
  for (const response of responses) response.end();
  server?.close();
  server?.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (options.http) {
  server = createServer(async (req, res) => {
    responses.add(res);
    res.on("close", () => responses.delete(res));
    const headerName = (options.header ?? "authorization").toLowerCase();
    const headerValue = req.headers[headerName];
    const headerPresent = headerValue !== undefined;
    const headerMatches = options.secretExpected === undefined ? headerPresent : headerValue === options.secretExpected;
    log("http-request", { method: req.method, headerPresent, headerMatches });
    if (options.secretExpected !== undefined && !headerMatches) { res.writeHead(401).end(); return; }
    let sessionId = req.headers["mcp-session-id"];
    if (req.method === "DELETE") {
      log("http-close", { knownSession: sessions.has(sessionId) });
      const session = sessions.get(sessionId);
      if (session) for (const channel of session.channels) channel.end();
      for (const state of active.values()) if (state.session === sessionId) state.cancel();
      sessions.delete(sessionId);
      listedSessions.delete(sessionId);
      res.writeHead(200).end();
      return; // The remote server deliberately outlives a client's session.
    }
    if (req.method === "GET") {
      const session = sessions.get(sessionId);
      if (!session) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      res.write(": role fixture notification channel\n\n");
      session.channels.add(res);
      res.on("close", () => session.channels.delete(res));
      log("http-stream-open");
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      let request;
      try { request = JSON.parse(body); }
      catch { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); return; }
      const behavior = readBehavior();
      if (request.method === "tools/call" && behavior.expireNextCall && !expiredOnce) {
        expiredOnce = true; controlBehavior.schema = behavior.expireSchema ?? { type: "object", properties: { drift: { type: "string" } } };
        log("http-expire"); res.writeHead(404).end("Fixture session expired"); return;
      }
      if (request.method === "tools/call" && behavior.callHttpStatus) {
        log("http-call-error", { status: behavior.callHttpStatus });
        res.writeHead(behavior.callHttpStatus).end(behavior.callHttpBody ?? "Fixture HTTP failure"); return;
      }
      if (request.method === "initialize") { sessionId = `role-fixture-${++nextSession}`; sessions.set(sessionId, { channels: new Set() }); }
      sessionId ??= "stateless";
      const mode = request.params?.arguments?.mode ?? request.params?.name;
      const streaming = request.method === "tools/call" && ["progress", "change_list"].includes(mode);
      const headers = { "content-type": streaming ? "text/event-stream" : "application/json", "mcp-session-id": sessionId };
      if (streaming) { res.writeHead(200, { ...headers, "cache-control": "no-cache" }); res.flushHeaders(); }
      const requestKey = `${sessionId}:${JSON.stringify(request.id)}`;
      res.on("close", () => {
        const state = active.get(requestKey);
        if (state) { state.cancel(); log("transport-close", { requestId: request.id }); }
      });
      const response = await dispatch(request, sessionId, message => sse(res, message));
      if (res.destroyed || res.writableEnded) return;
      if (!response) { res.writeHead(202).end(); return; }
      if (streaming) { sse(res, response); res.end(); }
      else res.writeHead(200, headers).end(JSON.stringify(response));
    } catch { if (!res.destroyed && !res.writableEnded) res.writeHead(500).end(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1", () => {
    log("ready");
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp` }) + "\n");
  });
  process.stdin.resume();
  process.stdin.on("end", () => shutdown("stdin-end"));
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    let request;
    try { request = JSON.parse(line); }
    catch { sendStdio({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    void dispatch(request, "stdio", sendStdio).then(response => { if (response) sendStdio(response); });
  });
  lines.on("close", () => shutdown("stdin-end"));
  log("ready");
}
