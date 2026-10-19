import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type RpcEvent = { type: string; [key: string]: any };
export interface RpcLaunch { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }

/** Strict LF framing with UTF-8 streaming decode, not readline's additional delimiters. */
export class JsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(private receive: (event: RpcEvent) => void, private maxBytes = 16 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error("RPC frame exceeds limit");
      if (line.trim()) {
        const event = JSON.parse(line);
        if (!event || typeof event.type !== "string") throw new Error("Invalid RPC event");
        this.receive(event);
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error("RPC frame exceeds limit");
  }
}
export class RpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { type: string; resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  // Caller rejection/timeout does not cancel Pi's asynchronous prompt preflight.
  private promptPreflights = new Set<string>();
  private preflightsDrained?: () => void;
  private closed = false;
  private stopping?: Promise<void>;
  private stopSettled = false;
  private stopRequested = false;
  private exitPromise: Promise<void>;
  private stderr = "";
  constructor(launch: RpcLaunch, private timeoutMs = 15000, private graceMs = 1500) {
    super();
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "pipe", detached: process.platform !== "win32" });
    const decoder = new JsonlDecoder(e => this.receive(e));
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { decoder.push(chunk); } catch (e) { this.fail(e as Error); void this.stop().catch(() => {}); }
    });
    this.child.stderr.on("data", (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-8000); });
    this.child.stdin.on("error", e => this.fail(e));
    this.child.on("error", e => this.fail(e));
    this.exitPromise = new Promise(resolve => this.child.on("close", (code, signal) => {
      this.closed = true;
      this.rejectPending(new Error(`RPC process closed (${code ?? signal}): ${this.stderr}`));
      this.emit("closed", { code, signal, stderr: this.stderr });
      resolve();
    }));
  }
  private fail(error: Error): void { this.rejectPending(error); this.emit("fault", error); }
  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  private receive(event: RpcEvent): void {
    if (event.type === "response") {
      // Receipts arrive after preflight, not after model completion. Keep recognizing
      // late receipts even when their caller has timed out or was rejected by stop().
      if (event.command === "prompt" && typeof event.success === "boolean" && this.promptPreflights.delete(event.id) && !this.promptPreflights.size) {
        this.preflightsDrained?.();
      }
      const p = this.pending.get(event.id);
      if (!p) return;
      this.pending.delete(event.id); clearTimeout(p.timer);
      if (event.command !== p.type) p.reject(new Error("RPC response command mismatch"));
      else if (event.success !== true) p.reject(new Error(event.error || "RPC rejected request"));
      else p.resolve(event.data);
    } else this.emit("event", event);
  }
  send(event: RpcEvent): void {
    if (this.closed) throw new Error("RPC process is closed");
    if (this.stopRequested) throw new Error("RPC process is stopping");
    this.write(event);
  }
  private write(event: RpcEvent): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error("RPC process is closed");
    if (event.type === "prompt" && typeof event.id !== "string") event = { ...event, id: randomUUID() };
    const line = JSON.stringify(event) + "\n";
    if (event.type === "prompt") {
      if (this.promptPreflights.has(event.id)) throw new Error("Duplicate unresolved prompt ID");
      this.promptPreflights.add(event.id);
    }
    try { this.child.stdin.write(line); }
    catch (error) {
      // A synchronous write failure did not submit this prompt. Asynchronous
      // stream errors still leave acceptance unknown and must retain tracking.
      if (event.type === "prompt") this.promptPreflights.delete(event.id);
      throw error;
    }
  }
  request(type: string, fields: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<any> {
    if (this.closed || this.stopRequested) return Promise.reject(new Error("RPC process is stopping"));
    // Role readiness uses its remaining absolute deadline plus communication margin.
    // Do not change the 15s default or the conservative timeout/cleanup semantics.
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      return Promise.reject(new Error("timeoutMs must be positive, finite, and within the Node timer range"));
    }
    return this.requestWithTimeout(type, fields, timeoutMs, true);
  }
  private requestWithTimeout(type: string, fields: Record<string, unknown>, timeoutMs: number, stopOnTimeout: boolean): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`RPC ${type} timed out; acceptance/execution is unknown`);
        reject(error);
        if (stopOnTimeout) { this.fail(error); void this.stop().catch(() => {}); }
      }, timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      try { this.write({ ...fields, type, id }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  stop(): Promise<void> {
    this.stopRequested = true;
    if (this.stopping) return this.stopping;
    this.stopSettled = false;
    this.stopping = Promise.resolve().then(() => this.stopProcess()).finally(() => { this.stopSettled = true; });
    return this.stopping;
  }
  get exited(): boolean { return this.closed; }
  get pid(): number | undefined { return this.child.pid; }
  /** Retry a settled stop failure without submitting new model work. */
  retryStop(): Promise<void> {
    if (this.stopSettled) this.stopping = undefined;
    return this.stop();
  }
  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid || this.closed) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else if (!this.closed) this.child.kill(signal);
    } catch (e: any) { if (e.code !== "ESRCH") throw e; }
  }
  private async waitForPromptPreflights(): Promise<void> {
    if (!this.promptPreflights.size) return;
    if (this.closed) throw new Error("Prompt acceptance is unknown after child exit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Prompt preflight did not settle; acceptance remains unknown"));
          }, this.graceMs);
          this.preflightsDrained = resolve;
        }),
        this.exitPromise.then(() => {
          throw new Error("Prompt acceptance is unknown after child exit");
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.preflightsDrained = undefined;
    }
  }
  private async stopProcess(): Promise<void> {
    this.rejectPending(new Error("RPC process stopping"));
    let cleanupConfirmed = false;
    let cleanupError: unknown;
    // Idle/abort does not cover pending input/before_agent_start hooks. Drain their
    // receipts first, then abort while Pi still has its detached-bash signal cleanup.
    try {
      await this.waitForPromptPreflights();
      let legacyWithoutClearQueue = false;
      try { await this.requestWithTimeout("clear_queue", {}, this.graceMs, false); }
      catch (error) {
        if (!(error instanceof Error) || !/Unknown command:\s*clear_queue\b/.test(error.message)) throw error;
        legacyWithoutClearQueue = true;
      }
      await this.requestWithTimeout("abort", {}, this.graceMs, false);
      if (legacyWithoutClearQueue) {
        // Pi 0.84 has Session.clearQueue(), but does not expose it over RPC. Abort,
        // then conservatively prove that no queued work remains before allowing EOF.
        const state = await this.requestWithTimeout("get_state", {}, this.graceMs, false);
        if (state?.isStreaming !== false || state?.isCompacting || state?.pendingMessageCount) {
          throw new Error("Pi 0.84 cannot confirm an empty queue after abort");
        }
      }
      cleanupConfirmed = true;
    } catch (error) { cleanupError = error; /* No EOF or confirmation when preflight/abort is uncertain. */ }
    if (cleanupConfirmed && !this.child.stdin.destroyed && this.child.stdin.writable) {
      try { this.child.stdin.end(); } catch {}
    } else this.signal("SIGTERM");
    const delay = (ms: number) => new Promise<void>(r => {
      if (this.closed) return r();
      const t = setTimeout(r, ms);
      this.exitPromise.then(() => { clearTimeout(t); r(); });
    });
    await delay(this.graceMs);
    if (!this.closed) {
      this.signal("SIGTERM");
      await delay(this.graceMs);
    }
    if (!this.closed) {
      this.signal("SIGKILL");
      await delay(this.graceMs);
    }
    if (!this.closed) throw new Error("Could not confirm child process exit; continuation disabled");
    if (!cleanupConfirmed) throw new Error(`Child exited without confirmed agent/tool cleanup; continuation disabled: ${cleanupError}`);
  }
}
