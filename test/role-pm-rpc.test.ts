import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { startRoleMcpPeer } from "./fixtures/role-mcp-peer.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { loadout } from "./fixtures/loadout.ts";
const pkg = getPackageDir(), cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
const entry = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url)), provider = fileURLToPath(new URL("./fixtures/role-team-provider.ts", import.meta.url));
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "role-pm-rpc-")); mkdirSync(join(dir, ".pi"));
  const config = join(dir, ".pi/agent-mesh.yaml"), session = join(dir, "parent.jsonl"), log = join(dir, "requests.jsonl");
  const role = join(dir, ".pi/pm.yaml"), body = join(dir, ".pi/pm.md");
  writeFileSync(body, "ROLE_TEAM_PM_ORIGINAL"); writeFileSync(role, "schema_version: 1\nid: pm\ndescription: PM fixture\nsystem_prompt: ./pm.md\nbuiltin_tools: [read, grep, find, ls]\ndefaults: {access: read-only}\n");
  writeFileSync(config, "schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: ./pm.yaml, builder: 'builtin:builder', tester: 'builtin:tester', reviewer: 'builtin:reviewer'}\nmcp_servers: {}\n");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_AGENT_MESH_CONFIG: "", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ROLE_TEAM_LOG: log };
  for (const key of Object.keys(env)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete env[key];
  const events: any[] = []; const processes: RpcProcess[] = [];
  const open = (extensions: string[] = [], extra: string[] = [], nativeDefaults = false) => {
    const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env, args: [cli, "--mode", "rpc", "--session", session, ...(nativeDefaults ? [] : ["--no-extensions"]), "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve", "--model", "role-team-fixture/pm", "--thinking", "off", "-e", provider, "-e", entry, ...extensions.flatMap(e => ["-e", e]), ...extra] });
    rpc.on("event", event => events.push(event)); processes.push(rpc); return rpc;
  };
  t.after(async () => { await Promise.allSettled(processes.map(rpc => rpc.stop())); rmSync(dir, { recursive: true, force: true }); });
  const requests = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return { dir, config, session, role, body, env, events, open, requests };
}
async function idle(rpc: RpcProcess, check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check() || (await rpc.request("get_state")).isStreaming) { if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture result"); await new Promise(r => setTimeout(r, 20)); }
}
const call = (rpc: RpcProcess, name: string, args: unknown) => rpc.request("prompt", { message: `CALL ${JSON.stringify({ name, arguments: args })}` });
function seedRecovery(f: ReturnType<typeof fixture>) {
  const now = new Date().toISOString(), sessionId = "pm-gate";
  writeFileSync(f.session, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now, cwd: f.dir }) + "\n");
  const store = new TaskStore(join(f.dir, "rpc-subagents", sessionId));
  for (const [index, question] of [false, true].entries()) {
    const id = `00000000-0000-0000-0000-00000000000${index}`, childSession = join(f.dir, `recovered-${index}.jsonl`);
    writeFileSync(childSession, JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: f.dir }) + "\n");
    const base = { ...loadout(f.dir), tools: ["ask_question"], toolMetadata: [], extensions: [], skills: [], model: "role-team-fixture/worker", thinking: "off", agentDir: join(f.dir, "agent"), providerExtensions: [provider] };
    store.save({ version: 2, id, name: `recover-${index}`, task: question ? "CHILD_QUESTION" : "RECOVERY_RESULT", access: "read-only", context: "none", loadout: base, availableLoadout: base,
      state: "failed", startedAt: Date.now(), updatedAt: Date.now(), sessionFile: childSession, output: "RECOVERY_RESULT", activity: "interrupted", log: [], questions: [], stopped: question, run: 1,
      execution: { boundary: { kind: "systemd", unit: "unused-pm-gate" } as any, cleanup: question ? "confirmed" : "pending", intent: question ? "interrupted" : "failed" }, recovery: { phase: "cleaning", attempts: question ? 0 : 4 } });
  }
}
function records(dir: string, suffix = "") : any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? records(join(dir, e.name), suffix) : /^[a-f0-9-]{36}\.json$/.test(e.name) ? [JSON.parse(readFileSync(join(dir, e.name), "utf8"))] : []);
}

