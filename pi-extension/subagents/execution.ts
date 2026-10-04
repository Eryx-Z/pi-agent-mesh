import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { RpcLaunch } from "./rpc.ts";

export interface ExecutionBoundary {
  kind: "systemd-scope";
  unit: string;
  bootId: string;
  uid: number;
}
export interface ExecutionController {
  prepare(recordId: string, run: number): ExecutionBoundary | undefined;
  wrap(launch: RpcLaunch, boundary: ExecutionBoundary): RpcLaunch;
  /** PRECONDITION: launcher creation has settled (persisted successful RPC readiness)
   * OR the launcher has closed/its own persisted identity is proven dead. Caller must
   * also fence the previous owner so it cannot spawn again. Parent-owner death alone
   * is insufficient: an orphan launcher may still create a scope. Without readiness
   * or a dead launcher, missing-unit cleanup must remain unconfirmed. After cleanup,
   * caller verifies the original launcher is dead before releasing task resources.
   */
  cleanup(boundary: ExecutionBoundary): Promise<void>;
}
export interface ProcessIdentity { pid: number; startTime: string; bootId: string }

const bootPath = "/proc/sys/kernel/random/boot_id";
const bootId = () => {
  const value = readFileSync(bootPath, "utf8").trim();
  if (!value) throw new Error("Missing kernel boot identity");
  return value;
};
function startTime(pid: number): string {
  // comm may contain spaces and ')'; field 22 follows the final closing paren.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const value = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (!value || !/^\d+$/.test(value)) throw new Error("Invalid process stat");
  return value;
}
export function readProcessIdentity(pid = process.pid): ProcessIdentity | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try { return { pid, startTime: startTime(pid), bootId: bootId() }; } catch { return undefined; }
}
/** Unknown/unreadable means alive: never authorize recovery from a failed identity probe. */
export function isProcessIdentityAlive(identity: ProcessIdentity): boolean {
  if (process.platform !== "linux") return true;
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.startTime || !identity.bootId) return true;
  try { if (bootId() !== identity.bootId) return false; } catch { return true; }
  try { return startTime(identity.pid) === identity.startTime; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

const commandTimeout = 5000;
const runCommand = promisify(execFile);
const scopeArgs = (unit: string) => ["--user", "--scope", "--quiet", "--collect", "--expand-environment=no",
  `--unit=${unit}`, "--description=Pi subagent execution", "--property=KillMode=control-group", "--property=TimeoutStopSec=2s", "--"];
// Injection is limited to OS operations for deterministic failure-path tests.
interface Operations {
  platform: string;
  uid: () => number | undefined;
  bootId: () => string;
  probe: () => boolean;
  command: (command: string, args: string[]) => Promise<string>;
  read: (path: string) => string;
  sleep: (ms: number) => Promise<void>;
}
const realOperations: Operations = {
  platform: process.platform,
  uid: () => process.getuid?.(),
  bootId,
  probe: () => {
    try {
      execFileSync("systemd-run", [...scopeArgs(`pi-execution-probe-${randomUUID()}.scope`), "/bin/true"],
        { timeout: commandTimeout, stdio: "pipe" });
      // Recursive populated accounting is a cgroup v2 guarantee.
      readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8");
      return true;
    } catch { return false; }
  },
  command: async (command, args) => (await runCommand(command, args,
    { timeout: commandTimeout, maxBuffer: 64 * 1024, encoding: "utf8" })).stdout,
  read: path => readFileSync(path, "utf8"),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** A scope owns the entire descendant cgroup, including setsid/detached grandchildren.
 * This is containment for ordinary tools, not a sandbox against hostile cgroup migration.
 */
export class SystemdExecutionController implements ExecutionController {
  private available?: boolean;
  private ops: Operations;
  constructor(operations: Partial<Operations> = {}) { this.ops = { ...realOperations, ...operations }; }

  prepare(_recordId: string, _run: number): ExecutionBoundary | undefined {
    if (this.available === undefined) {
      try { this.available = this.ops.platform === "linux" && this.ops.uid() !== undefined && this.ops.probe(); }
      catch { this.available = false; }
    }
    if (!this.available) return undefined;
    try {
      const boot = this.ops.bootId(); const uid = this.ops.uid();
      if (!boot || uid === undefined) return undefined;
      // Random name, not user-controlled record text or an identifier reused by retry.
      return { kind: "systemd-scope", unit: `pi-execution-${randomUUID()}.scope`, bootId: boot, uid };
    } catch { return undefined; }
  }
  wrap(launch: RpcLaunch, boundary: ExecutionBoundary): RpcLaunch {
    this.validate(boundary);
    return { ...launch, command: "systemd-run", args: [...scopeArgs(boundary.unit), launch.command, ...launch.args] };
  }
  private validate(boundary: ExecutionBoundary): void {
    if (boundary.kind !== "systemd-scope" || !/^pi-execution-[a-zA-Z0-9-]+\.scope$/.test(boundary.unit) ||
        !boundary.bootId || !Number.isSafeInteger(boundary.uid) || boundary.uid < 0) {
      throw new Error("Invalid execution boundary");
    }
    if (this.ops.platform !== "linux" || this.ops.uid() !== boundary.uid) throw new Error("Execution boundary owner unavailable or changed");
  }
  private async show(unit: string): Promise<{ load: string; active: string; group: string }> {
    // Nonzero status (including bus/authentication errors) is never 'not found'.
    const output = await this.ops.command("systemctl", ["--user", "show", unit,
      "--property=LoadState", "--property=ActiveState", "--property=ControlGroup"]);
    const fields = new Map(output.trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const load = fields.get("LoadState"); const active = fields.get("ActiveState"); const group = fields.get("ControlGroup");
    if (!load || !active || group === undefined) throw new Error("Incomplete execution boundary status");
    return { load, active, group };
  }
  private empty(group: string): boolean {
    if (!group.startsWith("/") || group === "/" || group.split("/").some(part => part === "." || part === "..")) {
      throw new Error("Invalid execution control group");
    }
    try {
      const events = this.ops.read(`/sys/fs/cgroup${group}/cgroup.events`);
      if (!/^populated [01]$/m.test(events)) throw new Error("Missing cgroup population status");
      return /^populated 0$/m.test(events);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  async cleanup(boundary: ExecutionBoundary): Promise<void> {
    this.validate(boundary);
    // No process from the previous kernel boot survives; uid checks still apply.
    const currentBoot = this.ops.bootId();
    if (!currentBoot) throw new Error("Missing kernel boot identity");
    if (currentBoot !== boundary.bootId) return;
    const initial = await this.show(boundary.unit);
    let group = initial.group;
    if (initial.load === "not-found" && initial.active === "inactive" && !group) return;
    // Kill immediately, including children in separate sessions; stop also cancels the unit.
    // Either operation may race collection. Only subsequent affirmative proof is decisive.
    for (const args of [
      ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", boundary.unit],
      ["--user", "stop", boundary.unit],
    ]) { try { await this.ops.command("systemctl", args); } catch { /* verify below */ } }
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await this.show(boundary.unit);
      if (status.group) {
        if (group && status.group !== group) throw new Error("Execution control group changed during cleanup");
        group = status.group;
      }
      if (group && this.empty(group)) return;
      if (!group && !status.group && status.active === "inactive" && status.load === "not-found") return;
      await this.ops.sleep(50);
    }
    throw new Error(`Execution boundary cleanup unconfirmed: ${boundary.unit}`);
  }
}
