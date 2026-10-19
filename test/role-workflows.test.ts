import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { RoleCatalog } from "../pi-extension/subagents/roles.ts";
import { createRolePlan } from "../pi-extension/subagents/role-loadout.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { WorkflowManager, validateSteps, workflowSummary } from "../pi-extension/subagents/workflows.ts";
import type { AgentMessage } from "../pi-extension/subagents/context.ts";
import { loadout } from "./fixtures/loadout.ts";
import { git } from "../pi-extension/subagents/workspaces.ts";

const pi = getPackageDir();
const cli = join(pi, JSON.parse(readFileSync(join(pi, "package.json"), "utf8")).bin.pi);
const provider = fileURLToPath(new URL("./fixtures/role-workflows-provider.ts", import.meta.url));
async function until(check: () => boolean) {
  for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Role workflow timed out");
}
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "role-workflows-"));
  const config = join(dir, "team.yaml");
  writeFileSync(config, "schema_version: 1\nenabled: true\nmain_role: builder\nroles:\n  builder: ./builder.yaml\n  reviewer: ./reviewer.yaml\nmcp_servers: {}\n");
  for (const id of ["builder", "reviewer"]) {
    writeFileSync(join(dir, `${id}.yaml`), `schema_version: 1\nid: ${id}\ndescription: Test ${id}\nsystem_prompt: ./${id}.md\nbuiltin_tools: [read${id === "builder" ? ", write" : ""}]\ndefaults: {access: ${id === "builder" ? "full" : "read-only"}}\n`);
    writeFileSync(join(dir, `${id}.md`), `FROZEN_${id.toUpperCase()}_BODY\n`);
  }
  const tasks = new TaskManager(new TaskStore(join(dir, "tasks")), { command: process.execPath, baseArgs: [cli], isProjectTrusted: () => true });
  const workflows = new WorkflowManager(tasks, join(dir, "workflows"));
  const directory = new RoleCatalog(dir, config).reload();
  const plan = (id: string, context: "none" | "partial" | "full" = "none", access: "full" | "read-only" = id === "builder" ? "full" : "read-only") => createRolePlan(directory.roles.find(r => r.id === id)!, directory,
    { access, context, model: "role-workflow-fixture/role", thinking: "off", cwd: dir, agentDir: join(dir, "agent"), providerExtensions: [provider] });
  t.after(async () => { await workflows.shutdown(); await tasks.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, tasks, workflows, plan, input: { context: "none" as const, loadout: { ...loadout(dir, "role-workflow-fixture/workflow"), providerExtensions: [provider] } } };
}

test("mixed role DAG freezes each role's effective configuration and omits reviewer dependency reports", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const builder = f.plan("builder", "partial"), reviewer = f.plan("reviewer");
  const r = f.workflows.launch({ ...f.input, context: "partial", contextText: "WORKFLOW_SELECTED_CONTEXT",
    rolePlans: { build: builder, review: reviewer }, steps: [
      { id: "build", role: "builder", task: "BUILD_REPORT", dependsOn: [] },
      { id: "review", role: "reviewer", task: "REVIEW_WITHOUT_REPORT", dependsOn: ["build"] },
    ] });
  f.workflows.pause(r.id);
  builder.systemPrompt = "MUTATED_AFTER_CREATION";
  writeFileSync(join(f.dir, "builder.md"), "RELOADED_BUILDER_BODY");
  unlinkSync(join(f.dir, "reviewer.yaml"));
  assert.equal(r.version, 2);
  assert.equal(r.steps[0].access, "full");
  assert.equal(r.steps[0].model, "role-workflow-fixture/role");
  assert.equal(r.steps[0].contextText, "WORKFLOW_SELECTED_CONTEXT");
  assert.equal(r.steps[1].context, "none");
  assert.equal(r.steps[1].dependencyReports, "omit");
  assert.equal(r.steps[0].rolePlan?.systemPrompt, "FROZEN_BUILDER_BODY\n");
  assert.match(workflowSummary(r), /role=reviewer.*model=role-workflow-fixture\/role.*context=none.*dependencyReports=omit/);
  f.workflows.resume(r.id);
  await until(() => r.state === "completed" || r.state === "paused");
  assert.equal(r.state, "completed", r.error);
  const build = f.tasks.get(r.steps[0].taskId!), review = f.tasks.get(r.steps[1].taskId!);
  assert.equal(build.version, 3);
  assert.match(build.output, /FROZEN_BUILDER_BODY/);
  assert.match(build.output, /WORKFLOW_SELECTED_CONTEXT/);
  assert.equal(review.context, "none");
  assert.equal(review.task, "REVIEW_WITHOUT_REPORT");
  assert.doesNotMatch(review.output, /BUILD_REPORT|WORKFLOW_SELECTED_CONTEXT|RELOADED_BUILDER_BODY/);
});

