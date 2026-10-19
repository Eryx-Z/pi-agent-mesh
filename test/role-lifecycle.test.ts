import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import entry from "../pi-extension/subagents/index.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { loadout } from "./fixtures/loadout.ts";

test("session shutdown stops managed children while PM authentication is pending, but awaits auth before replacement", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "role-shutdown-auth-"));
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi/agent-mesh.yaml"), "schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: builtin:pm}\n");
  const fake = fileURLToPath(new URL("./fixtures/fake-rpc.mjs", import.meta.url));
  const manager = new TaskManager(new TaskStore(join(dir, "tasks")), {
    command: process.execPath, createRpc: launch => new RpcProcess({ ...launch, args: [fake] }, 1000, 100),
  });
  let releaseAuth!: (result: boolean) => void;
  const auth = new Promise<boolean>(resolve => { releaseAuth = resolve; });
  let authenticating = false;
  const handlers = new Map<string, ((...args: any[]) => unknown)[]>();
  const api: any = {
    on(name: string, handler: (...args: any[]) => unknown) { const all = handlers.get(name) ?? []; all.push(handler); handlers.set(name, all); return () => {}; },
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerToolRenderer() {},
    getSettings: () => ({ extensions: ["-builtin:mcp"] }), getActiveTools: () => [], getAllTools: () => [],
    setActiveTools() {}, setModel() { authenticating = true; return auth; }, setThinkingLevel() {}, appendEntry() {}, events: { emit() {} },
  };
  const model = { provider: "fixture", id: "pm", reasoning: false };
  const ctx: any = { cwd: dir, model, thinkingLevel: "off", modelRegistry: { find: () => model }, isProjectTrusted: () => true,
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: { getBranch: () => [], getSessionFile: () => join(dir, "parent.jsonl"), getSessionDir: () => dir, getSessionId: () => "parent" },
  };
  const original = TaskManager.open;
  TaskManager.open = async () => manager;
  const emit = async (name: string, ...args: any[]) => { for (const handler of handlers.get(name) ?? []) await handler(...args); };
  let startup: Promise<void> | undefined, shutdown: Promise<void> | undefined;
  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 1000;
    while (!check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  try {
    const task = await manager.launch({ task: "SCENARIO_HOLD", context: "none", access: "full", loadout: loadout(dir) });
    await entry(api);
    startup = emit("session_start", {}, ctx);
    await until(() => authenticating, "PM authentication did not start");
    assert.equal(manager.isLive(task.id), true);
    let acknowledged = false;
    shutdown = emit("session_shutdown").then(() => { acknowledged = true; });
    await until(() => task.stopped, "Pending PM auth must not postpone managed-child shutdown");
    assert.equal(manager.isLive(task.id), false);
    assert.equal(acknowledged, false, "Session replacement must still await the noncancellable native auth operation");
    releaseAuth(false);
    await shutdown;
    assert.equal(acknowledged, true);
  } finally {
    releaseAuth(false);
    await Promise.allSettled([startup, shutdown]);
    await manager.shutdown(); TaskManager.open = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
