import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { setupRoleMcp } from "../pi-extension/subagents/role-mcp.ts";
import { ROLE_CHILD_EXTENSION, type RolePlan } from "../pi-extension/subagents/role-loadout.ts";

const tool = (name = "echo", changed = false) => ({ name, description: name,
  inputSchema: { type: "object", properties: changed ? { changed: { type: "boolean" } } : {} } });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("MCP refresh peer barrier timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Local, manually released HTTP responses exercise Pi's real concurrent refresh/listAll path. */
async function fixture(selected = ["echo"], timeout = 2) {
  let stream: ServerResponse | undefined;
  let registrations = 0, calls = 0, holdCall = false, nextBarrier = 0, autoListThrough = 0;
  const lists: { message: any; response: ServerResponse }[] = [];
  const heldCalls: ServerResponse[] = [];
  const barriers = new Set<string>();
  const cancelled: unknown[] = [];
  const remote = createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); stream = res; return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    const reply = (result: unknown) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "local-refresh" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
    if (message.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "local-refresh", version: "1" } });
    else if (message.method === "tools/list") {
      lists.push({ message, response: res });
      if (lists.length === 1) reply({ tools: selected.map(name => tool(name)) });
      else if (lists.length <= autoListThrough) reply({ tools: [], nextCursor: `auto-${lists.length}` });
    } else if (message.method === "tools/call") {
      calls++;
      if (holdCall) { holdCall = false; heldCalls.push(res); }
      else reply({ content: [{ type: "text", text: "authorized" }] });
    } else {
      if (message.method === "notifications/cancelled") cancelled.push(message.params);
      if (!message.method && typeof message.id === "string") barriers.add(message.id);
      res.writeHead(202).end();
    }
  });
  remote.listen(0, "127.0.0.1"); await once(remote, "listening");
  const port = (remote.address() as { port: number }).port;
  const plan = { version: 1, schemaVersion: 1, roleId: "refresh-worker", manifestPath: "/tmp/role.yaml", manifestHash: "manifest",
    systemPrompt: "test", systemPromptHash: "prompt", promptVersion: 1, skills: [], builtinTools: [], extraTools: [],
    mcp: [{ server: "selected", config: { url: `http://127.0.0.1:${port}/mcp`, timeout }, tools: selected }],
    model: "unused/test", thinking: "off", context: "none", access: "full", cwd: "/tmp", agentDir: "/tmp" } as RolePlan;
  const handlers = new Map<string, Function[]>(), definitions = new Map<string, any>();
  const ctx = { cwd: "/tmp", mode: "rpc", hasUI: false, ui: { notify() {} } } as unknown as ExtensionCommandContext;
  const pi = {
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
    registerCommand() {}, registerToolRenderer() {}, getMcpServers: () => [],
    registerTool(definition: any) { registrations++; definitions.set(definition.name, definition); },
    getAllTools: () => [...definitions.values()].map(definition => ({ ...definition, sourceInfo: { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary", origin: "top-level" } })),
    getActiveTools: () => [], setActiveTools() {},
  } as unknown as ExtensionAPI;
  // Capture the real adapter-wrapped transport for defensive token/reuse probes only.
  // Tests in this file run serially; restore the prototype before any test assertion.
  const transports: StreamableHttpTransport[] = [], start = StreamableHttpTransport.prototype.start;
  StreamableHttpTransport.prototype.start = async function () { transports.push(this); await start.call(this); };
  let adapter: Awaited<ReturnType<typeof setupRoleMcp>> | undefined;
  try {
    adapter = await setupRoleMcp(pi, plan, "full");
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    await adapter.ready(ctx, Date.now() + 3000);
    await until(() => !!stream);
  } catch (error) {
    await adapter?.close(); stream?.end(); remote.closeAllConnections();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    throw error;
  } finally { StreamableHttpTransport.prototype.start = start; }
  const readyAdapter = adapter;
  const notify = (count = 2) => { for (let i = 0; i < count; i++) stream!.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`); };
  const respond = (index: number, result: unknown, error = false) => {
    const { response, message } = lists[index];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, [error ? "error" : "result"]: result }));
  };
  // An MCP ping in the same response stream is a deterministic receive barrier, even
  // for rejected/cancelled lists that never register a tool or send a continuation.
  const respondObserved = async (index: number, result: unknown, error = false) => {
    const { response, message } = lists[index], id = `observed-${++nextBarrier}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, [error ? "error" : "result"]: result })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n\n`);
    await until(() => barriers.has(id)); await turn(); await turn();
  };
  const settle = async (count: number) => { await until(() => registrations >= count); await turn(); await turn(); };
  const call = async () => definitions.get(readyAdapter.sources()[0].tools[0].name).execute("call", {}, undefined, undefined, {});
  return { adapter: readyAdapter, transport: transports[0], lists, notify, respond, respondObserved, settle, call, cancelled, calls: () => calls,
    heldCalls, holdNextCall() { holdCall = true; }, autoPaginate(pages: number) { autoListThrough = lists.length + pages; },
    async close() { await readyAdapter.close(); stream?.end(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); } };
}

test("identical concurrent single-page refreshes keep the verified capability", async () => {
  const f = await fixture();
  try {
    const original = f.adapter.sources();
    f.notify(); await until(() => f.lists.length === 3);
    assert.throws(() => f.adapter.verify(), /not ready/);
    f.respond(1, { tools: [tool()] }); await f.settle(2);
    assert.throws(() => f.adapter.verify(), /not ready/);
    f.respond(2, { tools: [tool()] }); await f.settle(3);
    f.adapter.verify(); assert.deepEqual(f.adapter.sources(), original);
    assert.equal((await f.call()).content[0].text, "authorized"); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test("interleaved refreshes with identical remote cursors keep independent inventories", async () => {
  const f = await fixture(["echo", "other"]);
  try {
    const original = f.adapter.sources();
    f.notify(); await until(() => f.lists.length === 3);
    // B's first page precedes A's; A's last page precedes B's. Both use the same cursor.
    f.respond(2, { tools: [tool("other")], nextCursor: "shared-remote-cursor" });
    await until(() => f.lists.length === 4);
    f.respond(1, { tools: [tool()], nextCursor: "shared-remote-cursor" });
    await until(() => f.lists.length === 5);
    assert.equal(f.lists[3].message.params.cursor, "shared-remote-cursor");
    assert.equal(f.lists[4].message.params.cursor, "shared-remote-cursor");
    f.respond(4, { tools: [tool("other")], nextCursor: null }); await f.settle(4);
    assert.throws(() => f.adapter.verify(), /not ready/);
    f.respond(3, { tools: [tool()], nextCursor: "" }); await f.settle(6);
    f.adapter.verify(); assert.deepEqual(f.adapter.sources(), original); await f.call();
  } finally { await f.close(); }
});

for (const bad of ["duplicate", "schema", "missing"] as const) for (const badRequest of [1, 2]) for (const badFirst of [false, true]) {
  test(`concurrent ${badRequest === 1 ? "older" : "newer"} ${bad} refresh remains rejected when bad response is ${badFirst ? "first" : "last"}`, async () => {
    const f = await fixture();
    try {
      f.notify(); await until(() => f.lists.length === 3);
      const tools = bad === "duplicate" ? [tool(), tool()] : bad === "schema" ? [tool("echo", true)] : [];
      await f.respondObserved(badFirst ? badRequest : 3 - badRequest, { tools: badFirst ? tools : [tool()] });
      await f.respondObserved(badFirst ? 3 - badRequest : badRequest, { tools: badFirst ? [tool()] : tools });
      assert.throws(() => f.adapter.verify(), /changed|duplicate|missing|not ready/);
      await assert.rejects(f.call()); assert.equal(f.calls(), 0);
    } finally { await f.close(); }
  });
}

for (const bad of ["error", "malformed", "repeated-cursor", "timeout"] as const) test(`concurrent ${bad} cannot be rescued by a valid sibling or late response`, async () => {
  const f = await fixture(["echo"], bad === "timeout" ? 0.15 : 2);
  try {
    f.notify(); await until(() => f.lists.length === 3);
    if (bad === "error") await f.respondObserved(1, { code: -32603, message: "synthetic list failure" }, true);
    if (bad === "malformed") await f.respondObserved(1, { tools: [tool(), { name: "unselected", inputSchema: [] }] });
    if (bad === "repeated-cursor") {
      f.respond(1, { tools: [], nextCursor: "loop" }); await until(() => f.lists.length === 4);
      assert.equal(f.lists[3].message.params.cursor, "loop");
      await f.respondObserved(3, { tools: [tool()], nextCursor: "loop" });
    }
    if (bad === "timeout") await until(() => f.cancelled.length >= 2);
    await f.respondObserved(2, { tools: [tool()] });
    if (bad === "timeout") await f.respondObserved(1, { tools: [tool()] });
    else await f.settle(2);
    await turn(); await turn();
    assert.throws(() => f.adapter.verify(), /not ready|inventory|refresh/);
    await assert.rejects(f.call()); assert.equal(f.calls(), 0);
    assert.equal(f.lists.length, bad === "repeated-cursor" ? 4 : 3, "No unexpected continuation request");
  } finally { await f.close(); }
});

test("unknown pagination tokens are rejected locally, never treated as a new first page", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: "unknown-token-probe", method: "tools/list", params: { cursor: "not-an-issued-token" } }), /token unavailable/);
    assert.throws(() => f.adapter.verify(), /not ready/);
    assert.equal(f.lists.length, 1); await assert.rejects(f.call()); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

for (const cancelled of [false, true]) test(`${cancelled ? "cancelled" : "consumed"} pagination tokens cannot be reused or rescued by a late page`, async () => {
  const f = await fixture(["echo"], cancelled ? 0.15 : 2);
  try {
    f.notify(1); await until(() => f.lists.length === 2);
    f.respond(1, { tools: [], nextCursor: "original-remote-cursor" });
    await until(() => f.lists.length === 3);
    assert.equal(f.lists[2].message.params.cursor, "original-remote-cursor");
    if (cancelled) await until(() => f.cancelled.length === 1);
    await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: "reused-token-probe", method: "tools/list", params: { cursor: "role-mcp-page:1" } }), /token unavailable/);
    await f.respondObserved(2, { tools: [tool()] });
    assert.throws(() => f.adapter.verify(), /not ready/);
    assert.equal(f.lists.length, 3); await assert.rejects(f.call()); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("closing a pending paginated refresh invalidates its transport and tokens", async () => {
  const f = await fixture();
  try {
    f.notify(1); await until(() => f.lists.length === 2);
    f.respond(1, { tools: [], nextCursor: "pending-page" }); await until(() => f.lists.length === 3);
    await f.adapter.close();
    await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: "closed-token-probe", method: "tools/list", params: { cursor: "role-mcp-page:1" } }), /closed/);
    f.respond(2, { tools: [tool("echo", true)] });
    assert.throws(() => f.adapter.verify(), /closed/); assert.equal(f.lists.length, 3); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("a detached pre-renewal refresh cannot publish a late changed inventory", async () => {
  const f = await fixture();
  try {
    const original = f.adapter.sources();
    f.holdNextCall(); const pendingCall = f.call();
    await until(() => f.heldCalls.length === 1);
    f.notify(1); await until(() => f.lists.length === 2);
    f.respond(1, { tools: [], nextCursor: "old-connection-page" });
    await until(() => f.lists.length === 3);
    f.heldCalls[0].writeHead(404).end("session expired");
    await until(() => f.lists.length === 4);
    assert.throws(() => f.adapter.verify(), /not ready/);
    f.respond(3, { tools: [tool()] }); await f.settle(2);
    assert.equal((await pendingCall).content[0].text, "authorized");
    await f.respondObserved(2, { tools: [tool("echo", true)] });
    f.adapter.verify(); assert.deepEqual(f.adapter.sources(), original);
    await f.call(); assert.equal(f.calls(), 3);
  } finally { await f.close(); }
});

for (const cursor of [0, false, [], {}]) test(`malformed cursor ${JSON.stringify(cursor)} is rejected without continuation`, async () => {
  const f = await fixture();
  try {
    f.notify(1); await until(() => f.lists.length === 2);
    await f.respondObserved(1, { tools: [tool()], nextCursor: cursor });
    assert.throws(() => f.adapter.verify(), /not ready/);
    await assert.rejects(f.call()); assert.equal(f.lists.length, 2); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

for (const ended of [false, true]) test(`native 1,000-page boundary stays ${ended ? "valid when terminated" : "fail-closed when exceeded"}`, async () => {
  const f = await fixture();
  try {
    f.autoPaginate(999); f.notify(1);
    await until(() => f.lists.length === 1001, 10000);
    assert.equal(f.lists[1000].message.params.cursor, "auto-1000");
    await f.respondObserved(1000, { tools: [tool()], ...(ended ? {} : { nextCursor: "beyond-limit" }) });
    if (ended) { f.adapter.verify(); await f.call(); }
    else { assert.throws(() => f.adapter.verify(), /not ready/); await assert.rejects(f.call()); }
    assert.equal(f.lists.length, 1001);
  } finally { await f.close(); }
});

test("duplicate selected definitions across pages are not deduplicated", async () => {
  const f = await fixture();
  try {
    f.notify(1); await until(() => f.lists.length === 2);
    f.respond(1, { tools: [tool()], nextCursor: "next" }); await until(() => f.lists.length === 3);
    f.respond(2, { tools: [tool()] }); await f.settle(2);
    assert.throws(() => f.adapter.verify(), /changed|duplicate|not ready/);
    await assert.rejects(f.call()); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
