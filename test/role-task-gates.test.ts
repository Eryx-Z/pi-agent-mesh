import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { ROLE_CHILD_EXTENSION, rolePlanDigest, snapshotRoleTools, type RolePlan, type RoleSnapshot } from "../pi-extension/subagents/role-loadout.ts";
import { snapshotTool } from "../pi-extension/subagents/loadout.ts";
import { readInfo } from "./fixtures/loadout.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(t: { after(fn: () => void | Promise<void>): void }, alter: (value: any) => any = value => value) {
  const dir = mkdtempSync(join(tmpdir(), "role-gates-"));
  const plan: RolePlan = { version: 1, schemaVersion: 1, promptVersion: 1, roleId: "test", manifestPath: join(dir, "deleted-role.yaml"), manifestHash: hash("old manifest"),
    systemPrompt: "Saved body", systemPromptHash: hash("Saved body"), skills: [], builtinTools: ["read"], extraTools: [], mcp: [],
    model: "fake/test", thinking: "off", context: "none", access: "full", cwd: dir, agentDir: dir };
  const store = new TaskStore(join(dir, "tasks"));
  const prompts: string[] = [];
  const requests: { type: string; message?: string; timeoutMs?: number }[] = [];
  let changed: (() => void) | undefined;
  let schemaChange = false;
  let stopFails = false;
  const rpc = new EventEmitter() as any;
  rpc.stop = async () => { if (stopFails) throw new Error("Shutdown unconfirmed"); };
  rpc.request = async (type: string, fields: any, options?: { timeoutMs?: number }) => {
    requests.push({ type, message: fields?.message, timeoutMs: options?.timeoutMs });
    if (type === "get_state") return { isStreaming: true, isCompacting: false, pendingMessageCount: 0 };
    if (type === "get_commands") return { commands: [{ name: "rpc-subagent-preflight" }] };
    if (type !== "prompt" || fields.message === "/rpc-role-cancel-preflight") return;
    prompts.push(fields.message);
    if (fields.message === "/rpc-subagent-preflight") {
      const input = JSON.parse(readFileSync(rpc.launch.env.PI_RPC_SUBAGENT_ROLE_RUN, "utf8"));
      const q = { name: "ask_question", description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.",
        parameters: Type.Object({ question: Type.String({ minLength: 1 }) }), exposure: "model-only" as const,
        sourceInfo: { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary" as const, origin: "top-level" as const } };
      const read = readInfo(dir);
      if (schemaChange) read.description += " CHANGED";
      const snapshot: RoleSnapshot = { version: 1, binding: input.run.binding, roleId: plan.roleId,
        tools: snapshotRoleTools(plan, input.run.access, [read, q]), skills: [], reservedBridge: { ...snapshotTool(q), sourceInfo: q.sourceInfo },
        piVersion: "1.0.2", model: plan.model, thinking: plan.thinking, effectiveAccess: input.run.access, preflightComplete: true };
      const result = alter({ binding: input.run.binding, snapshot });
      if (result !== undefined) writeFileSync(input.resultPath, JSON.stringify(result));
    } else {
      const durable = JSON.parse(readFileSync(store.path([...manager.records.keys()][0]), "utf8"));
      assert.equal(durable.roleRuns.at(-1).status, "submitting");
      assert.equal(durable.roleRuns.at(-1).snapshot.preflightComplete, true);
      assert.equal(durable.roleBaseline.length, 1);
      assert.equal(durable.roleRuns.at(-1).binding.planHash, rolePlanDigest(plan));
      rpc.emit("event", { type: "agent_start" });
    }
  };
  const manager = new TaskManager(store, { command: "unused", isProjectTrusted: () => true, changed: () => changed?.(), createRpc: launch => { rpc.launch = launch; return rpc; } });
  t.after(async () => { stopFails = false; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, plan, store, manager, rpc, prompts, requests, onChange: (fn: () => void) => changed = fn, changeSchema: () => schemaChange = true, failStop: () => stopFails = true };
}
for (const [name, alter] of [
  ["missing sidecar", () => undefined],
  ["error despite command receipt", (v: any) => ({ binding: v.binding, error: "declared resource is missing" })],
  ["stale nonce", (v: any) => ({ ...v, binding: { ...v.binding, nonce: "stale" } })],
  ["stale attempt", (v: any) => ({ ...v, binding: { ...v.binding, attemptId: "stale" } })],
  ["stale run", (v: any) => ({ ...v, binding: { ...v.binding, run: 99 } })],
  ["wrong task", (v: any) => ({ ...v, binding: { ...v.binding, taskId: "different-task" } })],
  ["wrong plan", (v: any) => ({ ...v, binding: { ...v.binding, planHash: hash("wrong") } })],
  ["forged inner snapshot", (v: any) => ({ ...v, snapshot: { ...v.snapshot, binding: { ...v.snapshot.binding, nonce: "stale" } } })],
] as const) {
  test(`role parent refuses ${name} before a real prompt`, async t => {
    const f = fixture(t, alter);
    await assert.rejects(f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan }));
    assert.deepEqual(f.prompts, ["/rpc-subagent-preflight"]);
    const record = [...f.manager.records.values()][0];
    assert.equal(record.state, "failed"); assert.equal(record.stopped, true);
    assert.equal(record.roleRuns![0].snapshot, undefined); assert.deepEqual(record.roleBaseline, []);
    assert.equal(record.roleRuns![0].outcome, "failed"); assert.equal(record.roleRuns![0].cleanup, "confirmed");
  });
}
test("role snapshot and baseline are durable before model submission; mismatch cannot partially update history", async t => {
  const f = fixture(t);
  const record = await f.manager.launch({ task: "original", access: "full", context: "none", rolePlan: f.plan });
  for (const request of f.requests.filter(r => r.type !== "prompt" || r.message === "/rpc-subagent-preflight")) {
    assert.ok(request.timeoutMs! > 15000 && request.timeoutMs! <= 35000, "Role startup uses remaining 30s deadline + 5s margin, not legacy 15s timeout");
  }
  assert.equal(f.requests.find(r => r.message?.includes("Assigned task:"))!.timeoutMs, undefined, "Only readiness gets the extended RPC budget");
  await f.manager.cancel(record.id);
  const baseline = structuredClone(record.roleBaseline), snapshot = structuredClone(record.roleRuns![0].snapshot);
  f.changeSchema();
  await assert.rejects(f.manager.continue(record.id, "new instruction", "full"), /Historical.*mismatch/);
  assert.deepEqual(record.roleBaseline, baseline); assert.deepEqual(record.roleRuns![0].snapshot, snapshot);
  assert.equal(record.roleRuns![1].snapshot, undefined);
  assert.equal(record.roleRuns![1].status, "planned");
  assert.equal(f.prompts.filter(p => p !== "/rpc-subagent-preflight").length, 1);
  assert.deepEqual(f.store.load()[0].roleBaseline, baseline);
});
test("reentrant cancellation after verified persistence prevents model submission", async t => {
  const f = fixture(t);
  f.onChange(() => {
    const record = [...f.manager.records.values()][0];
    if (record?.roleRuns?.at(-1)?.status === "verified") void f.manager.cancel(record.id);
  });
  await assert.rejects(f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan }), /stopped|failed/i);
  assert.deepEqual(f.prompts, ["/rpc-subagent-preflight"]);
});
test("role preflight failure with unknown shutdown retains lock and forbids replacement", async t => {
  const f = fixture(t, v => ({ binding: v.binding, error: "preflight fails" })); f.failStop();
  await assert.rejects(f.manager.launch({ task: "NEVER_MODEL", access: "full", context: "none", rolePlan: f.plan }));
  const record = [...f.manager.records.values()][0];
  assert.equal(record.stopped, false); assert.equal(record.roleRuns![0].cleanup, "pending");
  assert.throws(() => f.store.lock(record.id), /locked/);
  await assert.rejects(f.manager.continue(record.id, "replacement"), /shutdown|running|stopping/);
  assert.deepEqual(f.prompts, ["/rpc-subagent-preflight"]);
});

