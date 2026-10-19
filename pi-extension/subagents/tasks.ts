import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { RpcProcess, type RpcEvent, type RpcLaunch } from "./rpc.ts";
import { CHILD_EXTENSION, validateLoadout, applyAccess, accessMode, type AccessMode, type Loadout } from "./loadout.ts";
import { atomicWrite, addLog, bounded, uniqueName, terminal, TaskStore, type TaskRecord } from "./store.ts";
import { COOPERATION, seedSession, taskPrompt, type ContextMode } from "./context.ts";
import type { AgentMessage } from "./context.ts";
import { diagnoseFailure } from "./diagnostics.ts";
import { SystemdExecutionController, readProcessIdentity, isProcessIdentityAlive, type ExecutionController } from "./execution.ts";
import { acquireExecutionLease, type ExecutionLease } from "./lease.ts";
import { isDeepStrictEqual } from "node:util";
import { effectiveRole, initialRoleLoadout, mergeRoleBaseline, rolePlanDigest, ROLE_CHILD_EXTENSION,
  snapshotRoleLoadout, validateRolePlan, validateRoleSnapshot, type RolePlan, type RoleRun, type RolePreflightResult } from "./role-loadout.ts";

export type NewTask = {
  name?: string; task: string; access: AccessMode; context: ContextMode; contextText?: string;
  workflow?: { id: string; stepId: string; attemptId?: string };
  snapshot?: AgentMessage[]; parentSession?: string;
} & ({ loadout: Loadout; rolePlan?: never } | { rolePlan: RolePlan; loadout?: never });
interface LiveRun {
  rpc: RpcProcess; release: () => void; finishing?: Promise<void>; pendingMessages: number;
  startupPhase?: string;
  cancelRequested?: boolean;
  settled: boolean; lastStop?: string; lastError?: string; started: boolean; askToolCallId?: string;
  persistTimer?: ReturnType<typeof setTimeout>; settleChecking?: boolean; checkAgain?: boolean;
  finalTools: Map<string, boolean>; finalOutput: Map<string, string>; submission: number;
}
interface ManagerOptions {
  command: string; baseArgs?: string[]; maxConcurrent?: number;
  createRpc?: (launch: RpcLaunch) => RpcProcess;
  executionController?: ExecutionController;
  changed?: () => void; notify?: (record: TaskRecord, kind: "result" | "question") => void;
  /** Tests may shorten delays; production retries are bounded and back off. */
  recoveryDelayMs?: number;
}
export function childLaunch(record: TaskRecord, dir: string, command: string, baseArgs: string[] = []): RpcLaunch {
  if (record.version === 3) return roleChildLaunch(record, dir, command, baseArgs);
  const l = validateLoadout(record.loadout);
  const loadoutPath = join(dir, `${record.id}.loadout.json`);
  const promptPath = join(dir, `${record.id}.prompt.md`);
  atomicWrite(loadoutPath, JSON.stringify(l));
  atomicWrite(promptPath, COOPERATION);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_RPC_SUBAGENT_") || key === "PI_SESSION_FILE" || key === "PI_SESSION_ID") delete env[key];
  env.PI_RPC_SUBAGENT_LOADOUT = loadoutPath;
  env.PI_RPC_SUBAGENT_CHILD = "1";
  env.PI_CODING_AGENT_DIR = l.agentDir;
  return {
    command, cwd: l.cwd, env,
    args: [...baseArgs, "--mode", "rpc", "--session", record.sessionFile,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
      "--tools", l.tools.join(","), "--model", l.model, "--thinking", l.thinking,
      "--append-system-prompt", promptPath,
      ...l.skills.flatMap(s => ["--skill", s.loadPath ?? s.filePath]),
      "-e", CHILD_EXTENSION, ...[...new Set([...(l.providerExtensions ?? []), ...l.extensions])].flatMap(p => ["-e", p])],
  };
}
function newRoleRun(record: Pick<TaskRecord, "id" | "run" | "workflow">, plan: RolePlan, access: AccessMode, continuationMessage?: string): RoleRun {
  return { version: 1, binding: { taskId: record.id, run: record.run, attemptId: randomUUID(), nonce: randomUUID(), planHash: rolePlanDigest(plan) },
    access, status: "planned", outcome: "running", cleanup: "pending", ...(continuationMessage !== undefined ? { continuationMessage } : {}) };
}
function roleResultPath(record: TaskRecord, dir: string): string {
  return join(dir, `${record.id}.${record.run}.${record.roleRuns!.at(-1)!.binding.nonce}.preflight.json`);
}
function roleChildLaunch(record: TaskRecord, dir: string, command: string, baseArgs: string[]): RpcLaunch {
  const plan = validateRolePlan(record.rolePlan, { access: record.access });
  const run = record.roleRuns!.at(-1)!;
  const effective = effectiveRole(plan, run.access);
  // Fail before importing local code or launching resources; MCP belongs to M3.
  if (effective.mcp.length) throw new Error("Role MCP execution requires M3");
  const runPath = join(dir, `${record.id}.${record.run}.role-run.json`);
  const promptPath = join(dir, `${record.id}.${record.run}.prompt.md`);
  atomicWrite(runPath, JSON.stringify({ plan, run, resultPath: roleResultPath(record, dir) }));
  atomicWrite(promptPath, `${plan.systemPrompt}\n\n${COOPERATION}`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_RPC_SUBAGENT_") || key === "PI_SESSION_FILE" || key === "PI_SESSION_ID") delete env[key];
  env.PI_RPC_SUBAGENT_ROLE_RUN = runPath; env.PI_RPC_SUBAGENT_CHILD = "1"; env.PI_CODING_AGENT_DIR = plan.agentDir;
  return { command, cwd: plan.cwd, env, args: [...baseArgs, "--mode", "rpc", "--session", record.sessionFile,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
    "--model", plan.model, "--thinking", plan.thinking, "--append-system-prompt", promptPath,
    ...plan.skills.flatMap(s => ["--skill", s.loadPath ?? s.filePath]),
    "-e", ROLE_CHILD_EXTENSION, ...(plan.providerExtensions ?? []).flatMap(p => ["-e", p])] };
}
function text(message: any): string {
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}
export class TaskManager {
  readonly records = new Map<string, TaskRecord>();
  private live = new Map<string, LiveRun>();
  private closed = false;
  private lease?: ExecutionLease;
  private recoveryWork?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown?: Promise<void>;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  isLive(id: string): boolean { return this.live.has(id); }
  hasCapacity(): boolean { return [...this.records.values()].filter(r => !r.stopped).length < (this.options.maxConcurrent ?? 8); }
  /** Acquire directory ownership before task/workflow loading can mutate anything. */
  static async open(store: TaskStore, options: ManagerOptions): Promise<TaskManager> {
    if (process.platform !== "linux") return new TaskManager(store, options);
    let manager: TaskManager | undefined;
    const lease = await acquireExecutionLease(join(store.dir, ".owner.lease"), () => { void manager?.shutdown(); });
    try {
      const path = join(store.dir, ".owner.json"), identity = readProcessIdentity(process.pid);
      if (!identity) throw new Error("Cannot establish parent process identity; recovery is isolated");
      if (existsSync(path)) {
        const previous = JSON.parse(readFileSync(path, "utf8"));
        if (previous.active !== false && isProcessIdentityAlive(previous.identity)) {
          throw new Error("Previous parent is still alive; refusing execution ownership takeover");
        }
      }
      manager = new TaskManager(store, { ...options, executionController: options.executionController ?? new SystemdExecutionController() });
      manager.lease = lease;
      atomicWrite(path, JSON.stringify({ identity, active: true }));
      for (const record of manager.records.values()) {
        if (record.recovery) store.save(record);
        // completeCleanup may have persisted its proof before crashing on lock deletion.
        // Only this leased owner may finish that idempotent release; stopped alone is not proof.
        if (record.stopped && terminal(record.state) && record.execution?.cleanup === "confirmed") {
          manager.assertOwnership();
          store.lock(record.id, true)();
        }
      }
      return manager;
    } catch (error) { await lease.release(); throw error; }
  }
  constructor(readonly store: TaskStore, private options: ManagerOptions) {
    if (!Number.isInteger(options.maxConcurrent ?? 8) || (options.maxConcurrent ?? 8) < 1) throw new Error("maxConcurrent must be a positive integer");
    for (const record of store.load()) this.records.set(record.id, record);
  }
  assertOwnership(): void {
    if (this.lease && !this.lease.alive) throw new Error("Execution ownership lease was lost; manager is fenced");
  }
  private save(record: TaskRecord, announce = true): void {
    this.assertOwnership();
    record.updatedAt = Date.now();
    const run = record.roleRuns?.at(-1);
    if (run) { run.outcome = record.state; run.error = record.error; run.cleanup = record.stopped ? "confirmed" : "pending"; }
    this.store.save(record);
    if (announce) { this.options.changed?.(); for (const listener of this.listeners) listener(); }
  }
  get(id: string): TaskRecord {
    const record = this.records.get(id) ?? [...this.records.values()].find(r => r.name === id);
    if (!record) throw new Error(`Unknown task: ${id}`);
    return record;
  }
  async launch(input: NewTask): Promise<TaskRecord> {
    if (this.closed) throw new Error("Parent session is shutting down");
    if (!this.hasCapacity()) throw new Error("Global subagent concurrency limit reached; wait for a child to stop");
    if (!input.task.trim()) throw new Error("Task is required");
    const prompt = taskPrompt(input.task, input.access, input.context, input.contextText);
    const plan = input.rolePlan ? structuredClone(validateRolePlan(input.rolePlan, { access: input.access })) : undefined;
    if (plan && (plan.context !== input.context || plan.access !== input.access)) throw new Error("Role plan/input context or initial access mismatch");
    if (plan && input.context !== "partial" && input.contextText !== undefined) throw new Error("Role contextText is only supported for partial context");
    if (!plan) validateLoadout(input.loadout);
    if (input.context === "full" && plan && !Array.isArray(input.snapshot)) throw new Error("Role full context requires an explicit frozen parent snapshot");
    const id = randomUUID();
    const record: TaskRecord = {
      version: plan ? 3 : 2, id, name: uniqueName(input.name ?? input.context, [...this.records.values()].map(r => r.name)),
      task: input.task, access: input.access, context: input.context,
      loadout: plan ? initialRoleLoadout(plan, input.access) : applyAccess(input.loadout!, input.access),
      availableLoadout: plan ? undefined : structuredClone(input.loadout), workflow: input.workflow,
      ...(plan ? { rolePlan: plan, roleBaseline: [], taskInput: { task: input.task, context: input.context,
        ...(input.contextText !== undefined ? { contextText: input.contextText } : {}),
        ...(input.context === "full" ? { snapshot: structuredClone(input.snapshot!) } : {}),
        ...(input.parentSession ? { parentSession: input.parentSession } : {}), cwd: plan.cwd } } : {}),
      state: "running", startedAt: Date.now(), updatedAt: Date.now(), sessionFile: join(this.store.dir, `${id}.session.jsonl`),
      output: "", activity: "starting RPC", log: [], questions: [], stopped: false, run: 1,
    };
    if (plan) record.roleRuns = [newRoleRun(record, plan, input.access)];
    // Reserve names and session ownership synchronously, before any startup awaits.
    this.records.set(id, record);
    try {
      seedSession(record.sessionFile, record.loadout.cwd, input.context, input.snapshot, input.parentSession);
      this.save(record);
    } catch (e) { this.records.delete(id); throw e; }
    await this.start(record, prompt);
    return record;
  }
  async continue(id: string, message: string, access?: AccessMode, workflowId?: string, automatic = false): Promise<TaskRecord> {
    if (this.closed) throw new Error("Parent session is shutting down");
    if (!message.trim()) throw new Error("Continuation message is required");
    const record = this.get(id);
    if (!automatic && record.recovery && record.recovery.phase !== "blocked") throw new Error("Task automatic recovery is pending");
    if (record.workflow && record.workflow.id !== workflowId) throw new Error("Use workflow_control retry for workflow steps");
    const selected = accessMode(access ?? record.access);
    const available = record.availableLoadout ?? record.loadout;
    const effective = record.version === 3 ? initialRoleLoadout(validateRolePlan(record.rolePlan, { access: selected }), selected) : applyAccess(available as Loadout, selected);
    if (this.live.get(record.id)?.finishing && !record.stopped) throw new Error("Task shutdown is not confirmed; automatic cleanup pending");
    if (this.live.has(record.id)) throw new Error("Task is already running or stopping");
    this.store.validateForContinue(record);
    if (!this.hasCapacity()) throw new Error("Global subagent concurrency limit reached; wait for a child to stop");
    const release = this.store.lock(record.id);
    if (!automatic) {
      record.recoveryRuns = 0;
      record.continuationTask = message;
      record.supplementaryInstructions = [];
    }
    record.recovery = undefined;
    const previousRoleRun = record.roleRuns?.at(-1);
    const neverSubmitted = record.version === 3 && record.roleRuns!.every(run => ["planned", "verified"].includes(run.status));
    const preSubmissionRecovery = record.version === 3 && automatic && previousRoleRun && ["planned", "verified"].includes(previousRoleRun.status);
    if (record.version !== 3) { record.version = 2; record.availableLoadout = structuredClone(available as Loadout); }
    record.access = selected; record.loadout = effective;
    record.state = "running"; record.stopped = false; record.run++; record.error = undefined;
    if (record.version === 3) {
      const retainedMessage = preSubmissionRecovery ? previousRoleRun!.continuationMessage : message;
      record.roleRuns!.push(newRoleRun(record, record.rolePlan!, selected, retainedMessage));
    }
    record.questions = []; record.output = ""; record.startedAt = Date.now(); record.activity = "starting continuation";
    addLog(record, `Continuation ${record.run}: ${message}`);
    try {
      if (record.version === 3 && !existsSync(record.sessionFile)) {
        const input = record.taskInput!;
        seedSession(record.sessionFile, input.cwd, input.context, input.snapshot, input.parentSession);
      }
      this.save(record);
    }
    catch (e) { release(); record.state = "failed"; record.stopped = true; throw e; }
    const retained = record.roleRuns?.at(-1)?.continuationMessage;
    const continuation = preSubmissionRecovery ? retained : message;
    const prompt = neverSubmitted ?
      taskPrompt(record.taskInput!.task, selected, record.taskInput!.context, record.taskInput!.contextText) +
        (continuation !== undefined ? `\n\nContinuation task (takes precedence):\n${continuation}` : "") :
      `${COOPERATION}\nAccess: ${record.access}\nContinuation task:\n${continuation}`;
    await this.start(record, prompt, release);
    return record;
  }
  private async start(record: TaskRecord, prompt: string, reserved?: () => void): Promise<void> {
    let release = reserved;
    let spawned = false;
    let phase = "launch";
    try {
      this.assertOwnership();
      if (this.closed) throw new Error("Parent session is shutting down");
      release ??= this.store.lock(record.id);
      let launch = childLaunch(record, this.store.dir, this.options.command, this.options.baseArgs);
      const boundary = this.lease ? this.options.executionController?.prepare(record.id, record.run) : undefined;
      record.execution = boundary ? { boundary, intent: "running", cleanup: "pending" } : undefined;
      this.save(record); // Identity is durable before the launcher can create a scope.
      if (boundary) launch = this.options.executionController!.wrap(launch, boundary);
      const rpc = (this.options.createRpc ?? (l => new RpcProcess(l)))(launch);
      const live: LiveRun = { rpc, release, startupPhase: phase, pendingMessages: 1, settled: false, started: false, finalTools: new Map(), finalOutput: new Map(), submission: 0 };
      this.live.set(record.id, live);
      spawned = true;
      if (record.execution) {
        record.execution.launcher = rpc.pid ? readProcessIdentity(rpc.pid) : undefined;
        this.save(record); // Missing identity after a crash is isolated, never guessed.
      }
      rpc.on("event", event => {
        try { this.event(record, live, event); }
        catch (e) { void this.finish(record, "failed", String(e)); }
      });
      rpc.on("fault", error => { if (!live.finishing) void this.finish(record, "failed", String(error), !live.startupPhase); });
      rpc.on("closed", detail => {
        if (!live.finishing) void this.finish(record, "failed", `Unexpected child exit: ${detail.code ?? detail.signal}\n${detail.stderr}`, !live.startupPhase);
      });
      phase = live.startupPhase = "RPC readiness";
      await rpc.request("get_state"); // readiness, not a timed sleep
      this.assertOwnership();
      if (this.closed || live.finishing) throw new Error("Parent session closed during startup");
      if (record.execution) { record.execution.ready = true; this.save(record); }
      await rpc.request("set_auto_retry", { enabled: false });
      phase = live.startupPhase = "loadout preflight";
      const commands = await rpc.request("get_commands");
      if (!commands?.commands?.some((c: { name: string }) => c.name === "rpc-subagent-preflight")) throw new Error("Child bridge did not load; refusing to send any model prompt");
      await rpc.request("prompt", { message: "/rpc-subagent-preflight" });
      this.assertOwnership();
      if (live.finishing || this.closed) throw new Error("Child failed during preflight");
      if (record.version === 3) {
        const run = record.roleRuns!.at(-1)!;
        const result = JSON.parse(readFileSync(roleResultPath(record, this.store.dir), "utf8")) as RolePreflightResult;
        if (!isDeepStrictEqual(result.binding, run.binding)) throw new Error("Role preflight result binding mismatch");
        if (typeof result.error === "string") throw new Error(`Role preflight failed: ${result.error}`);
        const snapshot = structuredClone(validateRoleSnapshot(result.snapshot, record.rolePlan!, run.binding, run.access));
        const baseline = mergeRoleBaseline(record.roleBaseline!, snapshot);
        if (this.closed || live.finishing || live.cancelRequested) throw new Error("Role task stopped before verified snapshot persistence");
        run.snapshot = snapshot; run.status = "verified";
        record.roleBaseline = baseline; record.loadout = snapshotRoleLoadout(record.rolePlan!, snapshot);
        this.save(record); // Atomic role snapshot + cumulative verified baseline, before any model submission.
      }
      phase = live.startupPhase = "initial prompt";
      if (this.closed || live.finishing || live.cancelRequested) throw new Error("Task stopped before model submission");
      if (record.version === 3) {
        record.roleRuns!.at(-1)!.status = "submitting"; this.save(record);
        if (this.closed || live.finishing || live.cancelRequested) throw new Error("Role task stopped before model submission");
      }
      await rpc.request("prompt", { message: prompt });
      if (record.version === 3) { record.roleRuns!.at(-1)!.status = "submitted"; this.save(record); }
      live.startupPhase = undefined;
      live.pendingMessages--;
      addLog(record, "Initial task accepted by RPC (not a completion acknowledgement)");
      this.save(record); this.maybeComplete(record, live);
    } catch (e) {
      if (spawned) await this.finish(record, "failed", String(e));
      else {
        release?.(); record.state = "failed"; record.error = diagnoseFailure(String(e), record.loadout, phase); record.stopped = true;
        if (record.execution) { record.execution.intent = "failed"; record.execution.cleanup = "confirmed"; }
        this.save(record);
      }
      throw new Error(diagnoseFailure(String(e), record.loadout, phase), { cause: e });
    }
  }
  private event(record: TaskRecord, live: LiveRun, event: RpcEvent): void {
    if (live.finishing || this.closed) return;
    if (event.type === "extension_error") throw new Error(`Child extension error: ${event.error}`);
    if (event.type === "agent_start") { live.started = true; live.settled = false; record.activity = "model running"; }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      record.output = bounded(record.output + event.assistantMessageEvent.delta);
    }
    if (event.type === "message_start" && event.message?.role === "assistant") record.output = "";
    if (event.type === "message_end" && event.message?.role === "assistant") {
      record.output = bounded(text(event.message)); live.lastStop = event.message.stopReason; live.lastError = event.message.errorMessage;
      live.finalTools = new Map((event.message.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => [b.id, false]));
      live.finalOutput.clear();
      addLog(record, `Assistant: ${record.output}`);
    }
    if (event.type === "tool_execution_start") {
      if (event.toolName === "ask_question") live.askToolCallId = event.toolCallId;
      record.activity = `${event.toolName}: ${bounded(JSON.stringify(event.args ?? {}), 200)}`;
      addLog(record, `Start ${event.toolCallId}: ${record.activity}`);
    }
    if (event.type === "tool_execution_update") record.activity = `${event.toolName}: ${bounded(text(event.partialResult), 200)}`;
    if (event.type === "tool_execution_end") {
      if (live.finalTools.has(event.toolCallId)) {
        const terminating = event.result?.terminate === true && event.isError === false;
        live.finalTools.set(event.toolCallId, terminating);
        if (terminating) live.finalOutput.set(event.toolCallId, bounded(text(event.result)));
      }
      if (event.toolName === "ask_question") live.askToolCallId = undefined;
      addLog(record, `${event.isError ? "Failed" : "Done"} ${event.toolName} (${event.toolCallId}): ${text(event.result)}`);
      if (event.toolName === "ask_question") record.questions = record.questions.filter(q => q.toolCallId !== event.toolCallId);
      record.state = record.questions.length ? "waiting" : "running";
      record.activity = record.questions.length ? "waiting for parent answer" : "model running";
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "input") {
        if (typeof event.id !== "string" || typeof event.title !== "string") throw new Error("Malformed question");
        if (!record.questions.some(q => q.id === event.id)) {
          if (!live.askToolCallId) throw new Error("Unsolicited child dialog; only ask_question input is supported");
          record.questions.push({ id: event.id, title: event.title, toolCallId: live.askToolCallId });
          record.state = "waiting"; record.activity = "waiting for parent answer";
          this.save(record); this.options.notify?.(record, "question");
        }
      } else if (["select", "confirm", "editor"].includes(event.method)) {
        live.rpc.send({ type: "extension_ui_response", id: event.id, cancelled: true });
        throw new Error(`Unsupported child dialog ${event.method}; use ask_question`);
      }
      // Child widgets/notifications are not terminal components and do not own the parent's UI.
    }
    if (event.type === "agent_settled") { live.settled = true; this.maybeComplete(record, live); }
    if (event.type === "queue_update" && !live.started) this.maybeComplete(record, live);
    if (!live.finishing) {
      if (event.type === "message_update" || event.type === "tool_execution_update") {
        if (!live.persistTimer) live.persistTimer = setTimeout(() => {
          live.persistTimer = undefined;
          try { if (!live.finishing) this.save(record); }
          catch (e) { void this.finish(record, "failed", String(e)); }
        }, 200);
      } else this.save(record);
    }
  }
  private maybeComplete(record: TaskRecord, live: LiveRun): void {
    if ((live.started && !live.settled) || live.pendingMessages || record.questions.length || live.finishing) return;
    if (live.settleChecking) { live.checkAgain = true; return; }
    // A supplement can race an older run's agent_settled. Query after all prompt receipts,
    // then recheck local counters before closing a session that may now be running again.
    live.settleChecking = true;
    const submission = live.submission;
    void live.rpc.request("get_state").then(state => {
      if (submission !== live.submission) { live.checkAgain = true; return; }
      if (!live.finishing && (!live.started || live.settled) && live.pendingMessages === 0 && !record.questions.length &&
          state?.isStreaming === false && !state.isCompacting && !state.pendingMessageCount) {
        if (!live.started) {
          void this.finish(record, "failed", "RPC accepted the task but no agent run started and no work is queued (input may have been handled by an extension)");
          return;
        }
        const terminated = live.lastStop === "toolUse" && live.finalTools.size > 0 && [...live.finalTools.values()].every(Boolean);
        if (terminated) record.output = bounded([record.output, ...[...live.finalTools.keys()].map(id => live.finalOutput.get(id))].filter(Boolean).join("\n"));
        const final = live.lastStop === "aborted" ? "cancelled" : live.lastStop === "stop" || terminated ? "completed" : "failed";
        void this.finish(record, final, final === "failed" ? live.lastError ?? `Run settled with stopReason=${live.lastStop ?? "missing"}` : undefined);
      }
    }).catch(e => { if (!live.finishing) void this.finish(record, "failed", String(e)); })
      .finally(() => {
        live.settleChecking = false;
        if (live.checkAgain) { live.checkAgain = false; this.maybeComplete(record, live); }
      });
  }
  private finish(record: TaskRecord, state: TaskRecord["state"], error?: string, interrupted = false): Promise<void> {
    const live = this.live.get(record.id);
    if (!live) return Promise.resolve();
    if (live.finishing) return live.finishing;
    if (error) error = diagnoseFailure(error, record.loadout, live.startupPhase);
    // Install promise before stopping: close/fault callbacks must never finalize twice.
    if (live.persistTimer) clearTimeout(live.persistTimer);
    live.finishing = Promise.resolve().then(async () => {
      record.state = live.cancelRequested ? "cancelled" : state;
      record.error = live.cancelRequested ? "Cancelled by parent" : error;
      record.questions = []; record.activity = "stopping process";
      if (record.execution) record.execution.intent = !live.cancelRequested && interrupted ? "interrupted" : record.state;
      let persistenceError: unknown;
      try { this.save(record, false); } catch (e) { persistenceError = e; }
      // Even a persistence/lease failure must stop this manager's already-owned RPC.
      try {
        let stopError: unknown;
        try { await live.rpc.stop(); } catch (e) { stopError = e; }
        if (record.execution) await this.confirmBoundary(record, live);
        else if (stopError) throw stopError;
        if (persistenceError) throw persistenceError;
        this.completeCleanup(record, live);
        if (!this.closed && record.execution?.intent === "interrupted" && !record.workflow && (record.recoveryRuns ?? 0) < 1) {
          record.recovery = { phase: "cleaning", attempts: 0 };
          this.save(record); this.scheduleRecovery();
        } else if (!this.closed) this.options.notify?.(record, "result");
      } catch (e) {
        record.stopped = false;
        record.recovery = { phase: record.execution ? "cleaning" : "blocked", attempts: 0, error: String(e) };
        record.activity = record.execution ? "automatic cleanup pending" : record.state;
        this.save(record);
        // Keep the RPC handle and release callback: stop failure must remain retryable.
        if (record.execution) this.scheduleRecovery();
        else if (!this.closed) this.options.notify?.(record, "result");
      }
    }).catch(e => { record.stopped = false; record.recovery = { phase: "blocked", attempts: 0, error: String(e) }; });
    return live.finishing;
  }
  private async confirmBoundary(record: TaskRecord, live?: LiveRun): Promise<void> {
    if (!live) this.assertOwnership(); // A fenced manager may still stop its own live execution.
    const execution = record.execution;
    if (!this.lease || !execution || !this.options.executionController) throw new Error("No verifiable execution boundary; automatically isolated");
    // Readiness seals scope creation. Otherwise a late orphan launcher could create
    // a scope after a 'not found' check; only proven launcher death seals that race.
    if (!execution.ready && !(live?.rpc.exited || (execution.launcher && !isProcessIdentityAlive(execution.launcher)))) {
      throw new Error("Execution launcher has not settled; cleanup remains unconfirmed");
    }
    if (!live && !execution.launcher) throw new Error("Execution launcher identity missing; automatically isolated");
    await this.options.executionController.cleanup(execution.boundary);
    if (live && !live.rpc.exited) { try { await live.rpc.retryStop(); } catch { /* proof below */ } }
    if (live ? !live.rpc.exited : isProcessIdentityAlive(execution.launcher!)) {
      throw new Error("Execution boundary is empty but launcher exit is not yet confirmed");
    }
  }
  private completeCleanup(record: TaskRecord, live?: LiveRun, announce = true): void {
    record.stopped = true; record.recovery = undefined;
    if (record.error === "Interrupted execution; automatic cleanup pending") record.error = "Previous execution interrupted; cleanup confirmed";
    if (record.execution) record.execution.cleanup = "confirmed";
    record.activity = record.state;
    this.save(record, announce);
    if (live) { live.release(); this.live.delete(record.id); }
    else this.store.lock(record.id, true)(); // Leased directory + confirmed boundary, no stale-unlink race.
  }
  /** Called once after workflow listeners are installed; no model polling required. */
  startRecovery(): void {
    if (this.closed) return;
    if (!this.lease) return;
    void this.recover();
  }
  private scheduleRecovery(): void {
    if (this.closed || this.recoveryTimer || !this.lease) return;
    const pending = [...this.records.values()].filter(r => r.execution && r.recovery?.phase === "cleaning" &&
      (!r.stopped || r.execution.intent === "interrupted" && !r.workflow && (r.recoveryRuns ?? 0) < 1));
    if (!pending.length) return;
    const attempts = Math.min(...pending.map(r => r.recovery?.attempts ?? 0));
    this.recoveryTimer = setTimeout(() => { this.recoveryTimer = undefined; void this.recover(); },
      this.options.recoveryDelayMs ?? Math.min(30000, 1000 * 2 ** attempts));
    this.recoveryTimer.unref();
  }
  private recover(): Promise<void> {
    if (this.recoveryWork) return this.recoveryWork;
    this.recoveryWork = Promise.resolve().then(async () => {
      for (const record of this.records.values()) {
        if (this.closed) break;
        const live = this.live.get(record.id);
        const interrupted = record.execution?.intent === "interrupted" && !record.workflow && (record.recoveryRuns ?? 0) < 1;
        if ((record.stopped && !interrupted) || !record.execution || (live && !live.finishing) || record.recovery?.phase === "blocked") continue;
        if (live?.finishing) await live.finishing;
        if (record.stopped && !(record.execution.intent === "interrupted" && !record.workflow && (record.recoveryRuns ?? 0) < 1)) continue;
        const run = record.run;
        record.recovery = { phase: "cleaning", attempts: (record.recovery?.attempts ?? 0) + 1 };
        record.activity = "automatically cleaning previous execution";
        this.save(record);
        try {
          if (!record.stopped || record.execution.cleanup !== "confirmed") await this.confirmBoundary(record, live);
          if (record.execution.intent !== "interrupted") record.state = record.execution.intent;
          // Do not expose a cleared recovery guard to synchronous subscribers before
          // lock release and either waiting-state or continuation-slot reservation.
          this.completeCleanup(record, live, false);
          if (record.execution.intent === "interrupted" && !record.workflow && !this.closed && (record.recoveryRuns ?? 0) < 1) {
            if (!this.hasCapacity()) {
              // Cleanup frees this writer's slot, but other cleanup/runs may still fill
              // capacity. Waiting is not a submission and must not consume its budget.
              record.recovery = { phase: "cleaning", attempts: 0 };
              record.activity = "automatic continuation waiting for capacity";
              this.save(record);
              continue;
            }
            record.recoveryRuns = (record.recoveryRuns ?? 0) + 1;
            record.recovery = { phase: "resuming", attempts: 0 };
            // No listeners between the capacity check and continue's synchronous slot
            // reservation: a reentrant launch must not steal capacity after budget use.
            this.save(record, false); // Reserve the attempt durably before any new prompt.
            await this.continue(record.id,
              `Recover the interrupted task using the retained session history. First inspect existing results and partial tool effects. Do not blindly repeat side effects or treat interruption as rollback. Keep all original restrictions and finish only remaining work. Original task:\n${record.task}` +
                (record.version === 3 && record.taskInput?.context === "partial" ? `\nOriginal selected parent context (saved before submission):\n${record.taskInput.contextText}` : "") +
                (record.continuationTask ? `\nLatest continuation instruction (takes precedence):\n${record.continuationTask}` : "") +
                (record.supplementaryInstructions?.length ? `\nSupplementary instructions submitted by the parent (receipt/execution may be unknown):\n${record.supplementaryInstructions.join("\n\n")}` : ""),
              record.access, undefined, true);
          } else if (!this.closed) {
            // Terminal/workflow listeners still need the cleanup transition, but only
            // after its old lock is gone. A listener may explicitly start a new run.
            this.save(record);
            if (record.run === run && record.stopped) this.options.notify?.(record, "result");
          }
        } catch (error) {
          if (this.closed) break;
          if (record.run !== run) continue; // The replacement run owns its own cleanup/outcome now.
          const attempts = record.recovery?.attempts ?? 5;
          const isolated = attempts >= 5 || record.stopped && (record.recoveryRuns ?? 0) >= 1;
          record.recovery = { phase: isolated ? "blocked" : "cleaning", attempts, error: String(error) };
          record.activity = isolated ? "automatic continuation isolated" : "automatic cleanup retry pending";
          this.save(record);
          if (isolated) this.options.notify?.(record, "result");
        }
      }
    }).catch(() => { /* Ownership loss is fail-closed; shutdown owns remaining cleanup. */ })
      .finally(() => { this.recoveryWork = undefined; this.scheduleRecovery(); });
    return this.recoveryWork;
  }
  async message(id: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error("Message is required");
    const record = this.get(id), live = this.live.get(record.id);
    if (!live || live.finishing) throw new Error("Task is not running; use continue explicitly");
    if (live.startupPhase) throw new Error("Task is still starting; send supplementary instructions after startup is accepted");
    if (record.questions.length) throw new Error("Task is waiting for an answer; reply with its question ID");
    // A settled run cannot prove that a new submission started. Input hooks may
    // consume it without emitting another agent_start/agent_settled pair.
    if (live.settled) live.started = false;
    live.submission++;
    live.pendingMessages++; live.settled = false;
    try {
      record.supplementaryInstructions = [...record.supplementaryInstructions ?? [], message];
      this.save(record, false); // Preserve unacknowledged instructions across owner death.
      await live.rpc.request("prompt", { message: `Supplementary parent instruction:\n${message}`, streamingBehavior: "steer" });
      // Queued receipts do not prove history persistence/execution; retain directives
      // until an explicit new continuation supersedes this run.
      addLog(record, `Supplement accepted/queued (not yet proven executed): ${message}`); this.save(record);
    } catch (e) {
      // Do not strand a formerly settled run after clearing its settled flag.
      // A failed control operation stops this writer rather than guessing whether to retry.
      await this.finish(record, "failed", `Supplement failed: ${String(e)}`);
      throw e;
    } finally { live.pendingMessages--; this.maybeComplete(record, live); }
  }
  answer(id: string, questionId: string, answer: string): void {
    if (!answer.trim()) throw new Error("Answer is required");
    const record = this.get(id), live = this.live.get(record.id);
    const q = record.questions.find(q => q.id === questionId);
    if (!live || live.finishing || !q || q.responseSent) throw new Error("Question is no longer pending");
    live.rpc.send({ type: "extension_ui_response", id: questionId, value: answer });
    q.responseSent = true; record.activity = "answer sent; waiting for tool acknowledgement";
    addLog(record, `Answer sent for ${questionId}: ${answer}`); this.save(record);
  }
  async cancel(id: string): Promise<void> {
    const record = this.get(id), live = this.live.get(record.id);
    if (!live && record.execution?.intent !== "interrupted" && (record.stopped || !record.recovery)) throw new Error("Task is not running");
    if (!(live?.finishing && record.state === "completed")) {
      if (live) live.cancelRequested = true;
      // Cancellation fences resumption even while an older finish/cleanup is awaited.
      if (record.execution) record.execution.intent = "cancelled";
      record.state = "cancelled"; record.error = "Cancelled by parent";
      if (record.stopped) record.recovery = undefined;
      this.save(record, false);
    }
    if (live) await this.finish(record, "cancelled", "Cancelled by parent");
    if (!record.stopped) throw new Error(`Cancellation could not confirm shutdown; automatic cleanup pending: ${record.recovery?.error ?? record.error ?? "unknown stop failure"}`);
  }
  fenceRecovery(): void {
    this.closed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
  }
  shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.fenceRecovery(); // Fence all recovery/start permissions before the first await.
    this.shuttingDown = (async () => {
      await this.recoveryWork;
      await Promise.all([...this.live.keys()].map(id => this.finish(this.get(id), "cancelled", "Parent session closed/reloaded", true)));
      // Retry unresolved cleanup once during shutdown; never launch a replacement here.
      for (const [id, live] of this.live) {
        const record = this.get(id);
        if (!record.execution) continue;
        try { await this.confirmBoundary(record, live); this.completeCleanup(record, live); } catch { /* persisted isolation */ }
      }
      if (this.lease) {
        try {
          if (this.lease.alive) atomicWrite(join(this.store.dir, ".owner.json"), JSON.stringify({ identity: readProcessIdentity(), active: false }));
        } finally { await this.lease.release(); }
      }
    })();
    return this.shuttingDown;
  }
}
