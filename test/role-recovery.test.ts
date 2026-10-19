import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore, type TaskRecord } from "../pi-extension/subagents/store.ts";
import { initialRoleLoadout, rolePlanDigest, snapshotRoleLoadout, snapshotRoleTools, ROLE_CHILD_EXTENSION, type RolePlan, type RoleSnapshot } from "../pi-extension/subagents/role-loadout.ts";
import { snapshotTool } from "../pi-extension/subagents/loadout.ts";
import { readInfo } from "./fixtures/loadout.ts";
import { Type } from "typebox";
import { readProcessIdentity, type ExecutionController } from "../pi-extension/subagents/execution.ts";
import { seedSession, type AgentMessage } from "../pi-extension/subagents/context.ts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const pkg = getPackageDir();
const cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
const provider = fileURLToPath(new URL("./fixtures/role-tasks-provider.ts", import.meta.url));
async function until(check: () => boolean) {
  for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Role recovery did not settle");
}
for (const context of ["partial", "full"] as const) {
  for (const checkpoint of ["planned", "verified", "submitting", "submitting-retained", "submitted"] as const) {
  test(`${checkpoint} crash recovers saved ${context} input with new nonce and correct submission ambiguity policy`,  { skip: process.platform !== "linux", timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "role-recovery-"));
    let manager: TaskManager | undefined;
    try {
      const store = new TaskStore(join(dir, "tasks"));
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
      const identity = readProcessIdentity(child.pid!)!;
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
      assert.ok(identity);
      const id = randomUUID(), nonce = randomUUID();
      const plan: RolePlan = { version: 1, schemaVersion: 1, promptVersion: 1, roleId: "builder", manifestPath: join(dir, "does-not-exist.yaml"), manifestHash: hash("deleted manifest"),
        systemPrompt: "SAVED_CRASH_ROLE_BODY", systemPromptHash: hash("SAVED_CRASH_ROLE_BODY"), skills: [], builtinTools: ["read", "bash"], extraTools: [], mcp: [],
        model: "role-fixture/test", thinking: "off", context, access: "read-only", cwd: dir, agentDir: join(dir, "agent"), providerExtensions: [provider] };
      const snapshot: AgentMessage[] = [{ role: "user", content: "ORIGINAL_FROZEN_REFERENCE", timestamp: Date.now() }];
      const record: TaskRecord = { version: 3, id, name: context, task: "INSPECT_ROLE", context, access: "read-only", loadout: initialRoleLoadout(plan, "read-only"),
        rolePlan: plan, roleBaseline: [], roleRuns: [{ version: 1, binding: { taskId: id, run: 1, attemptId: randomUUID(), nonce, planHash: rolePlanDigest(plan) }, access: "read-only", status: "planned", outcome: "running", cleanup: "pending" }],
        taskInput: { task: "INSPECT_ROLE", context, cwd: dir, parentSession: "/original/parent-session", ...(context === "partial" ? { contextText: "ORIGINAL_PARTIAL_SELECTION" } : { snapshot }) },
        state: "running", startedAt: Date.now(), updatedAt: Date.now(), sessionFile: join(dir, "tasks", `${id}.session.jsonl`), output: "", activity: "preflight pending", log: [], questions: [], stopped: false, run: 1,
        execution: { boundary: { kind: "systemd-scope", unit: `pi-execution-${randomUUID()}.scope`, bootId: identity.bootId, uid: process.getuid!() }, launcher: identity, ready: true, intent: "running", cleanup: "pending" } };
      if (checkpoint !== "planned") {
        const bridge = { name: "ask_question", description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.",
          parameters: Type.Object({ question: Type.String({ minLength: 1 }) }), exposure: "model-only" as const,
          sourceInfo: { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary" as const, origin: "top-level" as const } };
        const builtin = readInfo(dir); builtin.sourceInfo.path = "builtin:read";
        const actual: RoleSnapshot = { version: 1, binding: record.roleRuns![0].binding, roleId: plan.roleId, tools: snapshotRoleTools(plan, "read-only", [builtin, bridge]), skills: [],
          reservedBridge: { ...snapshotTool(bridge), sourceInfo: bridge.sourceInfo }, piVersion: "1.0.2", model: plan.model, thinking: "off", effectiveAccess: "read-only", preflightComplete: true };
        record.roleRuns![0].status = checkpoint === "submitting-retained" ? "submitting" : checkpoint; record.roleRuns![0].snapshot = actual;
        record.roleBaseline = actual.tools; record.loadout = snapshotRoleLoadout(plan, actual);
      }
      // At the delivery-ambiguity checkpoint retain only the original seed: selected partial input was not delivered.
      if (checkpoint === "submitting-retained" || checkpoint === "submitted") seedSession(record.sessionFile, dir, context, context === "full" ? snapshot : [], record.taskInput!.parentSession);
      store.save(record); writeFileSync(`${store.path(id)}.lock`, "stale");
      const controller: ExecutionController = { prepare: () => ({ ...record.execution!.boundary, unit: `pi-execution-${randomUUID()}.scope` }), wrap: launch => launch, cleanup: async () => {} };
      manager = await TaskManager.open(store, { command: process.execPath, baseArgs: [cli], executionController: controller, recoveryDelayMs: 10, maxConcurrent: 1 });
      manager.startRecovery();
      const restored = manager.get(id);
      if (checkpoint === "submitting") {
        await until(() => restored.stopped && restored.recovery?.phase === "blocked");
        assert.equal(restored.run, 1);
        assert.match(restored.recovery!.error!, /missing after possible model submission/);
        assert.equal(restored.roleRuns!.length, 1);
        return;
      }
      await until(() => restored.run === 2 && restored.stopped);
      assert.equal(restored.state, "completed", restored.error);
      assert.equal(restored.recoveryRuns, 1);
      assert.equal(restored.access, "read-only", "Automatic recovery must not upgrade original authorization");
      assert.deepEqual(restored.loadout.tools, ["read", "ask_question"]);
      assert.notEqual(restored.roleRuns![1].binding.nonce, nonce);
      assert.equal(!!restored.roleRuns![0].snapshot, checkpoint !== "planned");
      assert.equal(restored.roleRuns![1].status, "submitted");
      assert.equal(restored.taskInput!.parentSession, "/original/parent-session");
      const transcript = readFileSync(restored.sessionFile, "utf8");
      assert.match(transcript, context === "partial" ? /ORIGINAL_PARTIAL_SELECTION/ : /ORIGINAL_FROZEN_REFERENCE/);
      assert.match(restored.output, /SAVED_CRASH_ROLE_BODY/);
      if (checkpoint === "submitting-retained" || checkpoint === "submitted") {
        assert.match(restored.output, /Recover the interrupted task/);
        if (context === "partial") assert.match(restored.output, /ORIGINAL_PARTIAL_SELECTION/);
      } else assert.doesNotMatch(restored.output, /Recover the interrupted task/);
      assert.equal(readFileSync(join(dir, "model-called"), "utf8").trim().split("\n").length, 1);
    } finally { await manager?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
  }
}
