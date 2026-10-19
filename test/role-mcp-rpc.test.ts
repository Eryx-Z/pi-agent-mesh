import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { type RolePlan } from "../pi-extension/subagents/role-loadout.ts";
import { roleMcpServerPath, startRoleMcpPeer } from "./fixtures/role-mcp-peer.ts";
const pkg = getPackageDir(), cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
const provider = fileURLToPath(new URL("./fixtures/role-mcp-provider.ts", import.meta.url));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const logs = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(check: () => boolean, reason = "condition") {
  for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`MCP integration did not reach ${reason}`);
}
function fixture(t: { after(fn: () => void | Promise<void>): void }, readinessMs = 30000) {
  const dir = mkdtempSync(join(tmpdir(), "role-mcp-rpc-"));
  const events: any[] = [];
  const manager = new TaskManager(new TaskStore(join(dir, "tasks")), { command: process.execPath, baseArgs: [cli], roleReadinessMs: readinessMs,
    createRpc: launch => { const rpc = new RpcProcess(launch); rpc.on("event", event => events.push(event)); return rpc; } });
  t.after(async () => { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const plan: RolePlan = { version: 1, schemaVersion: 1, promptVersion: 1, roleId: "builder", manifestPath: join(dir, "saved-role.yaml"), manifestHash: hash("saved manifest"),
    systemPrompt: "M3_ROLE_BODY", systemPromptHash: hash("M3_ROLE_BODY"), skills: [], builtinTools: ["read"], extraTools: [], mcp: [],
    model: "role-mcp-fixture/test", thinking: "off", context: "none", access: "full", cwd: dir, agentDir: join(dir, "agent"), providerExtensions: [provider] };
  const stdio = (id: string, options: Record<string, unknown> = {}, tools = ["echo"]) => ({ server: id,
    config: { command: process.execPath, args: [roleMcpServerPath, JSON.stringify({ id, log: join(dir, `${id}.jsonl`), ...options })] }, tools });
  const requests = () => logs(join(dir, "m3-requests.jsonl"));
  const launch = async (task: string, access: "full" | "read-only" = "full") => {
    const record = await manager.launch({ task, access, context: "none", rolePlan: { ...plan, access } });
    await until(() => record.stopped, "confirmed task stop");
    assert.equal(record.state, "completed", `${record.error}\n${JSON.stringify(record.log)}`);
    return record;
  };
  return { dir, manager, plan, stdio, launch, requests, rpcEvents: events, events: (id: string) => logs(join(dir, `${id}.jsonl`)) };
}
function toolResults(sessionFile: string): any[] {
  return readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === "message" && e.message.role === "toolResult").map(e => e.message);
}

test("role readiness uses one absolute deadline, can outwait scaled legacy cutoff, and closes timed-out connections before any model call", { timeout: 15000 }, async t => {
  const success = fixture(t, 6000);
  success.plan.mcp = [success.stdio("late", { tools: ["echo"], delayMs: 1500 })];
  const started = Date.now(); await success.launch("RAW late/echo");
  assert.ok(Date.now() - started > 1500, "Readiness must wait for actual tool discovery, not legacy short receipt");
  const failure = fixture(t, 2500);
  failure.plan.mcp = [failure.stdio("too_late", { tools: ["echo"], initDelayMs: 10000 })];
  const failedAt = Date.now();
  await assert.rejects(failure.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: failure.plan }), /deadline|readiness/i);
  assert.ok(Date.now() - failedAt < 7000);
  assert.equal(failure.requests().length, 0);
  const record = [...failure.manager.records.values()][0]; assert.equal(record.stopped, true);
  assert.equal(record.roleRuns![0].snapshot, undefined);
  await until(() => failure.events("too_late").some(e => e.event === "stop"), "timed-out initialize peer stop");
});

