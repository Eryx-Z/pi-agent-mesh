import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { finalTool } from "./fixtures/lifecycle-tools.ts";
import { resolveLoadout } from "../pi-extension/subagents/loadout.ts";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const provider = fileURLToPath(new URL("./fixtures/lifecycle-tools.ts", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(20); }
  throw new Error("Timed out waiting for real Pi lifecycle");
}
function setup(timeoutMs = 15000) {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-rpc-"));
  const results: string[] = [], events: any[] = [];
  let rpc: RpcProcess;
  const tools = [
    { ...finalTool, exposure: "direct" as const, sourceInfo: { path: provider, source: "extension", scope: "temporary" as const, origin: "top-level" as const } },
    { ...createBashToolDefinition(dir), exposure: "direct" as const, sourceInfo: { path: "<builtin:bash>", source: "builtin", scope: "temporary" as const, origin: "top-level" as const } },
  ];
  const loadout = resolveLoadout({ getActiveTools: () => tools.map(t => t.name), getAllTools: () => tools }, [], dir, "lifecycle-fixture/test", "off", dir);
  const manager = new TaskManager(new TaskStore(dir), {
    command: process.execPath, baseArgs: [cli],
    createRpc: launch => {
      rpc = new RpcProcess({ ...launch, env: { ...launch.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } }, timeoutMs, 500);
      rpc.on("event", event => events.push(event));
      return rpc;
    },
    notify: (r, kind) => { if (kind === "result") results.push(r.state); },
  });
  return { dir, manager, loadout, results, events, get rpc() { return rpc; }, async clean() { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("real Pi aborts builtin bash before delayed extension shutdown and never writes its marker", { timeout: 30000, skip: process.platform === "win32" }, async () => {
  const t = setup();
  try {
    const record = await t.manager.launch({ task: "BASH", access: "full", context: "none", loadout: t.loadout });
    await until(() => existsSync(join(t.dir, "started")));
    await t.manager.cancel(record.id);
    assert.equal(record.stopped, true, record.error);
    assert.equal(record.state, "cancelled");
    assert.ok(t.events.some(e => e.type === "tool_execution_end" && e.toolName === "bash" && e.isError));
    await sleep(3200);
    assert.equal(existsSync(join(t.dir, "marker")), false, "Cancelled builtin bash must not survive Pi exit");
    const release = t.manager.store.lock(record.id); release();
  } finally { await t.clean(); }
});

test("real Pi handled input fails explicitly and cleans up without a model run or resubmission", { timeout: 30000 }, async () => {
  const t = setup();
  try {
    const record = await t.manager.launch({ task: "HANDLED", access: "full", context: "none", loadout: t.loadout });
    await until(() => record.stopped);
    assert.equal(record.state, "failed");
    assert.match(record.error!, /accepted.*no agent run started/);
    assert.equal(t.events.some(e => e.type === "agent_start"), false);
    assert.deepEqual(t.results, ["failed"]);
    const release = t.manager.store.lock(record.id); release();
  } finally { await t.clean(); }
});

test("real Pi terminating tool completes exactly once without another assistant turn", { timeout: 30000 }, async () => {
  const t = setup();
  try {
    const record = await t.manager.launch({ task: "TERMINATE", access: "full", context: "none", loadout: t.loadout });
    await until(() => record.stopped);
    assert.equal(record.state, "completed", record.error);
    assert.equal(record.output, "Finished through tool");
    assert.deepEqual(t.results, ["completed"]);
    const assistants = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(s => JSON.parse(s)).filter(e => e.message?.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].message.stopReason, "toolUse");
    assert.ok(t.events.some(e => e.type === "tool_execution_end" && e.result.terminate === true && !e.isError));
  } finally { await t.clean(); }
});

for (const { hook, timeout } of [{ hook: "INPUT", timeout: false }, { hook: "BEFORE", timeout: false }, { hook: "BEFORE", timeout: true }]) test(`real Pi ${timeout ? "timeout" : "cancellation"} during gated ${hook} preflight never confirms cleanup from an idle abort`, { timeout: 30000, skip: process.platform === "win32" }, async () => {
  const t = setup(timeout ? 3000 : 15000);
  try {
    const launch = t.manager.launch({ task: `GATED_${hook}_BASH`, access: "full", context: "none", loadout: t.loadout })
      .then(() => undefined, error => error as Error);
    await until(() => existsSync(join(t.dir, "preflight-entered")));
    assert.equal((await t.rpc.request("get_state")).isStreaming, false, "Pi reports idle while awaiting prompt hooks");
    const record = [...t.manager.records.values()][0];
    const cancelled = timeout ? Promise.resolve(undefined) : t.manager.cancel(record.id).then(() => undefined, error => error as Error);
    await until(() => existsSync(join(t.dir, "shutdown-started")));
    await assert.rejects(t.rpc.request("prompt", { message: "new work" }), /stopping/);
    assert.throws(() => t.rpc.send({ type: "prompt", message: "raw new work" }), /stopping/);
    // Resume the suspended prompt only AFTER shutdown has begun. A late receipt
    // here must not retroactively validate the earlier idle/abort acknowledgement.
    writeFileSync(join(t.dir, "release-preflight"), "");
    await until(() => existsSync(join(t.dir, "started")));
    const cancelError = await cancelled;
    const launchError = await launch;
    // Let this deliberately surviving foreground fixture finish before teardown.
    await until(() => existsSync(join(t.dir, "marker")));
    if (!timeout) {
      assert.ok(cancelError instanceof Error, "Cancellation must not claim successful shutdown");
      assert.match(cancelError.message, /could not confirm shutdown/);
    }
    assert.ok(launchError instanceof Error);
    assert.match(launchError.message, timeout ? /timed out.*unknown/ : /stopping/);
    assert.equal(record.state, timeout ? "failed" : "cancelled");
    assert.equal(record.stopped, false);
    assert.throws(() => t.manager.store.lock(record.id), /locked/);
    assert.equal(JSON.parse(readFileSync(t.manager.store.path(record.id), "utf8")).stopped, false);
    assert.deepEqual(t.results, [timeout ? "failed" : "cancelled"]);
  } finally { await t.clean(); }
});

test('real Pi late preflight receipt before shutdown allows abort confirmation without waiting for model completion', { timeout: 30000, skip: process.platform === 'win32' }, async () => {
  const t = setup();
  try {
    const launch = t.manager.launch({ task: 'GATED_INPUT_BASH', access: "full", context: 'none', loadout: t.loadout })
      .then(() => undefined, error => error as Error);
    await until(() => existsSync(join(t.dir, 'preflight-entered')));
    const record = [...t.manager.records.values()][0];
    const cancelled = t.manager.cancel(record.id);
    await until(() => record.activity === 'stopping process');
    writeFileSync(join(t.dir, 'release-preflight'), '');
    await cancelled;
    assert.ok((await launch) instanceof Error, 'The original caller remains rejected even after a late receipt');
    assert.equal(record.state, 'cancelled');
    assert.equal(record.stopped, true, record.error);
    const release = t.manager.store.lock(record.id); release();
    await sleep(3200);
    assert.equal(existsSync(join(t.dir, 'marker')), false);
    assert.deepEqual(t.results, ['cancelled']);
  } finally { await t.clean(); }
});