for (const fails of [false, true]) test(`PM readiness gates actual recovery results and worker questions (failed=${fails})`, { timeout: 25000 }, async t => {
  const f = fixture(t), peer = await startRoleMcpPeer({ id: "gate", http: true, tools: fails ? ["other"] : ["echo"], initDelayMs: 3500 }); t.after(() => peer.stop());
  writeFileSync(f.role, 'schema_version: 1\nid: pm\ndescription: gated PM\nsystem_prompt: ./pm.md\nbuiltin_tools: [read]\nmcp: [{server: gate, tools: [echo]}]\ndefaults: {access: full}\n');
  writeFileSync(f.config, `schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: ./pm.yaml}\nmcp_servers: {gate: {url: ${JSON.stringify(peer.url)}}}\n`);
  seedRecovery(f); const rpc = f.open();
  const deadline = Date.now() + 12000;
  while (!records(f.dir).some(r => r.questions?.length)) { if (Date.now() >= deadline) throw new Error(`No recovered question: ${JSON.stringify(f.events)} ${JSON.stringify(records(f.dir))}`); await new Promise(r => setTimeout(r, 20)); }
  assert.equal(f.requests().some(r => !r.child), false, "Neither a cleanup result nor a real recovering worker question may wake an unready PM");
  assert.ok(records(f.dir).some(r => r.recovery?.phase === "blocked"));
  await rpc.request("get_state");
  if (fails) {
    await rpc.request("prompt", { message: "must not reach failed PM provider" });
    assert.equal(f.requests().some(r => !r.child), false);
    assert.ok(f.events.some(e => JSON.stringify(e).includes("PM not ready")));
  } else {
    await idle(rpc, () => f.requests().some(r => !r.child));
    const first = f.requests().find(r => !r.child); assert.match(first.prompt, /ROLE_TEAM_PM_ORIGINAL/);
    const messages = JSON.stringify(first.messages); assert.match(messages, /RECOVERY_RESULT/); assert.match(messages, /Which acceptance target/);
  }
});

