import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { startRoleMcpPeer, type RoleMcpPeer } from "./fixtures/role-mcp-peer.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(get: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = get(); if (value !== undefined) return value; await sleep(5); }
  throw new Error("Role MCP fixture selftest timed out");
}
function stdioClient(peer: RoleMcpPeer) {
  const messages: any[] = [];
  const lines = createInterface({ input: peer.process.stdout });
  lines.on("line", line => messages.push(JSON.parse(line)));
  let id = 0;
  const send = (message: object) => peer.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const request = (method: string, params: object = {}) => {
    const requestId = ++id;
    send({ id: requestId, method, params });
    return { id: requestId, response: until(() => messages.find(message => message.id === requestId)) };
  };
  const initialize = async () => {
    const response = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "selftest", version: "1" } }).response;
    send({ method: "notifications/initialized" });
    return response;
  };
  return { messages, send, request, initialize };
}
function assertValidPng(data: string) {
  const png = Buffer.from(data, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let width = 0;
  let height = 0;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString();
    const content = png.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, png.readUInt32BE(offset + 8 + length), `${type} CRC`);
    if (type === "IHDR") { width = content.readUInt32BE(0); height = content.readUInt32BE(4); }
    if (type === "IDAT") compressed.push(content);
    offset += 12 + length;
  }
  assert.equal(width, 1);
  assert.equal(height, 1);
  assert.equal(inflateSync(Buffer.concat(compressed)).length, 5); // filter byte + RGBA pixel
}
function readSse(response: Response) {
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const reader = response.body!.getReader();
  const messages: any[] = [];
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (data) { assert.match(frame, /^event: message\n/); messages.push(JSON.parse(data.slice(6))); }
      }
    }
  })();
  // Attach immediately so teardown-induced connection closures cannot be unhandled.
  void done.catch(() => {});
  return { messages, done, cancel: () => reader.cancel() };
}

