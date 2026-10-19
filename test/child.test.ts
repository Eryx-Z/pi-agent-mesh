import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bridge from "../pi-extension/subagents/child.ts";
import { loadout as makeLoadout, readInfo } from "./fixtures/loadout.ts";
import { CHILD_EXTENSION } from "../pi-extension/subagents/loadout.ts";
import entry from "../pi-extension/subagents/index.ts";

test('child question tool awaits RPC UI answer, respects abort and enforces sequential execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-'));
  const previous = process.env.PI_RPC_SUBAGENT_LOADOUT;
  const path = join(dir, 'loadout.json');
  writeFileSync(path, JSON.stringify(makeLoadout(dir)));
  process.env.PI_RPC_SUBAGENT_LOADOUT = path;
  try {
    const tools: any[] = [], handlers: Record<string, any> = {}, commands: Record<string, any> = {};
    let active: string[] = [];
    bridge({ registerTool: (t: any) => tools.push(t), registerCommand: (name: string, c: any) => commands[name] = c,
      on: (name: string, h: any) => handlers[name] = h, getAllTools: () => [readInfo(dir), {name: 'ask_question', sourceInfo: {path: CHILD_EXTENSION}}],
      setActiveTools: (t: string[]) => active = t, getActiveTools: () => active,
    } as any);
    handlers.session_start();
    const q = tools[0]; assert.equal(q.executionMode, 'sequential');
    assert.equal(q.exposure, 'model-only', 'Question bridge must not be callable by nested tools');
    let answer!: (value: string) => void;
    let completed = false;
    const pending = q.execute('tool-q', { question: 'Which?' }, undefined, undefined, {
      mode: 'rpc', ui: { input: () => new Promise<string>(r => answer = r) },
    }).then((r: any) => { completed = true; return r; });
    await new Promise(r => setTimeout(r, 10)); assert.equal(completed, false);
    answer('Choice A'); assert.equal((await pending).content[0].text, 'Choice A');
    await assert.rejects(q.execute('q', {question: 'Which?'}, AbortSignal.abort(), undefined, {mode: 'rpc', ui: { input: async () => undefined }}), /cancelled/);
    for (const toolName of ['subagent', 'workflow_run', 'workflow_control', 'bash', 'write']) assert.equal(handlers.tool_call({toolName}).block, true);
    await commands['rpc-subagent-preflight'].handler('', {model: {provider: 'fake', id: 'test'}, getSystemPromptOptions: () => ({skills: []})});
    assert.deepEqual(active, ['read', 'ask_question']);
    await assert.rejects(commands['rpc-subagent-preflight'].handler('', {model: {provider: 'other', id: 'model'}, getSystemPromptOptions: () => ({skills: []})}), /not selected/);
  } finally {
    if (previous === undefined) delete process.env.PI_RPC_SUBAGENT_LOADOUT; else process.env.PI_RPC_SUBAGENT_LOADOUT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('parent extension exposes discoverable control/UI; cannot register spawning in a child', async () => {
  const tools: any[] = [], commands: string[] = [], events: string[] = [];
  const api = { on: (name: string) => events.push(name), registerTool: (t: any) => tools.push(t), registerCommand: (name: string) => commands.push(name), registerMessageRenderer() {}, registerToolRenderer() {} } as any;
  await entry(api);
  assert.deepEqual(tools.map(t => t.name), ['roles_list', 'subagent', 'subagent_control', 'workflow_run', 'workflow_control']);
  assert.ok(commands.includes('roles'));
  assert.ok(commands.includes('subagents')); assert.ok(events.includes('session_shutdown'));
  const subagent = tools.find(t => t.name === 'subagent');
  assert.equal(subagent.parameters.properties.contextText.type, 'string');
  assert.equal(subagent.parameters.properties.agent, undefined);
  assert.equal(subagent.parameters.properties.ownership, undefined);
  assert.ok(!subagent.parameters.required.includes('access'), 'Role calls may use manifest access; non-role access is checked before launch');
  assert.equal(subagent.parameters.properties.role.type, 'string');
  assert.ok(commands.includes('workflows'));
  assert.equal(subagent.parameters.additionalProperties, false);
  const previous = process.env.PI_RPC_SUBAGENT_CHILD;
  process.env.PI_RPC_SUBAGENT_CHILD = '1';
  try { await entry({} as any); }
  finally { if (previous === undefined) delete process.env.PI_RPC_SUBAGENT_CHILD; else process.env.PI_RPC_SUBAGENT_CHILD = previous; }
});
