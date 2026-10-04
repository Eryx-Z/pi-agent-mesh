import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../pi-extension/subagents/store.ts';
import { WorkflowManager } from '../pi-extension/subagents/workflows.ts';
import { RpcProcess } from '../pi-extension/subagents/rpc.ts';
import { readProcessIdentity, type ExecutionController } from '../pi-extension/subagents/execution.ts';
import { git } from '../pi-extension/subagents/workspaces.ts';
import { loadout } from './fixtures/loadout.ts';
const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Workflow task recovery timed out');
}

test('restart preserves completed uncaptured child through automatic cleanup and workflow cancellation',
  { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-task-recovery-')), repo = join(dir, 'repo');
    mkdirSync(repo); await git(repo, 'init'); writeFileSync(join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
    let cleanupAllowed = false;
    const controller: ExecutionController = {
      prepare: () => ({ kind: 'systemd-scope', unit: `pi-execution-${randomUUID()}.scope`,
        bootId: readProcessIdentity()!.bootId, uid: process.getuid!() }),
      wrap: launch => launch,
      cleanup: async () => { if (!cleanupAllowed) throw new Error('Injected pending cleanup'); },
    };
    const store = new TaskStore(join(dir, 'tasks'));
    const tasks = await TaskManager.open(store, { command: process.execPath, executionController: controller,
      recoveryDelayMs: 1000, createRpc: launch => new RpcProcess({ ...launch, args: [fake] }, 3000, 100) });
    const workflows = new WorkflowManager(tasks, join(dir, 'workflows'));
    let recoveredTasks: TaskManager | undefined, recoveredFlows: WorkflowManager | undefined;
    try {
      const workflow = workflows.launch({ context: 'none', loadout: loadout(repo), workspace: 'isolated', validationCommand: 'true',
        steps: [{ id: 'a', access: 'full', task: 'SCENARIO_HOLD', dependsOn: [] }] });
      await until(() => !!workflow.steps[0].taskId && tasks.get(workflow.steps[0].taskId!).activity !== 'starting RPC');
      const child = tasks.get(workflow.steps[0].taskId!);
      writeFileSync(join(workflow.steps[0].worktree!.path, 'successful.txt'), 'must survive');
      await tasks.message(child.id, 'complete');
      await until(() => child.state === 'completed' && !!child.recovery);
      assert.equal(child.stopped, false); assert.equal(workflow.steps[0].worktree!.output, undefined);
      await workflows.shutdown(); await tasks.shutdown();
      cleanupAllowed = true;
      recoveredTasks = await TaskManager.open(store, { command: process.execPath, executionController: controller,
        createRpc: () => { throw new Error('Successful workflow child must never rerun'); } });
      recoveredFlows = new WorkflowManager(recoveredTasks, join(dir, 'workflows'));
      const restored = recoveredFlows.get(workflow.id);
      assert.equal(restored.state, 'paused'); assert.equal(restored.steps[0].state, 'running');
      recoveredTasks.startRecovery();
      await until(() => restored.steps[0].state === 'completed');
      assert.equal(recoveredTasks.get(child.id).state, 'completed');
      await recoveredFlows.cancel(restored.id);
      const tree = restored.steps[0].worktree!;
      assert.equal(tree.removed, true); assert.ok(tree.revisionRef);
      await git(repo, 'reflog', 'expire', '--expire=now', '--all'); await git(repo, 'gc', '--prune=now');
      assert.equal(await git(repo, 'show', `${tree.revisionRef}:successful.txt`), 'must survive');
    } finally {
      await recoveredFlows?.shutdown(); await recoveredTasks?.shutdown();
      await workflows.shutdown(); await tasks.shutdown(); rmSync(dir, { recursive: true, force: true });
    }
  });
