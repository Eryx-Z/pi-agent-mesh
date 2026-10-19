import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RoleCatalog } from "../pi-extension/subagents/roles.ts";
import { createRolePlan } from "../pi-extension/subagents/role-loadout.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";

const pi = getPackageDir();
const cli = join(pi, JSON.parse(readFileSync(join(pi, "package.json"), "utf8")).bin.pi);
const provider = fileURLToPath(new URL("./fixtures/role-tasks-provider.ts", import.meta.url));
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Role task did not reach expected state");
}
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "role-tasks-rpc-"));
  const config = join(dir, "team.yaml");
  writeFileSync(config, "schema_version: 1\nenabled: true\nmain_role: builder\nroles:\n  builder: ./role.yaml\nmcp_servers: {}\n");
  writeFileSync(join(dir, "role.yaml"), "schema_version: 1\nid: builder\ndescription: Test builder\nsystem_prompt: ./system.md\nbuiltin_tools: [read, bash]\ndefaults: {access: full, context: none}\n");
  writeFileSync(join(dir, "system.md"), "SAVED_ROLE_BODY_ONLY\n");
  writeFileSync(join(dir, "fixture-input.txt"), "Role builtin read works");
  const manager = new TaskManager(new TaskStore(join(dir, "tasks")), { command: process.execPath, baseArgs: [cli] });
  t.after(async () => { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  function plan(access: "full" | "read-only" = "full", context: "none" | "partial" | "full" = "none") {
    const directory = new RoleCatalog(dir, config).reload();
    return createRolePlan(directory.roles[0], directory, { access, context, model: "role-fixture/test", thinking: "off", cwd: dir, agentDir: join(dir, "agent"), providerExtensions: [provider] });
  }
  return { dir, manager, plan };
}

test("role task uses saved role body, independent capabilities and per-run snapshots across access changes", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const record = await f.manager.launch({ task: "INSPECT_ROLE", access: "read-only", context: "none", rolePlan: f.plan("read-only") });
  await until(() => record.stopped);
  assert.equal(record.state, "completed", record.error);
  assert.equal(record.version, 3);
  assert.equal(record.loadout.version, 3);
  assert.match(record.output, /SAVED_ROLE_BODY_ONLY/);
  assert.deepEqual([...record.loadout.tools].sort(), ["ask_question", "read"]);
  assert.equal(record.roleRuns?.[0].status, "submitted");
  assert.ok(record.roleRuns?.[0].snapshot?.preflightComplete);
  const firstPlan = structuredClone(record.rolePlan);
  const firstSnapshot = structuredClone(record.roleRuns?.[0].snapshot);
  writeFileSync(join(f.dir, "system.md"), "NEW_ROLE_BODY_NOT_FOR_OLD_TASK\n");
  unlinkSync(join(f.dir, "role.yaml"));
  for (const access of ["full", "read-only", "full"] as const) {
    await f.manager.continue(record.id, "INSPECT_ROLE", access);
    await until(() => record.stopped);
    assert.equal(record.state, "completed", record.error);
    assert.match(record.output, /SAVED_ROLE_BODY_ONLY/);
    assert.doesNotMatch(record.output, /NEW_ROLE_BODY/);
    assert.deepEqual([...record.loadout.tools].sort(), access === "full" ? ["ask_question", "bash", "read"] : ["ask_question", "read"]);
    assert.deepEqual(record.rolePlan, firstPlan);
  }
  assert.equal(record.roleRuns?.length, 4);
  assert.deepEqual(record.roleRuns?.[0].snapshot, firstSnapshot);
  assert.ok(record.roleBaseline?.some(tool => tool.name === "bash"));
  const loaded = new TaskStore(join(f.dir, "tasks")).load()[0];
  assert.equal(loaded.roleRuns?.length, 4);
  assert.deepEqual(loaded.rolePlan, firstPlan);
});

