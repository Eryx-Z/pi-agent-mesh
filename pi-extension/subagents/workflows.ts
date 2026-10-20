import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, bounded, uniqueName, type TaskRecord } from "./store.ts";
import { accessMode, validateLoadout, type AccessMode, type Loadout } from "./loadout.ts";
import { taskPrompt, type AgentMessage, type ContextMode } from "./context.ts";
import { TaskManager } from "./tasks.ts";
import { validateRolePlan, rolePlanDigest, type RolePlan } from "./role-loadout.ts";
import { initialize, prepare, capture, validate, groupAlive, retain, remove, type Isolation, type Worktree } from "./workspaces.ts";
import type { MeshObserver, WorkflowEventName } from "./observability.ts";

export interface StepDefinition {
  id: string; task: string; access?: AccessMode; dependsOn: string[];
  role?: string; model?: string; context?: ContextMode; contextText?: string; dependencyReports?: "include" | "omit";
}
export interface WorkflowStep extends StepDefinition {
  access: AccessMode; rolePlan?: RolePlan; snapshot?: AgentMessage[];
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  taskId?: string; error?: string; worktree?: Worktree; freshTask?: boolean; attemptId?: string;
}
export interface WorkflowInput {
  name?: string; context: ContextMode; contextText?: string; snapshot?: AgentMessage[];
  parentSession?: string; loadout: Loadout; maxParallel?: number; steps: StepDefinition[];
  workspace?: "shared" | "isolated"; validationCommand?: string;
  /** Already resolved by the caller; never look up the role catalog while scheduling. */
  rolePlans?: Record<string, RolePlan>;
}
export interface WorkflowRecord extends Omit<WorkflowInput, "name" | "steps" | "maxParallel" | "rolePlans"> {
  version: 1 | 2; id: string; name: string; maxParallel: number; steps: WorkflowStep[];
  state: "running" | "paused" | "completed" | "cancelled";
  createdAt: number; updatedAt: number; error?: string;
  isolation?: Isolation; integration?: Worktree; validated?: boolean; validationPid?: number;
  baseRef?: string; cleanupError?: string; retiredTrees?: Worktree[];
}
export function validateSteps(steps: StepDefinition[]): void {
  if (!Array.isArray(steps) || !steps.length || steps.length > 64) throw new Error("Workflow requires 1–64 steps");
  const byId = new Map<string, StepDefinition>();
  for (const s of steps) {
    if (!s || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || byId.has(s.id)) throw new Error("Step IDs must be unique, 1–64 letters/digits/_/-");
    if (typeof s.task !== "string" || !s.task.trim()) throw new Error(`Missing task for step ${s.id}`);
    if (s.role !== undefined && (typeof s.role !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s.role))) throw new Error(`Invalid role for step ${s.id}`);
    if (s.access !== undefined || s.role === undefined) accessMode(s.access);
    if (s.model !== undefined && (typeof s.model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(s.model))) throw new Error(`Step ${s.id}: use a canonical provider/model ID`);
    if (s.context !== undefined && !["none", "partial", "full"].includes(s.context)) throw new Error(`Invalid context for step ${s.id}`);
    if (s.contextText !== undefined && typeof s.contextText !== "string") throw new Error(`Invalid contextText for step ${s.id}`);
    if (s.dependencyReports !== undefined && !["include", "omit"].includes(s.dependencyReports)) throw new Error(`Invalid dependencyReports for step ${s.id}`);
    if (!Array.isArray(s.dependsOn) || new Set(s.dependsOn).size !== s.dependsOn.length) throw new Error(`Invalid dependencies: ${s.id}`);
    byId.set(s.id, s);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cyclic dependency: ${id}`);
    const step = byId.get(id);
    if (!step) throw new Error(`Unknown dependency: ${id}`);
    visiting.add(id); step.dependsOn.forEach(visit); visiting.delete(id); done.add(id);
  };
  for (const id of byId.keys()) visit(id);
}
const hasStepConfig = (s: StepDefinition) => [s.role, s.model, s.context, s.contextText, s.dependencyReports].some(v => v !== undefined);
function checkPlans(steps: StepDefinition[], plans?: Record<string, RolePlan>): void {
  for (const id of Object.keys(plans ?? {})) if (!steps.some(s => s.id === id && s.role)) throw new Error(`Unexpected role plan for step ${id}`);
}
function freezeStep(s: StepDefinition, input: Pick<WorkflowInput, "loadout" | "context" | "contextText" | "snapshot">, plan?: RolePlan): WorkflowStep {
  if (s.role && !plan) throw new Error(`Missing role plan for step ${s.id}`);
  if (plan) {
    validateRolePlan(plan, { resources: false });
    if (s.role !== plan.roleId || s.access !== undefined && s.access !== plan.access || s.model !== undefined && s.model !== plan.model ||
        s.context !== undefined && s.context !== plan.context || plan.cwd !== input.loadout.cwd) throw new Error(`Role plan mismatch for step ${s.id}`);
  }
  const access = accessMode(plan?.access ?? s.access), context = plan?.context ?? s.context ?? input.context;
  const model = plan?.model ?? s.model ?? input.loadout.model;
  if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error(`Step ${s.id}: use a canonical provider/model ID`);
  if (s.contextText !== undefined && context !== "partial") throw new Error(`Step ${s.id}: contextText is only supported in partial mode`);
  const contextText = context === "partial" ? s.contextText ?? input.contextText : undefined;
  taskPrompt(s.task, access, context, contextText);
  if (context === "full" && !Array.isArray(input.snapshot)) throw new Error(`Step ${s.id}: full context requires an explicit frozen parent snapshot`);
  return { ...structuredClone(s), access, model, context, ...(contextText !== undefined ? { contextText } : {}),
    dependencyReports: s.dependencyReports ?? (s.role && context === "none" ? "omit" : "include"),
    ...(context === "full" ? { snapshot: structuredClone(input.snapshot ?? []) } : {}),
    ...(plan ? { rolePlan: structuredClone(plan) } : {}), state: "pending" };
}
/** Scheduling only. TaskManager remains the single owner of processes, sessions and cancellation. */
export class WorkflowManager {
  readonly records = new Map<string, WorkflowRecord>();
  private closed = false;
  private scheduled = false;
  private pumping = false;
  private pump?: Promise<void>;
  private validation = new Map<string, AbortController>();
  private integrationRuns = new Map<string, Promise<void>>();
  private preparing = new Set<string>();
  private cleaning = new Map<string, Promise<void>>();
  private workspaceRuns = new Set<Promise<void>>();
  private unsubscribe: () => void;
  private ready = false;
  constructor(readonly tasks: TaskManager, readonly dir: string, private notify?: (record: WorkflowRecord) => void, private observe?: MeshObserver) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(dir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const r = JSON.parse(readFileSync(join(dir, file), "utf8")) as WorkflowRecord;
      if (![1, 2].includes(r.version) || `${r.id}.json` !== file || !["running", "paused", "completed", "cancelled"].includes(r.state)) throw new Error(`Invalid workflow record: ${file}`);
      validateSteps(r.steps); validateLoadout(r.loadout, { resources: false });
      if (r.version === 1) {
        if (r.steps.some(s => hasStepConfig(s) || s.rolePlan)) throw new Error(`Invalid legacy workflow configuration: ${file}`);
        taskPrompt("workflow", "full", r.context, r.contextText);
      } else for (const s of r.steps) {
        accessMode(s.access);
        if (s.role && !s.rolePlan || !s.role && s.rolePlan) throw new Error(`Missing/mismatched role plan for step ${s.id}`);
        // Access can change on explicit retry; the original authorization plan does not.
        const frozen = freezeStep({ ...s, access: s.rolePlan?.access ?? s.access }, { ...r, snapshot: s.snapshot }, s.rolePlan);
        if (frozen.model !== s.model || frozen.context !== s.context || frozen.contextText !== s.contextText || frozen.dependencyReports !== s.dependencyReports ||
            s.context === "full" && !Array.isArray(s.snapshot) || s.context !== "full" && s.snapshot !== undefined) throw new Error(`Invalid frozen step configuration: ${s.id}`);
      }
      if (!Number.isInteger(r.maxParallel) || r.maxParallel < 1 || r.maxParallel > 16 ||
          r.steps.some(s => !["pending", "running", "completed", "failed", "cancelled"].includes(s.state))) throw new Error(`Invalid workflow state: ${file}`);
      // Never re-launch a persisted running step. Reconcile task tags even if the
      // parent crashed between task creation and saving its ID in this record.
      this.records.set(r.id, r);
      for (const step of r.steps) {
        const task = this.findTask(r, step);
        if (task) step.taskId = task.id;
        if (step.state === "running" || step.state === "pending" && task) {
          // Completion and cleanup are separate. Keep successful work pending
          // reconciliation/capture; never turn it into an instruction to rerun it.
          step.state = task?.state === "completed"
            ? task.stopped && (r.workspace !== "isolated" || step.worktree?.output) ? "completed" : "running"
            : "failed";
          if (step.state === "failed") step.error = "Interrupted workflow; explicitly retry after automatic cleanup";
        }
      }
      if (r.state === "running") { r.state = "paused"; r.error = "Owner restarted; inspect and explicitly resume"; }
      this.save(r);
    }
    this.unsubscribe = tasks.subscribe(() => this.schedule());
    this.ready = true;
    for (const restored of this.records.values()) if (restored.error === "Owner restarted; inspect and explicitly resume") this.note(restored, "restart_paused", { error: restored.error });
    if ([...this.records.values()].some(r => r.steps.some(s => s.state === "running" && this.findTask(r, s)?.state === "completed"))) this.schedule();
  }
  private note(r: WorkflowRecord, event: WorkflowEventName, extra: { stepId?: string; roleId?: string; error?: string; detail?: string } = {}): void {
    if (!this.ready) return;
    try {
      this.observe?.workflow({ event, workflowId: r.id, name: r.name, workspace: r.workspace, stepId: extra.stepId, roleId: extra.roleId,
        error: extra.error, detail: extra.detail });
    } catch { /* Observability must not change scheduling. */ }
  }
  private save(r: WorkflowRecord): void { this.tasks.assertOwnership(); r.updatedAt = Date.now(); atomicWrite(join(this.dir, `${r.id}.json`), JSON.stringify(r, null, 2)); }
  get(id: string): WorkflowRecord {
    const r = this.records.get(id) ?? [...this.records.values()].find(r => r.name === id);
    if (!r) throw new Error(`Unknown workflow: ${id}`);
    return r;
  }
  private findTask(r: WorkflowRecord, s: WorkflowStep): TaskRecord | undefined {
    const matches = (t: TaskRecord) => t.workflow?.id === r.id && t.workflow.stepId === s.id &&
      (s.attemptId ? t.workflow.attemptId === s.attemptId : !s.freshTask && !t.workflow.attemptId);
    const direct = s.taskId ? this.tasks.records.get(s.taskId) : undefined;
    return direct && matches(direct) ? direct : [...this.tasks.records.values()].find(matches);
  }
  private emit(r: WorkflowRecord): void { if (!this.closed) this.notify?.(r); }
  private open(): void { if (this.closed) throw new Error("Workflow owner is shutting down"); }
  launch(input: WorkflowInput): WorkflowRecord {
    this.open(); validateSteps(input.steps); validateLoadout(input.loadout, { resources: input.steps.some(s => !s.role) });
    checkPlans(input.steps, input.rolePlans);
    const version = input.steps.some(hasStepConfig) || Object.keys(input.rolePlans ?? {}).length ? 2 : 1;
    if (version === 1) taskPrompt("workflow", "full", input.context, input.contextText);
    else if (!["none", "partial", "full"].includes(input.context)) throw new Error("Invalid workflow context mode");
    const steps = input.steps.map(s => version === 2 ? freezeStep(s, input, input.rolePlans?.[s.id]) : { ...structuredClone(s), access: accessMode(s.access), state: "pending" as const });
    if (input.workspace !== undefined && !["shared", "isolated"].includes(input.workspace)) throw new Error("Invalid workspace mode");
    if (input.workspace === "isolated" && !input.validationCommand?.trim()) throw new Error("Isolated workflows require validationCommand");
    const maxParallel = input.maxParallel ?? 3;
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16) throw new Error("maxParallel must be 1–16");
    const { rolePlans: _plans, snapshot, ...defaults } = structuredClone(input);
    const r: WorkflowRecord = { ...defaults, ...(version === 1 ? { snapshot } : {}), version, id: randomUUID(),
      name: uniqueName(input.name ?? "workflow", [...this.records.values()].map(r => r.name)),
      maxParallel, state: "running", steps,
      createdAt: Date.now(), updatedAt: Date.now() };
    this.save(r); this.records.set(r.id, r); this.note(r, "launched", { detail: `${r.steps.length} steps` }); this.schedule(); return r;
  }
  private schedule(): void {
    if (this.closed) return;
    this.scheduled = true;
    if (this.pumping) return;
    this.pumping = true;
    this.pump = Promise.resolve().then(async () => {
      while (this.scheduled && !this.closed) {
        this.scheduled = false;
        for (const r of this.records.values()) {
          if (r.workspace === "isolated") this.preparing.add(r.id);
          try { await this.collect(r); this.reconcile(r); if (r.state === "running") await this.dispatch(r); }
          catch (e) {
            const wasRunning = r.state === "running";
            if (r.state !== "cancelled") r.state = "paused";
            r.error = String(e);
            if (wasRunning) this.note(r, "auto_paused", { error: r.error });
            try { this.save(r); this.emit(r); } catch { this.closed = true; }
          } finally { this.preparing.delete(r.id); }
          if (!this.closed && (r.state === "completed" || r.state === "cancelled")) {
            try { await this.cleanupRecord(r); }
            catch (e) { r.cleanupError = String(e); this.save(r); }
          }
        }
      }
    }).finally(() => {
      this.pumping = false;
      // A task can finish after the loop's final check but before this microtask.
      if (this.scheduled && !this.closed) this.schedule();
    });
  }
  private reconcile(r: WorkflowRecord): void {
    let changed = false, failed = false;
    for (const s of r.steps.filter(s => s.state === "running")) {
      const t = this.findTask(r, s);
      if (t && (t.state === "failed" || t.state === "cancelled") && r.state === "running") { failed = true; changed = true; }
      if (!t || this.tasks.isLive(t.id) || t.state === "running" || t.state === "waiting" ||
          t.state === "completed" && !t.stopped) continue;
      s.taskId = t.id;
      if (r.workspace === "isolated" && t.stopped && t.state === "completed" && !s.worktree?.output) continue;
      const next = t.stopped && t.state === "completed" ? "completed" : t.state === "cancelled" ? "cancelled" : "failed";
      if (s.state === "running" && next === "failed") this.note(r, "step_failed", { stepId: s.id, roleId: s.role, error: t.error });
      if (s.state === "running" && next === "cancelled") this.note(r, "step_cancelled", { stepId: s.id, roleId: s.role, error: t.error });
      s.state = next;
      s.error = t.error; changed = true; failed ||= s.state !== "completed";
    }
    const before = r.state;
    if (failed && r.state === "running") { r.state = "paused"; r.error = "A step failed or was cancelled; inspect and explicitly retry"; }
    if (r.state === "running" && (r.workspace !== "isolated" || r.validated) && r.steps.every(s => s.state === "completed")) { r.state = "completed"; changed = true; }
    if (before === "running" && r.state === "paused") this.note(r, "auto_paused", { error: r.error });
    if (before === "running" && r.state === "completed") this.note(r, "completed");
    if (changed) { this.save(r); if (r.state !== "running") this.emit(r); }
  }
  private active(r: WorkflowRecord): WorkflowStep[] { return r.steps.filter(s => s.state === "running"); }
  private unsafe(r: WorkflowRecord): boolean {
    return (!!r.validationPid && !this.validation.has(r.id) && groupAlive(r.validationPid)) || [...this.tasks.records.values()].some(t => t.workflow?.id === r.id && !t.stopped && !this.tasks.isLive(t.id));
  }
  private async collect(r: WorkflowRecord): Promise<void> {
    if (r.workspace !== "isolated" || this.cleaning.has(r.id)) return;
    const failures: string[] = [];
    for (const s of this.active(r)) {
      const task = this.findTask(r, s);
      if (task?.stopped && task.state === "completed" && !this.tasks.isLive(task.id) && s.worktree && !s.worktree.output) {
        try { await capture(s.worktree); this.save(r); }
        catch (e) { this.note(r, "step_failed", { stepId: s.id, roleId: s.role, error: String(e) }); s.state = "failed"; s.error = String(e); failures.push(`Step ${s.id}: ${s.error}`); }
      }
    }
    if (failures.length) {
      // Settle captured siblings before pausing: retry must not see stopped children as active.
      this.reconcile(r);
      throw new Error(`Workflow capture failed:\n${failures.join("\n")}`);
    }
  }
  private async dispatch(r: WorkflowRecord): Promise<void> {
    if (this.integrationRuns.has(r.id) || this.cleaning.has(r.id)) return;
    if (r.steps.some(s => !s.role)) validateLoadout(r.loadout);
    if (this.unsafe(r)) throw new Error("Unconfirmed workflow child/validation shutdown; inspect orphan processes before scheduling");
    if (r.workspace === "isolated") {
      if (!r.isolation) { r.isolation = await initialize(r.loadout.cwd, join(this.dir, `${r.id}-worktrees`)); this.save(r); }
      this.reconcile(r);
      if (r.state !== "running" || this.closed) return;
      if (r.steps.every(s => s.state === "completed")) {
        r.integration ??= { path: join(r.isolation.directory, `result-${randomUUID()}`) }; this.save(r);
        // Leaf revisions already contain their dependency ancestry and any explicit conflict resolutions.
        const leaves = r.steps.filter(s => !r.steps.some(d => d.dependsOn.includes(s.id)));
        const cwd = await prepare(r.isolation, r.integration, leaves.map(s => s.worktree!.revisionRef ?? s.worktree!.output!));
        if (r.state !== "running" || this.closed) return;
        const controller = new AbortController(); this.validation.set(r.id, controller);
        const integration = r.integration;
        const run = validate(integration, cwd, r.validationCommand!, controller.signal, pid => { r.validationPid = pid; this.save(r); }).then(() => {
          if (r.state !== "running" || this.closed) return;
          integration.output = integration.input; r.validated = true;
        }).catch(e => {
          const wasRunning = r.state === "running";
          if (r.state !== "cancelled") r.state = "paused";
          r.error = String(e);
          if (wasRunning) this.note(r, "auto_paused", { error: r.error, detail: "validation" });
        }).finally(() => {
          this.validation.delete(r.id); this.integrationRuns.delete(r.id);
          if (r.validationPid && !groupAlive(r.validationPid)) r.validationPid = undefined;
          try { this.save(r); this.reconcile(r); if (r.state !== "running") this.emit(r); } catch { this.closed = true; }
          this.schedule();
        });
        this.integrationRuns.set(r.id, run); return;
      }
    }
    if (r.state !== "running" || this.closed) return;
    if (this.unsafe(r)) throw new Error("Unconfirmed workflow child shutdown; inspect orphan writers before scheduling");
    for (const s of r.steps) {
      if (s.state !== "pending" || !s.dependsOn.every(id => r.steps.find(d => d.id === id)!.state === "completed")) continue;
      const active = this.active(r);
      if (active.length >= r.maxParallel || !this.tasks.hasCapacity()) break;
      if (r.workspace !== "isolated" && (active.some(a => a.access === "full") || s.access === "full" && active.length)) continue;
      let loadout = r.loadout;
      if (r.isolation) {
        s.worktree ??= { path: join(r.isolation.directory, `step-${s.id}-${randomUUID()}`) }; this.save(r);
        try { loadout = { ...r.loadout, cwd: await prepare(r.isolation, s.worktree, s.dependsOn.map(id => { const tree = r.steps.find(d => d.id === id)!.worktree!; return tree.revisionRef ?? tree.output!; })) }; }
        catch (e) { this.note(r, "step_failed", { stepId: s.id, roleId: s.role, error: String(e) }); s.state = "failed"; s.error = String(e); throw e; }
        if (r.state !== "running" || this.closed) return;
        if (!this.tasks.hasCapacity()) return;
      }
      s.attemptId ??= randomUUID();
      s.state = "running"; this.save(r);
      const dependencies = (s.dependencyReports === "omit" ? [] : s.dependsOn).map(id => {
        const upstream = r.steps.find(d => d.id === id)!;
        const task = this.tasks.get(upstream.taskId!);
        return `Step ${id} (result is a worker report, not independent acceptance):\n${bounded(task.output, 8000)}\nSession: ${task.sessionFile}`;
      }).join("\n\n");
      const launch = this.tasks.launch({ name: `${r.name.slice(0, 35)}-${s.id.slice(0, 30)}`, task: `${s.task}${dependencies ? `\n\nDirect dependency results (reference data):\n${dependencies}` : ""}`,
        access: s.access, context: s.context ?? r.context, contextText: r.version === 2 ? s.contextText : r.contextText, snapshot: r.version === 2 ? s.snapshot : r.snapshot,
        ...(s.rolePlan ? { rolePlan: { ...structuredClone(s.rolePlan), cwd: loadout.cwd } } : { loadout: { ...structuredClone(loadout), model: s.model ?? loadout.model } }),
        parentSession: r.parentSession, workflow: { id: r.id, stepId: s.id, attemptId: s.attemptId } });
      const task = this.findTask(r, s); if (task) { s.taskId = task.id; s.freshTask = false; }
      // Attach a rejection handler before persisting: disk failure must not leave an unobserved launch.
      void launch.then(t => { if (t.workflow?.attemptId === s.attemptId) { s.taskId = t.id; s.freshTask = false; } }).catch(e => {
        s.error = String(e);
        const task = this.findTask(r, s); if (task) s.taskId = task.id;
        if (!task || !this.tasks.isLive(task.id)) { this.note(r, "step_failed", { stepId: s.id, roleId: s.role, error: String(e) }); s.state = "failed"; }
        if (r.state === "running") { r.state = "paused"; r.error = `Step ${s.id} could not start: ${e}`; this.note(r, "auto_paused", { stepId: s.id, error: r.error }); }
        try { this.save(r); this.emit(r); } catch { this.closed = true; }
      }).finally(() => this.schedule());
      this.save(r);
    }
  }
  pause(id: string): void { this.open(); const r = this.get(id); if (this.cleaning.has(r.id)) throw new Error("Wait for workspace cleanup before pausing"); if (r.state !== "running" && r.state !== "completed") throw new Error("Workflow cannot be paused"); r.state = "paused"; this.save(r); this.note(r, "paused"); }
  resume(id: string): void {
    this.open(); const r = this.get(id); this.reconcile(r);
    if (this.cleaning.has(r.id)) throw new Error("Wait for workspace cleanup before resuming");
    if (r.state !== "paused") throw new Error("Only paused workflows can resume");
    if (this.unsafe(r)) throw new Error("Unconfirmed child shutdown; cannot resume");
    if (r.steps.some(s => s.state === "failed" || s.state === "cancelled" ||
        ["failed", "cancelled"].includes(this.findTask(r, s)?.state ?? ""))) throw new Error("Explicitly retry failed/cancelled steps before resume");
    if (r.steps.some(s => !s.role)) validateLoadout(r.loadout);
    r.state = "running"; r.error = undefined; this.save(r); this.note(r, "resumed"); this.schedule();
  }
  update(id: string, updates: StepDefinition[], rolePlans?: Record<string, RolePlan>, snapshot?: AgentMessage[]): void {
    this.open(); const r = this.get(id);
    if (r.state !== "paused") throw new Error("Pause the workflow before updating pending steps");
    if (this.integrationRuns.has(r.id) || this.preparing.has(r.id)) throw new Error("Wait for workspace preparation/validation before updating steps");
    validateSteps([...r.steps.filter(s => !updates.some(u => u.id === s.id)), ...updates]);
    if (new Set(updates.map(s => s.id)).size !== updates.length) throw new Error("Duplicate step updates");
    for (const update of updates) {
      const old = r.steps.find(s => s.id === update.id);
      if (old && (old.state !== "pending" || old.taskId || old.worktree)) throw new Error(`Step ${old.id} already started; cannot edit`);
    }
    checkPlans(updates, rolePlans);
    const version = r.version === 2 || updates.some(hasStepConfig) || Object.keys(rolePlans ?? {}).length ? 2 : 1;
    const fallback = r.snapshot ?? r.steps.find(s => s.context === "full")?.snapshot ?? (r.version === 1 && r.context === "full" ? [] : undefined);
    const replacements = new Map(updates.map(s => {
      if (version === 1) return [s.id, { ...structuredClone(s), access: accessMode(s.access), state: "pending" as const }] as const;
      const frozen = freezeStep(s, { ...r, snapshot: snapshot ?? r.steps.find(old => old.id === s.id)?.snapshot ?? fallback }, rolePlans?.[s.id]);
      if (frozen.context === "full" && snapshot === undefined && r.steps.find(old => old.id === s.id)?.snapshot === undefined && fallback === undefined) throw new Error(`Step ${s.id}: full context update requires a parent snapshot`);
      return [s.id, frozen] as const;
    }));
    const next = r.steps.map(s => replacements.get(s.id) ?? (r.version === 1 && version === 2
      ? { ...freezeStep(s, { ...r, snapshot: r.snapshot ?? (r.context === "full" ? [] : undefined) }), state: s.state } : s));
    for (const s of replacements.values()) if (!next.some(n => n.id === s.id)) next.push(s);
    r.version = version; r.steps = next;
    if (version === 2) delete r.snapshot;
    r.validated = false; this.retireIntegration(r); this.save(r); this.note(r, "updated");
  }
  async retry(id: string, stepId: string, message: string, access?: AccessMode): Promise<void> {
    this.open(); const r = this.get(id); this.reconcile(r);
    if (r.state !== "paused") throw new Error("Pause the workflow before retrying a step");
    if (this.integrationRuns.has(r.id) || this.preparing.has(r.id) || this.cleaning.has(r.id)) throw new Error("Wait for workspace preparation/validation/cleanup before retrying");
    if (this.active(r).length || this.unsafe(r)) throw new Error("Wait for active steps and confirm child shutdown before retrying");
    const s = r.steps.find(s => s.id === stepId);
    if (!s || s.state === "pending" || s.state === "running") throw new Error("Step has not finished");
    if (!message.trim()) throw new Error("Explicit retry instruction required");
    const descendants = new Set([s.id]);
    for (let i = 0; i < r.steps.length; i++) for (const d of r.steps) if (d.dependsOn.some(id => descendants.has(id))) descendants.add(d.id);
    if (r.steps.some(d => d.id !== s.id && descendants.has(d.id) && (d.state !== "pending" || !!d.worktree))) throw new Error("A dependent step already started; cannot silently invalidate its input");
    const selected = accessMode(access ?? s.access);
    if (!s.role) validateLoadout(r.loadout);
    if (!this.tasks.hasCapacity()) throw new Error("Global subagent concurrency limit reached");
    const task = this.findTask(r, s);
    if (!task) {
      // Failed before a child was created: only an explicit retry can make it pending again.
      s.task = `${s.task}\n\nRetry instruction:\n${message}`; s.access = selected; s.state = "pending"; s.error = undefined; this.save(r); this.note(r, "retried", { stepId: s.id, roleId: s.role }); return;
    }
    if (r.isolation) {
      // A failed child scene is deliberately discarded, never continued with a
      // session whose cwd has vanished. Dependency outputs remain Git inputs.
      const isolation = r.isolation;
      this.preparing.add(r.id);
      const run = Promise.resolve().then(async () => {
        this.open();
        if (s.worktree) {
          if (s.worktree.output) {
            const ref = `refs/pi-workflows/${r.id}/retired/${randomUUID()}`;
            await retain(isolation.repo, ref, s.worktree.output);
            s.worktree.revisionRef = ref; this.save(r);
          }
          this.open();
          await remove(isolation, s.worktree); s.worktree.removed = true;
          (r.retiredTrees ??= []).push(s.worktree); this.save(r);
        }
        this.open();
        if (r.state !== "paused") throw new Error("Workflow state changed during retry; inspect before retrying");
        s.worktree = undefined; s.taskId = undefined; s.freshTask = true; s.attemptId = randomUUID();
        this.retireIntegration(r);
        s.task = `${s.task}\n\nRetry instruction:\n${message}`; s.access = selected;
        s.state = "pending"; s.error = undefined; r.validated = false;
        this.save(r); this.note(r, "retried", { stepId: s.id, roleId: s.role, detail: "isolated" });
      }).finally(() => { this.preparing.delete(r.id); this.workspaceRuns.delete(run); });
      this.workspaceRuns.add(run);
      await run; return;
    }
    this.tasks.store.validateForContinue(task);
    s.access = selected; s.state = "running"; s.error = undefined;
    if (s.worktree) s.worktree.output = undefined;
    r.validated = false; this.retireIntegration(r); this.save(r);
    try { await this.tasks.continue(task.id, message, selected, r.id); this.note(r, "retried", { stepId: s.id, roleId: s.role }); }
    catch (e) { this.note(r, "retry_failed", { stepId: s.id, roleId: s.role, error: String(e) }); s.state = "failed"; s.error = String(e); throw e; }
    finally { this.save(r); this.schedule(); }
  }
  private retireIntegration(r: WorkflowRecord): void {
    if (r.integration) (r.retiredTrees ??= []).push(r.integration);
    r.integration = undefined;
  }
  async cancel(id: string): Promise<void> {
    this.open(); const r = this.get(id);
    if (r.state === "completed") throw new Error("Workflow already completed");
    r.state = "cancelled"; this.note(r, "cancelled"); this.validation.get(r.id)?.abort();
    for (const s of r.steps) if (s.state === "pending") s.state = "cancelled";
    this.save(r);
    const failures = await Promise.allSettled(r.steps.filter(s => s.state === "running").map(async s => {
      const t = this.findTask(r, s);
      if (t && this.tasks.isLive(t.id)) await this.tasks.cancel(t.id);
      else if (t && !t.stopped) throw new Error(`Unconfirmed shutdown: ${t.id}`);
    }));
    await this.integrationRuns.get(r.id);
    this.reconcile(r); this.save(r); this.emit(r);
    const failure = failures.find(f => f.status === "rejected");
    if (failure?.status === "rejected") throw new Error(`Workflow cancelled but cleanup unconfirmed: ${failure.reason}`);
    if (this.unsafe(r)) throw new Error("Workflow cancelled but process cleanup unconfirmed; inspect retained processes");
    // Preparation can still be finishing after cancel marks the record terminal.
    await this.pump;
    await this.cleanup(id);
  }
  /** Retry terminal cleanup after a crash, ref failure or unconfirmed shutdown. */
  async cleanup(id: string): Promise<void> {
    this.open();
    const r = this.get(id);
    this.note(r, "cleanup");
    try { await this.cleanupRecord(r); }
    catch (e) { r.cleanupError = String(e); this.save(r); throw e; }
  }
  private cleanupRecord(r: WorkflowRecord): Promise<void> {
    const existing = this.cleaning.get(r.id);
    if (existing) return existing;
    const run = this.performCleanup(r).finally(() => this.cleaning.delete(r.id));
    this.cleaning.set(r.id, run); return run;
  }
  private async performCleanup(r: WorkflowRecord): Promise<void> {
    if (r.state !== "completed" && r.state !== "cancelled") throw new Error("Only completed/cancelled workflows can be cleaned up; paused scenes are retained");
    if (r.workspace !== "isolated" || !r.isolation) return;
    if (this.closed || this.preparing.has(r.id) || this.integrationRuns.has(r.id) || this.validation.has(r.id)) throw new Error("Wait for workspace preparation/validation before cleanup");
    if (this.unsafe(r) || (r.validationPid && groupAlive(r.validationPid)) || [...this.tasks.records.values()].some(t => t.workflow?.id === r.id && (this.tasks.isLive(t.id) || !t.stopped))) throw new Error("Unconfirmed child/validation shutdown; worktrees retained");
    // Derive completion from persisted removal/ref state so recovery and unrelated
    // task updates do not rewrite refs or repeat terminal notifications.
    const ownedTrees = [...r.steps.flatMap(s => s.worktree ? [s.worktree] : []),
      ...(r.integration ? [r.integration] : []), ...(r.retiredTrees ?? [])];
    if (r.baseRef && !r.cleanupError && ownedTrees.every(tree => tree.removed && (!tree.output || tree.revisionRef))) return;
    // Capture stopped successful siblings even when cancellation won the race.
    await this.collectForCleanup(r);
    const isolation = r.isolation;
    const prefix = `refs/pi-workflows/${r.id}`;
    await retain(isolation.repo, `${prefix}/base`, isolation.base);
    r.baseRef = `${prefix}/base`; this.save(r);
    const trees = r.steps.flatMap(s => s.worktree ? [{ tree: s.worktree, ref: `${prefix}/steps/${s.id}` }] : []);
    if (r.integration) trees.push({ tree: r.integration, ref: `${prefix}/result` });
    // Retired published results must not overwrite the new /result ref. Pin
    // their old commits first, before reusing any public step/result ref.
    trees.unshift(...(r.retiredTrees ?? []).map((tree, i) => ({ tree,
      ref: tree.revisionRef?.startsWith(`${prefix}/retired/`) ? tree.revisionRef : `${prefix}/retired/${i}` })));
    // All preservation must succeed before the first destructive removal.
    for (const { tree, ref } of trees) if (tree.output) {
      await retain(isolation.repo, ref, tree.output); tree.revisionRef = ref; this.save(r);
    }
    for (const { tree } of trees) if (!tree.removed) {
      if (this.closed) throw new Error("Owner shutting down; remaining worktrees retained");
      await remove(isolation, tree); tree.removed = true; this.save(r);
    }
    r.cleanupError = undefined; this.save(r); this.emit(r);
  }
  private async collectForCleanup(r: WorkflowRecord): Promise<void> {
    for (const s of r.steps) {
      const t = this.findTask(r, s);
      if (s.state !== "failed" && s.state !== "cancelled" && t?.stopped && t.state === "completed" && s.worktree && !s.worktree.output && !s.worktree.removed) {
        await capture(s.worktree); s.state = "completed"; this.save(r);
      }
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true; this.unsubscribe();
    for (const controller of this.validation.values()) controller.abort();
    await Promise.allSettled([...(this.pump ? [this.pump] : []), ...this.integrationRuns.values(), ...this.cleaning.values(), ...this.workspaceRuns]);
    for (const r of this.records.values()) if (r.state === "running") { r.state = "paused"; r.error = "Parent session closed; explicit resume required"; this.save(r); }
  }
}
export function workflowSummary(r: WorkflowRecord): string {
  return `${r.name} [${r.id}] ${r.state} workspace=${r.workspace ?? "shared"}\n${r.integration ? `Integration: ${r.integration.path} revision=${r.integration.revisionRef ?? r.integration.output ?? "pending"} removed=${!!r.integration.removed} validated=${!!r.validated}${r.validationPid ? ` validationPid=${r.validationPid}` : ""}\n` : ""}${r.error ?? ""}${r.cleanupError ? `\nCleanup blocked: ${r.cleanupError}` : ""}\n${r.steps.map(s => `${s.id}: ${s.state} (${s.access})${s.rolePlan ? ` role=${s.role} config=${rolePlanDigest(s.rolePlan).slice(0, 12)}` : ""}${r.version === 2 ? ` model=${s.model} context=${s.context} dependencyReports=${s.dependencyReports}` : ""} dependsOn=[${s.dependsOn.join(", ")}]${s.taskId ? ` task=${s.taskId}` : ""}${s.worktree ? ` worktree=${s.worktree.path} removed=${!!s.worktree.removed}${s.worktree.revisionRef ? ` ref=${s.worktree.revisionRef}` : ""}` : ""}${s.error ? ` — ${s.error}` : ""}`).join("\n")}`;
}
