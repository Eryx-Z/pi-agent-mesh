import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { startRoleMcpPeer } from "./fixtures/role-mcp-peer.ts";
import { writeFileSync } from "node:fs";
import { setupRoleMcp } from "../pi-extension/subagents/role-mcp.ts";
import { roleMcpConfigHash, ROLE_CHILD_EXTENSION, type RolePlan } from "../pi-extension/subagents/role-loadout.ts";

const server = fileURLToPath(new URL("./fixtures/role-mcp-unit-server.mjs", import.meta.url));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(options: Record<string, unknown> = {}, selected = ["echo"], mutate?: (plan: RolePlan) => void) {
  const dir = mkdtempSync(join(tmpdir(), "role-mcp-unit-"));
  const log = join(dir, "server.jsonl");
  const plan: RolePlan = { version: 1, schemaVersion: 1, roleId: "worker", manifestPath: join(dir, "role.yaml"), manifestHash: hash("manifest"),
    systemPrompt: "Saved body", systemPromptHash: hash("Saved body"), promptVersion: 1, skills: [], builtinTools: [], extraTools: [],
    mcp: [{ server: "selected", config: { command: process.execPath, args: [server, JSON.stringify({ log, ...options })], timeout: 2 }, tools: selected }],
    model: "unused/test", thinking: "off", context: "none", access: "full", cwd: dir, agentDir: dir };
  mutate?.(plan);
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), definitions = new Map<string, any>();
  const notifications: unknown[] = [];
  const sourceInfo = { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary", origin: "top-level", baseDir: undefined };
  const ctx = { cwd: dir, mode: "rpc", hasUI: false, ui: { notify(...args: unknown[]) { notifications.push(args); } } } as unknown as ExtensionCommandContext;
  let ambientReads = 0, active: string[] = [];
  const pi = {
    on(event: string, fn: Function) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => {}; },
    registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, registerToolRenderer() {},
    getMcpServers() { ambientReads++; return [{ name: "selected", config: { command: "MUST_NOT_CONNECT" } }]; },
    registerTool(def: any) { definitions.set(def.name, def); },
    getAllTools() { return [...definitions.values()].map(def => ({ ...def, sourceInfo })); },
    getActiveTools() { return active; }, setActiveTools(next: string[]) { active = next; },
  } as unknown as ExtensionAPI;
  const event = async (name: string, value: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(value, ctx); };
  const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const open = async (access: "full" | "read-only" = "full") => { const adapter = await setupRoleMcp(pi, plan, access); await event("session_start"); return adapter; };
  return { dir, plan, pi, ctx, definitions, commands, notifications, sourceInfo, events, event, open, ambientReads: () => ambientReads,
    clean() { rmSync(dir, { force: true, recursive: true }); } };
}
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(15); } throw new Error("fixture did not settle"); }

// Uses the actual createMcpExtension and Pi's own installed transports; only the extension host is a test double.
test("native registration maps actual collision/long names and excludes ambient, resources, hidden and late registrations", async () => {
  const long = "long_" + "x".repeat(90);
  const names = ["echo", "a-b", "a_b", long];
  const f = fixture({ tools: [...names, "unselected"] }, names);
  const adapter = await f.open();
  try {
    await adapter.ready(f.ctx, Date.now() + 3000);
    const [source] = adapter.sources();
    assert.equal(source.configHash, roleMcpConfigHash(f.plan, "selected"));
    assert.deepEqual(source.tools.map(t => t.rawName), names);
    assert.equal(new Set(source.tools.map(t => t.name)).size, names.length);
    for (const raw of ["a-b", "a_b"]) assert.match(source.tools.find(t => t.rawName === raw)!.name, /a_b_[a-f0-9]{8}$/);
    assert.equal(source.tools.find(t => t.rawName === long)!.name.length, 64);
    assert.deepEqual([...f.definitions.keys()].sort(), source.tools.map(t => t.name).sort());
    assert.ok([...f.definitions.values()].every(t => t.exposure === "direct"));
    await f.event("mcp_servers_change", { servers: [{ name: "late", config: { command: "MUST_NOT_CONNECT" } }] });
    assert.equal(f.ambientReads(), 0);
    assert.deepEqual(f.notifications, []);
    adapter.verify();
  } finally { await adapter.close(); f.clean(); }
});