test("PM native MCP router replaces ambient builtin connections and preserves selected local-tool provenance", { timeout: 25000 }, async t => {
  const f = fixture(t), peer = await startRoleMcpPeer({ id: "pm", http: true, tools: ["echo", "unselected"] }); t.after(() => peer.stop());
  const local = join(f.dir, ".pi/tool.ts");
  writeFileSync(local, 'export default pi => { pi.registerTool({name:"pm_local",label:"PM local",description:"Selected fixture",parameters:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:"PM_LOCAL_OK"}],details:{}}}}); }');
  writeFileSync(f.role, 'schema_version: 1\nid: pm\ndescription: PM full\nsystem_prompt: ./pm.md\nbuiltin_tools: [read]\nextra_tools: [{entry: ./tool.ts, tools: [pm_local]}]\nmcp: [{server: selected, tools: [echo]}]\ndefaults: {access: full}\n');
  writeFileSync(f.config, `schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: ./pm.yaml, builder: 'builtin:builder'}\nmcp_servers: {selected: {url: ${JSON.stringify(peer.url)}}}\n`);
  writeFileSync(join(f.dir, ".pi/mcp.json"), JSON.stringify({ mcpServers: { trap: { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('ambient-connected','bad')"] } } }));
  const rpc = f.open([], [], true);
  await call(rpc, "pm_local", {}); assert.equal(f.events.some(e => JSON.stringify(e).includes("PM not ready")), false, JSON.stringify(f.events)); await idle(rpc, () => f.requests().length >= 2);
  const first = f.requests()[0]; assert.ok(first.tools.includes("pm_local")); assert.ok(first.tools.includes("mcp__selected__echo")); assert.ok(!first.tools.some((n: string) => /unselected|resources|codemode/.test(n)));
  await call(rpc, "mcp__selected__echo", {}); await idle(rpc, () => peer.logs().some(e => e.event === "call-end"));
  assert.match(JSON.stringify((await rpc.request("get_messages")).messages), /PM_LOCAL_OK/);
  assert.equal(existsSync(join(f.dir, "ambient-connected")), false);
  const snapshot = readFileSync(f.session, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.customType === "agent_mesh_pm").data;
  assert.ok(snapshot.tools.some((tool: any) => tool.semanticKind === "local-tool" && tool.entry === local));
  assert.ok(snapshot.tools.some((tool: any) => tool.semanticKind === "mcp" && tool.server === "selected"));
  assert.equal(f.events.some(e => e.type === "extension_error"), false, JSON.stringify(f.events));
  await rpc.stop(); assert.equal(peer.process.exitCode, null); assert.ok(peer.logs().some(e => e.event === "http-close"));
});

test("public DAG freezes role/model/context precedence and omits Reviewer upstream text but retains code edges", { timeout: 30000 }, async t => {
  const f = fixture(t), rpc = f.open();
  await call(rpc, "workflow_run", { context: "partial", contextText: "WORKFLOW_SELECTED", model: "role-team-fixture/worker", steps: [
    { id: "build", role: "builder", task: "CHILD_INSPECT BUILD_REPORT_MARKER", dependsOn: [] },
    { id: "review", role: "reviewer", model: "role-team-fixture/override", task: "CHILD_INSPECT", dependsOn: ["build"] },
  ] });
  await idle(rpc, () => records(f.dir).some(r => r.steps?.length === 2 && r.state === "completed"));
  const flow = records(f.dir).find(r => r.steps?.length === 2), children = f.requests().filter(r => r.child);
  assert.equal(flow.version, 2); assert.equal(flow.steps[0].rolePlan.model, "role-team-fixture/worker"); assert.equal(flow.steps[0].context, "partial"); assert.equal(flow.steps[0].contextText, "WORKFLOW_SELECTED");
  assert.equal(flow.steps[1].model, "role-team-fixture/override"); assert.equal(flow.steps[1].context, "none"); assert.equal(flow.steps[1].dependencyReports, "omit"); assert.deepEqual(flow.steps[1].dependsOn, ["build"]);
  const review = children.find(r => r.model === "role-team-fixture/override"); assert.doesNotMatch(JSON.stringify(review.messages), /WORKFLOW_SELECTED|BUILD_REPORT_MARKER|Direct dependency results|ROLE_TEAM_PM_ORIGINAL/);
  assert.equal(f.events.some(e => e.type === "extension_error"), false, JSON.stringify(f.events));
});

for (const broken of ["invalid-config", "missing-explicit", "cli-filter", "untrusted-executable"] as const) test(`PM startup ${broken} cannot silently fall back or issue a model request`, { timeout: 20000 }, async t => {
  const f = fixture(t);
  if (broken === "invalid-config") writeFileSync(f.config, readFileSync(f.config, "utf8") + "unknown: true\n");
  if (broken === "missing-explicit") f.env.PI_AGENT_MESH_CONFIG = join(f.dir, "missing-team.yaml");
  if (broken === "untrusted-executable") {
    writeFileSync(join(f.dir, ".pi/tool.ts"), "require('node:fs').writeFileSync('untrusted-ran','bad'); export default () => {};");
    writeFileSync(f.role, 'schema_version: 1\nid: pm\ndescription: PM\nsystem_prompt: ./pm.md\nbuiltin_tools: []\nextra_tools: [{entry: ./tool.ts, tools: [unsafe]}]\ndefaults: {access: full}\n');
  }
  const extra = broken === "cli-filter" ? ["--tools", "read"] : broken === "untrusted-executable" ? ["--no-approve"] : [];
  const rpc = f.open([], extra);
  await rpc.request("prompt", { message: "should be handled with startup diagnostic" });
  assert.equal(f.requests().length, 0); assert.equal(existsSync(join(f.dir, "untrusted-ran")), false);
  assert.ok(f.events.some(e => JSON.stringify(e).includes("PM not ready")), JSON.stringify(f.events));
});

test("enabled team prepares and durably snapshots the PM before its very first provider request", { timeout: 25000 }, async t => {
  const f = fixture(t), rpc = f.open();
  await rpc.request("prompt", { message: "first PM input" }); await idle(rpc, () => f.requests().length > 0);
  const first = f.requests()[0]; assert.match(first.prompt, /ROLE_TEAM_PM_ORIGINAL/); assert.equal(first.prompt.split("ROLE_TEAM_PM_ORIGINAL").length - 1, 1);
  assert.doesNotMatch(first.prompt, /You are the Builder|You are the Tester|You are the Reviewer/);
  assert.deepEqual(first.tools.sort(), ["find", "grep", "ls", "read", "roles_list", "subagent", "subagent_control", "workflow_control", "workflow_run"].sort());
  assert.match(readFileSync(f.session, "utf8"), /agent_mesh_pm/);
  assert.equal(f.events.some(e => e.type === "extension_error"), false, JSON.stringify(f.events));
});

test("reload changes new dispatch but not current PM, while a new session adopts the new PM body", { timeout: 30000 }, async t => {
  const f = fixture(t); let rpc = f.open();
  await rpc.request("prompt", { message: "original" }); await idle(rpc, () => f.requests().length > 0);
  writeFileSync(f.body, "ROLE_TEAM_PM_CHANGED");
  await rpc.request("prompt", { message: "/roles reload" });
  await rpc.request("prompt", { message: "still same PM" }); await idle(rpc, () => f.requests().length >= 2);
  assert.match(f.requests().at(-1).prompt, /ROLE_TEAM_PM_ORIGINAL/); assert.doesNotMatch(f.requests().at(-1).prompt, /ROLE_TEAM_PM_CHANGED/);
  await rpc.stop(); const before = f.requests().length;
  rpc = f.open([], ["--session", join(f.dir, "new-parent.jsonl")]);
  await rpc.request("prompt", { message: "new PM" }); await idle(rpc, () => f.requests().length > before);
  assert.match(f.requests().at(-1).prompt, /ROLE_TEAM_PM_CHANGED/); assert.doesNotMatch(f.requests().at(-1).prompt, /ROLE_TEAM_PM_ORIGINAL/);
});

test("PM snapshot survives manifest deletion and bad current catalog while existing task management stays available", { timeout: 30000 }, async t => {
  const f = fixture(t); let rpc = f.open(); await rpc.request("prompt", { message: "initial PM" }); await idle(rpc, () => f.requests().length > 0); await rpc.stop();
  rmSync(f.role); writeFileSync(f.body, "ROLE_TEAM_PM_CHANGED");
  rpc = f.open(); const before = f.requests().length;
  await rpc.request("prompt", { message: "resumed PM" }); await idle(rpc, () => f.requests().length > before);
  assert.match(f.requests().at(-1).prompt, /ROLE_TEAM_PM_ORIGINAL/); assert.doesNotMatch(f.requests().at(-1).prompt, /ROLE_TEAM_PM_CHANGED/);
  await call(rpc, "subagent_control", { action: "list" }); await idle(rpc, () => f.requests().length >= before + 3);
  assert.match(JSON.stringify((await rpc.request("get_messages")).messages), /No tasks/);
  await call(rpc, "subagent", { role: "builder", task: "CHILD_INSPECT", contextText: "original acceptance" });
  await idle(rpc, () => f.requests().length >= before + 5);
  assert.match(JSON.stringify((await rpc.request("get_messages")).messages), /catalog|configuration|pm.yaml/i);
  assert.equal(f.requests().some(r => r.child), false);
});

test("a packaged custom role with a new ID dispatches its selected local tool without scheduler changes", { timeout: 20000 }, async t => {
  const f = fixture(t); f.env.PI_AGENT_MESH_CONFIG = fileURLToPath(new URL("../examples/role-resources/local/team.yaml", import.meta.url));
  const rpc = f.open();
  await call(rpc, "subagent", { role: "greeter", task: 'CALL {"name":"greet","arguments":{"name":"Ada"}}' });
  await idle(rpc, () => records(f.dir).some(r => r.rolePlan?.roleId === "greeter" && r.stopped));
  const child = records(f.dir).find(r => r.rolePlan?.roleId === "greeter");
  assert.equal(child.state, "completed", child.error); assert.match(child.output, /Hello, Ada!/); assert.equal(child.context, "none");
  assert.deepEqual(child.loadout.tools, ["read", "greet", "ask_question"]);
  assert.equal(f.events.some(e => e.type === "extension_error"), false, JSON.stringify(f.events));
});

test("role model overrides clamp inherited thinking to the selected model's supported levels", { timeout: 25000 }, async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, ".pi/builder.md"), "NONREASONING_BUILDER");
  writeFileSync(join(f.dir, ".pi/builder.yaml"), "schema_version: 1\nid: builder\ndescription: Builder\nsystem_prompt: ./builder.md\nbuiltin_tools: []\ndefaults: {access: read-only, context: none, model: role-team-fixture/worker}\n");
  writeFileSync(f.config, readFileSync(f.config, "utf8").replace("builder: 'builtin:builder'", "builder: ./builder.yaml"));
  const rpc = f.open([], ["--model", "role-team-fixture/reasoner", "--thinking", "high"]);
  await call(rpc, "subagent", { role: "builder", task: "CHILD_INSPECT" });
  await idle(rpc, () => f.events.some(e => e.type === "tool_execution_end" && e.toolName === "subagent"));
  const receipt = f.events.find(e => e.type === "tool_execution_end" && e.toolName === "subagent");
  assert.equal(receipt.isError, false, JSON.stringify(receipt));
  await idle(rpc, () => f.requests().some(r => r.child));
  assert.equal(f.requests().find(r => r.child).model, "role-team-fixture/worker");
  const task = records(f.dir).find(r => r.rolePlan?.roleId === "builder"); assert.equal(task.rolePlan.thinking, "off");
});

test("public role dispatch gives Builder bash independently of the PM and defaults Reviewer to none/read-only", { timeout: 30000 }, async t => {
  const f = fixture(t), rpc = f.open();
  await call(rpc, "subagent", { role: "builder", task: "CHILD_BASH", contextText: "Run deterministic acceptance printf" });
  await idle(rpc, () => f.requests().some(r => r.child && r.tools.includes("bash")) && f.events.some(e => e.type === "message_end" && JSON.stringify(e.message).includes("ROLE_TEAM_BASH_OK")));
  assert.equal(f.requests().find(r => !r.child).tools.includes("bash"), false);
  const receipt = f.events.find(e => e.type === "tool_execution_end" && e.toolName === "subagent" && !e.isError);
  assert.match(JSON.stringify(receipt.result), /role=builder.*config=[a-f0-9]+.*access=full.*model=role-team-fixture\/pm.*context=partial/);
  const before = f.requests().filter(r => r.child).length;
  await call(rpc, "subagent", { role: "reviewer", task: "CHILD_INSPECT" });
  await idle(rpc, () => f.requests().filter(r => r.child).length > before);
  const reviewer = f.requests().filter(r => r.child).at(-1); assert.deepEqual(reviewer.tools, ["read", "grep", "find", "ls", "ask_question"]);
  assert.doesNotMatch(reviewer.prompt, /ROLE_TEAM_PM_ORIGINAL/);
  await call(rpc, "subagent", { task: "legacy must still specify access", context: "none" });
  await idle(rpc, () => f.events.some(e => e.type === "tool_execution_end" && e.toolName === "subagent" && e.isError));
  assert.match(JSON.stringify((await rpc.request("get_messages")).messages), /access.*read-only.*full|access.*required/);
});
