import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore, type TaskRecord } from "../pi-extension/subagents/store.ts";
import { WorkflowManager } from "../pi-extension/subagents/workflows.ts";
import { seedSession } from "../pi-extension/subagents/context.ts";
import { readProcessIdentity } from "../pi-extension/subagents/execution.ts";
import { snapshotTool, type AccessMode } from "../pi-extension/subagents/loadout.ts";
import { effectiveRole, initialRoleLoadout, roleMcpConfigHash, rolePlanDigest, ROLE_CHILD_EXTENSION, snapshotRoleTools, snapshotMainRoleTools, ROLE_MAIN_EXTENSION,
  type RolePlan, type RoleSnapshot, type RoleToolInfo } from "../pi-extension/subagents/role-loadout.ts";
import type { RpcLaunch } from "../pi-extension/subagents/rpc.ts";
import { loadout, readInfo } from "./fixtures/loadout.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const trustError = /project trust is required before executing local tools or connecting MCP/;
const resources = ["local", "stdio", "http"] as const;
type Resource = typeof resources[number] | "builtin";
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Trust test did not reach the expected task/workflow state");
}
function fixture(t: TestContext, resource: Resource, isProjectTrusted?: () => boolean, changed?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "role-trust-"));
  const entry = join(dir, "local.mjs"), source = "throw new Error('Trust test must never import this entry');\n";
  writeFileSync(entry, source);
  const plan: RolePlan = { version: 1, schemaVersion: 1, promptVersion: 1, roleId: "worker", manifestPath: join(dir, "deleted-role.yaml"), manifestHash: hash("saved manifest"),
    systemPrompt: "Saved role", systemPromptHash: hash("Saved role"), skills: [], builtinTools: ["read"],
    extraTools: resource === "local" ? [{ entry, hash: hash(source), tools: ["local_run"] }] : [],
    mcp: resource === "stdio" || resource === "http" ? [{ server: "trust-peer", tools: ["echo"], config: resource === "stdio" ? { command: "never-run-trust-peer" } : { url: "http://127.0.0.1:1/never-connect" } }] : [],
    model: "fake/test", thinking: "off", context: "none", access: "full", cwd: dir, agentDir: dir };
  const store = new TaskStore(join(dir, "tasks")), launches: RpcLaunch[] = [], prompts: string[] = [];
  // The creation hook is the child-execution boundary. No import or MCP connection
  // can occur through TaskManager if this hook has not been called.
  const options = { command: "unused", ...(isProjectTrusted ? { isProjectTrusted } : {}), changed,
    createRpc: (launch: RpcLaunch) => {
      launches.push(launch);
      const rpc = new EventEmitter() as any;
      rpc.exited = false;
      rpc.stop = async () => { rpc.exited = true; };
      rpc.request = async (type: string, fields?: { message?: string }) => {
        if (type === "get_state") return { isStreaming: true, isCompacting: false, pendingMessageCount: 0 };
        if (type === "get_commands") return { commands: [{ name: "rpc-subagent-preflight" }] };
        if (type !== "prompt") return;
        if (fields?.message === "/rpc-subagent-preflight" && launch.env?.PI_RPC_SUBAGENT_ROLE_RUN) {
          const input = JSON.parse(readFileSync(launch.env!.PI_RPC_SUBAGENT_ROLE_RUN!, "utf8"));
          const effective = effectiveRole(input.plan, input.run.access);
          const sourceInfo = { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary" as const, origin: "top-level" as const };
          const bridge: RoleToolInfo = { name: "ask_question", description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.",
            parameters: { type: "object", properties: { question: { type: "string", minLength: 1 } }, required: ["question"] }, exposure: "model-only", sourceInfo };
          const local: RoleToolInfo[] = effective.extraTools.flatMap(e => e.tools.map(name => ({ name, description: "Local selected", parameters: { type: "object", properties: {} }, exposure: "direct", sourceInfo })));
          const remote = effective.mcp.flatMap(m => m.tools.map(rawName => ({ server: m.server, rawName, name: `mcp__trust_peer__${rawName}`, definitionHash: hash(rawName) })));
          const mcp: RoleToolInfo[] = remote.map(tool => ({ name: tool.name, description: "MCP selected", parameters: { type: "object", properties: {} }, exposure: "direct", namespace: { name: "mcp__trust_peer" }, sourceInfo }));
          const mcpSources = effective.mcp.map(m => ({ server: m.server, configHash: roleMcpConfigHash(input.plan, m.server), tools: remote.filter(tool => tool.server === m.server) }));
          const snapshot: RoleSnapshot = { version: 1, binding: input.run.binding, roleId: input.plan.roleId,
            tools: snapshotRoleTools(input.plan, input.run.access, [readInfo(dir), ...local, ...mcp, bridge], effective.extraTools, mcpSources),
            skills: [], reservedBridge: { ...snapshotTool(bridge), sourceInfo }, piVersion: "1.0.2", model: plan.model, thinking: plan.thinking, effectiveAccess: input.run.access, preflightComplete: true };
          writeFileSync(input.resultPath, JSON.stringify({ binding: input.run.binding, snapshot }));
        } else if (fields?.message !== "/rpc-subagent-preflight") {
          prompts.push(fields!.message!);
          rpc.emit("event", { type: "agent_start" });
        }
      };
      return rpc;
    } };
  const manager = new TaskManager(store, options), managers = [manager];
  t.after(async () => { for (const current of managers.reverse()) await current.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, plan, store, manager, launches, prompts, async open() {
    await manager.shutdown();
    const recovered = await TaskManager.open(store, { ...options, recoveryDelayMs: 10 }); managers.push(recovered); return recovered;
  } };
}

for (const resource of resources) {
  for (const trust of ["absent", "denied", "throws"] as const) {
    test(`initial full ${resource} role fails closed when live trust is ${trust}`, async t => {
      const f = fixture(t, resource, trust === "absent" ? undefined : trust === "denied" ? () => false : () => { throw new Error("project trust is unavailable"); });
      await assert.rejects(f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan }), trust === "throws" ? /project trust/ : trustError);
      assert.equal(f.launches.length, 0);
      assert.equal(f.prompts.length, 0);
      assert.equal(f.manager.records.size, 0, "Denied initial launch must not create task history");
    });
  }
  test(`read-only ${resource} role needs no trust, but full continuation cannot bypass it`, async t => {
    const f = fixture(t, resource); f.plan.access = "read-only";
    const record = await f.manager.launch({ task: "INSPECT", access: "read-only", context: "none", rolePlan: f.plan });
    assert.deepEqual(record.loadout.tools, ["read", "ask_question"]);
    await f.manager.cancel(record.id);
    const before = structuredClone(record), durable = readFileSync(f.store.path(record.id), "utf8");
    await assert.rejects(f.manager.continue(record.id, "NEVER_UPGRADE", "full"), trustError);
    assert.equal(f.launches.length, 1);
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(record, before, "Rejected access change must preserve the previous run/snapshot");
    assert.equal(readFileSync(f.store.path(record.id), "utf8"), durable);
    f.store.lock(record.id)();
  });
  test(`${resource} full continuation uses current trust, not original access or a cached grant`, async t => {
    let trusted = true;
    const f = fixture(t, resource, () => trusted); f.plan.access = "read-only";
    const record = await f.manager.launch({ task: "INSPECT", access: "read-only", context: "none", rolePlan: f.plan });
    await f.manager.cancel(record.id);
    await f.manager.continue(record.id, "TRUSTED_UPGRADE", "full");
    assert.ok(record.loadout.tools.length > 2);
    await f.manager.cancel(record.id);
    const before = structuredClone(record);
    trusted = false;
    await assert.rejects(f.manager.continue(record.id, "NEVER_REUSE_TRUST"), trustError);
    assert.deepEqual(record, before);
    assert.equal(f.launches.length, 2);
    assert.equal(record.rolePlan!.access, "read-only", "Saved plan access is not the effective continuation access");
  });
  test(`workflow retry cannot upgrade a ${resource} role without live trust`, async t => {
    let trusted = false;
    const f = fixture(t, resource, () => trusted); f.plan.access = "read-only";
    const workflows = new WorkflowManager(f.manager, join(f.dir, "workflows"));
    t.after(() => workflows.shutdown());
    const workflow = workflows.launch({ context: "none", loadout: loadout(f.dir), rolePlans: { step: f.plan }, steps: [{ id: "step", role: "worker", task: "INSPECT", dependsOn: [] }] });
    await until(() => [...f.manager.records.values()][0]?.roleRuns?.at(-1)?.status === "submitted");
    const record = [...f.manager.records.values()][0];
    await f.manager.cancel(record.id);
    await until(() => workflow.state === "paused" && workflow.steps[0].state !== "running");
    const before = structuredClone(record);
    await assert.rejects(workflows.retry(workflow.id, "step", "NEVER_UPGRADE", "full"), trustError);
    assert.deepEqual(record, before);
    assert.equal(f.launches.length, 1);
    trusted = true;
    await workflows.retry(workflow.id, "step", "TRUSTED_UPGRADE", "full");
    assert.equal(f.launches.length, 2);
    assert.equal(record.access, "full");
  });
}

