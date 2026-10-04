import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { taskMenu, widget, resultRenderer, TaskWidget, clean, detail, taskSummary, createDashboardContent } from "../pi-extension/subagents/ui.ts";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function setup() {
  const record: any = { id: "task-id", name: "auth work", state: "running", loadout: { cwd: "/project" }, context: "partial", run: 1, access: "full", sessionFile: "/tmp/session.jsonl", task: "fix auth", startedAt: Date.now(), updatedAt: Date.now(), activity: "read: auth.ts", output: "working", log: [], questions: [] };
  const calls: any[] = [], notices: string[] = [];
  const manager: any = {
    records: new Map([[record.id, record]]),
    get(id: string) { assert.ok(id === record.id || id === record.name); return record; },
    message: async (...args: unknown[]) => calls.push(["message", ...args]),
    answer: (...args: unknown[]) => calls.push(["answer", ...args]),
    cancel: async (...args: unknown[]) => calls.push(["cancel", ...args]),
    continue: async (...args: unknown[]) => calls.push(["continue", ...args]),
  };
  const selections: string[] = [], dialogs: any[] = [];
  const ctx: any = { hasUI: true, mode: "tui", ui: {
    select: async (...args: unknown[]) => { dialogs.push(args); return selections.shift(); }, editor: async () => "extra requirement",
    confirm: async () => true, notify: (text: string) => notices.push(text),
    setWidget: (...args: unknown[]) => calls.push(["widget", ...args]),
  } };
  return { record, manager, ctx, calls, notices, selections, dialogs };
}

test("task menu accepts an explicit name containing spaces and sends instructions", async () => {
  const t = setup(); t.selections.push("Message");
  await taskMenu(t.manager, t.ctx, "auth work");
  assert.deepEqual(t.calls, [["message", "task-id", "extra requirement"]]);
  assert.match(t.notices[0], /not yet proven executed/);
});
test("task menu routes correlated answers and avoids empty question dialogs", async () => {
  const t = setup(); t.selections.push("Answer question");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.deepEqual(t.notices, ["No unanswered questions"]);
  t.record.questions.push({ id: "q-id", title: "Which interface?" });
  t.selections.push("Answer question", "q-id Which interface?");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.deepEqual(t.calls, [["answer", "task-id", "q-id", "extra requirement"]]);
});
test("task menu controls cancellation and explicit continuation", async () => {
  const t = setup(); t.selections.push("Cancel");
  await taskMenu(t.manager, t.ctx, "task-id");
  t.selections.push("Continue", "read-only");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.deepEqual(t.calls, [["cancel", "task-id"], ["continue", "task-id", "extra requirement", "read-only"]]);
});
test("widget updates activity and headless mode has no terminal requirements", async () => {
  const t = setup(), display = new TaskWidget(); widget(t.manager, t.ctx, display);
  assert.equal(t.calls[0][1], "rpc-subagents");
  assert.equal(typeof t.calls[0][2], "function");
  const theme: any = { fg: (_color: string, text: string) => text };
  const component = t.calls[0][2]({}, theme);
  assert.match(component.render(80).join("\n"), /┌─ Subagents · 1 running.*\n│ ● auth work.*read: auth.ts/);
  t.record.activity = "bash: npm test"; widget(t.manager, t.ctx, display);
  assert.match(component.render(80).join("\n"), /bash: npm test/);
  t.ctx.hasUI = false;
  const count = t.calls.length; widget(t.manager, t.ctx, display); assert.equal(t.calls.length, count);
  await assert.rejects(taskMenu(t.manager, t.ctx), /headless/);
});
test("terminal summaries expire after eight seconds without deleting history or replaying it", () => {
  const t = setup(), display = new TaskWidget();
  t.record.state = "failed"; t.record.stopped = true;
  assert.equal(display.lines([t.record], 100), undefined, "loaded history stays hidden");
  display.result(t.record, 100);
  assert.match(display.lines([t.record], 8099)![0], /1 failed/);
  assert.equal(display.lines([t.record], 8100), undefined);
  assert.equal(display.lines([t.record], 20000), undefined);
  assert.equal(t.manager.records.size, 1);
  assert.equal(new TaskWidget().lines([t.record], 200), undefined, "new session does not replay results");
});
test("questions persist until answered and unconfirmed shutdowns never auto-hide", () => {
  const t = setup(), display = new TaskWidget();
  t.record.state = "waiting";
  t.record.questions = [{ id: "q", title: "Which interface?" }];
  assert.match(display.lines([t.record], 90000)!.join("\n"), /awaiting answer/);
  assert.match(display.lines([t.record], 90000)!.join("\n"), /\? auth work · Which interface\?/);
  t.record.questions[0].responseSent = true;
  assert.match(display.lines([t.record], 90001)![0], /1 running/);
  assert.doesNotMatch(display.lines([t.record], 90001)!.join("\n"), /Which interface/);
  t.record.state = "failed"; t.record.stopped = false;
  display.result(t.record, 90002);
  assert.match(display.lines([t.record], 200000)!.join("\n"), /shutdown unconfirmed/);
  t.record.stopped = true;
  assert.equal(display.lines([t.record], 200001), undefined);
});
test("a new run remains visible after older results expire", () => {
  const t = setup(), display = new TaskWidget();
  t.record.state = "completed"; t.record.stopped = true;
  display.result(t.record, 100);
  t.record.state = "running"; t.record.stopped = false;
  assert.match(display.lines([t.record], 9000)![0], /1 running/);
  assert.match(display.lines([t.record], 9000)![1], /auth work/);
  t.record.state = "completed"; t.record.stopped = true;
  display.result(t.record, 10000);
  assert.match(display.lines([t.record], 17999)![0], /1 completed/);
  assert.equal(display.lines([t.record], 18000), undefined);
});