test("pending step updates require fresh matching role plans and freeze only explicitly updated full history", async t => {
  const f = fixture(t);
  const r = f.workflows.launch({ ...f.input, steps: [{ id: "build", role: "builder", task: "BUILD", dependsOn: [] }], rolePlans: { build: f.plan("builder") } });
  f.workflows.pause(r.id);
  const original = structuredClone(r.steps[0]);
  assert.throws(() => f.workflows.update(r.id, [{ id: "review", role: "reviewer", task: "REVIEW", dependsOn: ["build"] }]), /Missing role plan/);
  assert.deepEqual(r.steps, [original]);
  const plan = f.plan("reviewer", "full");
  assert.throws(() => f.workflows.update(r.id, [{ id: "review", role: "reviewer", task: "REVIEW", dependsOn: ["build"] }], { review: plan }), /snapshot/i);
  const snapshot: AgentMessage[] = [{ role: "user", content: "UPDATE_FULL_HISTORY", timestamp: 1 }];
  f.workflows.update(r.id, [{ id: "review", role: "reviewer", task: "REVIEW", dependsOn: ["build"] }], { review: plan }, snapshot);
  snapshot.length = 0; plan.systemPrompt = "NEW_RELOAD";
  assert.deepEqual(r.steps[0], original);
  assert.equal(r.steps[1].snapshot?.length, 1);
  assert.equal(r.steps[1].rolePlan?.systemPrompt, "FROZEN_REVIEWER_BODY\n");
  assert.throws(() => f.workflows.update(r.id, [{ id: "review", role: "builder", task: "REVIEW", dependsOn: ["build"] }], { review: f.plan("reviewer") }), /mismatch/);
  assert.equal(r.steps[1].role, "reviewer");
  f.workflows.resume(r.id);
  await until(() => r.state === "completed" || r.state === "paused");
  assert.equal(r.state, "completed", r.error);
  const review = f.tasks.get(r.steps[1].taskId!);
  assert.match(readFileSync(review.sessionFile, "utf8"), /UPDATE_FULL_HISTORY/);
  assert.match(review.task, /Direct dependency results/);
  assert.throws(() => { f.workflows.pause(r.id); f.workflows.update(r.id, [{ id: "review", role: "reviewer", task: "CHANGE_STARTED", dependsOn: [] }], { review: f.plan("reviewer") }); }, /already started/);
});

test("step configuration validates conditional access, canonical models, contexts and role-plan identity", async t => {
  const f = fixture(t);
  assert.throws(() => validateSteps([{ id: "old", task: "OLD", dependsOn: [] }]), /access/);
  for (const model of ["inherit", "bare", "/model", "provider/", "provider/model extra"]) assert.throws(() => validateSteps([{ id: "bad", task: "BAD", access: "full", dependsOn: [], model }]), /canonical/);
  assert.throws(() => f.workflows.launch({ ...f.input, steps: [{ id: "r", role: "reviewer", task: "R", dependsOn: [] }] }), /Missing role plan/);
  assert.throws(() => f.workflows.launch({ ...f.input, steps: [{ id: "r", role: "reviewer", task: "R", dependsOn: [] }], rolePlans: { r: f.plan("builder") } }), /mismatch/);
  assert.throws(() => f.workflows.launch({ ...f.input, steps: [{ id: "r", role: "reviewer", access: "full", task: "R", dependsOn: [] }], rolePlans: { r: f.plan("reviewer") } }), /mismatch/);
  assert.throws(() => f.workflows.launch({ ...f.input, steps: [{ id: "r", role: "reviewer", task: "R", dependsOn: [] }], rolePlans: { r: f.plan("reviewer", "partial") } }), /contextText/);
  assert.throws(() => f.workflows.launch({ ...f.input, steps: [{ id: "r", role: "reviewer", contextText: "NOT_PARTIAL", task: "R", dependsOn: [] }], rolePlans: { r: f.plan("reviewer") } }), /partial/);
  assert.throws(() => f.workflows.launch({ ...f.input, steps: [{ id: "r", role: "reviewer", task: "R", dependsOn: [] }], rolePlans: { r: f.plan("reviewer", "full") } }), /snapshot/);
});

