import { spawn } from "node:child_process";

export interface ExecutionLease { readonly alive: boolean; release(): Promise<void> }

/** Kernel flock survives neither holder exit nor host death; no stale-file unlink race. */
export function acquireExecutionLease(path: string, onLost?: () => void): Promise<ExecutionLease> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--nonblock", "--close", path, process.execPath, "-e",
      'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
    { stdio: "pipe", detached: true });
    let ready = false, closed = false, output = "", stderr = "";
    let release: Promise<void> | undefined;
    let finish!: () => void;
    const exited = new Promise<void>(r => { finish = r; });
    const kill = () => { if (child.pid && !closed) { try { process.kill(-child.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; } } };
    const timer = setTimeout(() => { kill(); reject(new Error("Execution lease readiness timed out")); }, 3000);
    child.stdin.on("error", () => {});
    child.stderr.on("data", b => { stderr = (stderr + b).slice(-1000); });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      closed = true; clearTimeout(timer); finish();
      if (!ready) reject(new Error(`Execution is owned by another manager or lease is unavailable: ${stderr}`));
      else if (!release) onLost?.();
    });
    child.stdout.on("data", b => {
      output += b;
      if (ready || !output.includes("locked\n")) return;
      ready = true; clearTimeout(timer);
      resolve({ get alive() { return !closed; }, release() {
        return release ??= (async () => {
          child.stdin.end();
          const timeout = setTimeout(kill, 1000);
          try { await exited; } finally { clearTimeout(timeout); }
        })();
      } });
    });
  });
}