test("manual retry before first submission retains saved task/partial context plus new instruction", async t => {
  let calls = 0;
  const f = fixture(t, value => ++calls === 1 ? { binding: value.binding, error: "transient preflight failure" } : value);
  f.plan.context = "partial";
  await assert.rejects(f.manager.launch({ task: "ORIGINAL_ASSIGNED_TASK", access: "full", context: "partial", contextText: "ORIGINAL_SELECTED_CONTEXT", rolePlan: f.plan }));
  const record = [...f.manager.records.values()][0];
  await f.manager.continue(record.id, "RETRY_WITH_NEW_INSTRUCTION");
  const prompt = f.prompts.at(-1)!;
  assert.match(prompt, /ORIGINAL_ASSIGNED_TASK/);
  assert.match(prompt, /ORIGINAL_SELECTED_CONTEXT/);
  assert.match(prompt, /RETRY_WITH_NEW_INSTRUCTION/);
});
test("a later planned run cannot reconstruct a missing transcript after an earlier submission", async t => {
  let calls = 0;
  const f = fixture(t, value => ++calls === 2 ? { binding: value.binding, error: "second preflight failed" } : value);
  const record = await f.manager.launch({ task: "ORIGINAL", access: "full", context: "none", rolePlan: f.plan });
  await f.manager.cancel(record.id);
  await assert.rejects(f.manager.continue(record.id, "first continuation"));
  assert.equal(record.roleRuns![0].status, "submitted");
  assert.equal(record.roleRuns![1].status, "planned");
  unlinkSync(record.sessionFile);
  await assert.rejects(f.manager.continue(record.id, "MUST_NOT_RECREATE"), /missing after possible model submission/);
  assert.equal(record.roleRuns!.length, 2);
});
