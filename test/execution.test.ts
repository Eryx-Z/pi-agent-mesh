import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemdExecutionController, readProcessIdentity, isProcessIdentityAlive, type ExecutionBoundary } from "../pi-extension/subagents/execution.ts";

const boundary: ExecutionBoundary = { kind: "systemd-scope", unit: "pi-execution-test.scope", bootId: "boot", uid: 1000 };
const loaded = "LoadState=loaded\nActiveState=active\nControlGroup=/test.scope\n";
const missing = "LoadState=not-found\nActiveState=inactive\nControlGroup=\n";
function fake(options: ConstructorParameters<typeof SystemdExecutionController>[0] = {}) {
  return new SystemdExecutionController({ platform: "linux", uid: () => 1000, bootId: () => "boot", probe: () => true,
    command: async () => missing, read: () => "populated 0\n", sleep: async () => {}, ...options });
}

test("prepare probes once, persists identity, and never reuses names", () => {
  let probes = 0;
  const controller = fake({ probe: () => { probes++; return true; } });
  const first = controller.prepare("dangerous / record", 1)!;
  const next = controller.prepare("dangerous / record", 1)!;
  assert.equal(probes, 1);
  assert.equal(first.kind, "systemd-scope");
  assert.equal(first.uid, 1000);
  assert.equal(first.bootId, "boot");
  assert.notEqual(first.unit, next.unit);
  assert.match(first.unit, /^pi-execution-[a-f0-9-]+\.scope$/);
  let failures = 0;
  const unsupported = fake({ probe: () => { failures++; return false; } });
  assert.equal(unsupported.prepare("x", 1), undefined);
  assert.equal(unsupported.prepare("x", 2), undefined);
  assert.equal(failures, 1);
  assert.equal(fake({ platform: "darwin" }).prepare("x", 1), undefined);
  assert.equal(fake({ probe: () => { throw Error("probe failed"); } }).prepare("x", 1), undefined);
  assert.equal(fake({ bootId: () => { throw Error("unreadable"); } }).prepare("x", 1), undefined);
});

test("wrap preserves cwd/env and literal argv without a shell or environment expansion", () => {
  const env = { TOKEN: "secret" };
  const wrapped = fake().wrap({ command: "/node", args: ["a b", "$TOKEN", "${TOKEN}"], cwd: "/workspace", env }, boundary);
  assert.equal(wrapped.command, "systemd-run");
  assert.equal(wrapped.cwd, "/workspace");
  assert.equal(wrapped.env, env);
  assert.deepEqual(wrapped.args.slice(wrapped.args.indexOf("--") + 1), ["/node", "a b", "$TOKEN", "${TOKEN}"]);
  assert.ok(wrapped.args.includes("--expand-environment=no"));
  assert.ok(wrapped.args.includes("--property=KillMode=control-group"));
  assert.ok(!wrapped.args.join(" ").includes("secret"));
});

test("cleanup accepts an absent unit only on a successful, complete status response", async () => {
  await fake().cleanup(boundary);
  for (const output of ["", "LoadState=not-found\n", "LoadState=not-found\nActiveState=active\nControlGroup=\n"]) {
    await assert.rejects(fake({ command: async () => output }).cleanup(boundary));
  }
  await assert.rejects(fake({ command: async () => { throw Error("bus unavailable"); } }).cleanup(boundary), /bus unavailable/);
});

test("cleanup refuses changed uid/invalid unit; a previous boot needs no commands", async () => {
  await assert.rejects(fake().cleanup({ ...boundary, uid: 1001 }), /owner/);
  await assert.rejects(fake().cleanup({ ...boundary, unit: "unrelated.service" }), /Invalid/);
  let commands = 0;
  await fake({ bootId: () => "new-boot", command: async () => { commands++; throw Error(); } }).cleanup(boundary);
  assert.equal(commands, 0);
  await assert.rejects(fake({ bootId: () => { throw Error("boot unreadable"); } }).cleanup(boundary));
  await assert.rejects(fake({ bootId: () => "" }).cleanup(boundary), /Missing/);
});

test("cleanup kills whole cgroup, waits for recursive populated=0, handles failed units", async () => {
  const calls: string[][] = []; let reads = 0;
  await fake({ command: async (_cmd, args) => { calls.push(args); return loaded.replace("active", "failed"); },
    read: () => `populated ${++reads < 3 ? 1 : 0}\n` }).cleanup(boundary);
  assert.equal(reads, 3);
  assert.ok(calls.some(args => args.includes("kill") && args.includes("--kill-whom=all") && args.includes("--signal=SIGKILL")));
  assert.ok(calls.some(args => args.includes("stop")));
});

