import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateLoadout, type Loadout, type AccessMode } from "./loadout.ts";
import type { ContextMode } from "./context.ts";
import type { ExecutionBoundary, ProcessIdentity } from "./execution.ts";

export type TaskState = "running" | "waiting" | "completed" | "failed" | "cancelled";
export interface Question { id: string; title: string; toolCallId?: string; responseSent?: boolean }
export interface TaskRecord {
  version: 1 | 2; id: string; name: string; task: string; context: ContextMode;
  /** Legacy ownership is retained for inspection only; never inferred as access. */
  ownership?: string; access?: AccessMode; availableLoadout?: Loadout;
  workflow?: { id: string; stepId: string; attemptId?: string };
  state: TaskState; startedAt: number; updatedAt: number; sessionFile: string;
  loadout: Loadout; output: string; activity: string; log: string[]; questions: Question[];
  error?: string; stopped: boolean; run: number;
  /** Durable execution identity, separate from the task's terminal outcome. */
  execution?: { boundary: ExecutionBoundary; launcher?: ProcessIdentity; ready?: boolean;
    intent: TaskState | "interrupted"; cleanup: "pending" | "confirmed" };
  recovery?: { phase: "cleaning" | "resuming" | "blocked"; attempts: number; error?: string };
  recoveryRuns?: number;
  continuationTask?: string;
  supplementaryInstructions?: string[];
}
export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function toolHistory(record: TaskRecord, limit = 20): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("History limit must be 1–100");
  if (!existsSync(record.sessionFile)) return `No session transcript yet: ${record.sessionFile}`;
  const entries: string[] = [];
  const lines = readFileSync(record.sessionFile, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); }
    catch { if (index === lines.length - 1) continue; throw new Error("Malformed session transcript"); }
    const m = entry.message;
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "toolCall") entries.push(`${entry.timestamp ?? ""} CALL ${b.id} ${b.name}: ${bounded(JSON.stringify(b.arguments), 1000)}`);
    } else if (m?.role === "toolResult") entries.push(`${entry.timestamp ?? ""} RESULT ${m.toolCallId} ${m.toolName}${m.isError ? " ERROR" : ""}: ${bounded(JSON.stringify(m.content), 1000)}`);
  }
  return `Task: ${record.id}\nSession: ${record.sessionFile}\nTool operations (not a complete filesystem change audit):\n${entries.slice(-limit).join("\n") || "No tool operations recorded"}`;
}
export function terminal(state: TaskState): boolean { return ["completed", "failed", "cancelled"].includes(state); }
export function bounded(text: string, max = 12000): string {
  return text.length > max ? `[truncated; full transcript in session file]\n${text.slice(-max)}` : text;
}
export function addLog(record: TaskRecord, text: string): void {
  record.log.push(bounded(text, 1000));
  record.log = record.log.slice(-100);
}
export function uniqueName(base: string, names: string[]): string {
  base = base.trim();
  if (!base || base.length > 72 || /[\x00-\x1f\x7f]/.test(base)) throw new Error("Name must be 1–72 characters without control characters");
  let candidate = base;
  for (let i = 2; names.includes(candidate); i++) candidate = `${base.slice(0, 64)}-${i}`;
  return candidate;
}
export class TaskStore {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid task ID");
    return join(this.dir, `${id}.json`);
  }
  save(record: TaskRecord): void { atomicWrite(this.path(record.id), JSON.stringify(record, null, 2)); }
  load(): TaskRecord[] {
    return readdirSync(this.dir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => {
      const r = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as TaskRecord;
      if (![1, 2].includes(r.version) || `${r.id}.json` !== f || typeof r.name !== "string" || typeof r.task !== "string" ||
          (r.version === 1 ? typeof r.ownership !== "string" : !["read-only", "full"].includes(r.access ?? "")) || typeof r.sessionFile !== "string" ||
          !["none", "partial", "full"].includes(r.context) || !["running", "waiting", "completed", "failed", "cancelled"].includes(r.state) ||
          typeof r.stopped !== "boolean" || !Number.isInteger(r.run) || !Array.isArray(r.log) || !Array.isArray(r.questions)) throw new Error(`Invalid task record: ${f}`);
      if (r.recovery && (!["cleaning", "resuming", "blocked"].includes(r.recovery.phase) ||
          !Number.isInteger(r.recovery.attempts) || r.recovery.attempts < 0 || r.recovery.attempts > 5)) throw new Error(`Invalid task recovery: ${f}`);
      if (r.recoveryRuns !== undefined && (!Number.isInteger(r.recoveryRuns) || r.recoveryRuns < 0 || r.recoveryRuns > 1)) throw new Error(`Invalid recovery budget: ${f}`);
      // Loading is read-only. Only a leased manager may reconcile or mutate this record.
      if (!terminal(r.state) || !r.stopped) {
        if (!terminal(r.state)) {
          r.state = "failed";
          if (r.execution?.intent === "running" || r.execution?.intent === "waiting") r.execution.intent = "interrupted";
        }
        r.stopped = false; r.questions = [];
        r.recovery ??= { phase: r.execution ? "cleaning" : "blocked", attempts: 0,
          error: r.execution ? undefined : "Legacy execution has no verifiable cleanup boundary; automatically isolated" };
        if (!r.execution || r.execution.intent === "interrupted") r.error ??= "Interrupted execution; automatic cleanup pending";
      }
      if (r.stopped && r.execution?.intent === "interrupted" && (r.recoveryRuns ?? 0) >= 1 && r.recovery?.phase === "resuming") {
        r.recovery = { phase: "blocked", attempts: r.recovery.attempts,
          error: "Automatic continuation was reserved before interruption; retry budget consumed, execution isolated" };
        r.activity = "automatic continuation isolated";
      }
      return r;
    });
  }
  validateForContinue(r: TaskRecord): void {
    if (!terminal(r.state) || !r.stopped) throw new Error("Task is active or shutdown was not confirmed; continuation refused");
    if (!existsSync(r.sessionFile)) throw new Error("Child session file is missing");
    validateLoadout(r.loadout);
  }
  /** Reclaim is allowed only under the owner-wide kernel lease, after boundary cleanup. */
  lock(id: string, reclaim = false): () => void {
    const path = `${this.path(id)}.lock`, token = randomUUID();
    if (reclaim && existsSync(path)) unlinkSync(path);
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { flag: "wx", mode: 0o600 }); }
    catch { throw new Error("Task session is locked by another run; automatic recovery must confirm cleanup first"); }
    return () => {
      if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
    };
  }
}