function inheritedLoadout(f: ReturnType<typeof fixture>) {
  const sourceInfo = { source: "cli", path: ROLE_MAIN_EXTENSION, scope: "temporary" as const, origin: "top-level" as const };
  const info = (name: string): RoleToolInfo => ({ name, description: "PM selected", parameters: { type: "object", properties: {} }, exposure: "direct", sourceInfo });
  const local = f.plan.extraTools.flatMap(e => e.tools.map(info));
  const remote = f.plan.mcp.flatMap(m => m.tools.map(rawName => ({ rawName, name: `mcp__trust_peer__${rawName}`, definitionHash: hash(rawName) })));
  const sources = f.plan.mcp.map(m => ({ server: m.server, configHash: roleMcpConfigHash(f.plan, m.server), tools: remote }));
  const tools = snapshotMainRoleTools(f.plan, [readInfo(f.dir), ...local, ...remote.map(t => ({ ...info(t.name), namespace: { name: "mcp__trust_peer" } }))], f.plan.extraTools, sources);
  const metadata = tools.map(t => snapshotTool({ ...t, exposure: "direct" }));
  return { ...loadout(f.dir), tools: [...metadata.map(t => t.name), "ask_question"], toolMetadata: metadata,
    extensions: [ROLE_MAIN_EXTENSION], parentRole: { version: 1 as const, plan: structuredClone(f.plan), tools } };
}
for (const resource of resources) {
  test(`no-role full inheritance of PM ${resource} tools requires current project trust`, async t => {
    const f = fixture(t, resource), inherited = inheritedLoadout(f);
    await assert.rejects(f.manager.launch({ task: "NEVER_IMPORT", access: "full", context: "none", loadout: inherited }), trustError);
    assert.equal(f.launches.length, 0);
    assert.equal(f.manager.records.size, 0);
  });
  test(`no-role readonly PM ${resource} inheritance cannot upgrade without live project trust`, async t => {
    const f = fixture(t, resource);
    const record = await f.manager.launch({ task: "INSPECT", access: "read-only", context: "none", loadout: inheritedLoadout(f) });
    assert.equal(record.loadout.version, 2); assert.equal((record.loadout as any).parentRole, undefined);
    await f.manager.cancel(record.id);
    const before = structuredClone(record);
    await assert.rejects(f.manager.continue(record.id, "NEVER_IMPORT", "full"), trustError);
    assert.equal(f.launches.length, 1);
    assert.deepEqual(record, before);
  });
}
for (const revokeAtSave of [1, 2]) test(`no-role PM inheritance rechecks live trust after startup save ${revokeAtSave}`, async t => {
  let trusted = true, saves = 0;
  const f = fixture(t, "local", () => trusted, () => { if (++saves === revokeAtSave) trusted = false; });
  await assert.rejects(f.manager.launch({ task: "NEVER_IMPORT", access: "full", context: "none", loadout: inheritedLoadout(f) }), trustError);
  assert.equal(f.launches.length, 0);
});

