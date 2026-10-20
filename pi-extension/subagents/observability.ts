import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store.ts";

// Session-scoped counters and a bounded event ring.
// Tool arguments, tool results, prompts and unresolved secrets are never stored.
const MAX_TOOLS = 96;
const MAX_ROLES = 48;
const MAX_EVENTS = 400;
const MAX_BREAKDOWN = 16;
const MAX_TEXT = 240;
const MAX_JSON_CHARACTERS = 64_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
// Locate fields, not their values: bounded scanning below distinguishes quoted
// values, JSON containers and full Authorization header lines. Credential suffixes
// intentionally have no leading word boundary (HTTP_AUTHORIZATION, refreshToken,
// DB_PASSWORD); their unmatched prefixes remain readable. Matching query tokens in
// the same pass lets an enclosing quoted credential take precedence.
const SECRET_FIELD = /[?&](?:access_)?token=|(["']?(authorization|api[\s_-]*key|access[\s_-]*(?:key|token)|client[\s_-]*secret|token|secret|password|passwd|credentials?)["']?\s*[:=]\s*)/gi;
const SECRET = /(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}|\b(?:sk|rk)-[a-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b/gi;

export type ToolOrigin = "parent" | "child";
export type ToolOutcome = "success" | "error" | "blocked" | "aborted";
export type TaskEventName = "launched" | "continued" | "recovered" | "completed" | "failed" | "cancelled" | "question" | "answered" | "message" | "message_rejected" | "recovery_blocked" | "preflight_ok" | "preflight_failed";
export type RoleEventName = "created" | "continued" | "recovered" | "completed" | "failed" | "cancelled" | "question" | "answered" | "preflight_ok" | "preflight_failed";
export type WorkflowEventName = "launched" | "paused" | "resumed" | "cancelled" | "completed" | "auto_paused" | "retried" | "retry_failed" | "updated" | "step_failed" | "step_cancelled" | "restart_paused" | "cleanup";
export const REPORT_SECTIONS = ["all", "tools", "roles", "tasks", "workflows", "controls", "events"] as const;
export type ReportSection = typeof REPORT_SECTIONS[number];

export interface ToolObservation {
  origin: ToolOrigin; nested?: boolean; name: string; outcome?: ToolOutcome;
  durationMs?: number; roleId?: string; taskId?: string; workflowId?: string; stepId?: string;
  run?: number; action?: string; error?: string; toolCallId?: string;
}
export interface TaskObservation {
  event: TaskEventName; taskId: string; roleId?: string; workflowId?: string; stepId?: string;
  access?: string; context?: string; model?: string; version?: number; run?: number; error?: string; phase?: string;
}
export interface RoleObservation {
  event: RoleEventName; roleId: string; taskId?: string; workflowId?: string; stepId?: string;
  access?: string; context?: string; model?: string; run?: number; error?: string;
}
export interface WorkflowObservation {
  event: WorkflowEventName; workflowId: string; name?: string; stepId?: string; roleId?: string;
  workspace?: string; error?: string; detail?: string;
}
export interface ControlObservation { event: "pm" | "catalog" | "agent" | "persistence" | "command"; name: string; outcome: string; error?: string; detail?: string }
export interface MeshObserver {
  tool(event: ToolObservation & { outcome: ToolOutcome }): void;
  task(event: TaskObservation): void;
  role(event: RoleObservation): void;
  workflow(event: WorkflowObservation): void;
  control(event: ControlObservation): void;
  beginTool?(key: string, event: ToolObservation): void;
  endTool?(key: string, event: ToolObservation & { outcome: ToolOutcome }): void;
  abandonTools?(prefix: string): void;
  markBlocked?(key: string, reason?: string): void;
}

interface Breakdown { calls: number; successes: number; errors: number; blocked: number; aborted: number }
interface DurationStat { count: number; totalMs: number; minMs: number; maxMs: number; lastMs: number }
interface ToolStat {
  origin: ToolOrigin; nested: boolean; name: string; calls: number; successes: number; errors: number;
  blocked: number; aborted: number; duration: DurationStat; lastAt: number; lastOutcome: ToolOutcome;
  lastError?: string; byRole: Record<string, Breakdown>; byAction: Record<string, Breakdown>;
}
interface RoleStat {
  created: number; continued: number; recovered: number; runs: number; standalone: number; workflow: number;
  completed: number; failed: number; cancelled: number; preflightOk: number; preflightFailed: number;
  questions: number; answered: number; byAccess: Record<string, number>; byContext: Record<string, number>;
  byModel: Record<string, number>; lastAt: number; lastTaskId?: string; lastError?: string;
}
interface CountBag { [key: string]: number }
interface ObservationEvent {
  at: number; kind: "tool" | "task" | "role" | "workflow" | "control"; name: string; outcome?: string;
  origin?: ToolOrigin; nested?: boolean; roleId?: string; taskId?: string; workflowId?: string; stepId?: string;
  run?: number; durationMs?: number; action?: string; error?: string; phase?: string; detail?: string;
}
interface Inflight { at: number; sample: ToolObservation }
interface Persisted {
  version: 1; privacy: { arguments: "omitted"; results: "omitted"; prompts: "omitted" };
  startedAt: number; updatedAt: number; sessionId?: string; droppedEvents: number;
  tools: Record<string, ToolStat>; roles: Record<string, RoleStat>;
  tasks: CountBag; workflows: CountBag; controls: CountBag; byWorkspace: CountBag; failuresByPhase: CountBag;
  events: ObservationEvent[]; inflight: (Inflight & { key: string })[];
}
export interface MeshTotals {
  toolCalls: number; toolSuccesses: number; toolErrors: number; toolBlocked: number; toolAborted: number; toolFailures: number;
  rolesCreated: number; roleRuns: number; tasksLaunched: number; tasksFailed: number;
}

const emptyDuration = (): DurationStat => ({ count: 0, totalMs: 0, minMs: 0, maxMs: 0, lastMs: 0 });
const emptyBreakdown = (): Breakdown => ({ calls: 0, successes: 0, errors: 0, blocked: 0, aborted: 0 });
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const iso = (value: number) => Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : "n/a";
const rate = (ok: number, calls: number) => calls ? `${Math.round((ok / calls) * 1000) / 10}%` : "n/a";
const clock = (value: number) => !Number.isFinite(value) ? "n/a" : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;

interface TextStructure { containers: string[]; quote?: string }
const isQuote = (char: string | undefined) => char === '"' || char === "'";
const isMarker = (text: string, at: number) => text.slice(at, at + 10).toLowerCase() === "[redacted]";
function quotedEnd(text: string, start: number, limit = text.length): number {
  const quote = text[start];
  for (let i = start + 1; i < limit; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i + 1;
  }
  return limit; // Truncated/unclosed quoted values remain entirely private.
}
function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}
function nextObjectField(text: string, comma: number): boolean {
  const key = skipSpace(text, comma + 1);
  return isQuote(text[key]) && text[skipSpace(text, quotedEnd(text, key))] === ":";
}
function objectValueBoundary(text: string, at: number): boolean {
  // A closing brace attached to further secret text is part of the value, not
  // an object ending. Marker validation and credential scanning must agree.
  return (text[at] === "}" && (at + 1 === text.length || /[\s,}\]]/.test(text[at + 1])))
    || (text[at] === "," && nextObjectField(text, at));
}
// Track only surrounding structure, never interpreting a credential's contents as
// containers. [redacted] is an opaque atom, not a JSON array. All scans operate on
// the already bounded (4000 character) input and advance monotonically.
function advanceStructure(text: string, from: number, to: number, state: TextStructure): void {
  const root = skipSpace(text, 0);
  for (let i = from; i < to; i++) {
    const char = text[i];
    if (state.quote) {
      if (char === "\\") i++;
      else if (char === state.quote) state.quote = undefined;
    } else if (isMarker(text, i)) i += 9;
    // A quoted scalar can also be the whole message. Do not treat arbitrary
    // quotes in unstructured diagnostics or key="value" as enclosing strings.
    else if (isQuote(char) && (state.containers.length || i === root)) state.quote = char;
    else if (char === "{" || char === "[") state.containers.push(char);
    else if ((char === "}" && state.containers.at(-1) === "{") || (char === "]" && state.containers.at(-1) === "[")) state.containers.pop();
  }
}
function collectionEnd(text: string, start: number): number {
  const state: TextStructure = { containers: [text[start]] };
  for (let i = start + 1; i < text.length; i++) {
    // Quoted blocks are skipped whole so escaped brackets cannot close a value.
    if (isMarker(text, i)) i += 9;
    else if (isQuote(text[i])) i = quotedEnd(text, i) - 1;
    else {
      advanceStructure(text, i, i + 1, state);
      if (!state.containers.length) return i + 1;
    }
  }
  return text.length;
}
function safeHeaderMarkerBoundary(text: string, at: number, structured: boolean): boolean {
  while (at < text.length) {
    const next = skipSpace(text, at);
    if (next === at) return false; // An attached tail is always part of the header.
    if (next === text.length) return true;
    if (structured && objectValueBoundary(text, next)) return true;
    let end = next;
    let name: string;
    if (isQuote(text[next])) {
      end = quotedEnd(text, next);
      name = text.slice(next + 1, end - 1);
    } else {
      while (end < text.length && /[\w.-]/.test(text[end])) end++;
      name = text.slice(next, end);
    }
    const separator = skipSpace(text, end);
    if (text[separator] !== ":" && text[separator] !== "=") return false;
    // Newlines are normalized after redaction. Preserve only these explicit,
    // non-credential diagnostic fields on subsequent passes, not arbitrary header
    // parameters (e.g. response=...). Unknown tails and all schemes stay private.
    const value = skipSpace(text, separator + 1);
    const diagnostic = name.toLowerCase();
    if (diagnostic === "status" || diagnostic === "code") {
      const quoted = isQuote(text[value]);
      let valueEnd = value;
      if (quoted) {
        valueEnd = quotedEnd(text, value);
        if (text[valueEnd - 1] !== text[value]) return false;
      } else {
        while (valueEnd < text.length && /[\w.-]/.test(text[valueEnd])) valueEnd++;
      }
      const atom = text.slice(value + (quoted ? 1 : 0), valueEnd - (quoted ? 1 : 0));
      if (!/^[\w.-]+$/.test(atom)) return false;
      at = valueEnd;
    } else {
      if (!name || !isMarker(text, value)) return false;
      at = value + 10;
    }
    if (structured && objectValueBoundary(text, at)) return true;
    // Validate the complete remaining suffix, not just one redacted field before
    // an unknown tail. In particular, a comma cannot hide a new Basic scheme.
  }
  return true;
}
function credentialEnd(text: string, start: number, authorization: boolean, state: TextStructure): number {
  if (isQuote(text[start])) return quotedEnd(text, start);
  const structured = !state.quote && state.containers.at(-1) === "{";
  const marker = isMarker(text, start);
  if (structured && !marker && (text[start] === "{" || text[start] === "[")) return collectionEnd(text, start);
  let at = marker ? start + 10 : start;
  if (authorization && marker && safeHeaderMarkerBoundary(text, at, structured)) return at;
  if (!authorization && !marker) {
    const scheme = /^(?:bearer|basic)\s+/i.exec(text.slice(start));
    if (scheme) at += scheme[0].length;
  }
  const newline = authorization ? text.indexOf("\n", start) : -1;
  const limit = newline < 0 ? text.length : newline;
  for (; at < limit; at++) {
    const char = text[at];
    if (!authorization && /\s/.test(char)) break;
    if (structured && (at > start || char === ",") && objectValueBoundary(text, at)) break;
    if (state.quote) {
      if (char === "\\") at++;
      else if (char === state.quote) break;
    } else if (isQuote(char)) at = quotedEnd(text, at, limit) - 1;
  }
  return at;
}
function queryEnd(text: string, start: number, state: TextStructure): number {
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    // Escaped quotes/backslashes belong to the URL string. An unescaped closing
    // quote belongs to its containing field, never to this query parameter.
    if (char === "\\") { at++; continue; }
    if (char === "&" || /\s/.test(char)) return at;
    if (state.quote ? char === state.quote : isQuote(char) || char === "}" || char === "]" || (char === "," && nextObjectField(text, at))) return at;
  }
  return text.length;
}
function redactCredentialFields(text: string): string {
  const state: TextStructure = { containers: [] };
  const parts: string[] = [];
  let copied = 0, scanned = 0;
  SECRET_FIELD.lastIndex = 0;
  for (let match; (match = SECRET_FIELD.exec(text));) {
    const start = SECRET_FIELD.lastIndex;
    advanceStructure(text, scanned, start, state);
    const end = match[1] ? credentialEnd(text, start, match[2].toLowerCase() === "authorization", state) : queryEnd(text, start, state);
    parts.push(text.slice(copied, match.index), match[1] ?? "", end > start || !match[1] ? "[redacted]" : "");
    // A match inside an unrelated quoted string may consume its closing quote.
    // Otherwise credential contents are opaque, so braces in secrets never alter
    // the surrounding container stack used for subsequent fields.
    if (state.quote) advanceStructure(text, start, end, state);
    scanned = copied = SECRET_FIELD.lastIndex = end;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

export function sanitizeObservation(value: unknown, max = MAX_TEXT): string | undefined {
  if (value === undefined || value === null) return;
  const raw = (typeof value === "string" ? value : value instanceof Error ? value.message : String(value)).slice(0, 4000);
  const cleaned = redactCredentialFields(raw.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " "))
    .replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
export function observationText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return;
  const record = value as { content?: unknown; error?: unknown; message?: unknown };
  if (typeof record.error === "string") return record.error;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    const text = record.content.filter(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
      .map(block => (block as { text: string }).text).join("\n");
    if (text) return text;
  }
  return typeof record.message === "string" ? record.message : undefined;
}
export function classifyToolOutcome(isError: boolean | undefined, error?: string, blocked = false): ToolOutcome {
  if (blocked) return "blocked";
  if (!isError) return "success";
  const text = error ?? "";
  if (/tool execution was blocked|tool outside|was not executed/i.test(text)) return "blocked";
  if (/operation aborted|question cancelled without an answer/i.test(text)) return "aborted";
  return "error";
}
function validDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) return;
  return value;
}
function bump(map: CountBag, key: string, cap = MAX_BREAKDOWN): void {
  const name = sanitizeObservation(key, 64) ?? "unknown";
  if (map[name] !== undefined || Object.keys(map).length < cap) map[name] = num(map[name]) + 1;
  else map.__overflow__ = num(map.__overflow__) + 1;
}
function addBreakdown(target: Breakdown, extra: Breakdown): void {
  target.calls += num(extra.calls); target.successes += num(extra.successes); target.errors += num(extra.errors);
  target.blocked += num(extra.blocked); target.aborted += num(extra.aborted);
}
function outcomeField(outcome: ToolOutcome): keyof Pick<Breakdown, "successes" | "errors" | "blocked" | "aborted"> {
  return outcome === "success" ? "successes" : outcome === "blocked" ? "blocked" : outcome === "aborted" ? "aborted" : "errors";
}
function toolKey(sample: Pick<ToolObservation, "origin" | "nested" | "name">): string {
  return `${sample.origin}${sample.nested ? ":nested" : ""}:${sample.name}`;
}
function pairs(map: CountBag | undefined): string {
  return Object.entries(map ?? {}).filter(([, count]) => num(count) > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => `${key}=${count}`).join(", ") || "none";
}
function bag(value: unknown): CountBag {
  const out: CountBag = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, count] of Object.entries(value)) {
    const name = sanitizeObservation(key, 64);
    if (name) out[name] = num(out[name]) + num(count);
  }
  return out;
}