test("native calls preserve mixed content, structured content, isError and protocol errors", async () => {
  const f = fixture(); const adapter = await f.open();
  try {
    await adapter.ready(f.ctx, Date.now() + 3000);
    adapter.verify();
    const definition = f.definitions.get(adapter.sources()[0].tools[0].name);
    const result = await definition.execute("call", {}, undefined, undefined, {});
    assert.deepEqual(result.content.map((b: any) => b.type), ["text", "text", "image"]);
    assert.deepEqual(result.structuredContent.structuredContent.rawName, "echo");
    assert.equal(result.details.server, "selected");
    const error = await definition.execute("error", { mode: "error" }, undefined, undefined, {});
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent.isError, true);
    await assert.rejects(definition.execute("protocol", { mode: "protocol" }, undefined, undefined, {}), /Protocol failure/);
  } finally { await adapter.close(); f.clean(); }
});

test("read-only does not register hooks, commands, tools or launch MCP", async () => {
  const f = fixture({}, ["echo"], plan => { plan.mcp[0].config.command = "MUST_NOT_CONNECT"; });
  const adapter = await f.open("read-only");
  try {
    await adapter.ready(f.ctx, Date.now() + 100);
    assert.deepEqual(adapter.sources(), []); adapter.verify();
    assert.equal(f.commands.size, 0); assert.equal(f.definitions.size, 0); assert.deepEqual(f.events(), []);
  } finally { await adapter.close(); f.clean(); }
});

for (const stage of ["initDelay", "delay"]) test(`one absolute readiness deadline closes pending ${stage} without late activation`, async () => {
  const f = fixture({ [stage]: 900 }); const adapter = await f.open();
  try {
    await until(() => f.events().some(e => e.event === (stage === "initDelay" ? "initialize" : "tools/list")));
    const start = Date.now();
    await assert.rejects(adapter.ready(f.ctx, start + 50), /readiness failed/);
    assert.ok(Date.now() - start < 800);
    assert.throws(() => adapter.verify(), /closed/);
    for (const e of f.events().filter(e => e.event === "start")) assert.throws(() => process.kill(e.pid, 0), (e: any) => e.code === "ESRCH");
    await sleep(950);
    assert.equal(f.definitions.size, 0);
  } finally { await adapter.close(); f.clean(); }
});

test("native pending discovery can finish beyond short startupWait but before caller deadline", async () => {
  const f = fixture({ delay: 200 }); const adapter = await f.open();
  try {
    const start = Date.now(); await adapter.ready(f.ctx, start + 1500);
    assert.ok(Date.now() - start >= 150); adapter.verify();
  } finally { await adapter.close(); f.clean(); }
});

test("readiness cancellation closes a still initializing process", async () => {
  const f = fixture({ initDelay: 1000 }); const adapter = await f.open();
  try {
    await until(() => f.events().some(e => e.event === "initialize"));
    const controller = new AbortController(); const result = adapter.ready(f.ctx, Date.now() + 5000, controller.signal);
    controller.abort("sensitive abort text");
    await assert.rejects(result, error => /readiness failed/.test(String(error)) && !String(error).includes("sensitive"));
    assert.equal(f.definitions.size, 0);
    assert.ok(f.events().some(e => e.event === "stop"));
  } finally { await adapter.close(); f.clean(); }
});