for (const revokeAtSave of [1, 2]) {
  test(`shared start boundary rechecks trust after startup save ${revokeAtSave}`, async t => {
    let trusted = true, saves = 0;
    const f = fixture(t, "local", () => trusted, () => { if (++saves === revokeAtSave) trusted = false; });
    await assert.rejects(f.manager.launch({ task: "NEVER_SPAWN", access: "full", context: "none", rolePlan: f.plan }), trustError);
    assert.equal(f.launches.length, 0, "Even reentrant revocation must be checked before creating a child");
    assert.equal(f.prompts.length, 0);
    const record = [...f.manager.records.values()][0];
    assert.equal(record.state, "failed"); assert.equal(record.stopped, true);
    assert.equal(record.roleRuns![0].status, "planned"); assert.equal(record.roleRuns![0].cleanup, "confirmed");
    if (revokeAtSave === 1) assert.equal(existsSync(join(f.store.dir, `${record.id}.1.role-run.json`)), false, "Shared entry check precedes childLaunch artifacts");
    f.store.lock(record.id)();
  });
}

function interrupted(f: ReturnType<typeof fixture>, access: AccessMode) {
  const id = randomUUID(), identity = readProcessIdentity()!;
  const record: TaskRecord = { version: 3, id, name: id, task: "SAVED_WORK", context: "none", access, loadout: initialRoleLoadout(f.plan, access),
    rolePlan: structuredClone(f.plan), roleBaseline: [], taskInput: { task: "SAVED_WORK", context: "none", cwd: f.dir },
    roleRuns: [{ version: 1, binding: { taskId: id, run: 1, nonce: randomUUID(), attemptId: randomUUID(), planHash: rolePlanDigest(f.plan) }, access, status: "planned", outcome: "failed", cleanup: "confirmed" }],
    state: "failed", stopped: true, run: 1, startedAt: Date.now(), updatedAt: Date.now(), sessionFile: join(f.store.dir, `${id}.session.jsonl`), output: "", activity: "interrupted", questions: [], log: [],
    execution: { boundary: { kind: "systemd-scope", unit: `pi-execution-${randomUUID()}.scope`, bootId: identity.bootId, uid: process.getuid!() }, intent: "interrupted", cleanup: "confirmed" } };
  seedSession(record.sessionFile, f.dir, "none"); f.store.save(record);
  writeFileSync(`${f.store.path(id)}.lock`, "stale");
  return id;
}
for (const resource of resources) {
  for (const trust of ["absent", "revoked"] as const) {
    test(`full ${resource} crash recovery is isolated when current trust is ${trust}`, { skip: process.platform !== "linux" }, async t => {
      let trusted = true;
      const f = fixture(t, resource, trust === "absent" ? undefined : () => trusted), id = interrupted(f, "full");
      const manager = await f.open(); trusted = false;
      manager.startRecovery();
      await until(() => manager.get(id).recovery?.phase === "blocked" || f.launches.length > 0);
      assert.equal(f.launches.length, 0, "Recovering a saved plan must not authorize imports/connections");
      const record = manager.get(id);
      assert.equal(record.recovery!.phase, "blocked"); assert.match(record.recovery!.error!, trustError);
      assert.equal(record.run, 1); assert.equal(record.stopped, true); assert.equal(record.execution!.cleanup, "confirmed");
      assert.equal(f.prompts.length, 0); f.store.lock(id)();
    });
  }
}
for (const access of ["read-only", "full"] as const) {
  test(`${access} recovery still works ${access === "full" ? "with current trust" : "without a trust grant"}`, { skip: process.platform !== "linux" }, async t => {
    const f = fixture(t, "local", access === "full" ? () => true : undefined), id = interrupted(f, access);
    const manager = await f.open(); manager.startRecovery();
    await until(() => manager.get(id).roleRuns?.at(-1)?.status === "submitted");
    assert.equal(f.launches.length, 1); assert.equal(manager.get(id).run, 2); assert.equal(manager.get(id).access, access);
    if (access === "read-only") assert.deepEqual(manager.get(id).loadout.tools, ["read", "ask_question"]);
  });
}
test("full builtin-only roles remain available without project trust", async t => {
  const f = fixture(t, "builtin");
  const record = await f.manager.launch({ task: "INSPECT", access: "full", context: "none", rolePlan: f.plan });
  await f.manager.cancel(record.id);
  await f.manager.continue(record.id, "INSPECT_AGAIN");
  assert.equal(f.launches.length, 2); assert.deepEqual(record.loadout.tools, ["read", "ask_question"]);
});