test("cancel during MCP connection prevents model submission and confirms peer shutdown", { timeout: 15000 }, async t => {
  const f = fixture(t); f.plan.mcp = [f.stdio("connecting", { initDelayMs: 10000, tools: ["echo"] })];
  const launch = f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan });
  const rejection = assert.rejects(launch);
  await until(() => f.events("connecting").some(e => e.event === "start"), "connecting peer start");
  const record = [...f.manager.records.values()][0]; await f.manager.cancel(record.id); await rejection;
  assert.equal(record.state, "cancelled"); assert.equal(record.stopped, true); assert.equal(f.requests().length, 0);
  await until(() => f.events("connecting").some(e => e.event === "stop"), "cancelled connection stop");
});

for (const transport of ["stdio", "http"] as const) {
  test(`${transport} MCP progress resets request timeout but parent cancellation still closes only owned resources`, { timeout: 15000 }, async t => {
    const f = fixture(t), peer = transport === "http" ? await startRoleMcpPeer({ id: "progress_peer", http: true, tools: ["progress"] }) : undefined;
    if (peer) t.after(() => peer.stop());
    f.plan.mcp = [peer ? { server: "progress_peer", config: { url: peer.url!, timeout: 0.12 }, tools: ["progress"] } : { ...f.stdio("progress_peer", { tools: ["progress"] }, ["progress"]), config: { ...f.stdio("progress_peer").config, timeout: 0.12 } }];
    const record = await f.manager.launch({ task: 'RAW progress_peer/progress {"progressIntervalMs":25}', access: "full", context: "none", rolePlan: f.plan });
    const peerEvents = () => peer?.logs() ?? f.events("progress_peer");
    await until(() => peerEvents().filter(e => e.event === "progress").length >= 8, "sustained progress beyond request timeout");
    assert.equal(record.stopped, false);
    const start = Date.now(); await f.manager.cancel(record.id);
    assert.ok(Date.now() - start < 3000); assert.equal(record.stopped, true); assert.equal(record.state, "cancelled");
    await until(() => peerEvents().some(e => e.event === "notifications/cancelled" || e.event === "call-cancelled" || e.event === "cancelled" || e.event === "cancel"), "protocol cancellation");
    if (peer) { await until(() => peer.logs().some(e => e.event === "http-close"), "HTTP client close"); assert.equal(peer.process.exitCode, null); }
    else await until(() => f.events("progress_peer").some(e => e.event === "stop"), "progress stdio stop");
  });
}

test("native MCP request timeout produces failed tool result without replaying the call", { timeout: 15000 }, async t => {
  const f = fixture(t); f.plan.mcp = [{ ...f.stdio("local", { tools: ["hang"] }, ["hang"]), config: { ...f.stdio("local", { tools: ["hang"] }).config, timeout: 0.1 } }];
  const record = await f.launch("RAW local/hang");
  const result = toolResults(record.sessionFile).find(t => t.toolName.startsWith("mcp__"));
  assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /timed out|timeout/i);
  assert.equal(f.events("local").filter(e => e.event === "call-start").length, 1);
});

test("live MCP list changes never authorize new tools and removed tools fail before remote calls", { timeout: 15000 }, async t => {
  const f = fixture(t), behavior = join(f.dir, "live-behavior.json"); writeFileSync(behavior, "{}");
  const entry = join(f.dir, "dynamic-tools.ts");
  const source = `import {writeFileSync} from 'node:fs'; export default pi => {pi.registerTool({name:'change_then_call',label:'Change',description:'Live inventory probe',parameters:{type:'object',properties:{}},async execute(id,args,signal,update,ctx){writeFileSync(${JSON.stringify(behavior)},JSON.stringify({tools:['unselected','new_tool']}));await new Promise(r=>setTimeout(r,250));const out={};for(const name of ['mcp__local__new_tool','mcp__local__echo']){out[name]=await ctx.executeTool(name,{});}return {content:[{type:'text',text:JSON.stringify(out)}]};}});};`;
  writeFileSync(entry, source); f.plan.extraTools = [{ entry, hash: hash(source), tools: ["change_then_call"] }];
  f.plan.mcp = [f.stdio("local", { tools: ["echo", "unselected"], behaviorFile: behavior })];
  const record = await f.launch("DIRECT change_then_call");
  const result = toolResults(record.sessionFile).find(t => t.toolName === "change_then_call");
  assert.equal(result.isError, false);
  const nested = JSON.parse(result.content[0].text); assert.equal(nested.mcp__local__new_tool.isError, true); assert.equal(nested.mcp__local__echo.isError, true);
  assert.equal(f.events("local").some(e => e.event === "call-start"), false);
  assert.equal(record.loadout.tools.includes("mcp__local__new_tool"), false);
});