test("full steps freeze history even under workflow none; non-role model/context overrides do not mutate inherited loadouts", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const snapshot: AgentMessage[] = [{ role: "user", content: "CREATION_FULL_HISTORY", timestamp: 1 }];
  const r = f.workflows.launch({ ...f.input, snapshot, rolePlans: { full: f.plan("reviewer", "full") }, steps: [
    { id: "full", role: "reviewer", task: "FULL", dependsOn: [] },
    { id: "selected", task: "SELECTED", access: "read-only", model: "role-workflow-fixture/step", context: "partial", contextText: "STEP_SELECTED_TEXT", dependsOn: [] },
    { id: "inherited", task: "INHERITED", access: "read-only", dependsOn: ["full"] },
  ] });
  snapshot.length = 0;
  f.input.loadout.model = "role-workflow-fixture/parent";
  assert.equal(r.snapshot, undefined);
  assert.equal(r.steps[0].snapshot?.length, 1);
  assert.equal(r.steps[1].snapshot, undefined);
  assert.equal(r.steps[2].snapshot, undefined);
  await until(() => r.state === "completed" || r.state === "paused");
  assert.equal(r.state, "completed", r.error);
  const full = f.tasks.get(r.steps[0].taskId!), selected = f.tasks.get(r.steps[1].taskId!), inherited = f.tasks.get(r.steps[2].taskId!);
  assert.match(readFileSync(full.sessionFile, "utf8"), /CREATION_FULL_HISTORY/);
  assert.doesNotMatch(readFileSync(selected.sessionFile, "utf8"), /CREATION_FULL_HISTORY/);
  assert.match(selected.output, /STEP_SELECTED_TEXT/);
  assert.equal(selected.loadout.model, "role-workflow-fixture/step");
  assert.equal(inherited.loadout.model, "role-workflow-fixture/workflow");
  assert.equal(r.loadout.model, "role-workflow-fixture/workflow");
  assert.match(inherited.task, /Direct dependency results/);
});

test("restored role history needs no manifest; resource drift pauses before any model and retry can tighten access", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const entry = join(f.dir, "local.ts"), source = "export default pi => pi.registerTool({name:'workflow_local',label:'Local',description:'Local',parameters:{type:'object',properties:{}},async execute(){return {content:[]}}});\n";
  writeFileSync(entry, source);
  const plan = f.plan("builder");
  plan.extraTools.push({ entry, hash: createHash("sha256").update(source).digest("hex"), tools: ["workflow_local"] });
  const audit = join(f.dir, "model-audit");
  const r = f.workflows.launch({ ...f.input, rolePlans: { build: plan }, steps: [{ id: "build", role: "builder", task: `BUILD AUDIT_PATH=${audit}`, dependsOn: [] }] });
  f.workflows.pause(r.id); await f.workflows.shutdown();
  unlinkSync(join(f.dir, "builder.yaml")); unlinkSync(join(f.dir, "builder.md")); unlinkSync(entry);
  const restored = new WorkflowManager(f.tasks, join(f.dir, "workflows"));
  t.after(() => restored.shutdown());
  const recovered = restored.get(r.id);
  assert.equal(recovered.steps[0].rolePlan?.systemPrompt, "FROZEN_BUILDER_BODY\n");
  restored.resume(r.id);
  await until(() => recovered.state === "paused");
  assert.equal(recovered.steps[0].state, "failed");
  assert.equal(f.tasks.records.size, 0);
  assert.equal(existsSync(audit), false);
  await restored.retry(r.id, "build", "inspect read-only", "read-only");
  assert.equal(recovered.steps[0].rolePlan?.access, "full");
  assert.equal(recovered.steps[0].access, "read-only");
  await restored.shutdown();
  const again = new WorkflowManager(f.tasks, join(f.dir, "workflows"));
  t.after(() => again.shutdown());
  again.resume(r.id);
  await until(() => again.get(r.id).state === "completed" || again.get(r.id).state === "paused");
  assert.equal(again.get(r.id).state, "completed", again.get(r.id).error);
  const task = f.tasks.get(again.get(r.id).steps[0].taskId!);
  assert.equal(task.access, "read-only");
  assert.deepEqual(task.loadout.tools, ["read", "ask_question"]);
  assert.equal(task.rolePlan?.extraTools[0].entry, entry);
  await again.shutdown();
});

