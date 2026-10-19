import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const roleMcpServerPath = fileURLToPath(new URL("./role-mcp-server.mjs", import.meta.url));

/** JSON argv[2] contract; all delays are milliseconds (native MCP config timeout is seconds).
 * behaviorFile is a JSON object overriding tools/schema/annotations/delayMs/initDelayMs
 * and stopProgress. Atomic replacement is supported. A malformed write retains the last
 * valid behavior. Tools may be full definitions in behaviorFile for per-tool drift tests.
 */
export interface RoleMcpFixtureOptions {
  id: string;
  log?: string;
  http?: boolean;
  tools?: string[];
  delayMs?: number;
  initDelayMs?: number;
  schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  tokenEnv?: string;
  expectedToken?: string;
  /** HTTP credential header name, default authorization. */
  header?: string;
  /** Exact header value; a mismatch returns HTTP 401. */
  secretExpected?: string;
  behaviorFile?: string;
}

export interface RoleMcpPeerOptions extends RoleMcpFixtureOptions {
  /** Launcher-only controls, not serialized into the peer argv. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export interface RoleMcpPeer {
  process: ChildProcessWithoutNullStreams;
  url?: string;
  /** Present even when the launcher allocated a temporary log. */
  log: string;
  /** Snapshot of JSONL events; still available after stop(), including default logs. */
  logs(): any[];
  /** Idempotent SIGTERM, bounded SIGKILL fallback; does not send an MCP DELETE. */
  stop(): Promise<void>;
}

export async function startRoleMcpPeer(options: RoleMcpPeerOptions): Promise<RoleMcpPeer> {
  const { cwd, env, startupTimeoutMs = 5000, ...fixture } = options;
  const temporary = fixture.log ? undefined : mkdtempSync(join(tmpdir(), "role-mcp-peer-"));
  const log = fixture.log ?? join(temporary!, "events.jsonl");
  const child = spawn(process.execPath, [roleMcpServerPath, JSON.stringify({ ...fixture, log })], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: "pipe",
  });
  // Drain stderr but never interpolate it into failures: credentials can be in argv/env.
  child.stderr.resume();
  let spawnError: Error | undefined;
  let exited = false;
  const exit = new Promise<void>(resolve => {
    child.once("error", error => { spawnError = error; exited = true; resolve(); });
    child.once("exit", () => { exited = true; resolve(); });
  });
  let savedLogs: any[] | undefined;
  const logs = (): any[] => {
    if (savedLogs) return savedLogs.slice();
    if (!existsSync(log)) return [];
    const content = readFileSync(log, "utf8");
    // A concurrent reader may catch an in-progress final line.
    return content.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  };
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!exited) {
        child.kill("SIGTERM");
        timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 1000);
        await exit;
      }
    } finally {
      clearTimeout(timer);
      savedLogs = logs();
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      child.stdin.destroy();
      child.stdout.destroy();
    }
  })();
  let stdout = "";
  const onData = (chunk: Buffer) => { stdout += chunk.toString(); };
  if (fixture.http) child.stdout.on("data", onData);
  try {
    const deadline = Date.now() + startupTimeoutMs;
    while (!logs().some(event => event.event === "ready" && event.pid === child.pid) || (fixture.http && !stdout.includes("\n"))) {
      if (spawnError || exited) throw new Error("Role MCP fixture exited before readiness");
      if (Date.now() >= deadline) throw new Error("Role MCP fixture startup timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const url = fixture.http ? JSON.parse(stdout.split("\n")[0]).url as string : undefined;
    return { process: child, url, log, logs, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    if (fixture.http) child.stdout.off("data", onData);
  }
}