test("kill/stop failure is not confirmation; only subsequent emptiness can confirm", async () => {
  const command = async (_cmd: string, args: string[]) => {
    if (!args.includes("show")) throw Error("stop failed");
    return loaded;
  };
  await assert.rejects(fake({ command, read: () => "populated 1\n" }).cleanup(boundary), /unconfirmed/);
  await fake({ command, read: () => "populated 0\n" }).cleanup(boundary);
  await assert.rejects(fake({ command, read: () => { throw Object.assign(Error("denied"), { code: "EACCES" }); } }).cleanup(boundary), /denied/);
  await assert.rejects(fake({ command, read: () => "garbage" }).cleanup(boundary), /population/);
});

test("collection does not hide a previously observed populated cgroup", async () => {
  let shows = 0;
  const command = async (_cmd: string, args: string[]) => args.includes("show") ? (++shows === 1 ? loaded : missing) : "";
  await assert.rejects(fake({ command, read: () => "populated 1\n" }).cleanup(boundary), /unconfirmed/);
  shows = 0;
  await fake({ command, read: () => { throw Object.assign(Error("removed"), { code: "ENOENT" }); } }).cleanup(boundary);
});

test("a changed/unsafe cgroup path cannot authorize cleanup", async () => {
  let shows = 0;
  await assert.rejects(fake({ command: async (_cmd, args) => args.includes("show") ?
    (++shows === 1 ? loaded : loaded.replace("/test.scope", "/other.scope")) : "" }).cleanup(boundary), /changed/);
  await assert.rejects(fake({ command: async () => loaded.replace("/test.scope", "/../outside") }).cleanup(boundary), /Invalid/);
});

test("process identity distinguishes live, reused pid, previous boot and gone owner", { skip: process.platform !== "linux" }, async () => {
  const identity = readProcessIdentity()!;
  assert.equal(identity.pid, process.pid);
  assert.equal(isProcessIdentityAlive(identity), true);
  assert.equal(isProcessIdentityAlive({ ...identity, startTime: "0" }), false);
  assert.equal(isProcessIdentityAlive({ ...identity, bootId: "different" }), false);
  assert.equal(isProcessIdentityAlive({ ...identity, pid: -1 }), true);
  assert.equal(readProcessIdentity(-1), undefined);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"]);
  await once(child, "spawn");
  const owner = readProcessIdentity(child.pid!)!;
  const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  assert.equal(isProcessIdentityAlive(owner), false);
});

test("real scope preserves JSON stdio/env/cwd/argv and contains detached grandchildren", { timeout: 20000 }, async t => {
  const controller = new SystemdExecutionController();
  const record = controller.prepare("integration", 1);
  if (!record) { t.skip("Linux cgroup v2/systemd user scope unavailable"); return; }
  const directory = mkdtempSync(join(tmpdir(), "pi-execution-test-"));
  const marker = join(directory, "grandchild.pid");
  const code = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
    writeFileSync(${JSON.stringify(marker)}, String(child.pid)); child.unref();
    let buffer=''; process.stdin.on('data', data=>{
      buffer+=data; if(buffer.includes('\\n')) {
        process.stdout.write(JSON.stringify({input:buffer.trim(),cwd:process.cwd(),env:process.env.EXECUTION_TEST,arg:process.argv[1],pid:child.pid})+'\\n');
        process.exit(7);
      }
    });
  `;
  const launch = controller.wrap({ command: process.execPath, args: ["-e", code, "${EXECUTION_TEST}"], cwd: directory,
    env: { ...process.env, EXECUTION_TEST: "inherited" } }, record);
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "pipe", detached: true });
  const closed = once(child, "close"); let output = ""; let stderr = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { stderr += data; });
  child.stdin.end('{"request":"echo"}\n');
  try {
    const [status] = await closed;
    assert.equal(status, 7, stderr);
    const response = JSON.parse(output);
    assert.equal(response.input, '{"request":"echo"}');
    assert.equal(response.cwd, directory);
    assert.equal(response.env, "inherited");
    assert.equal(response.arg, "${EXECUTION_TEST}");
    const pid = Number(readFileSync(marker, "utf8"));
    const identity = readProcessIdentity(pid)!;
    assert.ok(identity);
    const group = execFileSync("systemctl", ["--user", "show", record.unit, "--property=ControlGroup", "--value"], { encoding: "utf8" }).trim();
    assert.ok(readFileSync(`/proc/${pid}/cgroup`, "utf8").includes(group));
    await controller.cleanup(record);
    // Zombies may persist under container PID 1 but cannot execute. The kernel's
    // recursive population bit is the authoritative no-executing-process proof.
    let populated = "";
    try { populated = readFileSync(`/sys/fs/cgroup${group}/cgroup.events`, "utf8"); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); }
    if (populated) assert.match(populated, /^populated 0$/m);
    await controller.cleanup(record); // idempotent after collection
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await controller.cleanup(record);
    rmSync(directory, { recursive: true, force: true });
  }
});
