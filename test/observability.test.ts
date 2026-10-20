import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Observability, classifyToolOutcome, sanitizeObservation } from "../pi-extension/subagents/observability.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { WorkflowManager, type StepDefinition } from "../pi-extension/subagents/workflows.ts";
import { loadout } from "./fixtures/loadout.ts";
import type { RolePlan } from "../pi-extension/subagents/role-loadout.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-rpc.mjs", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error("timed out waiting for observability task"); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("tool outcomes, durations, roles and secrets stay bounded and redacted", () => {
  let now = 1_000;
  const mesh = new Observability(() => now);
  mesh.beginTool("parent:1", { origin: "parent", name: "read" });
  now = 1_040;
  mesh.endTool("parent:1", { origin: "parent", name: "read", outcome: "success", roleId: "builder" });
  mesh.tool({ origin: "child", name: "bash", outcome: "error", error: "authorization: super-secret-value Bearer abcdefghijklmnop sk-supersecretvalue", roleId: "builder", durationMs: 12 });
  mesh.markBlocked("parent:2", "Tool outside verified role loadout");
  mesh.endTool("parent:2", { origin: "parent", name: "subagent_control", outcome: "error", action: "cancel", error: "Tool outside verified role loadout" });
  mesh.beginTool("child:task:hang", { origin: "child", name: "bash", taskId: "task" });
  mesh.abandonTools("child:task:");
  mesh.role({ event: "created", roleId: "builder", taskId: "task-1", access: "full", context: "partial", model: "fake/test" });
  mesh.role({ event: "created", roleId: "builder", taskId: "task-2", workflowId: "flow", access: "full", context: "none", model: "fake/test" });
  mesh.role({ event: "continued", roleId: "builder", taskId: "task-1", access: "read-only", context: "none", model: "fake/test", run: 2 });
  mesh.role({ event: "preflight_ok", roleId: "builder", taskId: "task-1" });
  mesh.role({ event: "failed", roleId: "builder", taskId: "task-2", error: "token=do-not-keep" });
  mesh.task({ event: "launched", taskId: "task-1", access: "full", context: "none", version: 3 });
  mesh.workflow({ event: "launched", workflowId: "flow", name: "auth", workspace: "shared", detail: "2 steps" });
  mesh.control({ event: "pm", name: "ready", outcome: "ready" });

  const totals = mesh.totals();
  assert.equal(totals.toolCalls, 4);
  assert.equal(totals.toolSuccesses, 1);
  assert.equal(totals.toolErrors, 1);
  assert.equal(totals.toolBlocked, 1);
  assert.equal(totals.toolAborted, 1);
  assert.equal(totals.rolesCreated, 2);
  assert.equal(totals.roleRuns, 3);
  const report = mesh.report();
  assert.match(report, /parent read  calls=1 ok=1/);
  assert.match(report, /avg=40ms/);
  assert.match(report, /roles: builder 1\/1 ok/);
  assert.match(report, /actions: cancel ok=0 err=0 blocked=1 aborted=0/);
  assert.match(report, /builder  created=2 standalone=1 workflow=1 continued=1 recovered=0 runs=3/);
  assert.match(report, /preflight ok=1 failed=0/);
  assert.match(report, /access: full=2, read-only=1/);
  assert.match(report, /pm:ready:ready=1/);
  assert.match(report, /In flight: 0/);
  assert.doesNotMatch(report, /super-secret-value|abcdefghijklmnop|sk-supersecretvalue|do-not-keep/);
  assert.match(report, /\[redacted\]/);
  const json = mesh.toJSON();
  assert.doesNotMatch(json, /super-secret-value|abcdefghijklmnop|sk-supersecretvalue|do-not-keep/);
  assert.match(json, /"arguments": "omitted"/);
  assert.equal(sanitizeObservation("password=hunter2"), "password=[redacted]");
  assert.equal(classifyToolOutcome(true, "Tool execution was blocked"), "blocked");
  assert.equal(classifyToolOutcome(true, "Question cancelled without an answer"), "aborted");
  assert.equal(classifyToolOutcome(false), "success");
  assert.throws(() => mesh.report("nope"), /Usage: \/mesh/);
});