test("isolated role steps rebind only cwd and merge dependency code despite omitted reports", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const repo = join(f.dir, "repo"); mkdirSync(repo);
  await git(repo, "init"); writeFileSync(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
  const buildPlan = { ...f.plan("builder", "partial"), cwd: repo }, reviewPlan = { ...f.plan("reviewer"), cwd: repo };
  const r = f.workflows.launch({ ...f.input, loadout: { ...f.input.loadout, cwd: repo }, workspace: "isolated", validationCommand: "test \"$(cat built.txt)\" = BUILDER_CODE",
    rolePlans: { build: buildPlan, review: reviewPlan }, contextText: "BUILD_SELECTED_ONLY", steps: [
      { id: "build", role: "builder", task: "WORKFLOW_WRITE", dependsOn: [] },
      { id: "review", role: "reviewer", task: "REVIEW_CODE_ONLY", dependsOn: ["build"] },
    ] });
  await until(() => r.state === "completed" && !!r.baseRef && !!r.integration?.removed || r.state === "paused");
  assert.equal(r.state, "completed", r.error);
  assert.equal(r.validated, true);
  const build = f.tasks.get(r.steps[0].taskId!), review = f.tasks.get(r.steps[1].taskId!);
  assert.notEqual(build.loadout.cwd, repo);
  assert.notEqual(review.loadout.cwd, build.loadout.cwd);
  assert.deepEqual(build.rolePlan, { ...buildPlan, cwd: build.loadout.cwd });
  assert.deepEqual(review.rolePlan, { ...reviewPlan, cwd: review.loadout.cwd });
  assert.deepEqual(r.steps[0].rolePlan, buildPlan);
  assert.equal(review.task, "REVIEW_CODE_ONLY");
  assert.equal(JSON.parse(review.output).built, "BUILDER_CODE\n");
  assert.equal(await git(repo, "show", `${r.integration!.revisionRef}:built.txt`), "BUILDER_CODE");
  assert.equal(existsSync(join(repo, "built.txt")), false);
  assert.equal(r.steps.every(s => s.worktree?.removed && !!s.worktree.revisionRef), true);
});

test("role default writers retain shared exclusion and readers still obey maxParallel", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const writerAudit = join(f.dir, "writer-audit"), readerAudit = join(f.dir, "reader-audit"), releaseWriter = join(f.dir, "release-writer"), releaseReaders = join(f.dir, "release-readers");
  const r = f.workflows.launch({ ...f.input, maxParallel: 2, rolePlans: { writer: f.plan("builder"), a: f.plan("reviewer"), b: f.plan("reviewer") }, steps: [
    { id: "writer", role: "builder", task: `WRITER WAIT_FOR=${releaseWriter} AUDIT_PATH=${writerAudit}`, dependsOn: [] },
    { id: "a", role: "reviewer", task: `READER_A WAIT_FOR=${releaseReaders} AUDIT_PATH=${readerAudit}`, dependsOn: [] },
    { id: "b", role: "reviewer", task: `READER_B WAIT_FOR=${releaseReaders} AUDIT_PATH=${readerAudit}`, dependsOn: [] },
  ] });
  await until(() => existsSync(writerAudit));
  assert.deepEqual(r.steps.map(s => s.state), ["running", "pending", "pending"]);
  assert.equal(f.tasks.records.size, 1);
  writeFileSync(releaseWriter, "go");
  await until(() => existsSync(readerAudit) && readFileSync(readerAudit, "utf8").trim().split("\n").length === 2);
  assert.deepEqual(r.steps.map(s => s.state), ["completed", "running", "running"]);
  writeFileSync(releaseReaders, "go");
  await until(() => r.state === "completed" || r.state === "paused");
  assert.equal(r.state, "completed", r.error);
});

