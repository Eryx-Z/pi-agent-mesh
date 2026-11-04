import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import entry from "../pi-extension/subagents/index.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import type { TaskRecord } from "../pi-extension/subagents/store.ts";
import { resultRenderer } from "../pi-extension/subagents/ui.ts";

// Exercise extension registration and notification wiring without launching a child.
test("subagent notices carry compact metadata without changing model content or delivery", async t => {
  const dir = mkdtempSync(join(tmpdir(), "message-integration-"));
  const handlers = new Map<string, Function>();
  const renderers = new Map<string, Function>();
  const messages: { message: any; delivery: any }[] = [];
  let manager!: TaskManager;
  let notify!: (record: TaskRecord, kind: "question" | "result") => void;
  const open = TaskManager.open;
  t.mock.method(TaskManager, "open", async (store: Parameters<typeof open>[0], options: Parameters<typeof open>[1]) => {
    notify = options.notify!;
    manager = await open.call(TaskManager, store, options);
    return manager;
  });
  entry({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool() {}, registerCommand() {},
    registerMessageRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
    sendMessage: (message: any, delivery: any) => messages.push({ message, delivery }),
  } as any);
  const ctx = (session: string) => ({
    hasUI: false,
    ui: { setWidget() {} },
    sessionManager: {
      getSessionFile: () => join(dir, `${session}.jsonl`),
      getSessionDir: () => dir,
      getSessionId: () => session,
    },
  });
  try {
    await handlers.get("session_start")!({}, ctx("first"));
    const record: TaskRecord = {
      version: 2, task: "Repair", context: "none",
      loadout: { version: 2, tools: [], toolMetadata: [], extensions: [], skills: [], model: "provider/model", thinking: "medium", cwd: dir, agentDir: dir },
      id: "worker", name: "Repair agent", state: "waiting", run: 3,
      questions: [{ id: "old", title: "Old", responseSent: true }, { id: "pending", title: "Choose mode" }],
      output: "", sessionFile: "/child.jsonl", startedAt: Date.now(), updatedAt: Date.now(),
      activity: "Waiting", stopped: false, log: [],
    };
    manager.records.set(record.id, record);
    notify(record, "question");
    const question = messages[0];
    assert.deepEqual(question.message.details, {
      id: "worker", name: "Repair agent", state: "waiting", run: 3, questionIds: ["pending"],
    });
    assert.equal(question.message.content, "Subagent Repair agent (worker) needs an answer:\npending: Choose mode\nUse subagent_control action=answer with id, questionId, message.");
    assert.deepEqual(question.delivery, { deliverAs: "steer", triggerTurn: true });
    assert.equal(question.message.display, true);
    assert.equal(renderers.get("rpc_workflow_result"), resultRenderer);
    assert.notEqual(renderers.get("rpc_subagent_question"), resultRenderer);
    const { CustomMessageComponent } = await import(pathToFileURL(join(getPackageDir(), "dist/modes/interactive/components/custom-message.js")).href);
    const { initTheme } = await import(pathToFileURL(join(getPackageDir(), "dist/modes/interactive/theme/theme.js")).href);
    initTheme("dark", false);
    const component = new CustomMessageComponent(question.message, renderers.get("rpc_subagent_question"));
    const rendered = () => component.render(90).join("\n");
    assert.match(rendered(), /Awaiting answer/);
    record.questions[1].responseSent = true;
    assert.match(rendered(), /Answer sent/); // Same cached component, no rebuild.
    record.questions = [];
    assert.match(rendered(), /Answered/);
    record.state = "completed";
    assert.match(rendered(), /Completed/);
    record.run++;
    assert.match(rendered(), /Previous run/);
    record.run--;

    record.state = "failed";
    record.error = "Validation failed";
    record.recovery = { phase: "blocked", attempts: 1, error: "Recovery blocked" };
    record.output = "Human report " + "x".repeat(2000);
    notify(record, "result");
    const result = messages[1];
    assert.deepEqual(result.delivery, question.delivery);
    assert.equal(result.message.details.run, 3);
    assert.equal(result.message.details.name, "Repair agent");
    assert.equal(result.message.details.state, "failed");
    assert.equal(result.message.details.questionIds, undefined);
    assert.equal(result.message.details.summary.length, 1200);
    assert.match(result.message.details.summary, /^Validation failed\nRecovery blocked\nHuman report/);
    assert.match(result.message.content, /Stopping is not acceptance: review its validation and shared-workspace changes\.$/);
    assert.ok(result.message.content.includes(record.output));
    record.error = "terminated";
    record.output = "";
    notify(record, "result");
    assert.equal(messages[2].delivery.triggerTurn, false);
    assert.equal(messages[2].delivery.deliverAs, "steer");

    await handlers.get("session_shutdown")!();
    await handlers.get("session_start")!({}, ctx("second"));
    manager.records.set(record.id, { ...record, state: "waiting", questions: [{ id: "pending", title: "Different session" }] });
    assert.match(rendered(), /Subagents · Question/);
    assert.doesNotMatch(rendered(), /Awaiting answer|Failed/);
    const currentComponent = renderers.get("rpc_subagent_question")!(question.message, { expanded: false });
    assert.match(currentComponent.render(90).join("\n"), /Awaiting answer/);

    const persisted = { ...record, id: "12345678-1234-1234-1234-123456789abc", access: "full" as const,
      state: "completed" as const, stopped: true, questions: [], recovery: undefined };
    manager.store.save(persisted);
    await handlers.get("session_shutdown")!();
    await handlers.get("session_start")!({}, ctx("second"));
    const historical = { ...question.message, details: { ...question.message.details, id: persisted.id } };
    const reloaded = renderers.get("rpc_subagent_question")!(historical, { expanded: false });
    assert.match(reloaded.render(90).join("\n"), /Completed/);
  } finally {
    await handlers.get("session_shutdown")!();
    rmSync(dir, { recursive: true, force: true });
  }
});
