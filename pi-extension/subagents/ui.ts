import { readFileSync, statSync } from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskManager } from "./tasks.ts";
import type { TaskRecord } from "./store.ts";
import { taskDashboard, type DashboardPane, type TaskAction } from "./dashboard.ts";

export function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
const inline = (text: string): string => clean(text).replace(/\s+/g, " ").trim();
const glyph = (state: TaskRecord["state"]): string => ({ running: "●", waiting: "?", completed: "✓", failed: "!", cancelled: "○" })[state];
function elapsed(r: TaskRecord, now: number): string {
  const seconds = Math.max(0, Math.floor(((r.state === "running" || r.state === "waiting" ? now : r.updatedAt) - r.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function taskSummary(r: TaskRecord, now = Date.now()): string {
  return inline(`${glyph(r.state)} ${r.name} [${r.id}] · ${r.state} · ${elapsed(r, now)} · ${r.activity}`);
}
const activeRecords = (records: TaskRecord[]): TaskRecord[] => records.filter(r => r.state === "running" || r.state === "waiting");
const recoveryStatus = (r: TaskRecord): string => r.recovery?.phase === "cleaning"
  ? `automatic cleanup · attempt ${r.recovery.attempts}/5`
  : r.recovery?.phase === "resuming" ? "automatically resuming"
  : "execution isolated — cleanup cannot be verified";
const stateColor = (state: TaskRecord["state"]) => ({ running: "accent", waiting: "warning", completed: "success", failed: "error", cancelled: "muted" } as const)[state];
function widgetHeader(line: string, theme: Theme): string {
  // Consume the existing counts rather than recomputing attention or result windows.
  const counts = line.slice("Subagents ─ ".length, -" · /subagents".length).split(" · ");
  const separator = theme.fg("muted", " · ");
  return theme.fg("muted", "┌─ ") + theme.fg("accent", "Subagents") + separator
    + counts.map(count => theme.fg(count.endsWith("failed") ? "error"
      : count.endsWith("completed") ? "success"
      : /awaiting answer|shutdown unconfirmed/.test(count) ? "warning"
      : count.endsWith("running") ? "accent" : "muted", count)).join(separator)
    + separator + theme.fg("muted", "/subagents");
}
// Session-local attention state: persisted history never starts a new display window.
export class TaskWidget {
  private recent = new Map<string, TaskRecord["state"]>();
  private expiresAt = 0;
  result(record: TaskRecord, now = Date.now()): void {
    if (now >= this.expiresAt) this.recent.clear();
    this.recent.set(record.id, record.state);
    this.expiresAt = now + 8000;
  }
  lines(records: TaskRecord[], now = Date.now()): string[] | undefined {
    if (now >= this.expiresAt) this.recent.clear();
    const active = activeRecords(records);
    const pending = active.filter(r => r.questions.some(q => !q.responseSent));
    const unsafe = records.filter(r => !r.stopped && r.state !== "running" && r.state !== "waiting");
    const counts: string[] = [];
    if (active.length - pending.length) counts.push(`${active.length - pending.length} running`);
    if (pending.length) counts.push(`${pending.length} awaiting answer`);
    if (unsafe.length) counts.push(`${unsafe.length} shutdown unconfirmed`);
    if (!active.length) {
      for (const state of ["completed", "failed", "cancelled"] as const) {
        const count = [...this.recent.values()].filter(s => s === state).length;
        if (count) counts.push(`${count} ${state}`);
      }
    }
    if (!counts.length) return undefined;
    const attention = [
      ...unsafe.map(r => `! ${r.name} · shutdown unconfirmed — ${recoveryStatus(r)}`),
      ...pending.map(r => `? ${r.name} · ${r.questions.filter(q => !q.responseSent).map(q => q.title).join("; ")}`),
    ];
    const previews = active.slice(0, 3).map(r => `${glyph(r.state)} ${r.name} · ${elapsed(r, now)} · ${r.activity}`);
    return [
      `Subagents ─ ${counts.join(" · ")} · /subagents`,
      ...previews.map(inline),
      ...(active.length > 3 ? [`+${active.length - 3} more active · /subagents`] : []),
      ...attention.slice(0, 5).map(inline),
      ...(attention.length > 5 ? [`+${attention.length - 5} need attention · /subagents`] : []),
    ];
  }
}
export function widget(manager: TaskManager, ctx: ExtensionContext, display: TaskWidget): void {
  if (!ctx.hasUI) return;
  const lines = display.lines([...manager.records.values()]);
  if (!lines || ctx.mode !== "tui") {
    // RPC supports text widgets, not custom terminal component factories.
    ctx.ui.setWidget("rpc-subagents", lines?.map(line => truncateToWidth(line, 150)));
    return;
  }
  ctx.ui.setWidget("rpc-subagents", (_tui, theme) => {
    return {
      invalidate() { /* No themed output is cached: every render rebuilds it. */ },
      render(width: number): string[] {
        if (width <= 0) return [];
        const records = [...manager.records.values()], now = Date.now();
        const lines = display.lines(records, now) ?? [];
        const previews = activeRecords(records).slice(0, 3);
        // Keep the existing line budget and attention order; only decorate TUI output.
        return lines.map((line, index) => {
          if (index === 0) return truncateToWidth(widgetHeader(line, theme), width);
          const record = previews[index - 1];
          const content = record
            ? theme.fg(stateColor(record.state), glyph(record.state)) + " " + theme.fg("text", inline(record.name))
              + theme.fg("muted", ` · ${elapsed(record, now)} · ${inline(record.activity)}`)
            : theme.fg(line.startsWith("!") || line.startsWith("?") ? "warning" : "muted", line);
          return truncateToWidth(theme.fg("muted", "│ ") + content, width);
        });
      },
    };
  });
}
export function detail(r: TaskRecord, live = false): string {
  return clean([
    taskSummary(r),
    "\n── Run & access ──",
    `Model: ${r.loadout.model ?? "unknown"} · Thinking: ${r.loadout.thinking ?? "unknown"}`,
    `Context: ${r.context} · Run: ${r.run}`,
    `Access: ${r.access ?? "legacy — choose access before continuation"}`,
    `Shutdown: ${r.state === "running" || r.state === "waiting" ? "not requested (active run)" : r.stopped ? "confirmed" : "unconfirmed"}`,
    ...(r.recovery ? [`Recovery: ${recoveryStatus(r)}`, ...(r.recovery.error ? [`Cleanup error: ${r.recovery.error}`] : [])] : []),
    ...(r.execution ? [`Execution: ${r.execution.boundary.unit} · Cleanup: ${r.execution.cleanup}`] : []),
    ...(r.workflow ? [`Workflow: ${r.workflow.id}, step ${r.workflow.stepId}`] : []),
    `Cwd: ${r.loadout.cwd}`, `Session: ${r.sessionFile}`,
    "\n── Task · Parent prompt ──", r.task,
    ...(r.error ? ["\n── Error ──", r.error] : []),
    "\n── Questions ──",
    r.questions.map(q => `${q.responseSent ? "✓" : "?"} ${q.id}: ${q.title}${q.responseSent ? " (answer sent)" : " (awaiting answer)"}`).join("\n") || "None",
    "\n── Latest assistant text (bounded) ──", r.output || "No assistant text yet",
    "\n── Recent activity (bounded) ──", r.log.join("\n") || "No activity yet",
    live ? "\nLive details · bounded output/activity · End follows latest" : "\nSnapshot only · reopen to refresh · edits are not saved",
  ].join("\n"));
}
export function dashboardSummary(r: TaskRecord): string {
  return inline(`${glyph(r.state)} ${r.name} · ${r.state}`);
}
function readTrace(record: TaskRecord): string {
  const heading = [
    "Recorded session JSONL · full records as pretty JSON",
    "May include inherited context; only recorded/emitted thinking, not hidden reasoning.",
    `Session: ${record.sessionFile}`, "",
  ].join("\n");
  try {
    const raw = readFileSync(record.sessionFile, "utf8");
    const entries = raw.split("\n").flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        // Clean decoded strings before JSON serialization, which would otherwise escape controls.
        const entry = JSON.parse(line, (_key, value: unknown) => typeof value === "string" ? clean(value) : value);
        return [`── Record ${index + 1} ──\n${JSON.stringify(entry, null, 2)}`];
      } catch {
        // A live writer may not have finished the last line. Preserve it, not just a parse error.
        return [`── Invalid or incomplete JSONL line ${index + 1} · raw ──\n${line}`];
      }
    });
    return clean(heading + "\n" + (entries.join("\n\n") || "No session records yet"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return clean(heading + "\n" + (code === "ENOENT" ? "No session transcript yet" : `Cannot read session transcript: ${String(error)}`));
  }
}

// One last-file cache per dashboard interaction, retained across native action dialogs.
// No other task's transcript is loaded, and switching files cannot grow the cache.
export function createDashboardContent() {
  let cached: { path: string; stamp: string; text: string } | undefined;
  const trace = (record: TaskRecord): string => {
    try {
      const stat = statSync(record.sessionFile);
      const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
      if (cached?.path === record.sessionFile && cached.stamp === stamp) return cached.text;
      const text = readTrace(record);
      cached = { path: record.sessionFile, stamp, text };
      return text;
    } catch {
      cached = undefined;
      return readTrace(record);
    }
  };
  return { summary: dashboardSummary, detail: (record: TaskRecord, pane: DashboardPane) => dashboardDetail(record, pane, trace) };
}

export function dashboardDetail(r: TaskRecord, pane: DashboardPane, trace = readTrace): string {
  if (pane === "trace") return trace(r);
  if (pane === "prompt") return clean(r.task || "No parent task prompt recorded");
  if (pane === "activity") return clean([
    "Latest assistant text", r.output || "No assistant text yet",
    "\nRecent activity", r.log.join("\n") || "No activity yet",
  ].join("\n"));
  const shutdown = r.state === "running" || r.state === "waiting" ? "active" : r.stopped ? "confirmed" : `UNCONFIRMED — ${recoveryStatus(r)}`;
  return clean([
    `Access: ${r.access ?? "legacy — choose before continuing"} · Context: ${r.context}`,
    `Thinking: ${r.loadout.thinking ?? "unknown"} · Run: ${r.run} · Elapsed: ${elapsed(r, Date.now())}`,
    `Shutdown: ${shutdown}`,
    ...(r.recovery?.error ? [`Cleanup: ${r.recovery.error}`] : []),
    ...(r.workflow ? [`Workflow step: ${r.workflow.stepId}`] : []),
    `\nNow: ${inline(r.activity)}`,
    ...(r.error ? ["\nError", r.error] : []),
    "\nQuestions",
    r.questions.map(q => `${q.responseSent ? "Answered" : "Awaiting answer"}: ${q.title}`).join("\n") || "None",
  ].join("\n"));
}
export async function taskMenu(manager: TaskManager, ctx: ExtensionContext, taskId?: string): Promise<void> {
  if (!ctx.hasUI) throw new Error("Use subagent_control in headless mode");
  if (ctx.mode === "tui" && !taskId) {
    await taskDashboard(manager, ctx, createDashboardContent(),
      (id, action) => taskAction(manager, ctx, id, action));
    return;
  }
  const items = [...manager.records.values()];
  if (!items.length) { ctx.ui.notify("No subagent tasks yet", "info"); return; }
  const selected = taskId || await ctx.ui.select("Subagent tasks", items.map(r => `${r.id} ${truncateToWidth(taskSummary(r), 120)}`));
  if (!selected) return;
  const record = manager.get(taskId ?? selected.split(" ")[0]);
  const action = await ctx.ui.select(clean(taskSummary(record)), ["Details", "Message", "Answer question", "Cancel", "Continue"]);
  if (action) await taskAction(manager, ctx, record.id, action);
}
async function taskAction(manager: TaskManager, ctx: ExtensionContext, id: string, action: TaskAction | string): Promise<void> {
  const record = manager.get(id);
  if (action === "Details") {
    // An editor provides a scrollable copy of the snapshot, not an editable task record.
    await ctx.ui.editor("Task details (snapshot; edits are not saved)", detail(record));
  } else if (action === "Message" || action === "Continue") {
    const message = await ctx.ui.editor(`${action}: ${inline(record.name)}`, "");
    if (!message?.trim()) return;
    if (action === "Message") { await manager.message(record.id, message); ctx.ui.notify("Instruction accepted/queued, not yet proven executed", "info"); }
    else {
      const access = await ctx.ui.select("Continuation access", ["read-only", "full"]);
      if (access !== "read-only" && access !== "full") return;
      await manager.continue(record.id, message, access); ctx.ui.notify("Continuation accepted", "info");
    }
  } else if (action === "Answer question") {
    const questions = record.questions.filter(q => !q.responseSent);
    if (!questions.length) { ctx.ui.notify("No unanswered questions", "info"); return; }
    const choice = await ctx.ui.select("Pending question", questions.map(q => `${q.id} ? ${truncateToWidth(inline(q.title), 120)}`));
    if (!choice) return;
    const id = choice.split(" ")[0];
    const answer = await ctx.ui.editor("Answer", "");
    if (answer?.trim()) manager.answer(record.id, id, answer);
  } else if (action === "Cancel" && await ctx.ui.confirm("Cancel task?", inline(record.name))) await manager.cancel(record.id);
}
export function resultRenderer(message: { content: unknown }, options: { expanded: boolean; outputPad?: number }, theme?: Theme): Text {
  const [heading = "", ...body] = clean(String(message.content)).split("\n");
  const title = inline(heading) || "Subagent update";
  const preview = options.expanded ? body : body.slice(0, 4);
  const text = new Text("", 0, 0);
  const render = text.render.bind(text);
  text.render = (width: number): string[] => {
    if (width <= 0) return [];
    const pad = Math.min(Math.max(0, Math.floor(options.outputPad ?? 0)), Math.floor((width - 1) / 2));
    // Collapse the title only in the preview; expansion preserves the full report.
    const titleLine = options.expanded ? `Subagents ─ ${title}` : truncateToWidth(`Subagents ─ ${title}`, width - pad * 2);
    text.setText([
      theme ? theme.fg("accent", titleLine) : titleLine,
      ...preview,
      ...(!options.expanded ? [theme ? theme.fg("muted", "/subagents for details · expand for full report") : "/subagents for details · expand for full report"] : []),
    ].join("\n"));
    return render(width - pad * 2).map(line => truncateToWidth(" ".repeat(pad) + line + " ".repeat(pad), width));
  };
  return text;
}