for (const mode of ["remove", "schema"]) test(`selected remote ${mode} drift is rejected while newly added unselected tools stay absent`, async () => {
  const f = fixture(); const adapter = await f.open();
  try {
    await adapter.ready(f.ctx, Date.now() + 3000);
    const name = adapter.sources()[0].tools[0].name;
    await f.definitions.get(name).execute("add", { mode: "add" }, undefined, undefined, {});
    await until(() => f.events().filter(e => e.event === "tools/list").length >= 2); await sleep(40);
    adapter.verify(); assert.equal(f.definitions.size, 1);
    await f.definitions.get(name).execute("change", { mode }, undefined, undefined, {});
    await until(() => f.events().filter(e => e.event === "tools/list").length >= 3); await sleep(40);
    assert.throws(() => adapter.verify(), /changed|missing|ambiguous|not ready/);
  } finally { await adapter.close(); f.clean(); }
});

for (const schema of [{ type: "array", items: { type: "string" } }, { type: "object", properties: { bad: { type: "not-a-type" } } }]) test("invalid selected input schemas never pass readiness", async () => {
  const f = fixture({ schema }); const adapter = await f.open();
  try { await assert.rejects(adapter.ready(f.ctx, Date.now() + 3000), /schema|readiness failed/); assert.equal(f.definitions.size, 0); }
  finally { await adapter.close(); f.clean(); }
});

test("missing selected tool and transport failure are sanitized and cannot pass readiness", async () => {
  for (const broken of [false, true]) {
    const f = fixture({}, ["absent"], plan => { if (broken) plan.mcp[0].config.command = join(plan.cwd, "credential-secret-never-print"); });
    const adapter = await f.open();
    try {
      await assert.rejects(adapter.ready(f.ctx, Date.now() + 3000), e => /readiness failed/.test(String(e)) && !String(e).includes("credential-secret"));
      assert.deepEqual(f.notifications, []);
    } finally { await adapter.close(); f.clean(); }
  }
});

test("credential rotation resolves each child, preserves native escapes, literal args and bound cwd; hashes stay unresolved", async () => {
  const previous = process.env.ROLE_MCP_UNIT_TOKEN;
  try {
    let previousHash: string | undefined;
    for (const token of ["first-secret", "second-secret"]) {
      process.env.ROLE_MCP_UNIT_TOKEN = token;
      const f = fixture({}, ["echo"], plan => {
        plan.mcp[0].config.env = { ROLE_MCP_UNIT_TOKEN: "${ROLE_MCP_UNIT_TOKEN}:$ROLE_MCP_UNIT_TOKEN:$$HOME:$!literal" };
        plan.mcp[0].config.args!.push("~/literal", "$NO_INTERPOLATE", "./relative");
      });
      // Only the unresolved connection config is hashed; make identical cwd/config across successive children.
      const adapter = await f.open();
      try {
        await adapter.ready(f.ctx, Date.now() + 3000);
        const result = await f.definitions.get(adapter.sources()[0].tools[0].name).execute("test", {}, undefined, undefined, {});
        const structured = result.structuredContent.structuredContent;
        assert.equal(structured.credential, `${token}:${token}:$HOME:!literal`);
        assert.equal(structured.cwd, f.dir);
        assert.deepEqual(structured.args, ["~/literal", "$NO_INTERPOLATE", "./relative"]);
        assert.equal(f.plan.mcp[0].config.env!.ROLE_MCP_UNIT_TOKEN, "${ROLE_MCP_UNIT_TOKEN}:$ROLE_MCP_UNIT_TOKEN:$$HOME:$!literal");
        const currentHash = adapter.sources()[0].configHash;
        process.env.ROLE_MCP_UNIT_TOKEN = "changed-after-connect";
        assert.equal(roleMcpConfigHash(f.plan, "selected"), currentHash);
        previousHash = currentHash;
      } finally { await adapter.close(); f.clean(); }
    }
    assert.ok(previousHash);
  } finally { if (previous === undefined) delete process.env.ROLE_MCP_UNIT_TOKEN; else process.env.ROLE_MCP_UNIT_TOKEN = previous; }
});