export class Observability implements MeshObserver {
  private startedAt: number;
  private updatedAt: number;
  private sessionId?: string;
  private path?: string;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private droppedEvents = 0;
  private lastPersistError?: string;
  private tools = new Map<string, ToolStat>();
  private roles = new Map<string, RoleStat>();
  private tasks: CountBag = {};
  private workflows: CountBag = {};
  private controls: CountBag = {};
  private byWorkspace: CountBag = {};
  private failuresByPhase: CountBag = {};
  private events: ObservationEvent[] = [];
  private open = new Map<string, Inflight>();
  private blocked = new Map<string, string>();
  onUpdate?: () => void;
  constructor(private now: () => number = Date.now) { this.startedAt = now(); this.updatedAt = this.startedAt; }

  tool(event: ToolObservation & { outcome: ToolOutcome }): void { this.guard(() => this.recordTool(event)); }
  task(event: TaskObservation): void { this.guard(() => this.recordTask(event)); }
  role(event: RoleObservation): void { this.guard(() => this.recordRole(event)); }
  workflow(event: WorkflowObservation): void { this.guard(() => this.recordWorkflow(event)); }
  control(event: ControlObservation): void { this.guard(() => this.recordControl(event)); }
  beginTool(key: string, event: ToolObservation): void {
    this.guard(() => {
      if (this.open.has(key)) this.finishOpen(key, "aborted", "superseded before completion");
      this.open.set(key, { at: this.now(), sample: this.cleanTool(event) });
      this.touch(false);
    });
  }
  endTool(key: string, event: ToolObservation & { outcome: ToolOutcome }): void {
    this.guard(() => {
      const reason = this.blocked.get(key);
      this.blocked.delete(key);
      const open = this.open.get(key);
      this.open.delete(key);
      const sample = this.cleanTool({ ...open?.sample, ...event, outcome: reason ? "blocked" : event.outcome, error: event.error ?? reason });
      sample.durationMs = validDuration(event.durationMs) ?? (open ? validDuration(this.now() - open.at) : undefined);
      this.recordTool(sample, true);
    });
  }
  markBlocked(key: string, reason?: string): void { this.guard(() => { this.blocked.set(key, sanitizeObservation(reason) ?? "blocked"); }); }
  abandonTools(prefix: string): void {
    this.guard(() => {
      for (const key of [...this.open.keys()]) if (key.startsWith(prefix)) {
        const reason = this.blocked.get(key);
        this.blocked.delete(key);
        this.finishOpen(key, reason ? "blocked" : "aborted", reason ?? "not finished before close");
      }
    });
  }
  totals(): MeshTotals {
    let toolCalls = 0, toolSuccesses = 0, toolErrors = 0, toolBlocked = 0, toolAborted = 0, rolesCreated = 0, roleRuns = 0;
    for (const stat of this.tools.values()) {
      toolCalls += stat.calls; toolSuccesses += stat.successes; toolErrors += stat.errors; toolBlocked += stat.blocked; toolAborted += stat.aborted;
    }
    for (const stat of this.roles.values()) { rolesCreated += stat.created; roleRuns += stat.runs; }
    return { toolCalls, toolSuccesses, toolErrors, toolBlocked, toolAborted, toolFailures: toolErrors + toolBlocked + toolAborted,
      rolesCreated, roleRuns, tasksLaunched: num(this.tasks.launched), tasksFailed: num(this.tasks.failed) };
  }
  attach(dir: string, sessionId?: string): void {
    try {
      if (this.path === join(dir, "observability.json")) { if (sessionId) this.sessionId = sessionId; return; }
      this.flush();
      this.path = join(dir, "observability.json");
      if (sessionId) this.sessionId = sessionId;
      const prior = this.read(this.path);
      if (prior === "corrupt") this.recordControl({ event: "persistence", name: "reset", outcome: "error", error: "observability file was unreadable; kept new observations" });
      else if (prior !== "missing") this.merge(prior);
      this.dirty = true;
      this.flush();
    } catch (error) { this.lastPersistError = sanitizeObservation(error) ?? "persist failed"; }
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    try { atomicWrite(this.path, JSON.stringify(this.persisted(), null, 2)); }
    catch (error) { this.dirty = true; this.lastPersistError = sanitizeObservation(error) ?? "persist failed"; }
  }
  report(section: string = "all", limit = section === "events" ? 80 : 40): string {
    if (!REPORT_SECTIONS.includes(section as ReportSection)) throw new Error("Usage: /mesh [tools|roles|tasks|workflows|controls|events [n]|json]");
    const shown = this.eventLimit(limit);
    const selected = section as ReportSection;
    const lines = [...this.header(), ""];
    if (selected === "all" || selected === "tools") lines.push(...this.toolLines(), "");
    if (selected === "all" || selected === "roles") lines.push(...this.roleLines(), "");
    if (selected === "all" || selected === "tasks") lines.push(...this.taskLines(), "");
    if (selected === "all" || selected === "workflows") lines.push(...this.workflowLines(), "");
    if (selected === "all" || selected === "controls") lines.push(...this.controlLines(), "");
    if (selected === "all" || selected === "events") lines.push(...this.eventLines(shown), "");
    return lines.join("\n").trimEnd();
  }
  toJSON(limit = 80): string {
    const snap = this.persisted();
    snap.events = snap.events.slice(-this.eventLimit(limit));
    let text = JSON.stringify(snap, null, 2);
    if (text.length <= MAX_JSON_CHARACTERS) return text;

    // Only exports are reduced; persistence and live counters remain complete.
    // Whole categories keep the fallback cheap and avoid presenting partial rows
    // as complete statistics. Omission counts refer to the requested snapshot.
    const omitted: Partial<Record<"events" | "inflight" | "tools" | "roles" | "controls" | "tasks" | "workflows" | "byWorkspace" | "failuresByPhase" | "sessionId", number>> = {};
    const bounded = { ...snap, totals: this.totals(), truncated: { maxCharacters: MAX_JSON_CHARACTERS, omitted } };
    for (const category of ["events", "inflight"] as const) {
      omitted[category] = bounded[category].length;
      bounded[category] = [];
      text = JSON.stringify(bounded, null, 2);
      if (text.length <= MAX_JSON_CHARACTERS) return text;
    }
    for (const category of ["tools", "roles", "controls", "tasks", "workflows", "byWorkspace", "failuresByPhase"] as const) {
      omitted[category] = Object.keys(bounded[category]).length;
      bounded[category] = {};
      text = JSON.stringify(bounded, null, 2);
      if (text.length <= MAX_JSON_CHARACTERS) return text;
    }
    // Session IDs originate outside this class and have no input length bound.
    omitted.sessionId = bounded.sessionId === undefined ? 0 : 1;
    delete bounded.sessionId;
    return JSON.stringify(bounded, null, 2);
  }

