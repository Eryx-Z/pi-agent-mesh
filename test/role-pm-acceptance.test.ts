import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { startRoleMcpPeer } from "./fixtures/role-mcp-peer.ts";

const pkg = getPackageDir(), cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
const mesh = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/role-team-provider.ts", import.meta.url));
const inspectPrefix = "PM_ACCEPTANCE_INSPECT ";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "role-pm-acceptance-")), transcripts = join(dir, "transcripts");
  mkdirSync(join(dir, ".pi")); mkdirSync(transcripts);
  const config = join(dir, ".pi/agent-mesh.yaml"), role = join(dir, ".pi/pm.yaml"), session = join(transcripts, "parent.jsonl"), log = join(dir, "requests.jsonl");
  writeFileSync(join(dir, ".pi/pm.md"), "PM_ACCEPTANCE");
  writeFileSync(role, "schema_version: 1\nid: pm\ndescription: PM acceptance\nsystem_prompt: ./pm.md\nbuiltin_tools: []\ndefaults: {access: read-only}\n");
  const validConfig = "schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: ./pm.yaml}\nmcp_servers: {}\n";
  writeFileSync(config, validConfig);
  const inspector = join(dir, "inspect.mjs");
  writeFileSync(inspector, `export default pi => pi.registerCommand('pm-acceptance-inspect', {description:'Inspect public PM state', handler(_args,ctx) {ctx.ui.notify(${JSON.stringify(inspectPrefix)}+JSON.stringify({entries:ctx.sessionManager.getBranch(),sessionId:ctx.sessionManager.getSessionId(),commands:pi.getCommands()}),'info');}});`);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_AGENT_MESH_CONFIG: "", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ROLE_TEAM_LOG: log };
  for (const key of Object.keys(env)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete env[key];
  const events: any[] = [], processes: RpcProcess[] = [];
  const open = (before: string[] = [], after: string[] = []) => {
    const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env, args: [cli, "--mode", "rpc", "--session", session, "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve", "--model", "role-team-fixture/pm", "--thinking", "off", ...[provider, inspector, ...before, mesh, ...after].flatMap(e => ["-e", e])] });
    rpc.on("event", event => events.push(event)); processes.push(rpc); return rpc;
  };
  t.after(async () => {
    await Promise.allSettled(processes.map(rpc => rpc.stop()));
    chmodSync(transcripts, 0o700); rmSync(dir, { recursive: true, force: true });
  });
  const requests = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const inspect = async (rpc: RpcProcess) => {
    const from = events.length;
    await rpc.request("prompt", { message: "/pm-acceptance-inspect" });
    const event = events.slice(from).find(e => e.method === "notify" && e.message?.startsWith(inspectPrefix));
    assert.ok(event, JSON.stringify(events));
    return JSON.parse(event.message.slice(inspectPrefix.length));
  };
  const failurePaths = () => readdirSync(transcripts).filter(name => /^parent\.jsonl\.agent-mesh-pm-failure-[a-f0-9-]{36}\.json$/.test(name)).map(name => join(transcripts, name));
  return { dir, transcripts, config, role, session, validConfig, events, open, requests, inspect, failurePaths };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PM acceptance evidence");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function failedEntry(state: any) {
  const entry = state.entries.findLast((entry: any) => entry.type === "custom" && entry.customType === "agent_mesh_pm_failure");
  assert.ok(entry, JSON.stringify(state)); return entry.data;
}

