import { getPackageDir, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { accessMode, nonempty, resolveLoadout } from "./loadout.ts";
import { snapshotContext } from "./context.ts";
import { TaskStore, bounded, toolHistory } from "./store.ts";
import { TaskManager } from "./tasks.ts";
import { WorkflowManager, workflowSummary } from "./workflows.ts";
import { detail, resultRenderer, taskMenu, taskSummary, widget, TaskWidget } from "./ui.ts";
import type { AgentMessage } from "./context.ts";
import { closeDashboards } from "./dashboard.ts";
import { registerRoles } from "./roles-ui.ts";
import { createTeamRuntime, installMainMcpRouter } from "./pm.ts";
import { resolveRoleDispatch, selectedModel } from "./role-dispatch.ts";
import { ROLE_MAIN_EXTENSION, type RolePlan } from "./role-loadout.ts";
import type { StepDefinition } from "./workflows.ts";
import { Observability, classifyToolOutcome, observationText } from "./observability.ts";

const result = (text: string) => ({ content: [{ type: "text" as const, text: bounded(text, 16000) }], details: {} });
const accessSchema = () => StringEnum(["read-only", "full"] as const);
const contextFields = {
  context: Type.Optional(StringEnum(["none", "partial", "full"] as const, { description: "Parent context mode: partial (default) requires contextText; none shares no parent history; full freezes the active branch." })),
  contextText: Type.Optional(Type.String({ description: "Selected parent context, required for partial mode (including when context is omitted); only supported in partial mode. Use context=none for an independent task." })),
  name: Type.Optional(Type.String()), model: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
};
const roleField = Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }));
const stepSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }),
  task: Type.String({ minLength: 1 }), access: Type.Optional(accessSchema()), role: roleField,
  model: Type.Optional(Type.String()), context: contextFields.context, contextText: contextFields.contextText,
  dependencyReports: Type.Optional(StringEnum(["include", "omit"] as const)),
  dependsOn: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
}, { additionalProperties: false });
export default async function subagentsExtension(pi: ExtensionAPI) {
  if (process.env.PI_RPC_SUBAGENT_CHILD === "1") {
    const path = process.env.PI_RPC_SUBAGENT_LOADOUT;
    if (path) {
      const inherited = JSON.parse(readFileSync(path, "utf8"));
      if (inherited.parentRole !== undefined) {
        const { inheritMainRoleTools } = await import("./role-inheritance.ts");
        await inheritMainRoleTools(pi, inherited);
      }
    }
    return;
  }
  const catalog = registerRoles(pi)!;
  let mesh: Observability | undefined;
  const parentActions = new Map<string, string>();
  const team = createTeamRuntime(pi, catalog, { observe: event => mesh?.control({ event: "pm", name: event.state, outcome: event.state, error: event.error }) });
  pi.on("input", (_event, ctx) => team.input(ctx));
  let manager: TaskManager | undefined;
  let workflows: WorkflowManager | undefined;
  let ctxForWidget: ExtensionContext | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let promptOptions: { skills?: Skill[] } | undefined;
  // Later handlers may replace the skills array. Freeze the final inventory at dispatch,
  // not while the before_agent_start handler chain is still running.
  pi.on("before_agent_start", async (event, ctx) => { await team.prepare(event, ctx); promptOptions = event.systemPromptOptions; });
  const snapshots = new Map<string, AgentMessage[]>();
  function current(): TaskManager {
    if (!manager) throw new Error("Subagents require an active persistent parent session");
    return manager;
  }
  function workflow(): WorkflowManager {
    if (!workflows) throw new Error("Workflows require an active persistent parent session");
    return workflows;
  }
  function loadout(ctx: ExtensionContext, params: { model?: string; cwd?: string }) {
    const requested = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
    const slash = requested.indexOf("/");
    if (slash < 1) throw new Error("Use a canonical provider/model ID");
    const model = ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1));
    if (!model) throw new Error(`Model not found: ${requested}`);
    const inherited = resolveLoadout(pi, promptOptions?.skills, resolve(ctx.cwd, params.cwd ?? "."), `${model.provider}/${model.id}`, ctx.thinkingLevel ?? "medium");
    if (inherited.extensions.includes(ROLE_MAIN_EXTENSION)) inherited.parentRole = team.inheritance();
    return inherited;
  }
  function snapshot(id: string, mode: string, ctx: ExtensionContext) {
    const value = mode === "full" ? snapshots.get(id) ?? snapshotContext(ctx.sessionManager) : undefined;
    snapshots.delete(id); return value;
  }
  function publishMesh(ctx?: ExtensionContext) {
    const target = ctx ?? ctxForWidget;
    if (!mesh || !target) return;
    try {
      const totals = mesh.totals();
      const idle = totals.toolCalls === 0 && totals.rolesCreated === 0 && totals.tasksLaunched === 0;
      target.ui.setStatus("agent-mesh-metrics", idle ? "mesh idle" : `mesh ${totals.toolSuccesses}/${totals.toolCalls} ok · roles ${totals.rolesCreated} · fail ${totals.toolFailures}`);
    } catch { /* Status is advisory. */ }
  }
  function safeMesh(fn: () => void) { try { fn(); } catch { /* Observability must not affect the parent turn. */ } }
  pi.on("session_start", async (_event, ctx) => {
    closeDashboards();
    if (interval) clearInterval(interval);
    interval = undefined;
    ctx.ui.setWidget("rpc-subagents", undefined);
    try { ctx.ui.setStatus("agent-mesh-metrics", undefined); } catch { /* Status is advisory. */ }
    safeMesh(() => { mesh?.abandonTools("parent:"); mesh?.flush(); });
    parentActions.clear();
    mesh = new Observability();
    mesh.onUpdate = () => publishMesh(ctx);
    catalog.setObserver?.(event => mesh?.control({ event: "catalog", name: event.action, outcome: event.outcome, error: event.error }));
    const startup = team.start(ctx);
    if (!ctx.sessionManager.getSessionFile()) { await startup; publishMesh(ctx); return; }
    const display = new TaskWidget();
    ctxForWidget = ctx;
    // Host imports are mapped by Pi's loader; native module resolution cannot locate them.
    const packageDir = getPackageDir();
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const cli = join(packageDir, manifest.bin.pi);
    const dir = join(ctx.sessionManager.getSessionDir(), "rpc-subagents", ctx.sessionManager.getSessionId());
    manager = await TaskManager.open(new TaskStore(dir), {
      maxConcurrent: Number(process.env.PI_SUBAGENT_MAX_CONCURRENT ?? 8),
      command: process.execPath, baseArgs: [cli],
      isProjectTrusted: () => ctx.isProjectTrusted(),
      observe: mesh,
      notify(record, kind) {
        if (kind === "result") display.result(record);
        const content = kind === "question"
          ? `Subagent ${record.name} (${record.id}) needs an answer:\n${record.questions.filter(q => !q.responseSent).map(q => `${q.id}: ${q.title}`).join("\n")}\nUse subagent_control action=answer with id, questionId, message.`
          : `Subagent ${record.name} (${record.id}) ${record.state}.\n${record.error ?? ""}\n${record.recovery?.error ?? ""}\n${bounded(record.output)}\nSession: ${record.sessionFile}\nStopping is not acceptance: review its validation and shared-workspace changes.`;
        team.notify({ customType: `rpc_subagent_${kind}`, content, display: true, details: { id: record.id, state: record.state } });
      },
    });
    mesh.attach(dir, ctx.sessionManager.getSessionId());
    workflows = new WorkflowManager(manager, join(dir, "workflows"), r => {
      team.notify({ customType: "rpc_workflow_result", content: `${workflowSummary(r)}\nStep completion is not independent acceptance; inspect reports and validation.`, display: true, details: { id: r.id, state: r.state } });
    }, mesh);
    manager.startRecovery();
    interval = setInterval(() => { if (manager && ctxForWidget) widget(manager, ctxForWidget, display); }, 500);
    widget(manager, ctx, display);
    publishMesh(ctx);
    await startup;
  });
  pi.on("session_shutdown", async () => {
    closeDashboards();
    if (interval) clearInterval(interval);
    interval = undefined; snapshots.clear(); promptOptions = undefined;
    const widgetCtx = ctxForWidget;
    widgetCtx?.ui.setWidget("rpc-subagents", undefined);
    const old = manager, oldFlows = workflows;
    old?.fenceRecovery();
    manager = undefined; workflows = undefined; ctxForWidget = undefined;
    // Native model authentication can be unbounded. Drain it before replacement,
    // but start owned-worker cleanup immediately and await both even on errors.
    let failure: unknown;
    try {
      const stopped = await Promise.allSettled([
        team.stop(),
        (async () => { try { await oldFlows?.shutdown(); } finally { await old?.shutdown(); } })(),
      ]);
      const failed = stopped.find(r => r.status === "rejected");
      if (failed?.status === "rejected") failure = failed.reason;
    } finally {
      safeMesh(() => { mesh?.abandonTools("parent:"); mesh?.abandonTools("child:"); mesh?.flush(); });
      mesh = undefined; parentActions.clear();
      try { widgetCtx?.ui.setStatus("agent-mesh-metrics", undefined); } catch { /* Status is advisory. */ }
    }
    if (failure) throw failure;
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "workflow_run" || event.toolName === "workflow_control" && event.input?.action === "update" || event.toolName === "subagent") snapshots.set(event.toolCallId, snapshotContext(ctx.sessionManager));
    if ((event.toolName === "subagent_control" || event.toolName === "workflow_control") && typeof event.input?.action === "string") parentActions.set(event.toolCallId, event.input.action);
    const decision = team.toolCall(event.toolName, event.parentToolCallId);
    if (decision && typeof decision === "object" && "block" in decision && decision.block) {
      const reason = "reason" in decision && typeof decision.reason === "string" ? decision.reason : "blocked";
      safeMesh(() => mesh?.markBlocked(`parent:${event.toolCallId}`, reason));
    }
    return decision;
  });
  pi.on("tool_execution_start", event => {
    safeMesh(() => mesh?.beginTool(`parent:${event.toolCallId}`, {
      origin: "parent", nested: !!event.parentToolCallId, name: event.toolName, action: parentActions.get(event.toolCallId), toolCallId: event.toolCallId,
    }));
  });
  pi.on("tool_execution_end", event => {
    snapshots.delete(event.toolCallId);
    const action = parentActions.get(event.toolCallId);
    parentActions.delete(event.toolCallId);
    safeMesh(() => {
      const error = event.isError ? observationText(event.result) : undefined;
      mesh?.endTool(`parent:${event.toolCallId}`, {
        origin: "parent", nested: !!event.parentToolCallId, name: event.toolName, action,
        outcome: classifyToolOutcome(event.isError, error), error, durationMs: "durationMs" in event && typeof event.durationMs === "number" ? event.durationMs : undefined, toolCallId: event.toolCallId,
      });
    });
  });
  pi.on("agent_end", event => {
    const assistant = [...event.messages].reverse().find(message => message.role === "assistant") as { stopReason?: string } | undefined;
    safeMesh(() => mesh?.control({ event: "agent", name: "parent_turn", outcome: assistant?.stopReason ?? "unknown" }));
  });
  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: "Launch an asynchronous RPC subagent in the shared working directory. Optional role selects independently configured capabilities and defaults. Without role, access is required: read-only (verified builtin read/grep/find/ls only, plus ask_question) or full (parent active nondelegation tools). Tool filtering is not a sandbox. Context: none, partial (default; requires contextText), full (frozen active branch). Results/questions arrive automatically. Use subagent_control for history, questions, follow-up and continuation.",
    promptSnippet: "Delegate a task with explicit access and context",
    promptGuidelines: [
      "Coordinate parallel writers; standalone subagents share the working directory and have no write locks.",
      "After launch, do independent work or end the turn; results arrive automatically. Do not poll or invent completion.",
      "Worker reports are claims: inspect validation and changes before acceptance. Use read-only continuation to ask for explanations without granting write tools.",
    ],
    parameters: Type.Object({ task: Type.String({ minLength: 1 }), role: roleField, access: Type.Optional(accessSchema()), ...contextFields }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      signal?.throwIfAborted(); const m = current();
      const resolved = params.role !== undefined ? await resolveRoleDispatch(pi, ctx, catalog, { ...params, role: params.role }) : undefined;
      signal?.throwIfAborted();
      const mode = resolved?.plan.context ?? params.context ?? "partial", access = resolved?.plan.access ?? accessMode(params.access);
      const common = { name: params.name, task: params.task, access, context: mode, contextText: resolved?.contextText ?? params.contextText,
        snapshot: snapshot(id, mode, ctx), parentSession: ctx.sessionManager.getSessionFile() };
      const record = await m.launch(resolved ? { ...common, rolePlan: resolved.plan } : { ...common, loadout: loadout(ctx, params) });
      if (signal?.aborted) { await m.cancel(record.id); signal.throwIfAborted(); }
      const roleSummary = record.rolePlan ? `\nrole=${record.rolePlan.roleId} config=${record.rolePlan.manifestHash.slice(0, 12)} access=${record.access} model=${record.loadout.model} context=${record.context}` : "";
      return result(`Task accepted (not completed): ${taskSummary(record)}${roleSummary}\nSession: ${record.sessionFile}`);
    },
  });
  pi.registerTool({
    name: "subagent_control", label: "Subagent control",
    description: "Inspect tasks or tool history, message a running task, answer a question, cancel, or continue a stopped session. Optional access on continue changes tool access; legacy tasks require it. Workflow steps must be continued with workflow_control retry. Receipt is not execution. Previews are bounded; full transcript in sessionFile. Do not poll to wait.",
    parameters: Type.Object({
      action: StringEnum(["list", "inspect", "history", "message", "answer", "cancel", "continue"] as const),
      id: Type.Optional(Type.String()), message: Type.Optional(Type.String()), questionId: Type.Optional(Type.String()),
      access: Type.Optional(accessSchema()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    async execute(_id, p, signal) {
      const m = current(); signal?.throwIfAborted();
      if (p.action === "list") return result([...m.records.values()].map(record => taskSummary(record)).join("\n") || "No tasks");
      const id = nonempty(p.id, "id");
      if (p.action === "inspect") return result(detail(m.get(id)));
      if (p.action === "history") return result(toolHistory(m.get(id), p.limit));
      if (p.action === "cancel") { await m.cancel(id); return result("Task process stopped/cancelled; inspect any partial file changes."); }
      const message = nonempty(p.message, "message");
      if (p.action === "message") await m.message(id, message);
      else if (p.action === "answer") m.answer(id, nonempty(p.questionId, "questionId"), message);
      else {
        const r = await m.continue(id, message, p.access);
        if (signal?.aborted) { await m.cancel(r.id); signal.throwIfAborted(); }
      }
      return result("Accepted/sent, not yet proven executed. Task events will report progress and completion.");
    },
  });
  pi.registerTool({
    name: "workflow_run", label: "Run workflow",
    description: "Define and start a persistent dependency graph of subagent steps. Each step requires dependsOn (empty for roots); access is required without role. Steps may select role/model/context/contextText/dependencyReports. Role defaults are frozen at creation; role context=none defaults to omitting dependency reports while code dependencies still merge. Default shared mode: full steps run exclusively within this workflow only. Opt-in workspace=isolated permits concurrent writers in detached Git worktrees, requires a clean Git repository and validationCommand, merges dependency code before downstream launch, then integrates and validates without altering the source checkout. Worktrees are not sandboxes. Conflicts pause and preserve worktrees. Failure pauses future dispatch; no automatic retry. Results/questions arrive automatically. Completion is not acceptance: include explicit validation/review steps.",
    parameters: Type.Object({ ...contextFields, steps: Type.Array(stepSchema, { minItems: 1, maxItems: 64 }), maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })), workspace: Type.Optional(StringEnum(["shared", "isolated"] as const)), validationCommand: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    async execute(id, p, signal, _update, ctx) {
      signal?.throwIfAborted(); const mode = p.context ?? "partial";
      const rolePlans = await stepPlans(p.steps, ctx, { model: p.model, context: p.context, contextText: p.contextText, cwd: p.cwd });
      signal?.throwIfAborted();
      const r = workflow().launch({ ...p, context: mode, rolePlans, snapshot: snapshot(id, "full", ctx), loadout: loadout(ctx, p), parentSession: ctx.sessionManager.getSessionFile() });
      return result(`Workflow accepted (not completed):\n${workflowSummary(r)}`);
    },
  });
  pi.registerTool({
    name: "workflow_control", label: "Workflow control",
    description: "List/inspect workflows, pause future scheduling (active steps continue), resume, cancel, upsert pending steps while paused, retry a finished step (shared workspace continues its session; isolated workspace discards the old scene and starts a fresh task on resume), or retry terminal worktree cleanup. Retry requires a paused workflow, no active steps in that workflow and no started descendants; it does not automatically resume scheduling. Use subagent_control for child history, messages and question answers. Completed/cancelled isolated workflows pin successful Git outputs under refs/pi-workflows before deleting all owned worktrees, discarding uncommitted/conflicted scenes; sessions/logs remain. Cleanup refuses live or unconfirmed processes. Recovery never auto-resumes orphan writers.",
    parameters: Type.Object({ action: StringEnum(["list", "inspect", "pause", "resume", "cancel", "update", "retry", "cleanup"] as const), id: Type.Optional(Type.String()),
      steps: Type.Optional(Type.Array(stepSchema, { minItems: 1, maxItems: 64 })), stepId: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()), access: Type.Optional(accessSchema()),
    }, { additionalProperties: false }),
    async execute(callId, p, signal, _update, ctx) {
      signal?.throwIfAborted(); const w = workflow();
      if (p.action === "list") return result([...w.records.values()].map(workflowSummary).join("\n\n") || "No workflows");
      const id = nonempty(p.id, "id");
      if (p.action === "pause") w.pause(id);
      else if (p.action === "resume") w.resume(id);
      else if (p.action === "cancel") await w.cancel(id);
      else if (p.action === "cleanup") await w.cleanup(id);
      else if (p.action === "update") {
        if (!p.steps) throw new Error("steps required");
        const r = w.get(id);
        const rolePlans = await stepPlans(p.steps, ctx, { model: r.loadout.model, context: r.context, contextText: r.contextText, cwd: r.loadout.cwd });
        signal?.throwIfAborted(); w.update(id, p.steps, rolePlans, snapshot(callId, "full", ctx));
      }
      else if (p.action === "retry") {
        await w.retry(id, nonempty(p.stepId, "stepId"), nonempty(p.message, "message"), p.access);
        if (signal?.aborted) { await w.cancel(id); signal.throwIfAborted(); }
      }
      return result(workflowSummary(w.get(id)));
    },
  });
  pi.registerCommand("subagents", {
    description: "Task list/details; send instructions, answer, cancel or continue: /subagents [task ID]",
    async handler(args, ctx) {
      try { await taskMenu(current(), ctx, args.trim() || undefined); }
      catch (e) { ctx.ui.notify(String(e), "error"); }
    },
  });
  pi.registerCommand("mesh", {
    description: "Inspect plugin observability: /mesh [tools|roles|tasks|workflows|controls|events [n]|json]",
    async handler(args, ctx) {
      try {
        if (!mesh) throw new Error("Observability requires an active session");
        const words = args.trim().split(/\s+/).filter(Boolean);
        if (words.length > 2) throw new Error("Usage: /mesh [tools|roles|tasks|workflows|controls|events [n]|json]");
        const section = words[0] ?? "all";
        const limit = words[1] === undefined ? undefined : Number(words[1]);
        const text = section === "json" ? mesh.toJSON(limit ?? 80) : mesh.report(section, limit);
        if (ctx.hasUI) await ctx.ui.editor("Agent mesh observability (read-only snapshot)", text);
        else ctx.ui.notify(text, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("workflows", {
    description: "Inspect workflow state: /workflows [ID or name]",
    async handler(args, ctx) {
      try {
        const w = workflow(); const text = args.trim() ? workflowSummary(w.get(args.trim())) : [...w.records.values()].map(workflowSummary).join("\n\n") || "No workflows";
        if (ctx.hasUI) await ctx.ui.editor("Workflow snapshot (use workflow_control to change)", text);
        else ctx.ui.notify(text, "info");
      } catch (e) { ctx.ui.notify(String(e), "error"); }
    },
  });
  for (const type of ["rpc_subagent_result", "rpc_subagent_question", "rpc_workflow_result"]) pi.registerMessageRenderer(type, resultRenderer);
  async function stepPlans(steps: StepDefinition[], ctx: ExtensionContext, defaults: { model?: string; context?: "none" | "partial" | "full"; contextText?: string; cwd?: string }) {
    const plans: Record<string, RolePlan> = Object.create(null);
    for (const step of steps) {
      if (step.role) plans[step.id] = (await resolveRoleDispatch(pi, ctx, catalog, { ...step, role: step.role, cwd: defaults.cwd }, defaults)).plan;
      else { accessMode(step.access); if (step.model) selectedModel(ctx, step.model); }
    }
    return plans;
  }
  await installMainMcpRouter(pi, team);
}