test("malformed braced environment expressions stay literal like the native resolver", async () => {
  const literal = "${BAD-NAME}:${UNCLOSED:${invalid-$MISSING_INSIDE_123}";
  const f = fixture({}, ["echo"], plan => { plan.mcp[0].config.env = { ROLE_MCP_UNIT_TOKEN: literal }; });
  let adapter: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    adapter = await f.open(); await adapter.ready(f.ctx, Date.now() + 3000);
    const result = await f.definitions.get(adapter.sources()[0].tools[0].name).execute("literal", {}, undefined, undefined, {});
    assert.equal(result.structuredContent.structuredContent.credential, literal);
  } finally { await adapter?.close(); f.clean(); }
});

for (const [value, message] of [["${ROLE_MCP_UNIT_MISSING}", /worker.*selected.*env\.TOKEN.*ROLE_MCP_UNIT_MISSING/], ["!echo credential-secret", /commands/]] as const) test(`credential preflight rejects invalid/missing syntax without connecting`, async () => {
  const f = fixture({}, ["echo"], plan => { plan.mcp[0].config.env = { TOKEN: value }; });
  try { await assert.rejects(f.open(), message); assert.deepEqual(f.events(), []); }
  finally { f.clean(); }
});

for (const changed of [false, true]) test(`native HTTP session retry rechecks authorization after rediscovery (changed=${changed})`, async () => {
  const f = fixture(); const behavior = join(f.dir, "retry-behavior.json"); writeFileSync(behavior, JSON.stringify({ expireNextCall: true, expireSchema: { type: "object", properties: changed ? { changed: { type: "boolean" } } : {} } }));
  const peer = await startRoleMcpPeer({ id: "retry", http: true, tools: ["echo"], schema: { type: "object", properties: {} }, behaviorFile: behavior });
  f.plan.mcp[0].config = { url: peer.url! };
  let adapter: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    adapter = await f.open(); await adapter.ready(f.ctx, Date.now() + 3000);
    const tool = f.definitions.get(adapter.sources()[0].tools[0].name);
    if (changed) await assert.rejects(tool.execute("retry", {}, undefined, undefined, {}), /changed|ready|schema/i);
    else assert.equal((await tool.execute("retry", {}, undefined, undefined, {})).content[0].text, "retry:echo");
    assert.ok(peer.logs().filter(e => e.event === "initialize").length >= 2, "Must exercise native reconnect, not just a terminal HTTP error");
    assert.equal(peer.logs().filter(e => e.event === "call-start").length, changed ? 0 : 1);
  } finally { await adapter?.close(); await peer.stop(); f.clean(); }
});

test("cancellation during native renewal registration wait prevents the suspended retry from being sent", async () => {
  const f = fixture(); const behavior = join(f.dir, "cancel-retry.json"); writeFileSync(behavior, JSON.stringify({ expireNextCall: true, expireSchema: { type: "object", properties: {} } }));
  const peer = await startRoleMcpPeer({ id: "cancel-retry", http: true, tools: ["echo"], schema: { type: "object", properties: {} }, behaviorFile: behavior });
  f.plan.mcp[0].config = { url: peer.url! };
  let adapter: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    adapter = await f.open(); await adapter.ready(f.ctx, Date.now() + 3000);
    const tool = f.definitions.get(adapter.sources()[0].tools[0].name), controller = new AbortController();
    const register = f.pi.registerTool.bind(f.pi); let scheduled = false;
    f.pi.registerTool = definition => { register(definition); if (!scheduled) { scheduled = true; setImmediate(() => controller.abort()); } };
    await assert.rejects(tool.execute("cancel-retry", {}, controller.signal, undefined, {}), /abort|cancel/i);
    await sleep(60);
    assert.ok(scheduled); assert.ok(peer.logs().filter(e => e.event === "initialize").length >= 2);
    assert.equal(peer.logs().filter(e => e.event === "call-start").length, 0, "Cancelled retry must not leave the client after the await");
  } finally { await adapter?.close(); await peer.stop(); f.clean(); }
});