test("role MCP fixture stdio preserves rich results, capabilities, credentials, cwd, and errors", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "role-peer-selftest-"));
  const secret = "never-log-stdio-credential";
  const peer = await startRoleMcpPeer({ id: "stdio", cwd: dir, tokenEnv: "ROLE_PEER_SECRET", expectedToken: secret, env: { ROLE_PEER_SECRET: secret } });
  try {
    const client = stdioClient(peer);
    const initialized = await client.initialize();
    assert.equal(initialized.result.capabilities.tools.listChanged, true);
    assert.deepEqual(initialized.result.capabilities.resources, {});
    const list = await client.request("tools/list").response;
    assert.ok(list.result.tools.some((tool: any) => tool.name === "echo"));
    const call = async (name: string, args: object = {}) => (await client.request("tools/call", { name, arguments: args }).response);
    const echo = await call("echo", { value: { nested: [1, true] } });
    assert.deepEqual(echo.result.structuredContent.value, { nested: [1, true] });
    const mixed = await call("mixed");
    assert.deepEqual(mixed.result.content.map((item: any) => item.type), ["text", "text", "image"]);
    assert.equal(mixed.result.structuredContent.rawName, "mixed");
    assertValidPng(mixed.result.content[2].data);
    assert.equal((await call("echo", { mode: "mixed" })).result.content.length, 3);
    const resultError = await call("result_error");
    assert.equal(resultError.result.isError, true);
    assert.equal(resultError.error, undefined);
    const protocolError = await call("protocol_error");
    assert.equal(protocolError.error.code, -32001);
    assert.equal(protocolError.result, undefined);
    assert.equal((await call("absent")).error.code, -32602);
    assert.equal((await client.request("resources/list").response).result.resources.length, 1);
    assert.equal((await client.request("resources/templates/list").response).result.resourceTemplates.length, 1);
    assert.deepEqual((await client.request("ping").response).result, {});
    const start = peer.logs().find(event => event.event === "start");
    assert.equal(start.cwd, dir);
    assert.equal(start.tokenPresent, true);
    assert.equal(start.tokenMatches, true);
    assert.ok(!JSON.stringify(peer.logs()).includes(secret));
  } finally {
    await peer.stop();
    await peer.stop();
    assert.ok(peer.logs().some(event => event.event === "stop"));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("role MCP fixture refreshes schemas/inventory after atomic writes and tolerates malformed control files", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "role-peer-drift-"));
  const file = join(dir, "behavior.json");
  writeFileSync(file, JSON.stringify({ tools: ["echo"], schema: { type: "object", properties: {} } }));
  const peer = await startRoleMcpPeer({ id: "drift", behaviorFile: file });
  try {
    const client = stdioClient(peer);
    await client.initialize();
    assert.deepEqual((await client.request("tools/list").response).result.tools.map((tool: any) => tool.name), ["echo"]);
    writeFileSync(file, "{");
    await until(() => peer.logs().find(event => event.event === "behavior-read-error"));
    const schema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"] };
    writeFileSync(`${file}.next`, JSON.stringify({ tools: ["echo", "added"], schema, annotations: { readOnlyHint: false } }));
    renameSync(`${file}.next`, file);
    await until(() => client.messages.find(message => message.method === "notifications/tools/list_changed"));
    const changed = (await client.request("tools/list").response).result.tools;
    assert.deepEqual(changed.map((tool: any) => tool.name), ["echo", "added"]);
    assert.deepEqual(changed[0].inputSchema, schema);
    assert.deepEqual(changed[0].annotations, { readOnlyHint: false });
    // A definition-only change also emits a notification, not just a name change.
    const count = client.messages.filter(message => message.method === "notifications/tools/list_changed").length;
    writeFileSync(file, JSON.stringify({ tools: ["echo", "added"], schema: { type: "object" } }));
    await until(() => client.messages.filter(message => message.method === "notifications/tools/list_changed").length > count ? true : undefined);
  } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("role MCP fixture delayed readiness, hung calls and repeated progress cancel without replay", { timeout: 10000 }, async () => {
  const peer = await startRoleMcpPeer({ id: "cancel", initDelayMs: 1000, delayMs: 1000 });
  try {
    const client = stdioClient(peer);
    const init = client.request("initialize", { protocolVersion: "2025-03-26" });
    await until(() => peer.logs().find(event => event.event === "initialize"));
    client.send({ method: "notifications/cancelled", params: { requestId: init.id, reason: "do-not-log-reason" } });
    assert.equal((await init.response).error.code, -32800);
    const list = client.request("tools/list");
    await until(() => peer.logs().find(event => event.event === "tools/list"));
    client.send({ method: "notifications/cancelled", params: { requestId: list.id } });
    assert.equal((await list.response).error.code, -32800);
    // Only the first list is delayed.
    assert.ok((await client.request("tools/list").response).result.tools.length > 0);
    assert.ok((await client.request("tools/call", { name: "slow", arguments: { delayMs: 10 } }).response).result);
    for (const name of ["hang", "progress"]) {
      const call = client.request("tools/call", { name, arguments: {}, _meta: { progressToken: `token-${name}` } });
      await until(() => peer.logs().find(event => event.event === "call-start" && event.requestId === call.id));
      if (name === "progress") {
        await until(() => client.messages.filter(message => message.method === "notifications/progress").length >= 3 ? true : undefined);
        assert.ok(client.messages.filter(message => message.method === "notifications/progress").every(message => message.params.progressToken === "token-progress"));
      }
      client.send({ method: "notifications/cancelled", params: { requestId: call.id } });
      assert.equal((await call.response).error.code, -32800);
      assert.equal(peer.logs().filter(event => event.event === "tools/call" && event.requestId === call.id).length, 1);
    }
    const count = peer.logs().filter(event => event.event === "progress").length;
    await sleep(60);
    assert.equal(peer.logs().filter(event => event.event === "progress").length, count);
    assert.ok(!JSON.stringify(peer.logs()).includes("do-not-log-reason"));
  } finally { await peer.stop(); }
});