test("isolated explicit retry preserves the role plan, discards the failed scene and can run read-only", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const repo = join(f.dir, "repo"); mkdirSync(repo);
  await git(repo, "init"); writeFileSync(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
  const plan = { ...f.plan("builder"), cwd: repo };
  const r = f.workflows.launch({ ...f.input, loadout: { ...f.input.loadout, cwd: repo }, workspace: "isolated", validationCommand: "true",
    rolePlans: { build: plan }, steps: [{ id: "build", role: "builder", task: "WORKFLOW_FAIL", dependsOn: [] }] });
  await until(() => r.state === "paused" && r.steps[0].state === "failed");
  await new Promise(resolve => setTimeout(resolve, 20));
  const old = f.tasks.get(r.steps[0].taskId!), oldTree = r.steps[0].worktree!;
  await f.workflows.retry(r.id, "build", "inspect without writes", "read-only");
  assert.equal(oldTree.removed, true);
  assert.deepEqual(r.steps[0].rolePlan, plan);
  assert.equal(r.steps[0].access, "read-only");
  f.workflows.resume(r.id);
  await until(() => r.state === "completed" && !!r.integration?.removed || r.state === "paused");
  assert.equal(r.state, "completed", r.error);
  const retried = f.tasks.get(r.steps[0].taskId!);
  assert.notEqual(retried.id, old.id);
  assert.notEqual(retried.loadout.cwd, old.loadout.cwd);
  assert.equal(retried.access, "read-only");
  assert.equal(retried.rolePlan?.access, "full");
  assert.deepEqual(retried.loadout.tools, ["read", "ask_question"]);
  assert.equal(new TaskStore(join(f.dir, "tasks")).load().find(task => task.id === retried.id)?.access, "read-only");
});

test("legacy records stay v1 until an explicit configured update migrates their frozen inputs", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const originalSnapshot: AgentMessage[] = [{ role: "user", content: "LEGACY_FROZEN_HISTORY", timestamp: 1 }];
  const r = f.workflows.launch({ ...f.input, context: "full", snapshot: originalSnapshot, steps: [
    { id: "a", task: "LEGACY_A", access: "read-only", dependsOn: [] },
    { id: "b", task: "LEGACY_B", access: "read-only", dependsOn: ["a"] },
  ] });
  f.workflows.pause(r.id);
  assert.equal(r.version, 1);
  assert.equal(r.steps[0].context, undefined);
  assert.deepEqual(r.snapshot, originalSnapshot);
  f.workflows.update(r.id, [{ id: "b", task: "STILL_LEGACY_B", access: "read-only", dependsOn: ["a"] }]);
  assert.equal(r.version, 1);
  const changedSnapshot: AgentMessage[] = [{ role: "user", content: "NEW_STEP_HISTORY", timestamp: 2 }];
  f.workflows.update(r.id, [{ id: "b", task: "CONFIGURED_B", access: "read-only", model: "role-workflow-fixture/step", dependsOn: ["a"] }], undefined, changedSnapshot);
  assert.equal(r.version, 2);
  assert.equal(r.snapshot, undefined);
  assert.deepEqual(r.steps[0].snapshot, originalSnapshot);
  assert.deepEqual(r.steps[1].snapshot, changedSnapshot);
  assert.equal(r.steps[0].dependencyReports, "include");
  await f.workflows.shutdown();
  const restored = new WorkflowManager(f.tasks, join(f.dir, "workflows"));
  t.after(() => restored.shutdown());
  restored.resume(r.id);
  await until(() => restored.get(r.id).state === "completed" || restored.get(r.id).state === "paused");
  assert.equal(restored.get(r.id).state, "completed", restored.get(r.id).error);
  const a = f.tasks.get(restored.get(r.id).steps[0].taskId!), b = f.tasks.get(restored.get(r.id).steps[1].taskId!);
  assert.match(readFileSync(a.sessionFile, "utf8"), /LEGACY_FROZEN_HISTORY/);
  assert.doesNotMatch(readFileSync(a.sessionFile, "utf8"), /NEW_STEP_HISTORY/);
  assert.match(readFileSync(b.sessionFile, "utf8"), /NEW_STEP_HISTORY/);
  assert.equal(b.loadout.model, "role-workflow-fixture/step");
  await restored.shutdown();
});

test("v2 history rejects missing effective access or partial text instead of guessing saved configuration", async t => {
  const f = fixture(t);
  const r = f.workflows.launch({ ...f.input, context: "partial", contextText: "FROZEN_SELECTED_TEXT", rolePlans: { build: f.plan("builder", "partial") },
    steps: [{ id: "build", role: "builder", task: "BUILD", dependsOn: [] }] });
  f.workflows.pause(r.id); await f.workflows.shutdown();
  const path = join(f.dir, "workflows", `${r.id}.json`), saved = readFileSync(path, "utf8");
  for (const key of ["access", "contextText"]) {
    const broken = JSON.parse(saved); delete broken.steps[0][key];
    writeFileSync(path, JSON.stringify(broken));
    assert.throws(() => new WorkflowManager(f.tasks, join(f.dir, "workflows")), /access|configuration/);
  }
  writeFileSync(path, saved);
});
