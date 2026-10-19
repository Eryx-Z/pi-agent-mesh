import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const extension = fileURLToPath(new URL("./fixtures/m0-mcp-extension.ts", import.meta.url));
const server = fileURLToPath(new URL("./fixtures/m0-mcp-server.mjs", import.meta.url));
const longName = "long_" + "x".repeat(90);
type Report = { ready?: boolean; failure?: string; deadline: number; finishedAt: number; tools: (ToolInfo & { label: string })[]; active: string[] };
function lines(path: string): any[] { return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; }
async function until<T>(get: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) { const result = get(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("M0 fixture did not settle");
}
async function openProbe(options: { delayMs?: number; http?: boolean; httpDelayMs?: number; missing?: boolean; noExtensions?: boolean; broken?: boolean; restrictCli?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "m0-mcp-"));
  const agent = join(dir, "agent");
  const log = join(dir, "server.jsonl");
  const reportPath = join(dir, "report.json");
  const requests = join(dir, "requests.jsonl");
  const events = join(dir, "events.txt");
  const stdio = (id: string, delayMs = 0) => ({ command: process.execPath, args: [server, JSON.stringify({ id, log, delayMs })], timeout: 5 });
  let http: ChildProcessWithoutNullStreams | undefined;
  let rpc: RpcProcess | undefined;
  try {
    mkdirSync(agent);
    mkdirSync(join(dir, ".pi"));
    // Trust is explicitly granted: absence of these connections proves replacement, not trust suppression.
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { ambient: stdio("ambient"), selected: stdio("ambient-same-name") } }));
    writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project: stdio("project"), selected: stdio("project-same-name") } }));
    const selected: Record<string, string[]> = { selected: options.missing ? ["missing"] : ["echo", "a-b", "a_b", longName] };
    const servers: McpServerEntry[] = [{ name: "selected", source: extension, scope: "extension", config: { ...stdio("selected", options.delayMs), exposure: "hidden", toolExposure: Object.fromEntries(selected.selected.map(name => [name, "direct"])) } }];
    if (options.broken) servers[0].config = { command: join(dir, "does-not-exist"), exposure: "hidden", toolExposure: { echo: "direct" } };
    if (options.http) {
      http = spawn(process.execPath, [server, JSON.stringify({ id: "http", log, http: true, delayMs: options.httpDelayMs ?? 0 })], { stdio: "pipe" });
      const [data] = await once(http.stdout, "data");
      const { url } = JSON.parse(data.toString());
      selected.remote = ["echo"];
      servers.push({ name: "remote", source: extension, scope: "extension", config: { url, headers: { Authorization: "Bearer fixture" }, exposure: "hidden", toolExposure: { echo: "direct" }, timeout: 5 } });
    }
    const configPath = join(dir, "probe.json");
    writeFileSync(configPath, JSON.stringify({ servers, selected, unwanted: { name: "registered", config: stdio("registered"), source: extension }, report: reportPath, requests, events }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, M0_MCP_CONFIG: configPath, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    rpc = new RpcProcess({ command: process.execPath, cwd: dir, env, args: [cli, "--mode", "rpc", "--session", join(dir, "session.jsonl"), "--approve", "--no-skills", "--no-context-files", "--no-prompt-templates", ...(options.noExtensions ? ["--no-extensions"] : []), ...(options.restrictCli ? ["--tools", "read"] : []), "--model", "m0-mcp/test", "--thinking", "off", "-e", extension] }, 1350, 1500);
    const errors: unknown[] = [];
    rpc.on("event", event => { if (event.type === "extension_error") errors.push(event); });
    // Scale the ordinary 15s deadline to 1350ms (30s readiness becomes 2700ms).
    // The delayed success case takes 1800ms, beyond this ordinary deadline.
    // Startup and readiness explicitly get their own communication budget.
    await rpc.request("get_state", {}, { timeoutMs: 5000 });
    const command = (message: string, timeoutMs = 5000) => rpc!.request("prompt", { message }, { timeoutMs });
    const report = () => JSON.parse(readFileSync(reportPath, "utf8")) as Report;
    const preflight = async (budgetMs: number) => {
      const deadline = Date.now() + budgetMs;
      // Native wait and inventory share the same absolute deadline, RPC gets communication margin.
      await command(`/m0-preflight ${deadline}`, Math.max(1, deadline - Date.now()) + 1000);
      return report();
    };
    const guardedPrompt = async (budgetMs: number, message: string) => {
      const result = await preflight(budgetMs);
      // RPC success is not readiness: extension commands swallow handler exceptions.
      // Only the actual inventory sidecar permits submitting the real task.
      if (result.ready) await command(message);
      return result;
    };
    const close = async () => {
      try {
        await rpc!.stop();
        assert.equal(rpc!.exited, true);
        for (const entry of lines(log).filter(entry => entry.event === "start" && entry.id !== "http")) {
          assert.throws(() => process.kill(entry.pid, 0), (error: any) => error.code === "ESRCH", `stdio pid ${entry.pid} survived Pi shutdown`);
          assert.ok(lines(log).some(stopped => stopped.event === "stop" && stopped.pid === entry.pid), "stdio fixture did not observe shutdown");
        }
      } finally {
        if (http && http.exitCode === null) { const exited = once(http, "exit"); http.kill("SIGTERM"); await exited; }
        rmSync(dir, { recursive: true, force: true });
      }
    };
    return { rpc, dir, log, requests, events, errors, selected, httpPid: http?.pid, command, preflight, guardedPrompt, report, close };
  } catch (error) {
    await rpc?.stop().catch(() => {});
    if (http && http.exitCode === null) { const exited = once(http, "exit"); http.kill("SIGTERM"); await exited; }
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function assertIsolation(probe: Awaited<ReturnType<typeof openProbe>>) {
  assert.deepEqual([...new Set(lines(probe.log).map(entry => entry.id))].sort(), Object.keys(probe.selected).map(name => name === "remote" ? "http" : name).sort());
  const events = readFileSync(probe.events, "utf8");
  assert.match(events, /filtered-getMcpServers/);
  assert.match(events, /filtered-mcp_servers_change:[1-9]/);
  assert.deepEqual(probe.errors, []);
}

test("M0 real MCP wrapper replaces builtin, filters both registration paths, discovers exact names and HTTP/stdio tools", { timeout: 20000 }, async () => {
  const probe = await openProbe({ delayMs: 1200, http: true }); // Deliberately no --no-extensions.
  try {
    const started = Date.now();
    await probe.command("/mcp");
    assert.ok(Date.now() - started >= 600, "/mcp did not wait for pending tools/list");
    assert.equal(lines(probe.requests).length, 0, "/mcp must not be a model task");
    await probe.command("/m0-inventory");
    const discovered = probe.report();
    // Role-only fallback: no CLI --tools restriction during discovery; the parent sends
    // no model prompt until preflight freezes an exact active list from actual inventory.
    const result = await probe.preflight(2000);
    assert.equal(result.ready, true, result.failure);
    const direct = result.tools.filter(tool => tool.exposure === "direct" && tool.name.startsWith("mcp__"));
    assert.equal(direct.length, 5);
    assert.deepEqual(direct.map(tool => tool.label).sort(), ["selected/echo", "selected/a-b", "selected/a_b", `selected/${longName}`, "remote/echo"].sort());
    assert.equal(new Set(direct.map(tool => tool.name)).size, direct.length);
    for (const tool of direct) {
      assert.match(tool.name, /^[A-Za-z0-9_]{1,64}$/);
      assert.equal(tool.sourceInfo.source, "cli"); // Actual wrapper source, not an invented source="mcp".
      assert.equal(tool.sourceInfo.path, extension);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    for (const raw of ["a-b", "a_b"]) assert.match(direct.find(tool => tool.label === `selected/${raw}`)!.name, /^mcp__selected__a_b_[a-f0-9]{8}$/);
    assert.equal(direct.find(tool => tool.label === `selected/${longName}`)!.name.length, 64);
    assert.deepEqual(result.active.sort(), direct.map(tool => tool.name).sort());
    assert.ok(discovered.active.includes("read"));
    assert.ok(direct.every(tool => discovered.active.includes(tool.name)), "Pi dynamic direct registration behavior changed");
    const hidden = result.tools.filter(tool => tool.label?.endsWith("/unselected"));
    assert.equal(hidden.length, 2);
    assert.ok(hidden.every(tool => tool.exposure === "hidden"));
    assert.ok(!result.active.some(name => ["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name)));
    for (const serverName of ["selected", "remote"]) {
      const name = direct.find(tool => tool.label === `${serverName}/echo`)!.name;
      await probe.command(`CALL ${name}`);
      await until(() => lines(probe.log).find(entry => entry.event === "tools/call" && entry.id === (serverName === "remote" ? "http" : serverName)));
      await until(() => lines(probe.requests).length >= (serverName === "selected" ? 2 : 4) ? true : undefined);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await probe.rpc.request("get_state")).isStreaming) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal((await probe.rpc.request("get_state")).isStreaming, false);
    }
    for (const request of lines(probe.requests)) assert.deepEqual(request.tools.sort(), result.active.sort());
    assertIsolation(probe);
    // Explicit stop closes this session's HTTP client, not the remote HTTP server.
    await probe.rpc.stop();
    assert.ok(lines(probe.log).some(entry => entry.event === "http-close"));
    assert.doesNotThrow(() => process.kill(probe.httpPid!, 0), "Closing a task's HTTP client must not stop the remote server");
  } finally { await probe.close(); }
});

test("M0 shared absolute readiness deadline accepts scaled 20/30 timing with native pending wait", { timeout: 15000 }, async () => {
  const probe = await openProbe({ delayMs: 1200, http: true, httpDelayMs: 1800, noExtensions: true });
  try {
    const result = await probe.preflight(2700);
    assert.equal(result.ready, true, result.failure);
    assert.ok(result.finishedAt <= result.deadline);
    assert.equal(lines(probe.requests).length, 0);
    assertIsolation(probe);
  } finally { await probe.close(); }
});

for (const scenario of ["deadline", "missing", "connection", "cli-filter"] as const) {
  test(`M0 ${scenario} failure sends zero model requests and cleans stdio child`, { timeout: 15000 }, async () => {
    const probe = await openProbe({ delayMs: scenario === "deadline" ? 5000 : 0, missing: scenario === "missing", broken: scenario === "connection", restrictCli: scenario === "cli-filter", noExtensions: true });
    try {
      const result = await probe.guardedPrompt(scenario === "deadline" ? 700 : 2500, "REAL TASK MUST NOT REACH PROVIDER");
      assert.equal(result.ready, false);
      assert.match(result.failure!, scenario === "deadline" ? /deadline expired/ : /Missing required MCP tool/);
      if (scenario === "deadline") {
        assert.ok(result.finishedAt - result.deadline < 400, "native 5s request timeout extended readiness deadline");
        assert.ok(lines(probe.log).some(entry => entry.id === "selected" && entry.event === "tools/list"), "deadline must interrupt a real in-flight MCP connection");
      }
      assert.equal(lines(probe.requests).length, 0);
      if (scenario === "cli-filter") {
        assert.ok(lines(probe.log).some(entry => entry.event === "tools/list"));
        assert.deepEqual(result.tools.map(tool => tool.name), ["read"], "CLI allowlist must remain a hard registry filter");
      }
      assert.deepEqual(probe.errors, []);
    } finally { await probe.close(); }
  });
}