test("result renderer preserves collapse and safely fits narrow CJK terminals", () => {
  const content = "Subagent auth completed\n" + ["中文🙂 ".repeat(20), "second", "third", "fourth", "hidden tail"].join("\n");
  const collapsed = resultRenderer({ content }, { expanded: false });
  assert.match(collapsed.render(80).join("\n"), /Subagents ─ Subagent auth completed/);
  assert.doesNotMatch(collapsed.render(80).join("\n"), /hidden tail/);
  assert.match(collapsed.render(80).join("\n"), /expand for full report/);
  const expanded = resultRenderer({ content }, { expanded: true, outputPad: 3 });
  assert.match(expanded.render(80).join("\n"), /hidden tail/);
  for (const component of [collapsed, expanded]) {
    assert.deepEqual(component.render(0), []);
    for (const width of [1, 2, 3, 8, 20, 80]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    }
  }
});

test("empty and historical widget state clears the installed widget", () => {
  const t = setup(), display = new TaskWidget();
  t.manager.records.clear();
  assert.equal(display.lines([], 0), undefined);
  widget(t.manager, t.ctx, display);
  assert.deepEqual(t.calls.at(-1), ["widget", "rpc-subagents", undefined]);
  t.record.state = "completed"; t.record.stopped = true;
  t.manager.records.set(t.record.id, t.record);
  widget(t.manager, t.ctx, display);
  assert.deepEqual(t.calls.at(-1), ["widget", "rpc-subagents", undefined]);
});

test("RPC widget uses only text and CJK-aware bounded fallback", () => {
  const t = setup(), display = new TaskWidget();
  t.ctx.mode = "rpc";
  t.record.name = "中文".repeat(100);
  widget(t.manager, t.ctx, display);
  const lines = t.calls.at(-1)[2];
  assert.ok(Array.isArray(lines));
  assert.deepEqual(lines, display.lines([...t.manager.records.values()])!.map(line => truncateToWidth(line, 150)));
  assert.equal(lines[0], "Subagents ─ 1 running · /subagents");
  assert.ok(lines[1].startsWith("● "));
  for (const line of lines) assert.ok(visibleWidth(line) <= 150);
});

