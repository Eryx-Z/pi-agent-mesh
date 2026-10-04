import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowManager, type WorkflowRecord } from '../pi-extension/subagents/workflows.ts';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../pi-extension/subagents/store.ts';
import { RpcProcess } from '../pi-extension/subagents/rpc.ts';
import { git } from '../pi-extension/subagents/workspaces.ts';
import { loadout } from './fixtures/loadout.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
async function until(fn: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('collection fixture timed out');
}

test('capture failure collects stopped successful siblings and does not block explicit retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-collection-')), repo = join(dir, 'repo');
  mkdirSync(repo);
  await git(repo, 'init'); writeFileSync(join(repo, 'base.txt'), 'base');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const tasks = new TaskManager(new TaskStore(join(dir, 'tasks')), { command: process.execPath,
    createRpc: l => new RpcProcess({ ...l, args: [fake] }, 3000, 1000) });
  const workflows = new WorkflowManager(tasks, join(dir, 'workflows'));
  const internals = workflows as unknown as { schedule(): void; pump?: Promise<void> };
  const schedule = internals.schedule.bind(workflows);
  try {
    const r = workflows.launch({ context: 'none', loadout: loadout(repo), workspace: 'isolated', validationCommand: 'true',
      steps: ['a', 'b'].map(id => ({ id, task: 'SCENARIO_HOLD', access: 'full', dependsOn: [] })) });
    await until(() => r.steps.every(s => !!s.taskId && tasks.get(s.taskId).activity !== 'starting RPC'));
    await internals.pump;
    // Suppress notification-driven collection until both children have stopped.
    internals.schedule = () => {};
    const first = r.steps[0].worktree!, sibling = r.steps[1].worktree!;
    const lock = resolve(first.path, await git(first.path, 'rev-parse', '--git-path', 'index.lock'));
    writeFileSync(lock, 'locked');
    writeFileSync(join(sibling.path, 'accepted.txt'), 'keep successful sibling');
    await Promise.all(r.steps.map(s => tasks.message(s.taskId!, 'done')));
    await until(() => r.steps.every(s => tasks.get(s.taskId!).stopped));
    assert.ok(r.steps.every(s => tasks.get(s.taskId!).state === 'completed'));
    assert.deepEqual(r.steps.map(s => s.state), ['running', 'running']);
    schedule(); await internals.pump;
    assert.equal(r.state, 'paused');
    assert.equal(r.steps[0].state, 'failed');
    assert.match(r.steps[0].error!, /index\.lock/);
    assert.equal(r.steps[1].state, 'completed', 'a capture failure must not strand a stopped sibling as running');
    assert.ok(sibling.output);
    assert.equal(await git(repo, 'show', `${sibling.output}:accepted.txt`), 'keep successful sibling');
    const persisted = JSON.parse(readFileSync(join(dir, 'workflows', `${r.id}.json`), 'utf8')) as WorkflowRecord;
    assert.deepEqual(persisted.steps.map(s => s.state), ['failed', 'completed']);
    rmSync(lock);
    await assert.doesNotReject(workflows.retry(r.id, 'a', 'redo capture failure'));
    assert.deepEqual(r.steps.map(s => s.state), ['pending', 'completed']);
    assert.equal(r.steps[0].freshTask, true);
    assert.equal(r.steps[1].worktree!.output, sibling.output);
  } finally {
    internals.schedule = schedule;
    await workflows.shutdown(); await tasks.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
