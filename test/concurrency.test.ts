import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore, type TaskRecord } from '../pi-extension/subagents/store.ts';
import { WorkflowManager } from '../pi-extension/subagents/workflows.ts';
import { loadout } from './fixtures/loadout.ts';

for (const maxConcurrent of [undefined, 2]) {
  test(`task capacity respects ${maxConcurrent === undefined ? 'default 16' : 'explicit 2'} and counts unconfirmed records`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concurrency-'));
    const tasks = new TaskManager(new TaskStore(dir), { command: process.execPath, maxConcurrent });
    try {
      const limit = maxConcurrent ?? 16;
      for (let i = 0; i < limit; i++) {
        assert.equal(tasks.hasCapacity(), true);
        const record: TaskRecord = {
          version: 2, id: `task-${i}`, name: `task-${i}`, task: 'held task', access: 'read-only', context: 'none',
          loadout: loadout(dir), state: 'failed', startedAt: 0, updatedAt: 0,
          sessionFile: join(dir, `task-${i}.jsonl`), output: '', activity: 'unconfirmed shutdown',
          log: [], questions: [], stopped: false, run: 1,
        };
        tasks.records.set(record.id, record);
      }
      assert.equal(tasks.hasCapacity(), false);
      await assert.rejects(tasks.launch({ task: 'extra', access: 'read-only', context: 'none', loadout: loadout(dir) }), /concurrency limit/);
      tasks.get('task-0').stopped = true;
      assert.equal(tasks.hasCapacity(), true);
    } finally {
      tasks.records.clear();
      await tasks.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('new workflows default to 8, explicit limits and persisted limits remain unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-concurrency-'));
  const tasks = new TaskManager(new TaskStore(dir), { command: process.execPath });
  const workflows = new WorkflowManager(tasks, join(dir, 'workflows'));
  let restored: WorkflowManager | undefined;
  try {
    const input = { context: 'none' as const, loadout: loadout(dir),
      steps: [{ id: 'reader', task: 'read', access: 'read-only' as const, dependsOn: [] }] };
    const defaults = workflows.launch(input);
    workflows.pause(defaults.id);
    assert.equal(defaults.maxParallel, 8);
    const explicit = workflows.launch({ ...input, maxParallel: 3 });
    workflows.pause(explicit.id);
    assert.equal(explicit.maxParallel, 3);
    await workflows.shutdown();
    restored = new WorkflowManager(tasks, join(dir, 'workflows'));
    assert.equal(restored.get(defaults.id).maxParallel, 8);
    assert.equal(restored.get(explicit.id).maxParallel, 3);
    assert.equal(tasks.records.size, 0);
  } finally {
    await restored?.shutdown();
    await workflows.shutdown();
    await tasks.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
