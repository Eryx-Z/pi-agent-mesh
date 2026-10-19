import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TaskDashboard, dashboardState } from "../pi-extension/subagents/dashboard.ts";
import { createDashboardContent, dashboardDetail, dashboardSummary, detail, taskSummary, TaskWidget, widget } from "../pi-extension/subagents/ui.ts";
import { initialRoleLoadout, mergeRoleBaseline, roleMcpConfigHash, rolePlanDigest, snapshotRoleLoadout, ROLE_CHILD_EXTENSION, type RolePlan, type RoleRun, type RoleSnapshot, type RoleToolSnapshot } from "../pi-extension/subagents/role-loadout.ts";
import { TaskStore, type TaskRecord } from "../pi-extension/subagents/store.ts";
import type { TaskManager } from "../pi-extension/subagents/tasks.ts";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const digest = "a".repeat(64);
function roleRecord(): TaskRecord {
  const plan: RolePlan = {
    version: 1, schemaVersion: 1, promptVersion: 1, roleId: "builder", manifestPath: "/missing/roles/builder.yaml", manifestHash: digest,
    systemPrompt: "FROZEN_ROLE_BODY", systemPromptHash: createHash("sha256").update("FROZEN_ROLE_BODY").digest("hex"),
    skills: [{ name: "coding", description: "Saved coding skill", filePath: "/missing/skills/coding/SKILL.md", loadPath: "/missing/skills/coding/SKILL.md", baseDir: "/missing/skills/coding", disableModelInvocation: false, hash: digest }],
    builtinTools: ["read", "bash"], extraTools: [{ entry: "/missing/tools/test-runner.ts", hash: digest, tools: ["run_tests"] }],
    mcp: [{ server: "catalog", config: { url: "https://example.invalid/mcp", headers: { Authorization: "DO_NOT_DISPLAY_CREDENTIAL_REFERENCE" } }, tools: ["lookup-item"] }],
    model: "provider/actual-model", thinking: "medium", context: "partial", access: "full", cwd: "/missing/project", agentDir: "/missing/agent",
  };
  const record: TaskRecord = {
    version: 3, id: "task-id", name: "implement", task: "Frozen task instruction", context: "partial", access: "full", loadout: initialRoleLoadout(plan, "full"),
    rolePlan: plan, taskInput: { task: "Frozen task instruction", context: "partial", contextText: "Selected requirements", cwd: plan.cwd }, roleRuns: [], roleBaseline: [],
    state: "running", startedAt: 1000, updatedAt: 4000, sessionFile: "/missing/child.jsonl", output: "", activity: "preflight pending", log: [], questions: [], stopped: false, run: 1,
  };
  record.roleRuns = [roleRun(record, 1, "full")];
  return record;
}
function roleRun(record: TaskRecord, run: number, access: "read-only" | "full"): RoleRun {
  return { version: 1, binding: { taskId: record.id, run, attemptId: `attempt-${run}`, nonce: `nonce-${run}`, planHash: rolePlanDigest(record.rolePlan!) }, access, status: "planned", outcome: "running", cleanup: "pending" };
}
function verify(record: TaskRecord): RoleSnapshot {
  const run = record.roleRuns!.at(-1)!;
  const read: RoleToolSnapshot = {
    name: "read", description: "Read file", parameters: { type: "object" }, source: "builtin", path: "<builtin:read>", semanticKind: "builtin", exposure: "direct",
    sourceInfo: { source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" },
  };
  const tools: RoleToolSnapshot[] = [read];
  if (run.access === "full") tools.push(
    { ...read, name: "bash", description: "Run command", path: "<builtin:bash>", sourceInfo: { ...read.sourceInfo, path: "builtin:bash" } },
    { ...read, name: "run_tests", source: "extension", semanticKind: "local-tool", path: ROLE_CHILD_EXTENSION,
      sourceInfo: { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary", origin: "top-level" }, entry: "/missing/tools/test-runner.ts", hash: digest },
    { ...read, name: "mcp__catalog__lookup_item_2", source: "extension", semanticKind: "mcp", path: ROLE_CHILD_EXTENSION,
      sourceInfo: { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary", origin: "top-level" }, server: "catalog", remoteName: "lookup-item", configHash: roleMcpConfigHash(record.rolePlan!, "catalog"), definitionHash: "c".repeat(64), namespace: { name: "mcp__catalog", description: "Catalog" } },
  );
  const snapshot: RoleSnapshot = {
    version: 1, binding: run.binding, roleId: record.rolePlan!.roleId, tools, skills: record.rolePlan!.skills.map(({ hash: _hash, ...s }) => s),
    reservedBridge: { name: "ask_question", description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.",
      parameters: { type: "object", properties: { question: { minLength: 1, type: "string" } }, required: ["question"] }, exposure: "model-only", source: "extension", path: ROLE_CHILD_EXTENSION,
      sourceInfo: { source: "cli", path: ROLE_CHILD_EXTENSION, scope: "temporary", origin: "top-level" } },
    piVersion: "1.0.2", model: "provider/actual-model", thinking: "medium", effectiveAccess: run.access, preflightComplete: true,
  };
  run.snapshot = snapshot; run.status = "verified";
  record.loadout = snapshotRoleLoadout(record.rolePlan!, snapshot);
  record.roleBaseline = mergeRoleBaseline(record.roleBaseline!, snapshot);
  return snapshot;
}
function currentInventory(text: string): string {
  return text.split("Effective capabilities")[1]!.split("Run history")[0]!;
}

test("role identity and persisted preflight phase are visible in task lists and both widget renderers", () => {
  const record = roleRecord();
  for (const summary of [taskSummary(record, 4000), dashboardSummary(record), new TaskWidget().lines([record], 4000)!.join("\n")]) {
    assert.match(summary, /builder/);
    assert.match(summary, /preflight pending/i);
  }
  let factory: ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined;
  const manager = { records: new Map([[record.id, record]]) } as TaskManager;
  const ctx = { hasUI: true, mode: "tui", ui: { setWidget(_id: string, content: typeof factory) { factory = content; } } } as unknown as ExtensionContext;
  widget(manager, ctx, new TaskWidget());
  const component = factory!({}, { fg: (_token: string, text: string) => text } as Theme);
  assert.match(component.render(200).join("\n"), /builder.*preflight pending/i);
  for (const width of [0, 1, 8, 20, 80]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
});

test("pending preflight distinguishes frozen available capability declarations from unverified effective selection", () => {
  const record = roleRecord();
  for (const text of [detail(record), dashboardDetail(record, "overview")]) {
    assert.match(text, /Role: builder/);
    assert.match(text, /Config:.*\/missing\/roles\/builder.yaml/);
    assert.match(text, new RegExp(`sha256 ${digest}`));
    assert.match(text, /schema 1.*prompt v1/i);
    assert.match(text, /Declared \/ available capabilities/);
    assert.match(text, /Builtin: read, bash/);
    assert.match(text, /Local: run_tests.*\/missing\/tools\/test-runner.ts/);
    assert.match(text, /MCP: catalog.*lookup-item/);
    assert.match(text, /Skills: coding.*\/missing\/skills\/coding\/SKILL.md/);
    assert.match(text, /Effective capabilities.*run 1.*full/i);
    assert.match(text, /Effective selection \(unverified\)/);
    assert.match(text, /Actual inventory: not recorded for this run/);
    assert.match(text, /Preflight: pending/);
    assert.match(text, /Run phase: planned/);
    assert.match(text, /Model submission: not started/);
    assert.doesNotMatch(text, /DO_NOT_DISPLAY_CREDENTIAL_REFERENCE|FROZEN_ROLE_BODY/);
  }
});

test("read-only preflight selection omits all undeployed local/MCP capabilities without shrinking the available plan", () => {
  const record = roleRecord();
  record.access = "read-only"; record.roleRuns![0].access = "read-only";
  record.loadout = initialRoleLoadout(record.rolePlan!, "read-only");
  for (const text of [detail(record), dashboardDetail(record, "overview")]) {
    assert.match(text, /Declared \/ available capabilities[\s\S]*Builtin: read, bash/);
    const effective = currentInventory(text);
    assert.match(effective, /Effective selection \(unverified\)/);
    assert.match(effective, /Builtin: read/);
    assert.match(effective, /Skills: coding/);
    assert.match(effective, /ask_question/);
    assert.doesNotMatch(effective, /bash|run_tests|MCP: catalog|SourceInfo:/);
  }
});

test("verified snapshots expose actual names, sourceInfo, local entry and MCP identity without reading resources", () => {
  const record = roleRecord(), snapshot = verify(record);
  record.roleRuns![0].status = "submitted";
  record.state = "completed"; record.stopped = true;
  // No resource used by this fixture exists: historical rendering must use only persisted data.
  for (const text of [detail(record), createDashboardContent().detail(record, "overview")]) {
    assert.match(text, /Preflight: complete/);
    assert.match(text, /Run phase: submitted/);
    assert.match(text, /Model submission: receipt acknowledged/);
    assert.match(text, /Model: provider\/actual-model.*Thinking: medium/);
    assert.match(text, /Context: partial/);
    assert.match(text, /Access: full/);
    assert.match(text, /Pi: 1.0.2/);
    assert.match(text, /read.*builtin/);
    assert.match(text, /run_tests.*local-tool/);
    assert.match(text, /Local entry: \/missing\/tools\/test-runner.ts/);
    assert.match(text, /mcp__catalog__lookup_item_2.*mcp/);
    assert.match(text, /MCP server: catalog.*raw tool: lookup-item/);
    assert.ok(text.includes(`config sha256 ${snapshot.tools[3].configHash}`));
    assert.match(text, /SourceInfo:.*"source":"cli"/);
    assert.ok(text.includes(ROLE_CHILD_EXTENSION), "actual wrapper source and original semantic source are both visible");
    assert.match(text, /ask_question.*runtime bridge.*model-only/);
    assert.match(text, /Actual skills: coding/);
    assert.doesNotMatch(text, /DO_NOT_DISPLAY_CREDENTIAL_REFERENCE|FROZEN_ROLE_BODY/);
  }
  assert.equal(record.roleRuns![0].snapshot, snapshot, "rendering does not rewrite historical inventory");
});

test("persisted v3 history loads and renders with every role resource absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "role-ui-history-"));
  try {
    const record = roleRecord(); record.id = randomUUID(); record.roleRuns![0].binding.taskId = record.id;
    verify(record); record.roleRuns![0].status = "submitted"; record.roleRuns![0].outcome = "completed"; record.roleRuns![0].cleanup = "confirmed";
    record.state = "completed"; record.stopped = true;
    const store = new TaskStore(dir); store.save(record);
    const saved = JSON.stringify(record), loaded = store.load()[0];
    assert.equal(JSON.stringify(loaded), saved, "history is loaded without migrations or resource rediscovery");
    assert.equal(detail(loaded), detail(record));
    assert.equal(dashboardDetail(loaded, "overview"), dashboardDetail(record, "overview"));
    assert.equal(JSON.stringify(loaded), saved, "rendering is read-only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read-only continuation shows only the current snapshot as effective and keeps full history separate", () => {
  const record = roleRecord(); verify(record);
  record.roleRuns![0].status = "submitted"; record.roleRuns![0].outcome = "completed"; record.roleRuns![0].cleanup = "confirmed";
  record.run = 2; record.access = "read-only";
  record.roleRuns!.push(roleRun(record, 2, "read-only"));
  verify(record);
  for (const text of [detail(record), dashboardDetail(record, "overview")]) {
    assert.match(text, /Declared \/ available capabilities[\s\S]*Builtin: read, bash/);
    const effective = currentInventory(text);
    assert.match(effective, /run 2.*read-only/i);
    assert.match(effective, /read.*builtin/);
    assert.match(effective, /ask_question/);
    assert.doesNotMatch(effective, /bash|run_tests|mcp__catalog__lookup_item_2/);
    assert.match(text, /Run history[\s\S]*Run 1.*full.*submitted.*completed/);
    assert.match(text, /Run history[\s\S]*mcp__catalog__lookup_item_2/);
  }
});

test("failed upgrade preflight never presents the last successful snapshot or historical baseline as current", () => {
  const record = roleRecord(); record.access = "read-only"; record.roleRuns![0].access = "read-only"; verify(record);
  record.roleRuns![0].status = "submitted"; record.roleRuns![0].outcome = "completed";
  record.run = 2; record.access = "full";
  record.roleRuns!.push(roleRun(record, 2, "full"));
  record.roleRuns![1].outcome = "failed"; record.roleRuns![1].error = "MCP catalog readiness deadline exceeded";
  record.roleRuns![1].cleanup = "confirmed"; record.state = "failed"; record.stopped = true;
  record.loadout = initialRoleLoadout(record.rolePlan!, "full");
  for (const text of [detail(record), dashboardDetail(record, "overview")]) {
    const effective = currentInventory(text);
    assert.match(effective, /run 2.*full/i);
    assert.match(effective, /Preflight: failed/);
    assert.match(effective, /Run phase: planned/);
    assert.match(effective, /Actual inventory: not recorded for this run/);
    assert.match(effective, /Model submission: not started/);
    assert.match(effective, /MCP catalog readiness deadline exceeded/);
    assert.doesNotMatch(effective, /SourceInfo:|Pi: 1.0.2|Preflight: complete/);
  }
  assert.match(taskSummary(record), /preflight failed/i);
});

test("phase labels distinguish verified, submitting, submitted, cancellation and post-preflight failures", () => {
  const record = roleRecord(); verify(record);
  for (const [phase, submission] of [["verified", "not started"], ["submitting", "receipt unknown"], ["submitted", "receipt acknowledged"]] as const) {
    record.roleRuns![0].status = phase;
    const text = dashboardDetail(record, "overview");
    assert.ok(text.includes(`Run phase: ${phase}`));
    assert.ok(text.includes(`Model submission: ${submission}`));
    assert.match(text, /Preflight: complete/);
  }
  record.state = "failed"; record.roleRuns![0].error = "Model failed";
  assert.match(dashboardDetail(record, "overview"), /Preflight: complete/);
  const cancelled = roleRecord(); cancelled.state = "cancelled"; cancelled.stopped = true; cancelled.roleRuns![0].outcome = "cancelled"; cancelled.roleRuns![0].error = "Cancelled by parent";
  assert.match(dashboardDetail(cancelled, "overview"), /Preflight: incomplete/);
  assert.doesNotMatch(taskSummary(cancelled), /preflight complete|preflight failed/);
});

test("dashboard keeps role/run phase and model/context/access visible while preserving pane controls and terminal bounds", () => {
  const record = roleRecord(); verify(record);
  const state = dashboardState(), tui = { terminal: { rows: 32 }, requestRender() {} };
  const view = new TaskDashboard({ records: new Map([[record.id, record]]) }, state, tui as never,
    { fg: (_token: string, text: string) => text } as Theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {}, createDashboardContent());
  try {
    let screen = stripTerminalSequences(view.render(180).join("\n"));
    assert.equal(state.pane, "prompt");
    assert.match(screen, /→ ● implement · Role: builder/, "the task list preserves both task name and role in its bounded column");
    assert.match(screen, /preflight complete/i);
    assert.match(screen, /Model: provider\/actual-model.*Context: partial.*Access: full/);
    assert.match(screen, /Frozen task instruction/);
    view.handleInput("1");
    assert.match(stripTerminalSequences(view.render(180).join("\n")), /Role: builder/);
    for (const rows of [1, 9, 20, 32]) {
      tui.terminal.rows = rows;
      for (const width of [0, 1, 8, 20, 60, 90, 180]) {
        const lines = view.render(width);
        assert.equal(lines.length, width > 0 ? rows : 0);
        assert.ok(lines.every(line => visibleWidth(line) === width));
      }
    }
  } finally { view.dispose(); }
});

test("all role display values sanitize terminal controls, while task and trace panes remain unchanged", () => {
  const record = roleRecord(); verify(record);
  const injection = "\x1b]0;BAD_TITLE\x07\x00";
  record.rolePlan!.roleId += injection;
  record.rolePlan!.manifestPath += injection;
  record.roleRuns![0].snapshot!.tools[0].sourceInfo.path += injection;
  record.roleRuns![0].snapshot!.tools[2].entry += injection;
  record.roleRuns![0].snapshot!.tools[3].server += injection;
  for (const text of [taskSummary(record), dashboardSummary(record), detail(record), dashboardDetail(record, "overview"), new TaskWidget().lines([record])!.join("\n")]) {
    assert.doesNotMatch(text, /BAD_TITLE|\x1b|\x00|\\u001b|\\u0000/);
  }
  assert.equal(dashboardDetail(record, "prompt"), record.task);
  const dir = mkdtempSync(join(tmpdir(), "role-ui-trace-"));
  try {
    record.sessionFile = join(dir, "child.jsonl");
    writeFileSync(record.sessionFile, JSON.stringify({ type: "message", text: "Saved role trace" }) + "\n");
    assert.match(createDashboardContent().detail(record, "trace"), /Saved role trace/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const version of [1, 2] as const) test(`legacy v${version} task list and detail rendering remain unchanged`, () => {
  const record = roleRecord();
  record.version = version; delete record.rolePlan; delete record.roleRuns; delete record.roleBaseline; delete record.taskInput;
  record.loadout = { ...record.loadout, version: 2, model: "provider/legacy", thinking: "off" };
  if (version === 1) { delete record.access; record.ownership = "historical"; }
  assert.equal(taskSummary(record, 4000), "● implement [task-id] · running · 3s · preflight pending");
  assert.equal(dashboardSummary(record), "● implement · running");
  assert.deepEqual(new TaskWidget().lines([record], 4000), ["Subagents ─ 1 running · /subagents", "● implement · 3s · preflight pending"]);
  assert.doesNotMatch(detail(record), /Role:|Config:|Declared \/ available|Effective capabilities|Run phase:/);
  assert.equal(dashboardDetail(record, "prompt"), "Frozen task instruction");
  assert.doesNotMatch(dashboardDetail(record, "overview"), /Role:|Config:|Declared \/ available|Effective capabilities|Run phase:/);
});
