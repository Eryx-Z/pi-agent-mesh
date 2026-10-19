import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import entry from '../pi-extension/subagents/index.ts';
import { TaskStore, type TaskRecord } from '../pi-extension/subagents/store.ts';
import { loadout } from './fixtures/loadout.ts';

test('control list uses current time rather than array indexes for active tasks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'control-list-'));
  const now = 1_700_000_000_000;
  const records = ['running', 'waiting'].map((state, index) => ({
    version: 2, id: `00000000-0000-0000-0000-00000000000${index}`, name: `task-${index}`,
    task: 'test', access: 'read-only', context: 'none', loadout: loadout(dir), state,
    startedAt: now - (65 + index * 60) * 1000, updatedAt: now,
    sessionFile: join(dir, `${index}.jsonl`), output: '', activity: state,
    log: [], questions: [], stopped: false, run: 1,
  } as TaskRecord));
  t.mock.method(Date, 'now', () => now);
  t.mock.method(TaskStore.prototype, 'load', () => records);
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const emit = async (name: string, ...args: any[]) => { for (const handler of handlers.get(name) ?? []) await handler(...args); };
  const tools: any[] = [];
  await entry({
    on: (name: string, handler: (...args: any[]) => any) => { const all = handlers.get(name) ?? []; all.push(handler); handlers.set(name, all); return () => {}; },
    getSettings: () => ({ extensions: ['-builtin:mcp'] }),
    registerTool: (tool: any) => tools.push(tool), registerCommand() {}, registerMessageRenderer() {}, registerToolRenderer() {},
  } as any);
  try {
    await emit('session_start', {}, {
      cwd: dir, hasUI: false, ui: { setWidget() {}, notify() {}, setStatus() {} },
      sessionManager: {
        getSessionFile: () => join(dir, 'parent.jsonl'),
        getSessionDir: () => dir, getSessionId: () => 'parent', getBranch: () => [],
      },
    });
    const result = await tools.find(tool => tool.name === 'subagent_control').execute('call', { action: 'list' });
    assert.match(result.content[0].text, /task-0 .*running · 1m 5s/);
    assert.match(result.content[0].text, /task-1 .*waiting · 2m 5s/);
  } finally {
    await emit('session_shutdown');
    rmSync(dir, { recursive: true, force: true });
  }
});