for (const order of ["before", "after"] as const) test(`PM rejects an independent native MCP owner loaded ${order} mesh before selecting its model or resources`, { timeout: 25000 }, async t => {
  const f = fixture(t), peer = await startRoleMcpPeer({ id: `competing_${order}`, http: true, tools: ["echo"] });
  t.after(() => peer.stop());
  const competitor = join(f.dir, "competing-native.mjs"), localMarker = join(f.dir, "pm-local-imported");
  writeFileSync(competitor, `import {createMcpExtension} from ${JSON.stringify(join(pkg, "dist/index.js"))}; export default createMcpExtension();`);
  writeFileSync(join(f.dir, ".pi/mcp.json"), JSON.stringify({ mcpServers: { outside_plan: { url: peer.url } } }));
  writeFileSync(join(f.dir, ".pi/local.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(localMarker)},'loaded'); export default pi => pi.registerTool({name:'pm_acceptance_local',label:'PM acceptance',description:'PM acceptance',parameters:{type:'object',properties:{}},async execute(){return {content:[],details:{}}}});`);
  writeFileSync(f.role, "schema_version: 1\nid: pm\ndescription: PM acceptance\nsystem_prompt: ./pm.md\nbuiltin_tools: []\nextra_tools: [{entry: ./local.mjs, tools: [pm_acceptance_local]}]\ndefaults: {access: full, model: role-team-fixture/override}\n");
  const rpc = f.open(order === "before" ? [competitor] : [], order === "after" ? [competitor] : []);
  const state = await f.inspect(rpc);
  const owners = state.commands.filter((command: any) => /^mcp(?::\d+)?$/.test(command.name) && command.source === "extension");
  assert.equal(owners.length, 2, "Public getCommands exposes both owners, including native duplicate invocation suffixes");
  assert.ok(owners.some((command: any) => command.sourceInfo.path === competitor));
  assert.equal(f.events.some(e => e.method === "setStatus" && /PM .* ready/.test(e.statusText)), false, JSON.stringify(f.events));
  const failure = failedEntry(state);
  assert.match(failure.error, /MCP.*conflict|conflict.*MCP/i); assert.ok(failure.error.includes(competitor));
  assert.equal(existsSync(localMarker), false, "PM must reject ownership before importing selected executable resources");
  assert.equal((await rpc.request("get_state")).model.id, "pm", "Conflict must be checked before native model selection");
  await rpc.request("prompt", { message: "must not start an unsafe PM" });
  assert.deepEqual(f.requests(), []);
  // Public Pi cannot cancel another extension's lifecycle handler. Refusal is not a sandbox:
  // the independently owned native extension can still connect, but PM never becomes ready.
  await until(() => peer.logs().some(event => event.event === "initialize"));
  await rpc.stop(); assert.equal(f.failurePaths().length, 1);
});

for (const order of ["before", "after"] as const) test(`PM rejects a selected local entry independently loaded ${order} mesh instead of accepting an unmanaged owner`, { timeout: 20000 }, async t => {
  const f = fixture(t), entry = join(f.dir, ".pi/independent-local.mjs");
  writeFileSync(entry, "export default pi => pi.registerTool({name:'pm_selected',label:'Selected',description:'Selected local',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'selected'}],details:{}}}});");
  writeFileSync(f.role, "schema_version: 1\nid: pm\ndescription: PM duplicate local\nsystem_prompt: ./pm.md\nbuiltin_tools: []\nextra_tools: [{entry: ./independent-local.mjs, tools: [pm_selected]}]\ndefaults: {access: full}\n");
  const rpc = f.open(order === "before" ? [entry] : [], order === "after" ? [entry] : []), state = await f.inspect(rpc);
  const failure = failedEntry(state);
  assert.match(failure.error, /local.*ownership.*conflict/i); assert.ok(failure.error.includes("pm_selected"));
  assert.equal(f.events.some(e => e.method === "setStatus" && /PM .* ready/.test(e.statusText)), false);
  await rpc.request("prompt", { message: "must not dispatch with an independently owned local entry" });
  assert.deepEqual(f.requests(), []);
});

test("fresh PM startup failure is durable before any conversation and leaves native first-flush ownership intact", { timeout: 25000 }, async t => {
  const f = fixture(t); writeFileSync(f.config, f.validConfig + "unknown_field: true\n");
  const rpc = f.open(), state = await f.inspect(rpc), failure = failedEntry(state);
  assert.equal(f.failurePaths().length, 1, "A custom entry alone is not persisted by native Pi on a fresh session");
  const path = f.failurePaths()[0], retained = readFileSync(path, "utf8"), record = JSON.parse(retained);
  assert.equal(failure.recordPath, path); assert.equal(record.error, failure.error);
  assert.equal(record.state, "failed"); assert.equal(record.sessionFile, f.session); assert.equal(record.sessionId, state.sessionId);
  assert.ok(Number.isFinite(Date.parse(record.timestamp)));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(f.events.some(e => e.method === "notify" && e.message.includes(path)), "Failure must advertise its inspectable path");
  await rpc.request("prompt", { message: "blocked before the first conversation" });
  assert.deepEqual((await rpc.request("get_messages")).messages, []); assert.deepEqual(f.requests(), []);
  assert.equal(existsSync(f.session), false, "The extension must not materialize the host-owned session file");
  await rpc.stop(); assert.equal(readFileSync(path, "utf8"), retained);
  assert.ok(!readdirSync(f.transcripts).some(name => name.endsWith(".tmp")));
  writeFileSync(f.config, f.validConfig);
  const recovered = f.open(); await recovered.request("prompt", { message: "valid new startup" });
  await until(async () => f.requests().length > 0 && !(await recovered.request("get_state")).isStreaming);
  assert.ok(existsSync(f.session), "A later native first conversation must still flush with wx successfully");
  assert.match(readFileSync(f.session, "utf8"), /agent_mesh_pm/);
  assert.equal(readFileSync(path, "utf8"), retained);
});

test("startup failure sidecars are immutable across attempts and preserve existing transcripts, files, symlinks and modes", { timeout: 25000 }, async t => {
  const f = fixture(t), now = new Date().toISOString();
  const original = JSON.stringify({ type: "session", version: 3, id: "pm-existing-failure", cwd: f.dir, timestamp: now }) + "\n";
  writeFileSync(f.session, original, { mode: 0o640 });
  const sentinel = `${f.session}.agent-mesh-pm-failure.json`, linked = `${f.session}.agent-mesh-pm-failure-00000000-0000-0000-0000-000000000000.json`;
  writeFileSync(sentinel, "UNRELATED_RECORD", { mode: 0o640 }); symlinkSync(sentinel, linked);
  writeFileSync(f.config, f.validConfig + "unknown_field: true\n");
  const rpc = f.open(); await f.inspect(rpc); await rpc.stop();
  const first = f.failurePaths().filter(path => path !== linked);
  assert.equal(first.length, 1); const retained = readFileSync(first[0], "utf8");
  const second = f.open(); await f.inspect(second); await second.stop();
  assert.equal(f.failurePaths().filter(path => path !== linked).length, 2);
  assert.equal(readFileSync(first[0], "utf8"), retained);
  assert.ok(readFileSync(f.session, "utf8").startsWith(original));
  assert.equal(statSync(f.session).mode & 0o777, 0o640);
  assert.equal(readFileSync(sentinel, "utf8"), "UNRELATED_RECORD"); assert.equal(statSync(sentinel).mode & 0o777, 0o640); assert.ok(lstatSync(linked).isSymbolicLink());
  for (const path of f.failurePaths().filter(path => path !== linked)) {
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(path).nlink, 1);
  }
  assert.ok(!readdirSync(f.transcripts).some(name => name.endsWith(".tmp")));
});

test("an unwritable failure-record directory reports non-durability without replacing the PM startup error or crashing", { timeout: 20000, skip: process.getuid?.() === 0 ? "Root bypasses mode-bit write denial" : false }, async t => {
  const f = fixture(t); writeFileSync(f.config, f.validConfig + "unknown_field: true\n");
  const deny = join(f.dir, "deny-sidecar.mjs");
  // Leave TaskManager's independent directory writable; only deny sibling failure records.
  writeFileSync(deny, `import {chmodSync,mkdirSync} from 'node:fs';import {join} from 'node:path';export default pi => pi.on('session_start',(_event,ctx)=>{mkdirSync(join(ctx.sessionManager.getSessionDir(),'rpc-subagents',ctx.sessionManager.getSessionId()),{recursive:true});chmodSync(ctx.sessionManager.getSessionDir(),0o500);});`);
  const rpc = f.open([deny]), state = await f.inspect(rpc), failure = failedEntry(state);
  assert.match(failure.error, /unknown_field|additional properties/i);
  assert.match(failure.persistenceError, /EACCES|permission denied/i); assert.equal(failure.recordPath, undefined);
  assert.ok(f.events.some(e => e.method === "notify" && /not durable/i.test(e.message)), JSON.stringify(f.events));
  assert.ok(f.events.some(e => e.method === "setStatus" && e.statusText === "PM failed"));
  await rpc.request("prompt", { message: "still blocked" }); assert.deepEqual(f.requests(), []);
  assert.equal(existsSync(f.session), false); assert.deepEqual(f.failurePaths(), []);
  assert.equal(f.events.some(e => e.type === "extension_error"), false, JSON.stringify(f.events));
});

test("non-role sessions retain an explicitly loaded native MCP extension and normal model execution", { timeout: 25000 }, async t => {
  const f = fixture(t), peer = await startRoleMcpPeer({ id: "legacy_explicit", http: true, tools: ["echo"] }); t.after(() => peer.stop());
  rmSync(f.config);
  const competitor = join(f.dir, "ordinary-native.mjs");
  writeFileSync(competitor, `import {createMcpExtension} from ${JSON.stringify(join(pkg, "dist/index.js"))}; export default createMcpExtension();`);
  writeFileSync(join(f.dir, ".pi/mcp.json"), JSON.stringify({ mcpServers: { ordinary: { url: peer.url } } }));
  const rpc = f.open([], [competitor]); await rpc.request("get_state");
  await until(() => peer.logs().some(event => event.event === "initialize"));
  await rpc.request("prompt", { message: "ordinary no-role conversation" });
  await until(async () => f.requests().length > 0 && !(await rpc.request("get_state")).isStreaming);
  assert.ok(!f.events.some(e => e.method === "setStatus" && e.statusText === "PM failed"));
  assert.deepEqual(f.failurePaths(), []);
});