test("role native MCP selects actual collision-safe names across stdio/HTTP without ambient services or resource tools", { timeout: 30000 }, async t => {
  const f = fixture(t), http = await startRoleMcpPeer({ id: "remote", http: true, tools: ["echo", "a-b", "a_b", "unselected"] });
  t.after(() => http.stop());
  const long = "long_" + "x".repeat(100);
  f.plan.mcp = [f.stdio("local", { tools: ["echo", "a-b", "a_b", long, "unselected"] }, ["echo", "a-b", "a_b", long]), { server: "remote", config: { url: http.url! }, tools: ["echo"] }];
  mkdirSync(join(f.dir, "agent")); mkdirSync(join(f.dir, ".pi"));
  const trap = { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(join(f.dir, "AMBIENT_CONNECTED"))},'bad')`] };
  writeFileSync(join(f.dir, "agent", "mcp.json"), JSON.stringify({ mcpServers: { ambient: trap, local: trap } }));
  writeFileSync(join(f.dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { ambient_project: trap, local: trap } }));
  const record = await f.launch("RAW local/echo");
  const tools = record.roleRuns![0].snapshot!.tools.filter(tool => tool.semanticKind === "mcp");
  assert.equal(tools.length, 5); assert.equal(new Set(tools.map(t => t.name)).size, 5);
  assert.ok(tools.some(t => t.remoteName === long));
  assert.notEqual(tools.find(t => t.remoteName === "a-b")!.name, tools.find(t => t.remoteName === "a_b")!.name);
  assert.ok(tools.every(t => t.sourceInfo.source === "cli" && t.server && t.remoteName && t.configHash));
  assert.match(record.output, /local/);
  assert.ok(!record.loadout.tools.includes("list_mcp_resources"));
  assert.ok(record.loadout.tools.every(name => !name.includes("unselected") && !["codemode", "tool_search"].includes(name)));
  assert.equal(existsSync(join(f.dir, "AMBIENT_CONNECTED")), false);
  await until(() => f.events("local").some(e => e.event === "stop"), "stdio peer stop");
  await until(() => http.logs().some(e => e.event === "http-close"), "HTTP client DELETE");
  assert.equal(http.process.exitCode, null, "Closing the client must not terminate remote service");
  for (const raw of ["a-b", "a_b", long]) {
    await f.manager.continue(record.id, `RAW local/${raw}`, "full"); await until(() => record.stopped);
    assert.equal(record.state, "completed", record.error);
    assert.ok(f.events("local").some(e => e.event === "call-start" && e.name === raw));
  }
  assert.equal(f.events("local").some(e => e.event === "call-start" && e.name === "unselected"), false);
});

for (const raw of ["mixed", "result_error", "protocol_error"] as const) {
  test(`native MCP preserves ${raw} result semantics through actual role task RPC`, { timeout: 15000 }, async t => {
    const f = fixture(t); f.plan.mcp = [f.stdio("local", { tools: [raw] }, [raw])];
    const record = await f.launch(`RAW local/${raw}`);
    const result = toolResults(record.sessionFile).find(r => r.toolName.startsWith("mcp__"));
    const execution = f.rpcEvents.find(e => e.type === "tool_execution_end" && e.toolName.startsWith("mcp__"));
    assert.ok(result, record.output); assert.ok(execution);
    if (raw === "mixed") {
      assert.equal(result.isError, false); assert.equal(result.content.filter((b: any) => b.type === "text").length, 2);
      assert.equal(result.content.filter((b: any) => b.type === "image").length, 1);
      assert.ok(execution.result.structuredContent?.structuredContent, JSON.stringify(execution));
    } else {
      assert.equal(result.isError, true);
      if (raw === "result_error") assert.equal(execution.result.structuredContent?.isError, true);
      else assert.match(JSON.stringify(result.content), /Fixture protocol error/);
    }
  });
}

test("role read-only skips MCP entirely, then full discovers it once; later schemas cannot replace historical definitions", { timeout: 20000 }, async t => {
  const f = fixture(t), behavior = join(f.dir, "behavior.json"); writeFileSync(behavior, "{}");
  f.plan.mcp = [f.stdio("local", { tools: ["echo"], behaviorFile: behavior })];
  const record = await f.launch("INSPECT", "read-only");
  assert.deepEqual(f.events("local"), []); assert.equal(record.roleBaseline!.some(t => t.semanticKind === "mcp"), false);
  await f.manager.continue(record.id, "RAW local/echo", "full"); await until(() => record.stopped);
  assert.equal(record.state, "completed", record.error); assert.ok(record.roleBaseline!.some(t => t.semanticKind === "mcp"));
  await f.manager.continue(record.id, "INSPECT", "read-only"); await until(() => record.stopped);
  const baseline = structuredClone(record.roleBaseline), snapshot = structuredClone(record.roleRuns!.at(-1)!.snapshot), count = f.requests().length;
  writeFileSync(behavior, JSON.stringify({ schema: { type: "object", properties: { drift: { type: "boolean" } } } }));
  await assert.rejects(f.manager.continue(record.id, "MUST_NOT_SUBMIT", "full"), /Historical.*mismatch/);
  assert.equal(f.requests().length, count); assert.deepEqual(record.roleBaseline, baseline);
  assert.deepEqual(record.roleRuns!.at(-2)!.snapshot, snapshot); assert.equal(record.roleRuns!.at(-1)!.snapshot, undefined);
});

test("remote output schema drift is part of the persisted historical definition even when ToolInfo omits it", { timeout: 15000 }, async t => {
  const f = fixture(t), behavior = join(f.dir, "output-behavior.json");
  writeFileSync(behavior, JSON.stringify({ tools: [{ name: "echo", outputSchema: { type: "object", properties: { value: { type: "string" } } } }] }));
  f.plan.mcp = [f.stdio("local", { tools: ["echo"], behaviorFile: behavior })];
  const record = await f.launch("INSPECT"); const before = f.requests().length;
  writeFileSync(behavior, JSON.stringify({ tools: [{ name: "echo", outputSchema: { type: "object", properties: { value: { type: "boolean" } } } }] }));
  await assert.rejects(f.manager.continue(record.id, "NEVER_MODEL", "full"), /Historical.*mismatch/);
  assert.equal(f.requests().length, before);
});

test("missing selected MCP tool and malformed schema fail preflight with zero model requests and stopped stdio peers", { timeout: 15000 }, async t => {
  for (const invalid of ["missing", "schema"] as const) {
    const f = fixture(t); f.plan.mcp = [f.stdio("local", invalid === "schema" ? { tools: ["echo"], schema: { type: "object", properties: { x: { type: "not-a-json-schema-type" } } } } : { tools: ["other"] })];
    await assert.rejects(f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan }), /preflight|schema|missing|MCP/i);
    assert.equal(f.requests().length, 0);
    const record = [...f.manager.records.values()][0]; assert.equal(record.stopped, true); assert.equal(record.roleRuns![0].snapshot, undefined);
    await until(() => f.events("local").some(e => e.event === "stop"), "failed peer stop");
  }
});

test("HTTP session renewal cannot retry an authorized call against a changed selected schema", { timeout: 15000 }, async t => {
  const f = fixture(t), behavior = join(f.dir, "expire.json"); writeFileSync(behavior, JSON.stringify({ expireNextCall: true }));
  const peer = await startRoleMcpPeer({ id: "renew", http: true, tools: ["echo"], behaviorFile: behavior }); t.after(() => peer.stop());
  f.plan.mcp = [{ server: "renew", config: { url: peer.url! }, tools: ["echo"] }];
  const record = await f.launch("RAW renew/echo");
  const result = toolResults(record.sessionFile).find(r => r.toolName.startsWith("mcp__"));
  assert.ok(peer.logs().some(e => e.event === "http-expire"));
  assert.equal(result.isError, true);
  assert.equal(peer.logs().filter(e => e.event === "call-start").length, 0, "Native retry must not reach a changed tool implementation");
});

test("selected malformed output schemas fail before submitting any model prompt", { timeout: 15000 }, async t => {
  const f = fixture(t), behavior = join(f.dir, "invalid-output.json");
  writeFileSync(behavior, JSON.stringify({ tools: [{ name: "echo", outputSchema: { type: "not-a-type" } }] }));
  f.plan.mcp = [f.stdio("local", { tools: ["echo"], behaviorFile: behavior })];
  await assert.rejects(f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan }), /schema|readiness/i);
  assert.equal(f.requests().length, 0);
});

test("valid remote output schemas keep their own root-relative reference scope", { timeout: 15000 }, async t => {
  const f = fixture(t), behavior = join(f.dir, "valid-output-refs.json");
  writeFileSync(behavior, JSON.stringify({ tools: [{ name: "echo", outputSchema: { type: "object", properties: { value: { $ref: "#/$defs/V" } }, $defs: { V: { type: "string" } } } }] }));
  f.plan.mcp = [f.stdio("local", { tools: ["echo"], behaviorFile: behavior })];
  const record = await f.launch("INSPECT"); assert.equal(record.roleRuns![0].snapshot!.preflightComplete, true);
});

test("runtime HTTP transport diagnostics redact referenced credentials without changing ordinary error classification", { timeout: 15000 }, async t => {
  const f = fixture(t), before = process.env.M3_HTTP_RUNTIME_SECRET;
  t.after(() => { if (before === undefined) delete process.env.M3_HTTP_RUNTIME_SECRET; else process.env.M3_HTTP_RUNTIME_SECRET = before; });
  process.env.M3_HTTP_RUNTIME_SECRET = "private-runtime-secret";
  const behavior = join(f.dir, "http-error.json"); writeFileSync(behavior, JSON.stringify({ callHttpStatus: 403, callHttpBody: "denied Bearer private-runtime-secret (private-runtime-secret)" }));
  const peer = await startRoleMcpPeer({ id: "errors", http: true, tools: ["echo"], behaviorFile: behavior }); t.after(() => peer.stop());
  f.plan.mcp = [{ server: "errors", config: { url: peer.url!, headers: { Authorization: "Bearer ${M3_HTTP_RUNTIME_SECRET}" } }, tools: ["echo"] }];
  const record = await f.launch("RAW errors/echo");
  const result = toolResults(record.sessionFile).find(r => r.toolName.startsWith("mcp__"));
  assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /403/);
  assert.doesNotMatch(readFileSync(f.manager.store.path(record.id), "utf8"), /private-runtime-secret/);
  assert.doesNotMatch(readFileSync(record.sessionFile, "utf8"), /private-runtime-secret/);
});

test("parent shutdown cancels a role still discovering MCP and leaves no local peer", { timeout: 15000 }, async t => {
  const f = fixture(t); f.plan.mcp = [f.stdio("shutdown_peer", { tools: ["echo"], initDelayMs: 10000 })];
  const launch = f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan }); const rejection = assert.rejects(launch);
  await until(() => f.events("shutdown_peer").some(e => e.event === "start"), "peer before parent shutdown");
  await f.manager.shutdown(); await rejection;
  assert.equal(f.requests().length, 0); assert.equal([...f.manager.records.values()][0].stopped, true);
  await until(() => f.events("shutdown_peer").some(e => e.event === "stop"), "peer after parent shutdown");
});

test("role wrapper filters both initial and late extension MCP registrations, including same-name overrides", { timeout: 15000 }, async t => {
  const f = fixture(t), injected = join(f.dir, "injected-provider.ts"), marker = join(f.dir, "unexpected-registration");
  const trap = { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] };
  writeFileSync(injected, `import fixture from ${JSON.stringify(provider)}; export default pi => {fixture(pi); pi.registerMcpServer('local',${JSON.stringify(trap)}); pi.on('session_start',()=>{pi.registerMcpServer('late',${JSON.stringify(trap)});});};`);
  f.plan.providerExtensions = [injected]; f.plan.mcp = [f.stdio("local", { tools: ["echo"] })];
  await f.launch("RAW local/echo");
  assert.equal(existsSync(marker), false);
  assert.equal(f.events("local").filter(e => e.event === "start").length, 1);
});

test("role HTTP credentials stay in memory and failed authentication produces zero model requests", { timeout: 15000 }, async t => {
  const f = fixture(t), before = process.env.M3_HTTP_CREDENTIAL;
  t.after(() => { if (before === undefined) delete process.env.M3_HTTP_CREDENTIAL; else process.env.M3_HTTP_CREDENTIAL = before; });
  const peer = await startRoleMcpPeer({ id: "secure", http: true, tools: ["echo"], secretExpected: "Bearer private-http-credential" }); t.after(() => peer.stop());
  process.env.M3_HTTP_CREDENTIAL = "private-http-credential";
  f.plan.mcp = [{ server: "secure", config: { url: peer.url!, headers: { Authorization: "Bearer ${M3_HTTP_CREDENTIAL}" } }, tools: ["echo"] }];
  const record = await f.launch("RAW secure/echo");
  assert.doesNotMatch(readFileSync(f.manager.store.path(record.id), "utf8"), /private-http-credential/);
  assert.ok(peer.logs().some(e => e.headerMatches === true || e.credentialMatches === true));
  const count = f.requests().length; process.env.M3_HTTP_CREDENTIAL = "incorrect-private-credential";
  await assert.rejects(f.manager.continue(record.id, "NEVER_MODEL", "full"), /readiness|authentication/i);
  assert.equal(f.requests().length, count); assert.equal(record.stopped, true);
  assert.doesNotMatch(JSON.stringify(record), /private-http-credential|incorrect-private-credential/);
  assert.equal(peer.process.exitCode, null);
});

test("role credential references rotate without leaking resolved values into records, snapshots or diagnostic logs", { timeout: 20000 }, async t => {
  const f = fixture(t), before = process.env.M3_ROTATING_TOKEN;
  t.after(() => { if (before === undefined) delete process.env.M3_ROTATING_TOKEN; else process.env.M3_ROTATING_TOKEN = before; });
  const behavior = join(f.dir, "credential-expectation.json"); writeFileSync(behavior, JSON.stringify({ expectedToken: "secret-one" }));
  f.plan.mcp = [f.stdio("local", { tools: ["echo"], tokenEnv: "TOKEN", behaviorFile: behavior })];
  f.plan.mcp[0].config.env = { TOKEN: "${M3_ROTATING_TOKEN}" };
  process.env.M3_ROTATING_TOKEN = "secret-one";
  const record = await f.launch("RAW local/echo");
  const baseline = structuredClone(record.roleBaseline);
  // Only the peer's test expectation changes; authored role credential reference remains frozen.
  process.env.M3_ROTATING_TOKEN = "secret-two"; writeFileSync(behavior, JSON.stringify({ expectedToken: "secret-two" }));
  await f.manager.continue(record.id, "RAW local/echo", "full"); await until(() => record.stopped);
  assert.equal(record.state, "completed", record.error);
  assert.ok(f.events("local").filter(e => e.event === "start").every(e => e.tokenMatches));
  assert.deepEqual(record.roleBaseline, baseline);
  const durable = readFileSync(f.manager.store.path(record.id), "utf8");
  assert.doesNotMatch(durable, /secret-one|secret-two/);
  assert.match(durable, /M3_ROTATING_TOKEN/);
  delete process.env.M3_ROTATING_TOKEN;
  const count = f.requests().length;
  await assert.rejects(f.manager.continue(record.id, "NEVER_MODEL", "full"), /M3_ROTATING_TOKEN/);
  assert.equal(f.requests().length, count);
  assert.doesNotMatch(JSON.stringify(record.log), /secret-one|secret-two/);
});
