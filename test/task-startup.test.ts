import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../pi-extension/subagents/store.ts';
import { loadout } from './fixtures/loadout.ts';

for (const phase of ['readiness', 'preflight', 'initial prompt'] as const) {
  test(`supplement is refused during ${phase}, then accepted after startup`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-startup-'));
    const rpc = new EventEmitter() as any;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked = new Promise<void>(resolve => { reached = resolve; });
    const prompts: string[] = [];
    let firstState = true;
    rpc.request = async (type: string, fields: any) => {
      if (type === 'get_state') {
        if (firstState) {
          firstState = false;
          if (phase === 'readiness') { reached(); await gate; }
        }
        return { isStreaming: true, isCompacting: false, pendingMessageCount: 0 };
      }
      if (type === 'get_commands') return { commands: [{ name: 'rpc-subagent-preflight' }] };
      if (type === 'prompt') {
        prompts.push(fields.message);
        const preflight = fields.message === '/rpc-subagent-preflight';
        if ((phase === 'preflight' && preflight) || (phase === 'initial prompt' && !preflight && !fields.message.startsWith('Supplementary parent'))) {
          reached(); await gate;
        }
        if (!preflight) rpc.emit('event', { type: 'agent_start' });
      }
    };
    rpc.stop = async () => {};
    const manager = new TaskManager(new TaskStore(dir), { command: 'unused', createRpc: () => rpc });
    const launch = manager.launch({ task: 'initial task', access: 'full', context: 'none', loadout: loadout(dir) });
    try {
      await blocked;
      const record = [...manager.records.values()][0];
      const before = [...prompts];
      await assert.rejects(manager.message(record.id, 'too early'), /starting/);
      assert.deepEqual(prompts, before, 'no supplement may be submitted before startup completes');
      release();
      await launch;
      await manager.message(record.id, 'after startup');
      assert.match(prompts.at(-1)!, /Supplementary parent instruction:\nafter startup/);
      assert.equal(record.state, 'running');
    } finally {
      release();
      await launch;
      await manager.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