  private guard(fn: () => void): void { try { fn(); } catch { /* Observability must not affect execution. */ } }
  private touch(immediate: boolean): void {
    this.updatedAt = this.now();
    this.dirty = true;
    try { this.onUpdate?.(); } catch { /* Status publication is advisory. */ }
    if (!this.path) return;
    if (immediate) { this.flush(); return; }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 100);
      this.timer.unref?.();
    }
  }
  private eventLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Event limit must be 1–200");
    return limit;
  }
  private cleanTool(event: ToolObservation): ToolObservation {
    return {
      origin: event.origin === "child" ? "child" : "parent", nested: !!event.nested,
      name: sanitizeObservation(event.name, 80) ?? "unknown", outcome: event.outcome, durationMs: validDuration(event.durationMs),
      roleId: event.roleId ? sanitizeObservation(event.roleId, 64) : undefined,
      taskId: event.taskId ? sanitizeObservation(event.taskId, 80) : undefined,
      workflowId: event.workflowId ? sanitizeObservation(event.workflowId, 80) : undefined,
      stepId: event.stepId ? sanitizeObservation(event.stepId, 64) : undefined,
      run: Number.isInteger(event.run) ? event.run : undefined,
      action: event.action && /^[a-z_]{1,32}$/.test(event.action) ? event.action : event.action ? "unknown" : undefined,
      error: sanitizeObservation(event.error), toolCallId: undefined,
    };
  }
  private blankTool(sample: ToolObservation): ToolStat {
    return { origin: sample.origin, nested: !!sample.nested, name: sample.name, calls: 0, successes: 0, errors: 0, blocked: 0, aborted: 0,
      duration: emptyDuration(), lastAt: 0, lastOutcome: "success", byRole: {}, byAction: {} };
  }
  private bucket(sample: ToolObservation): ToolStat {
    const key = toolKey(sample);
    const found = this.tools.get(key);
    if (found) return found;
    if (this.tools.size >= MAX_TOOLS) {
      const overflow = this.tools.get("__overflow__") ?? this.blankTool({ origin: "parent", name: "__overflow__" });
      overflow.name = "__overflow__";
      this.tools.set("__overflow__", overflow);
      return overflow;
    }
    const created = this.blankTool(sample);
    this.tools.set(key, created);
    return created;
  }
  private recordTool(event: ToolObservation & { outcome?: ToolOutcome }, alreadyClean = false): void {
    const sample = alreadyClean ? event : this.cleanTool(event);
    const outcome = sample.outcome ?? "success";
    const stat = this.bucket(sample);
    stat.calls++; stat[outcome === "success" ? "successes" : outcome === "blocked" ? "blocked" : outcome === "aborted" ? "aborted" : "errors"]++;
    stat.lastAt = this.now(); stat.lastOutcome = outcome; stat.lastError = outcome === "success" ? undefined : sample.error ?? stat.lastError;
    if (sample.durationMs !== undefined) {
      const duration = stat.duration;
      duration.count++; duration.totalMs += sample.durationMs; duration.lastMs = sample.durationMs;
      duration.minMs = duration.count === 1 ? sample.durationMs : Math.min(duration.minMs, sample.durationMs);
      duration.maxMs = Math.max(duration.maxMs, sample.durationMs);
    }
    const breakdown = (map: Record<string, Breakdown>, key?: string) => {
      if (!key) return;
      const name = key === "__overflow__" ? key : sanitizeObservation(key, 64) ?? "unknown";
      if (!map[name] && Object.keys(map).length >= MAX_BREAKDOWN) key = "__overflow__";
      const slot = name === "__overflow__" || key === "__overflow__" ? "__overflow__" : name;
      map[slot] ??= emptyBreakdown();
      map[slot].calls++; map[slot][outcomeField(outcome)]++;
    };
    breakdown(stat.byRole, sample.roleId);
    breakdown(stat.byAction, sample.action);
    this.push({ at: stat.lastAt, kind: "tool", name: stat.name, outcome, origin: sample.origin, nested: sample.nested, roleId: sample.roleId,
      taskId: sample.taskId, workflowId: sample.workflowId, stepId: sample.stepId, run: sample.run, durationMs: sample.durationMs, action: sample.action,
      error: outcome === "success" ? undefined : sample.error });
    this.touch(true);
  }
  private blankRole(id: string): RoleStat {
    return { created: 0, continued: 0, recovered: 0, runs: 0, standalone: 0, workflow: 0, completed: 0, failed: 0, cancelled: 0,
      preflightOk: 0, preflightFailed: 0, questions: 0, answered: 0, byAccess: {}, byContext: {}, byModel: {}, lastAt: 0 };
  }
  private roleBucket(id: string): RoleStat {
    const found = this.roles.get(id);
    if (found) return found;
    if (this.roles.size >= MAX_ROLES) {
      const overflow = this.roles.get("__overflow__") ?? this.blankRole("__overflow__");
      this.roles.set("__overflow__", overflow);
      return overflow;
    }
    const created = this.blankRole(id);
    this.roles.set(id, created);
    return created;
  }
  private recordRole(event: RoleObservation): void {
    const roleId = sanitizeObservation(event.roleId, 64) ?? "unknown";
    const stat = this.roleBucket(roleId);
    const field = event.event === "created" ? "created" : event.event === "continued" ? "continued" : event.event === "recovered" ? "recovered"
      : event.event === "completed" ? "completed" : event.event === "failed" ? "failed" : event.event === "cancelled" ? "cancelled"
      : event.event === "preflight_ok" ? "preflightOk" : event.event === "preflight_failed" ? "preflightFailed"
      : event.event === "question" ? "questions" : "answered";
    stat[field]++;
    if (event.event === "created" || event.event === "continued" || event.event === "recovered") {
      stat.runs++;
      if (event.event === "created") stat[event.workflowId ? "workflow" : "standalone"]++;
      if (event.access) bump(stat.byAccess, event.access, 8);
      if (event.context) bump(stat.byContext, event.context, 8);
      if (event.model) bump(stat.byModel, event.model, 12);
    }
    stat.lastAt = this.now(); stat.lastTaskId = sanitizeObservation(event.taskId, 80) ?? stat.lastTaskId;
    stat.lastError = event.error ? sanitizeObservation(event.error) : stat.lastError;
    this.push({ at: stat.lastAt, kind: "role", name: roleId, outcome: event.event, taskId: stat.lastTaskId, workflowId: sanitizeObservation(event.workflowId, 80),
      stepId: sanitizeObservation(event.stepId, 64), run: Number.isInteger(event.run) ? event.run : undefined, error: sanitizeObservation(event.error) });
    this.touch(event.event === "created" || event.event === "failed" || event.event === "preflight_failed");
  }
  private recordTask(event: TaskObservation): void {
    bump(this.tasks, event.event, 32);
    if (event.event === "launched") {
      if (event.access) bump(this.tasks, `access:${event.access}`, 32);
      if (event.context) bump(this.tasks, `context:${event.context}`, 32);
      if (event.version) bump(this.tasks, `version:${event.version}`, 32);
    }
    if ((event.event === "failed" || event.event === "preflight_failed") && event.phase) bump(this.failuresByPhase, event.phase, 16);
    const at = this.now();
    this.push({ at, kind: "task", name: event.event, outcome: event.event, roleId: sanitizeObservation(event.roleId, 64), taskId: sanitizeObservation(event.taskId, 80),
      workflowId: sanitizeObservation(event.workflowId, 80), stepId: sanitizeObservation(event.stepId, 64), run: Number.isInteger(event.run) ? event.run : undefined,
      phase: sanitizeObservation(event.phase, 40), error: sanitizeObservation(event.error) });
    this.touch(event.event === "launched" || event.event === "completed" || event.event === "failed" || event.event === "cancelled");
  }
  private recordWorkflow(event: WorkflowObservation): void {
    bump(this.workflows, event.event, 32);
    if (event.event === "launched" && event.workspace) bump(this.byWorkspace, event.workspace, 8);
    this.push({ at: this.now(), kind: "workflow", name: sanitizeObservation(event.name, 72) ?? event.workflowId, outcome: event.event,
      workflowId: sanitizeObservation(event.workflowId, 80), stepId: sanitizeObservation(event.stepId, 64), roleId: sanitizeObservation(event.roleId, 64),
      detail: sanitizeObservation(event.detail, 80), error: sanitizeObservation(event.error) });
    this.touch(true);
  }
  private recordControl(event: ControlObservation): void {
    const name = sanitizeObservation(event.name, 64) ?? "unknown";
    const outcome = sanitizeObservation(event.outcome, 64) ?? "unknown";
    bump(this.controls, `${event.event}:${name}:${outcome}`, 64);
    this.push({ at: this.now(), kind: "control", name: `${event.event}:${name}`, outcome, error: sanitizeObservation(event.error), detail: sanitizeObservation(event.detail, 80) });
    this.touch(true);
  }
  private finishOpen(key: string, outcome: ToolOutcome, error?: string): void {
    const open = this.open.get(key);
    this.open.delete(key);
    if (!open) return;
    // Close/reload is not a measured execution; do not invent a duration from the wall clock.
    this.recordTool({ ...open.sample, outcome, error: sanitizeObservation(error) ?? open.sample.error, durationMs: undefined }, true);
  }
  private push(event: ObservationEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      const extra = this.events.length - MAX_EVENTS;
      this.events.splice(0, extra);
      this.droppedEvents += extra;
    }
  }
  private header(): string[] {
    const totals = this.totals();
    const inflight = [...this.open.values()].slice(0, 8).map(item => `${item.sample.origin}${item.sample.nested ? " nested" : ""} ${item.sample.name}`).join(", ");
    return [
      "Agent mesh observability",
      "Counts are cumulative for this parent session. Tool arguments, results and prompts are omitted. Errors are truncated and redacted.",
      `Started: ${iso(this.startedAt)} · Updated: ${iso(this.updatedAt)}`,
      `Persistence: ${this.path ?? "memory only"}${this.lastPersistError ? ` · persist error: ${this.lastPersistError}` : ""}`,
      `Tools: ${totals.toolCalls} calls · ${totals.toolSuccesses} ok · ${totals.toolErrors} error · ${totals.toolBlocked} blocked · ${totals.toolAborted} aborted · success ${rate(totals.toolSuccesses, totals.toolCalls)}`,
      `Roles created: ${totals.rolesCreated} · role runs: ${totals.roleRuns} · tasks launched: ${totals.tasksLaunched} · task failures: ${totals.tasksFailed}`,
      `In flight: ${this.open.size}${inflight ? ` (${inflight}${this.open.size > 8 ? ", …" : ""})` : ""} · dropped events: ${this.droppedEvents}`,
    ];
  }
  private toolLines(): string[] {
    const rows = [...this.tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    const lines = ["Tools"];
    if (!rows.length) return [...lines, "  No tool calls recorded."];
    for (const stat of rows) {
      const label = stat.name === "__overflow__" ? "other tools (cardinality cap)" : `${stat.origin}${stat.nested ? " nested" : ""} ${stat.name}`;
      const avg = stat.duration.count ? clock(stat.duration.totalMs / stat.duration.count) : "n/a";
      lines.push(`  ${label}  calls=${stat.calls} ok=${stat.successes} err=${stat.errors} blocked=${stat.blocked} aborted=${stat.aborted} rate=${rate(stat.successes, stat.calls)} avg=${avg} min=${stat.duration.count ? clock(stat.duration.minMs) : "n/a"} max=${stat.duration.count ? clock(stat.duration.maxMs) : "n/a"} last=${stat.duration.count ? clock(stat.duration.lastMs) : "n/a"}`);
      const roles = Object.entries(stat.byRole).map(([role, counts]) => `${role} ${counts.successes}/${counts.calls} ok`).join(", ");
      const actions = Object.entries(stat.byAction).map(([action, counts]) => `${action} ok=${counts.successes} err=${counts.errors} blocked=${counts.blocked} aborted=${counts.aborted}`).join(", ");
      if (roles) lines.push(`    roles: ${roles}`);
      if (actions) lines.push(`    actions: ${actions}`);
      if (stat.lastOutcome !== "success" && stat.lastError) lines.push(`    last error: ${stat.lastError}`);
    }
    return lines;
  }
  private roleLines(): string[] {
    const rows = [...this.roles.entries()].sort((a, b) => b[1].created - a[1].created || a[0].localeCompare(b[0]));
    const lines = ["Roles"];
    if (!rows.length) return [...lines, "  No role creations recorded."];
    for (const [id, stat] of rows) {
      lines.push(`  ${id === "__overflow__" ? "other roles (cardinality cap)" : id}  created=${stat.created} standalone=${stat.standalone} workflow=${stat.workflow} continued=${stat.continued} recovered=${stat.recovered} runs=${stat.runs}`);
      lines.push(`    outcomes: completed=${stat.completed} failed=${stat.failed} cancelled=${stat.cancelled} · preflight ok=${stat.preflightOk} failed=${stat.preflightFailed} · questions=${stat.questions} answered=${stat.answered}`);
      lines.push(`    access: ${pairs(stat.byAccess)} · context: ${pairs(stat.byContext)} · model: ${pairs(stat.byModel)}`);
      if (stat.lastTaskId || stat.lastError) lines.push(`    last task: ${stat.lastTaskId ?? "n/a"}${stat.lastError ? ` · last error: ${stat.lastError}` : ""}`);
    }
    return lines;
  }
  private taskLines(): string[] {
    return ["Tasks", `  ${pairs(this.tasks)}`, `  startup/failure phases: ${pairs(this.failuresByPhase)}`];
  }
  private workflowLines(): string[] {
    return ["Workflows", `  ${pairs(this.workflows)}`, `  workspace: ${pairs(this.byWorkspace)}`];
  }
  private controlLines(): string[] {
    return ["Controls", `  ${pairs(this.controls)}`];
  }
  private eventLines(limit: number): string[] {
    const rows = this.events.slice(-limit);
    const lines = [`Recent events (newest last, showing ${rows.length}${this.droppedEvents ? `; ${this.droppedEvents} older events dropped` : ""})`];
    if (!rows.length) return [...lines, "  No events recorded."];
    for (const event of rows) {
      const where = [event.origin ? `${event.origin}${event.nested ? "/nested" : ""}` : "", event.roleId ? `role=${event.roleId}` : "", event.taskId ? `task=${event.taskId}` : "",
        event.workflowId ? `workflow=${event.workflowId}` : "", event.stepId ? `step=${event.stepId}` : "", event.run ? `run=${event.run}` : "",
        event.durationMs !== undefined ? clock(event.durationMs) : "", event.action ? `action=${event.action}` : "", event.phase ? `phase=${event.phase}` : ""].filter(Boolean).join(" ");
      lines.push(`  ${iso(event.at)} ${event.kind} ${event.name} ${event.outcome ?? ""}${where ? ` · ${where}` : ""}${event.error ? ` · ${event.error}` : ""}`);
    }
    return lines;
  }
  private persisted(): Persisted {
    return {
      version: 1, privacy: { arguments: "omitted", results: "omitted", prompts: "omitted" },
      startedAt: this.startedAt, updatedAt: this.updatedAt, ...(this.sessionId ? { sessionId: this.sessionId } : {}), droppedEvents: this.droppedEvents,
      tools: Object.fromEntries(this.tools), roles: Object.fromEntries(this.roles), tasks: { ...this.tasks }, workflows: { ...this.workflows },
      controls: { ...this.controls }, byWorkspace: { ...this.byWorkspace }, failuresByPhase: { ...this.failuresByPhase },
      events: this.events.map(event => ({ ...event })), inflight: [...this.open.entries()].map(([key, value]) => ({ key, at: value.at, sample: { ...value.sample } })),
    };
  }
  private read(path: string): Persisted | "missing" | "corrupt" {
    if (!existsSync(path)) return "missing";
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Persisted>;
      if (!parsed || parsed.version !== 1 || !parsed.tools || typeof parsed.tools !== "object" || !parsed.roles || typeof parsed.roles !== "object" || !Array.isArray(parsed.events)) return "corrupt";
      return parsed as Persisted;
    } catch { return "corrupt"; }
  }
  private merge(prior: Persisted): void {
    const delta = this.persisted();
    const live = new Map(this.open);
    this.reset();
    this.startedAt = num(prior.startedAt) || this.startedAt;
    this.droppedEvents = num(prior.droppedEvents);
    this.importTools(prior.tools);
    this.importRoles(prior.roles);
    this.tasks = bag(prior.tasks); this.workflows = bag(prior.workflows); this.controls = bag(prior.controls);
    this.byWorkspace = bag(prior.byWorkspace); this.failuresByPhase = bag(prior.failuresByPhase);
    this.events = (prior.events ?? []).filter(event => event && typeof event === "object").slice(-MAX_EVENTS).map(event => ({ ...event, error: sanitizeObservation(event.error) }));
    for (const item of prior.inflight ?? []) {
      if (!item || live.has(item.key)) continue;
      this.open.set(item.key, { at: num(item.at) || this.now(), sample: this.cleanTool(item.sample ?? { origin: "parent", name: "unknown" }) });
      this.finishOpen(item.key, "aborted", "not finished before reload");
    }
    this.addPersisted(delta);
    this.open = live;
    if (this.events.length > MAX_EVENTS) {
      this.droppedEvents += this.events.length - MAX_EVENTS;
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }
  private reset(): void {
    this.tools.clear(); this.roles.clear(); this.events = []; this.open.clear(); this.blocked.clear();
    this.tasks = {}; this.workflows = {}; this.controls = {}; this.byWorkspace = {}; this.failuresByPhase = {}; this.droppedEvents = 0;
  }
  private importTools(value: Persisted["tools"]): void {
    for (const [key, stat] of Object.entries(value ?? {})) {
      if (!stat || typeof stat !== "object" || this.tools.size >= MAX_TOOLS + 1) continue;
      const sample = this.cleanTool({ origin: stat.origin === "child" ? "child" : "parent", nested: !!stat.nested, name: stat.name || key });
      const tool = this.blankTool(sample);
      tool.calls = num(stat.calls); tool.successes = num(stat.successes); tool.errors = num(stat.errors); tool.blocked = num(stat.blocked); tool.aborted = num(stat.aborted);
      tool.lastAt = num(stat.lastAt); tool.lastOutcome = stat.lastOutcome ?? "success"; tool.lastError = sanitizeObservation(stat.lastError);
      const duration = stat.duration ?? emptyDuration();
      tool.duration = { count: num(duration.count), totalMs: num(duration.totalMs), minMs: num(duration.minMs), maxMs: num(duration.maxMs), lastMs: num(duration.lastMs) };
      for (const [name, counts] of Object.entries(stat.byRole ?? {})) tool.byRole[sanitizeObservation(name, 64) ?? "unknown"] = { ...emptyBreakdown(), ...counts, calls: num(counts?.calls), successes: num(counts?.successes), errors: num(counts?.errors), blocked: num(counts?.blocked), aborted: num(counts?.aborted) };
      for (const [name, counts] of Object.entries(stat.byAction ?? {})) tool.byAction[sanitizeObservation(name, 32) ?? "unknown"] = { ...emptyBreakdown(), ...counts, calls: num(counts?.calls), successes: num(counts?.successes), errors: num(counts?.errors), blocked: num(counts?.blocked), aborted: num(counts?.aborted) };
      const keyName = toolKey(sample);
      const existing = this.tools.get(keyName);
      if (existing) { existing.calls += tool.calls; existing.successes += tool.successes; existing.errors += tool.errors; existing.blocked += tool.blocked; existing.aborted += tool.aborted; continue; }
      if (this.tools.size >= MAX_TOOLS) {
        const overflow = this.tools.get("__overflow__") ?? this.blankTool({ origin: "parent", name: "__overflow__" });
        overflow.calls += tool.calls; overflow.successes += tool.successes; overflow.errors += tool.errors; overflow.blocked += tool.blocked; overflow.aborted += tool.aborted;
        this.tools.set("__overflow__", overflow);
        continue;
      }
      this.tools.set(keyName, tool);
    }
  }
  private importRoles(value: Persisted["roles"]): void {
    for (const [id, stat] of Object.entries(value ?? {})) {
      if (!stat || typeof stat !== "object") continue;
      const roleId = sanitizeObservation(id, 64) ?? "unknown";
      const role = this.roleBucket(roleId);
      for (const field of ["created", "continued", "recovered", "runs", "standalone", "workflow", "completed", "failed", "cancelled", "preflightOk", "preflightFailed", "questions", "answered"] as const) role[field] = num(stat[field]);
      role.byAccess = bag(stat.byAccess); role.byContext = bag(stat.byContext); role.byModel = bag(stat.byModel);
      role.lastAt = num(stat.lastAt); role.lastTaskId = sanitizeObservation(stat.lastTaskId, 80); role.lastError = sanitizeObservation(stat.lastError);
    }
  }
  private addPersisted(delta: Persisted): void {
    for (const stat of Object.values(delta.tools)) {
      const sample = this.cleanTool(stat);
      const tool = this.bucket(sample);
      tool.calls += num(stat.calls); tool.successes += num(stat.successes); tool.errors += num(stat.errors); tool.blocked += num(stat.blocked); tool.aborted += num(stat.aborted);
      if (num(stat.lastAt) >= tool.lastAt) { tool.lastAt = num(stat.lastAt); tool.lastOutcome = stat.lastOutcome ?? tool.lastOutcome; tool.lastError = sanitizeObservation(stat.lastError) ?? tool.lastError; }
      const duration = stat.duration ?? emptyDuration();
      if (num(duration.count)) {
        const adding = num(duration.count);
        const had = tool.duration.count;
        tool.duration.totalMs += num(duration.totalMs); tool.duration.count += adding; tool.duration.lastMs = num(duration.lastMs) || tool.duration.lastMs;
        tool.duration.minMs = had === 0 ? num(duration.minMs) : Math.min(tool.duration.minMs, num(duration.minMs));
        tool.duration.maxMs = Math.max(tool.duration.maxMs, num(duration.maxMs));
      }
      for (const [name, counts] of Object.entries(stat.byRole ?? {})) { tool.byRole[name] ??= emptyBreakdown(); addBreakdown(tool.byRole[name], counts); }
      for (const [name, counts] of Object.entries(stat.byAction ?? {})) { tool.byAction[name] ??= emptyBreakdown(); addBreakdown(tool.byAction[name], counts); }
    }
    for (const [id, stat] of Object.entries(delta.roles)) {
      const role = this.roleBucket(id);
      for (const field of ["created", "continued", "recovered", "runs", "standalone", "workflow", "completed", "failed", "cancelled", "preflightOk", "preflightFailed", "questions", "answered"] as const) role[field] += num(stat[field]);
      for (const [key, count] of Object.entries(bag(stat.byAccess))) role.byAccess[key] = num(role.byAccess[key]) + count;
      for (const [key, count] of Object.entries(bag(stat.byContext))) role.byContext[key] = num(role.byContext[key]) + count;
      for (const [key, count] of Object.entries(bag(stat.byModel))) role.byModel[key] = num(role.byModel[key]) + count;
      if (num(stat.lastAt) >= role.lastAt) { role.lastAt = num(stat.lastAt); role.lastTaskId = stat.lastTaskId ?? role.lastTaskId; role.lastError = stat.lastError ?? role.lastError; }
    }
    for (const [key, count] of Object.entries(bag(delta.tasks))) this.tasks[key] = num(this.tasks[key]) + count;
    for (const [key, count] of Object.entries(bag(delta.workflows))) this.workflows[key] = num(this.workflows[key]) + count;
    for (const [key, count] of Object.entries(bag(delta.controls))) this.controls[key] = num(this.controls[key]) + count;
    for (const [key, count] of Object.entries(bag(delta.byWorkspace))) this.byWorkspace[key] = num(this.byWorkspace[key]) + count;
    for (const [key, count] of Object.entries(bag(delta.failuresByPhase))) this.failuresByPhase[key] = num(this.failuresByPhase[key]) + count;
    this.droppedEvents += num(delta.droppedEvents);
    this.events.push(...delta.events);
  }
}