test("role MCP fixture progress completes through the behavior-file stop flag", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "role-peer-progress-"));
  const behaviorFile = join(dir, "behavior.json");
  writeFileSync(behaviorFile, "{}");
  const peer = await startRoleMcpPeer({ id: "progress", behaviorFile });
  try {
    const client = stdioClient(peer);
    await client.initialize();
    const call = client.request("tools/call", { name: "progress", _meta: { progressToken: 42 } });
    await until(() => client.messages.find(message => message.method === "notifications/progress"));
    writeFileSync(behaviorFile, JSON.stringify({ stopProgress: true }));
    assert.equal((await call.response).result.structuredContent.rawName, "progress");
  } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("role MCP fixture HTTP JSON, GET list notifications, SSE progress, auth and session-only DELETE", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "role-peer-http-"));
  const behaviorFile = join(dir, "behavior.json");
  writeFileSync(behaviorFile, "{}");
  const secret = "never-log-http-credential";
  const peer = await startRoleMcpPeer({ id: "http", http: true, header: "x-fixture-token", secretExpected: secret, behaviorFile });
  let notifications: ReturnType<typeof readSse> | undefined;
  try {
    const auth = { "x-fixture-token": secret };
    assert.equal((await fetch(peer.url!, { method: "POST", body: "{}" })).status, 401);
    const init = await fetch(peer.url!, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) });
    assert.equal((await init.json()).result.capabilities.tools.listChanged, true);
    const session = init.headers.get("mcp-session-id")!;
    assert.ok(session);
    const headers = { ...auth, "mcp-session-id": session, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const post = (id: number | undefined, method: string, params: object = {}) => fetch(peer.url!, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) });
    assert.equal((await post(undefined, "notifications/initialized")).status, 202);
    assert.equal((await (await post(2, "tools/call", { name: "echo", arguments: { value: "hello" } })).json()).result.content[0].text, "hello");
    notifications = readSse(await fetch(peer.url!, { headers }));
    writeFileSync(behaviorFile, JSON.stringify({ tools: ["echo", "progress", "change_list", "new_tool"] }));
    await until(() => notifications!.messages.find(message => message.method === "notifications/tools/list_changed"));
    const inventory = await (await post(3, "tools/list")).json();
    assert.ok(inventory.result.tools.some((tool: any) => tool.name === "new_tool"));
    const progress = readSse(await post(4, "tools/call", { name: "progress", _meta: { progressToken: "http-token" } }));
    await until(() => progress.messages.filter(message => message.method === "notifications/progress").length >= 3 ? true : undefined);
    assert.equal((await post(undefined, "notifications/cancelled", { requestId: 4 })).status, 202);
    await progress.done;
    assert.equal(progress.messages.at(-1).error.code, -32800);
    const changed = readSse(await post(5, "tools/call", { name: "change_list", arguments: { tools: ["echo"] } }));
    await changed.done;
    assert.equal(changed.messages[0].method, "notifications/tools/list_changed");
    assert.equal(changed.messages.at(-1).result.structuredContent.rawName, "change_list");
    assert.equal((await fetch(peer.url!, { method: "DELETE", headers })).status, 200);
    await notifications.done;
    assert.doesNotThrow(() => process.kill(peer.process.pid!, 0));
    // DELETE only destroys that session; the same remote process still responds.
    const again = await fetch(peer.url!, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "2025-03-26" } }) });
    assert.ok((await again.json()).result);
    assert.notEqual(again.headers.get("mcp-session-id"), session);
    assert.ok(peer.logs().some(event => event.event === "http-close" && event.knownSession));
    assert.ok(peer.logs().some(event => event.event === "http-request" && event.headerMatches));
    assert.ok(peer.logs().some(event => event.event === "http-request" && !event.headerPresent));
    assert.ok(!readFileSync(peer.log, "utf8").includes(secret));
  } finally {
    await notifications?.cancel().catch(() => {});
    await peer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("role MCP fixture rejects missing stdio credentials without exposing them", { timeout: 10000 }, async () => {
  const peer = await startRoleMcpPeer({ id: "missing-token", tokenEnv: "MISSING_ROLE_FIXTURE_SECRET", expectedToken: "private-token" });
  try {
    const client = stdioClient(peer);
    assert.equal((await client.initialize()).error.code, -32002);
    assert.equal(peer.logs().find(event => event.event === "start").tokenMatches, false);
    assert.ok(!JSON.stringify(peer.logs()).includes("private-token"));
  } finally { await peer.stop(); }
});

test("role MCP fixture stdin end closes HTTP streams and pending requests", { timeout: 10000 }, async () => {
  const peer = await startRoleMcpPeer({ id: "stdin-close", http: true });
  try {
    const init = await fetch(peer.url!, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    await init.json();
    const headers = { "mcp-session-id": init.headers.get("mcp-session-id")! };
    const stream = readSse(await fetch(peer.url!, { headers }));
    const hanging = fetch(peer.url!, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hang" } }) }).catch(() => undefined);
    await until(() => peer.logs().find(event => event.event === "call-start" && event.name === "hang"));
    const exited = once(peer.process, "exit");
    peer.process.stdin.end();
    await exited;
    await stream.done.catch(() => {});
    await hanging;
    assert.ok(peer.logs().some(event => event.event === "stop" && event.reason === "stdin-end"));
  } finally { await peer.stop(); }
});