test("widget bounds previews, retains attention, and refreshes theme colors", () => {
  const t = setup(), display = new TaskWidget();
  t.record.name = "中文🙂".repeat(50) + "\x1b[31mRED\x1b[0m\r\x07";
  t.record.activity = "\x1b]0;BAD-TITLE\x07read\nfile";
  for (let i = 0; i < 5; i++) t.manager.records.set(`task-${i}`, { ...t.record, id: `task-${i}`, name: `worker ${i}` });
  const unsafe = { ...t.record, id: "unsafe", name: "unsafe", state: "failed", stopped: false };
  t.manager.records.set(unsafe.id, unsafe);
  const lines = display.lines([...t.manager.records.values()])!;
  assert.equal(lines.filter(line => line.startsWith("●")).length, 3);
  assert.match(lines.join("\n"), /\+3 more active/);
  assert.match(lines.join("\n"), /shutdown unconfirmed/);
  widget(t.manager, t.ctx, display);
  let code = "31";
  const colors: string[] = [];
  const theme: any = { fg: (color: string, text: string) => { colors.push(color); return `\x1b[${code}m${text}\x1b[0m`; } };
  const component = t.calls.at(-1)[2]({}, theme);
  for (const width of [0, 1, 2, 3, 12, 40, 80]) {
    const rendered = component.render(width);
    for (const line of rendered) {
      assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(stripTerminalSequences(line), /BAD-TITLE|[\x00-\x1f\x7f-\x9f]/);
    }
  }
  assert.ok(colors.includes("accent")); assert.ok(colors.includes("warning"));
  code = "32"; component.invalidate();
  const refreshed = component.render(80).join("\n");
  assert.match(refreshed, /\x1b\[32m/);
  assert.doesNotMatch(refreshed, /\x1b\[31m/);
});

test("widget card emphasizes structured names and semantic counts without extra rows", testContext => {
  const t = setup(), display = new TaskWidget();
  testContext.mock.method(Date, "now", () => t.record.startedAt);
  t.record.name = "auth · 中文 [running]";
  t.record.questions = [{ id: "q", title: "Which interface?" }];
  t.record.state = "waiting";
  const unsafe = { ...t.record, id: "unsafe", name: "unsafe", state: "failed", stopped: false, questions: [] };
  t.manager.records.set(unsafe.id, unsafe);
  widget(t.manager, t.ctx, display);
  const styles: [string, string][] = [];
  const theme: any = { fg: (color: string, text: string) => { styles.push([color, text]); return text; } };
  const component = t.calls.at(-1)[2]({}, theme);
  const rendered = component.render(150);
  assert.equal(rendered.length, display.lines([...t.manager.records.values()])!.length);
  assert.deepEqual(rendered, [
    "┌─ Subagents · 1 awaiting answer · 1 shutdown unconfirmed · /subagents",
    "│ ? auth · 中文 [running] · 0s · read: auth.ts",
    "│ ! unsafe · shutdown unconfirmed — execution isolated — cleanup cannot be verified",
    "│ ? auth · 中文 [running] · Which interface?",
  ]);
  for (const pair of [
    ["accent", "Subagents"], ["warning", "1 awaiting answer"], ["warning", "1 shutdown unconfirmed"],
    ["text", t.record.name], ["warning", "?"], ["muted", " · 0s · read: auth.ts"],
  ]) assert.ok(styles.some(style => style[0] === pair[0] && style[1] === pair[1]), pair.join(": "));
});

test("widget result card uses success/error colors and vanishes at the original deadline", testContext => {
  const t = setup(), display = new TaskWidget();
  let now = 1000;
  testContext.mock.method(Date, "now", () => now);
  t.record.state = "completed"; t.record.stopped = true;
  display.result(t.record);
  widget(t.manager, t.ctx, display);
  const styles: [string, string][] = [];
  const theme: any = { fg: (color: string, text: string) => { styles.push([color, text]); return text; } };
  const component = t.calls.at(-1)[2]({}, theme);
  assert.deepEqual(component.render(80), ["┌─ Subagents · 1 completed · /subagents"]);
  assert.ok(styles.some(([color, text]) => color === "success" && text === "1 completed"));
  now = 8999;
  assert.equal(component.render(80).length, 1);
  now = 9000;
  assert.deepEqual(component.render(80), []);
  t.record.state = "failed";
  display.result(t.record);
  assert.deepEqual(component.render(80), ["┌─ Subagents · 1 failed · /subagents"]);
  assert.ok(styles.some(([color, text]) => color === "error" && text === "1 failed"));
  assert.equal(t.manager.records.size, 1);
});

test("RPC menu preserves task and question IDs as the first token", async () => {
  const t = setup(); t.ctx.mode = "rpc";
  t.record.name = "中文 auth\nwork";
  t.selections.push("task-id ● 中文 auth work · running", "Details");
  await taskMenu(t.manager, t.ctx);
  assert.match(t.dialogs[0][1][0], /^task-id ● 中文 auth work \[task-id\]/);
  t.record.questions.push({ id: "q-id", title: "Which\ninterface?" });
  t.selections.push("Answer question", "q-id ? Which interface?");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.equal(t.dialogs.at(-1)[1][0], "q-id ? Which interface?");
  assert.deepEqual(t.calls.at(-1), ["answer", "task-id", "q-id", "extra requirement"]);
});

test("details show the saved model, thinking level and complete parent task prompt", () => {
  const t = setup();
  t.record.loadout.model = "provider/child-model";
  t.record.loadout.thinking = "high";
  t.record.task = "Parent instruction:\n" + "完整任务说明\n".repeat(2000) + "PROMPT_END";
  for (const live of [false, true]) {
    const text = detail(t.record, live);
    assert.match(text, /Model: provider\/child-model · Thinking: high/);
    assert.ok(text.includes("── Task · Parent prompt ──"));
    assert.ok(text.includes(t.record.task), "parent task must not be truncated");
  }
});

test("Trace preserves complete session records and caches only the selected file per interaction", context => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-trace-"));
  const t = setup();
  t.record.sessionFile = join(dir, "child.jsonl");
  const long = "完整参数\n".repeat(2000) + "ARGUMENT_END";
  const entries = [
    { type: "session", id: "child", inherited: true },
    { type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "emitted thinking\nsecond line" },
      { type: "text", text: "first\nsecond" },
      { type: "toolCall", id: "call", name: "write", arguments: { content: long } },
    ] } },
    { type: "message", message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: long + "RESULT_END" }] } },
    { type: "custom", data: "\x1b]0;evil\x07VISIBLE\x00" },
  ];
  writeFileSync(t.record.sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const otherPath = join(dir, "other.jsonl");
  writeFileSync(otherPath, JSON.stringify({ type: "other", text: "OTHER_TRACE" }) + "\n");
  let parses = 0;
  const parse = JSON.parse;
  context.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => { parses++; return parse(...args); });
  try {
    const content = createDashboardContent();
    content.detail(t.record, "overview"); content.detail(t.record, "prompt"); content.detail(t.record, "activity");
    assert.equal(parses, 0, "non-Trace views never load transcripts");
    const text = content.detail(t.record, "trace");
    assert.match(text, /inherited context.*not hidden reasoning/);
    for (const entry of entries.slice(0, 3)) assert.ok(text.includes(JSON.stringify(entry, null, 2)), "no record fields or long values are truncated");
    assert.match(text, /VISIBLE/); assert.doesNotMatch(text, /evil|\\u001b|\\u0000|\x1b|\x00/);
    assert.equal(parses, entries.length);
    assert.equal(content.detail(t.record, "trace"), text);
    assert.equal(parses, entries.length, "unchanged contents are not reparsed");
    assert.equal(createDashboardContent().detail(t.record, "trace"), text);
    assert.equal(parses, entries.length * 2, "new interactions own a fresh cache");
    assert.match(content.detail({ ...t.record, sessionFile: otherPath }, "trace"), /OTHER_TRACE/);
    assert.equal(parses, entries.length * 2 + 1);
    content.detail(t.record, "trace");
    assert.equal(parses, entries.length * 3 + 1, "switching paths replaces the single cached file");
    appendFileSync(t.record.sessionFile, JSON.stringify({ type: "message", text: "APPENDED_RECORD" }) + "\n");
    assert.match(content.detail(t.record, "trace"), /APPENDED_RECORD/);
    assert.equal(parses, entries.length * 4 + 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Trace recovers from missing/unreadable files and retains malformed or partial JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-trace-errors-"));
  const t = setup(), content = createDashboardContent();
  t.record.sessionFile = join(dir, "child.jsonl");
  try {
    assert.match(content.detail(t.record, "trace"), /No session transcript yet/);
    assert.match(content.detail({ ...t.record, sessionFile: dir }, "trace"), /Cannot read session transcript/);
    writeFileSync(t.record.sessionFile, "");
    assert.match(content.detail(t.record, "trace"), /No session records yet/);
    writeFileSync(t.record.sessionFile, JSON.stringify({ text: "VALID" }) + '\n{broken}\n{"text":"PARTIAL');
    let text = content.detail(t.record, "trace");
    assert.match(text, /VALID/);
    assert.match(text, /Invalid or incomplete JSONL line 2 · raw/);
    assert.match(text, /\{broken\}/);
    assert.match(text, /Invalid or incomplete JSONL line 3 · raw/);
    assert.ok(text.includes('{"text":"PARTIAL'));
    appendFileSync(t.record.sessionFile, '_COMPLETE"}\n');
    text = content.detail(t.record, "trace");
    assert.match(text, /PARTIAL_COMPLETE/);
    assert.doesNotMatch(text, /Invalid or incomplete JSONL line 3/);
    appendFileSync(t.record.sessionFile, '{"text":"\x1b]0;raw-evil\x07SAFE_PARTIAL');
    text = content.detail(t.record, "trace");
    assert.match(text, /SAFE_PARTIAL/);
    assert.doesNotMatch(text, /raw-evil|\x1b|\x07/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshots have explicit sections and sanitize terminal controls", () => {
  const t = setup();
  t.record.name = "\x1b[31mauth\x1b[0m\nwork";
  t.record.error = "\x1b]0;evil\x07failure\x9b";
  t.record.output = "\x1b[2Jhello\x00\nworld";
  assert.equal(clean("\x1b[31mred\x1b[0m\t\n\x1b]0;title\x07\x9b"), "red\t\n");
  assert.doesNotMatch(taskSummary(t.record), /[\n\x1b]/);
  const snapshot = detail(t.record);
  for (const section of ["Run & access", "Task", "Error", "Questions", "Latest assistant text", "Recent activity"]) assert.ok(snapshot.includes(`── ${section}`));
  assert.match(snapshot, /hello\nworld/);
  assert.doesNotMatch(snapshot, /evil|[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  const component = resultRenderer({ content: t.record.output }, { expanded: true });
  assert.doesNotMatch(component.render(80).join("\n"), /\x1b|\x00/);
});