for (const mode of ["refresh_error", "malformed_cursor", "malformed_entry", "repeated_cursor"]) test(`failed tools/list ${mode} remains unauthorized instead of restoring stale definitions`, async () => {
  const f = fixture(); const adapter = await f.open();
  try {
    await adapter.ready(f.ctx, Date.now() + 3000);
    const name = adapter.sources()[0].tools[0].name;
    await f.definitions.get(name).execute("refresh-error", { mode }, undefined, undefined, {});
    await until(() => f.events().filter(e => e.event === "tools/list").length >= 2); await sleep(60);
    assert.throws(() => adapter.verify(), /not ready|inventory|refresh/i);
    await assert.rejects(f.definitions.get(name).execute("blocked", {}, undefined, undefined, {}));
    assert.equal(f.events().filter(e => e.event === "tools/call").length, 1);
  } finally { await adapter.close(); f.clean(); }
});

test("unchanged repeated absolute $id schemas and reordered selected inventories do not count as drift", async () => {
  const f = fixture({ tools: ["echo", "other"], schema: { $id: "https://example.test/role-schema", type: "object", properties: {} } }, ["echo", "other"]); const adapter = await f.open();
  try {
    await adapter.ready(f.ctx, Date.now() + 3000);
    const name = adapter.sources()[0].tools[0].name;
    await f.definitions.get(name).execute("unchanged", { mode: "unchanged" }, undefined, undefined, {});
    await until(() => f.events().filter(e => e.event === "tools/list").length >= 2); await sleep(60); adapter.verify();
    await f.definitions.get(name).execute("reorder", { mode: "reorder" }, undefined, undefined, {});
    await until(() => f.events().filter(e => e.event === "tools/list").length >= 3); await sleep(60); adapter.verify();
  } finally { await adapter.close(); f.clean(); }
});

test("native tool timeout and parent cancellation survive progress resets", async () => {
  const f = fixture({}, ["echo"], plan => { plan.mcp[0].config.timeout = 0.08; }); const adapter = await f.open();
  try {
    await adapter.ready(f.ctx, Date.now() + 3000);
    const definition = f.definitions.get(adapter.sources()[0].tools[0].name);
    await assert.rejects(definition.execute("timeout", { mode: "wait" }, undefined, undefined, {}), /timed out|timeout/i);
    const controller = new AbortController(); let updates = 0;
    const call = definition.execute("progress", { mode: "progress" }, controller.signal, () => { updates++; }, {});
    await sleep(180); assert.ok(updates >= 3);
    controller.abort(); await assert.rejects(call, /abort|cancel/i);
    await until(() => f.events().some(e => e.event === "notifications/cancelled"));
  } finally { await adapter.close(); f.clean(); }
});

test("HTTP 401 does not read ambient OAuth state, login, leak remote exceptions or edit config", async () => {
  let requests = 0;
  const remote = createServer((_req, res) => { requests++; res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://must-not-visit.invalid/oauth"' }); res.end("credential-secret"); });
  remote.listen(0, "127.0.0.1"); await once(remote, "listening");
  const address = remote.address() as { port: number };
  const f = fixture({}, ["echo"], plan => { plan.mcp[0].config = { url: `http://127.0.0.1:${address.port}/mcp` }; });
  const adapter = await f.open();
  try {
    await assert.rejects(adapter.ready(f.ctx, Date.now() + 2000), e => /readiness failed/.test(String(e)) && !String(e).includes("credential-secret"));
    assert.equal(requests, 1); assert.deepEqual(f.notifications, []);
    await assert.rejects(f.commands.get("mcp").handler("login selected", f.ctx), /disabled/);
    assert.equal(existsSync(join(f.dir, "mcp-auth.json")), false);
  } finally { await adapter.close(); await new Promise<void>(resolve => remote.close(() => resolve())); f.clean(); }
});