test("role child loads only exact progressive skills and rejects skill/local resource drift before continuation", { timeout: 20000 }, async t => {
  const f = fixture(t);
  for (const name of ["visible", "hidden", "neighbor"]) {
    const path = join(f.dir, name); mkdirSync(path);
    writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ROLE_${name.toUpperCase()}_DESCRIPTION\ndisable-model-invocation: ${name === "hidden"}\n---\nROLE_${name.toUpperCase()}_BODY_MUST_STAY_PROGRESSIVE\n`);
  }
  const manifest = join(f.dir, "role.yaml");
  writeFileSync(manifest, readFileSync(manifest, "utf8") + "skills: [./visible/SKILL.md, ./hidden/SKILL.md]\n");
  const record = await f.manager.launch({ task: "INSPECT_ROLE", access: "full", context: "none", rolePlan: f.plan() });
  await until(() => record.stopped);
  assert.equal(record.state, "completed", record.error);
  assert.deepEqual(record.roleRuns![0].snapshot!.skills.map(s => s.name), ["visible", "hidden"]);
  const request = JSON.parse(readFileSync(join(f.dir, "model-called"), "utf8").trim().split("\n")[0]);
  assert.match(request.prompt, /ROLE_VISIBLE_DESCRIPTION/);
  assert.doesNotMatch(request.prompt, /ROLE_HIDDEN_DESCRIPTION|ROLE_NEIGHBOR|BODY_MUST_STAY_PROGRESSIVE/);
  assert.equal(request.prompt.split("SAVED_ROLE_BODY_ONLY").length - 1, 1);
  assert.equal(request.prompt.split("You are a delegated child").length - 1, 1);
  const old = structuredClone(record.roleRuns);
  writeFileSync(join(f.dir, "visible", "SKILL.md"), readFileSync(join(f.dir, "visible", "SKILL.md"), "utf8") + "drift\n");
  await assert.rejects(f.manager.continue(record.id, "MUST_NOT_SUBMIT", "read-only"), /hash changed/);
  assert.deepEqual(record.roleRuns, old);
  assert.equal(readFileSync(join(f.dir, "model-called"), "utf8").trim().split("\n").length, 1);
  unlinkSync(join(f.dir, "visible", "SKILL.md"));
  assert.equal(new TaskStore(join(f.dir, "tasks")).load()[0].state, "completed", "Deleted resources do not prevent historical display");
});

test("local tools are skipped read-only, freeze on first full enable, and source drift rejects upgrade without losing the last snapshot", { timeout: 20000 }, async t => {
  const f = fixture(t);
  const entry = join(f.dir, "local.ts");
  writeFileSync(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(f.dir, "local-imported"))}, 'yes');\nexport default pi => pi.registerTool({name:'local_run',label:'Run',description:'Local selected',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'LOCAL_EXECUTED'}]}}});\n`);
  const manifest = join(f.dir, "role.yaml");
  writeFileSync(manifest, readFileSync(manifest, "utf8") + "extra_tools: [{entry: ./local.ts, tools: [local_run]}]\n");
  const record = await f.manager.launch({ task: "INSPECT_ROLE", access: "read-only", context: "none", rolePlan: f.plan("read-only") });
  await until(() => record.stopped);
  assert.equal(record.state, "completed", record.error); assert.equal(existsSync(join(f.dir, "local-imported")), false);
  await f.manager.continue(record.id, "RUN_TOOL local_run", "full"); await until(() => record.stopped);
  assert.equal(record.state, "completed", record.error); assert.match(record.output, /LOCAL_EXECUTED/);
  assert.equal(existsSync(join(f.dir, "local-imported")), true);
  assert.ok(record.roleBaseline!.some(tool => tool.name === "local_run"));
  await f.manager.continue(record.id, "INSPECT_ROLE", "read-only"); await until(() => record.stopped);
  const last = structuredClone(record.roleRuns), baseline = structuredClone(record.roleBaseline);
  writeFileSync(entry, readFileSync(entry, "utf8") + "// drift\n");
  await assert.rejects(f.manager.continue(record.id, "MUST_NOT_SUBMIT", "full"), /hash changed/);
  assert.deepEqual(record.roleRuns, last); assert.deepEqual(record.roleBaseline, baseline);
  assert.equal(new TaskStore(join(f.dir, "tasks")).load()[0].roleRuns!.length, 3);
});

test("role preflight failure cannot submit a model prompt even if command RPC receipt succeeds", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const plan = f.plan();
  // Pi may acknowledge a failing slash command; the private result must still fail closed.
  const entry = join(f.dir, "invalid-tool.ts"), source = "export default pi => { pi.on('input', () => ({action:'handled'})); };\n";
  writeFileSync(entry, source);
  const missing = { ...plan, extraTools: [{ entry, hash: createHash("sha256").update(source).digest("hex"), tools: ["required_tool"] }] };
  await assert.rejects(f.manager.launch({ task: "MUST_NOT_SUBMIT", access: "full", context: "none", rolePlan: missing }), /preflight|tool-only|unsupported/i);
  const record = [...f.manager.records.values()][0];
  assert.ok(record.stopped);
  assert.equal(record.state, "failed");
  assert.equal(record.roleRuns?.[0].snapshot, undefined);
  assert.equal(existsSync(join(f.dir, "model-called")), false);
});

test("role task persists complete partial input before any child starts", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const record = await f.manager.launch({ task: "INSPECT_ROLE", access: "full", context: "partial", contextText: "EXPLICIT_SELECTED_CONTEXT", rolePlan: f.plan("full", "partial"), parentSession: "/parent/session.jsonl" });
  await until(() => record.stopped);
  assert.equal(record.state, "completed", record.error);
  assert.equal(record.taskInput?.contextText, "EXPLICIT_SELECTED_CONTEXT");
  assert.equal(record.taskInput?.parentSession, "/parent/session.jsonl");
  assert.equal(record.taskInput?.cwd, f.dir);
  assert.match(readFileSync(record.sessionFile, "utf8"), /EXPLICIT_SELECTED_CONTEXT/);
});
