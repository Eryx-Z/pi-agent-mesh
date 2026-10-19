import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import entry from "../pi-extension/subagents/index.ts";

// Exercise Pi's installed runtime, rather than inventing a second session_start
// without the shutdown that Pi emits before replacing a session.
for (const operation of ["new", "resume"] as const) {
  test(`Pi ${operation} awaits session_shutdown before creating the replacement`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-lifecycle-"));
    try {
      const events: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const sessionManager = SessionManager.create(dir, dir);
      const session = {
        sessionManager, sessionFile: sessionManager.getSessionFile(),
        abort: async () => { events.push("abort"); },
        dispose: () => { events.push("dispose"); },
        extensionRunner: {
          hasHandlers: (name: string) => name === "session_shutdown",
          emit: async (event: { type: string; reason: string }) => {
            events.push(`${event.type}:${event.reason}`);
            await gate;
            events.push("cleanup complete");
          },
        },
      };
      const runtime = new AgentSessionRuntime(session as any, { cwd: dir, agentDir: dir } as any, async options => {
        events.push(`replacement:${options.sessionStartEvent?.reason}`);
        return { session, services: { cwd: dir, agentDir: dir }, diagnostics: [] } as any;
      });
      const target = join(dir, "target.jsonl");
      writeFileSync(target, JSON.stringify({ type: "session", version: 3, id: "target", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
      const pending = operation === "new" ? runtime.newSession() : runtime.switchSession(target);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, ["abort", `session_shutdown:${operation}`]);
      release();
      await pending;
      assert.deepEqual(events, ["abort", `session_shutdown:${operation}`, "cleanup complete", "dispose", `replacement:${operation}`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("delegation schemas describe partial as the default and its explicit context requirement", async () => {
  const tools: any[] = [];
  await entry({ on() {}, registerTool: (tool: any) => tools.push(tool), registerCommand() {}, registerMessageRenderer() {}, registerToolRenderer() {} } as any);
  for (const name of ["subagent", "workflow_run"]) {
    const schema = tools.find(tool => tool.name === name).parameters;
    assert.match(schema.properties.context.description, /partial \(default\) requires contextText/);
    assert.match(schema.properties.contextText.description, /required for partial mode/);
    assert.match(schema.properties.contextText.description, /when context is omitted/);
    assert.ok(!schema.required.includes("context"));
    assert.ok(!schema.required.includes("contextText"));
  }
});