test("cardinality, event ring and persistence merge without double counting or treating inflight as success", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-obs-"));
  try {
    const first = new Observability(() => 5_000);
    for (let i = 0; i < 97; i++) first.tool({ origin: "child", name: `tool-${i}`, outcome: "success" });
    assert.equal(first.totals().toolCalls, 97);
    assert.match(first.report("tools"), /other tools \(cardinality cap\)/);
    for (let i = 0; i < 401; i++) first.control({ event: "command", name: "ping", outcome: "success" });
    assert.match(first.report("events", 10), /older events dropped/);
    first.attach(dir, "session-a");
    first.flush();
    const second = new Observability(() => 6_000);
    second.tool({ origin: "parent", name: "subagent", outcome: "success" });
    second.beginTool("child:open:1", { origin: "child", name: "read" });
    second.attach(dir, "session-a");
    second.attach(dir, "session-a");
    assert.equal(second.totals().toolCalls, 98, "Reload merges prior calls once and keeps the new call");
    assert.equal(second.totals().toolSuccesses, 98);
    const reloaded = new Observability(() => 7_000);
    reloaded.attach(dir, "session-a");
    assert.equal(reloaded.totals().toolAborted, 1, "Unfinished calls from the previous process are aborted, not successful");
    assert.equal(reloaded.totals().toolSuccesses, 98);
    writeFileSync(join(dir, "observability.json"), "{not json");
    const dirty = new Observability(() => 8_000);
    dirty.role({ event: "created", roleId: "reviewer", taskId: "kept" });
    assert.doesNotThrow(() => dirty.attach(dir, "session-b"));
    assert.match(dirty.report("roles"), /reviewer  created=1/);
    assert.match(dirty.report("controls"), /persistence:reset:error=1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("child tool success, role creation and observer failures are recorded without changing execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-tasks-"));
  const mesh = new Observability();
  mesh.attach(dir, "session");
  const manager = new TaskManager(new TaskStore(dir), {
    command: process.execPath, createRpc: launch => new RpcProcess({ ...launch, args: [fake] }, 1000, 25), observe: mesh,
  });
  const throwing = new TaskManager(new TaskStore(join(dir, "throw")), {
    command: process.execPath, createRpc: launch => new RpcProcess({ ...launch, args: [fake] }, 1000, 25),
    observe: { tool() { throw new Error("boom"); }, task() { throw new Error("boom"); }, role() { throw new Error("boom"); }, workflow() { throw new Error("boom"); }, control() { throw new Error("boom"); },
      beginTool() { throw new Error("boom"); }, endTool() { throw new Error("boom"); }, abandonTools() { throw new Error("boom"); } },
  });
  const workflows = new WorkflowManager(manager, join(dir, "workflows"), undefined, mesh);
  try {
    const record = await manager.launch({ task: "investigate", access: "read-only", context: "none", loadout: loadout(dir) });
    await until(() => record.stopped);
    assert.equal(record.state, "completed");
    assert.equal(mesh.totals().toolSuccesses >= 1, true);
    assert.match(mesh.report("tools"), /child read  calls=1 ok=1/);
    assert.match(mesh.report("tasks"), /launched=1/);
    assert.match(mesh.report("tasks"), /completed=1/);
    assert.match(mesh.report("tasks"), /preflight_ok=1/);
    const prompt = "Saved body";
    const plan: RolePlan = { version: 1, schemaVersion: 1, promptVersion: 1, roleId: "builder", manifestPath: join(dir, "role.yaml"), manifestHash: digest("manifest"),
      systemPrompt: prompt, systemPromptHash: digest(prompt), skills: [], builtinTools: ["read"], extraTools: [], mcp: [],
      model: "fake/test", thinking: "off", context: "none", access: "full", cwd: dir, agentDir: dir };
    await assert.rejects(manager.launch({ task: "role work", access: "full", context: "none", rolePlan: plan }));
    assert.equal(mesh.totals().rolesCreated, 1);
    assert.match(mesh.report("roles"), /builder  created=1 standalone=1 workflow=0/);
    assert.match(mesh.report("roles"), /preflight ok=0 failed=1/);
    assert.match(mesh.report("tasks"), /preflight_failed=1/);
    const flow = workflows.launch({ context: "none", loadout: loadout(dir), steps: [{ id: "read", task: "look", access: "read-only", dependsOn: [] } satisfies StepDefinition] });
    assert.match(mesh.report("workflows"), /launched=1/);
    assert.equal(flow.state, "running");
    const noisy = await throwing.launch({ task: "still completes", access: "read-only", context: "none", loadout: loadout(dir) });
    await until(() => noisy.stopped);
    assert.equal(noisy.state, "completed");
    assert.doesNotMatch(noisy.error ?? "", /boom/);
    const saved = JSON.parse(readFileSync(join(dir, "observability.json"), "utf8"));
    assert.equal(saved.privacy.arguments, "omitted");
    assert.equal(JSON.stringify(saved).includes("src/auth.ts"), false);
  } finally {
    await workflows.shutdown();
    await manager.shutdown();
    await throwing.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
