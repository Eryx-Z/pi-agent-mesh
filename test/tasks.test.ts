import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TaskStore, uniqueName, addLog } from "../pi-extension/subagents/store.ts";
import { TaskManager, childLaunch } from "../pi-extension/subagents/tasks.ts";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { validateLoadout } from "../pi-extension/subagents/loadout.ts";
import { loadout as makeLoadout } from "./fixtures/loadout.ts";

const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('timed out waiting for fake task'); }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'));
  const events: string[] = [];
  const create = () => new TaskManager(new TaskStore(dir), { command: process.execPath, createRpc: l => new RpcProcess({ ...l, args: [fake] }, 1000, 25), notify: (r, kind) => events.push(`${r.id}:${kind}:${r.state}`) });
  const manager = create();
  const loadout = makeLoadout(dir);
  return { dir, manager, loadout, events, create, async clean() { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('parallel tasks reserve explicit names, stream progress and settle exactly once', async () => {
  const t = setup();
  try {
    const [a, b] = await Promise.all(['a', 'b'].map(s => t.manager.launch({ name: 'same', task: s, access: "full", context: 'none', loadout: t.loadout })));
    assert.equal(a.name, 'same'); assert.equal(b.name, 'same-2');
    await until(() => a.stopped && b.stopped);
    assert.equal(a.state, 'completed'); assert.match(a.output, /finished/);
    assert.ok(a.log.some(l => l.includes('src/auth.ts')));
    assert.equal(t.events.filter(e => e.includes(':result:')).length, 2);
  } finally { await t.clean(); }
});
test('legacy records remain readable but require explicit access before continuation', async () => {
  const t = setup(); let restored: TaskManager | undefined;
  try {
    const r = await t.manager.launch({ task: 'initial', access: 'full', context: 'none', loadout: t.loadout });
    await until(() => r.stopped); await t.manager.shutdown();
    r.version = 1; r.ownership = 'historical scope'; delete r.access; delete r.availableLoadout;
    t.manager.store.save(r); restored = t.create();
    assert.equal(restored.get(r.id).ownership, 'historical scope');
    await assert.rejects(restored.continue(r.id, 'explain'), /access must/);
    const continued = await restored.continue(r.id, 'explain', 'read-only');
    await until(() => continued.stopped);
    assert.equal(continued.version, 2); assert.equal(continued.access, 'read-only');
    assert.deepEqual(continued.loadout.tools, ['read', 'ask_question']);
  } finally { await restored?.shutdown(); await t.clean(); }
});
test('question blocks completion; answer is correlated and duplicate/stale answers are rejected', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_QUESTION', access: "full", context: 'none', loadout: t.loadout });
    await until(() => r.state === 'waiting');
    await sleep(50); assert.equal(r.stopped, false); assert.equal(r.questions[0].id, 'q-1');
    await assert.rejects(t.manager.message(r.id, 'not an answer'), /question ID/);
    assert.throws(() => t.manager.answer(r.id, 'wrong', 'x'), /no longer/);
    t.manager.answer(r.id, 'q-1', 'Use interface A');
    assert.throws(() => t.manager.answer(r.id, 'q-1', 'duplicate'), /no longer/);
    await until(() => r.stopped);
    assert.equal(r.state, 'completed'); assert.equal(r.questions.length, 0);
  } finally { await t.clean(); }
});
test('supplemental messages are queued, not reported as execution; cancel stops waiting and running children', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_HOLD', access: "full", context: 'none', loadout: t.loadout });
    await t.manager.message(r.id, 'new instruction');
    assert.ok(r.log.some(l => l.includes('not yet proven executed')));
    const q = await t.manager.launch({ task: 'SCENARIO_QUESTION', access: "full", context: 'none', loadout: t.loadout });
    await until(() => q.state === 'waiting');
    await t.manager.cancel(q.id); assert.equal(q.state, 'cancelled'); assert.equal(q.stopped, true);
  } finally { await t.clean(); }
});
test('provider error and unexpected exit become failed, not successful completion', async () => {
  const t = setup();
  try {
    for (const scenario of ['SCENARIO_ERROR', 'SCENARIO_DIE']) {
      const r = await t.manager.launch({ task: scenario, access: "full", context: 'none', loadout: t.loadout });
      await until(() => r.state === 'failed' && r.activity === 'failed');
      assert.equal(r.stopped, scenario !== 'SCENARIO_DIE'); assert.ok(r.error);
    }
  } finally { await t.clean(); }
});
test('completed tasks persist and continue; concurrent continuations exclude a second writer', async () => {
  const t = setup();
  let restored: TaskManager | undefined;
  try {
    const r = await t.manager.launch({ task: 'initial', access: "full", context: 'none', loadout: t.loadout });
    await until(() => r.stopped); await t.manager.shutdown();
    restored = t.create();
    const first = restored.continue(r.id, 'SCENARIO_HOLD');
    await assert.rejects(restored.continue(r.id, 'duplicate'), /already running/);
    const resumed = await first;
    assert.equal(resumed.run, 2); assert.equal(resumed.name, r.name);
    await restored.shutdown(); assert.equal(resumed.state, 'cancelled'); assert.equal(resumed.stopped, true);
    await assert.rejects(restored.continue(r.id, 'late'), /shutting down/);
  } finally { await restored?.shutdown(); await t.clean(); }
});
test('stale live records and lockfiles never auto-resume orphan writers', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'initial', access: "full", context: 'none', loadout: t.loadout });
    await until(() => r.stopped);
    r.state = 'running'; r.stopped = false; t.manager.store.save(r);
    const loaded = t.manager.store.load()[0];
    assert.equal(loaded.state, 'failed'); assert.equal(loaded.stopped, false);
    assert.throws(() => t.manager.store.validateForContinue(loaded), /not confirmed/);
    const release = t.manager.store.lock(r.id);
    assert.throws(() => t.manager.store.lock(r.id), /locked/); release();
  } finally { await t.clean(); }
});
test('inherited loadouts reject legacy snapshots and nested tools; launch uses explicit resources', () => {
  const t = setup();
  try {
    assert.throws(() => validateLoadout({ version: 1 }), /legacy profile tasks/);
    assert.throws(() => validateLoadout({ ...t.loadout, tools: ['subagent', 'ask_question'] }), /nested delegation/);
    const launch = childLaunch({ id: 'example', sessionFile: '/tmp/session.jsonl', loadout: t.loadout } as any, t.dir, 'pi');
    assert.ok(launch.args.includes('--no-extensions')); assert.ok(launch.args.includes('--no-context-files'));
    assert.ok(launch.args.includes('--no-skills')); assert.equal(launch.cwd, t.dir);
    assert.equal(launch.args[launch.args.indexOf('--tools') + 1], 'read,ask_question');
    assert.throws(() => uniqueName('a\nb', []), /control/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
test('stale settled events cannot close a task while a supplementary instruction is running', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_HOLD', access: "full", context: 'none', loadout: t.loadout });
    await t.manager.message(r.id, 'finish this supplementary work');
    await sleep(30);
    assert.equal(r.stopped, false);
    assert.equal(t.events.filter(e => e.includes(':result:')).length, 0);
    await until(() => r.stopped);
    assert.equal(r.state, 'completed');
    assert.match(r.output, /supplementary work/);
    assert.equal(t.events.filter(e => e.includes(':result:')).length, 1);
  } finally { await t.clean(); }
});
test('failed supplementary prompt does not strand a running writer', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_HOLD', access: "full", context: 'none', loadout: t.loadout });
    await assert.rejects(t.manager.message(r.id, 'SCENARIO_REJECT_MESSAGE'), /rejected/);
    assert.equal(r.state, 'failed');
    assert.equal(r.stopped, true);
    assert.match(r.error!, /Supplement failed/);
  } finally { await t.clean(); }
});
test('logs and output remain bounded during long tool streams', () => {
  const record = { log: [] } as any;
  for (let i = 0; i < 1000; i++) addLog(record, 'x'.repeat(10000));
  assert.equal(record.log.length, 100); assert.ok(record.log[0].length < 1100);
});

test('cancel rejects unconfirmed shutdown and retains stopped=false and exclusive lock', async () => {
  const t = setup();
  let rpc: RpcProcess | undefined;
  const manager = new TaskManager(new TaskStore(t.dir), { command: process.execPath, createRpc: launch => {
    rpc = new RpcProcess({ ...launch, args: [fake] }, 1000, 50);
    const stop = rpc.stop.bind(rpc);
    rpc.stop = async () => { await stop(); throw new Error('injected stop confirmation failure'); };
    return rpc;
  } });
  try {
    const record = await manager.launch({ task: 'SCENARIO_HOLD', access: "full", context: 'none', loadout: t.loadout });
    await assert.rejects(manager.cancel(record.id), /could not confirm shutdown.*injected stop confirmation failure/s);
    assert.equal(record.stopped, false);
    assert.equal(record.state, 'cancelled'); // Cleanup failure does not rewrite the task outcome.
    assert.throws(() => manager.store.lock(record.id), /locked/);
    assert.equal(manager.store.load()[0].stopped, false);
    await assert.rejects(manager.continue(record.id, 'unsafe'), /not confirmed/);
  } finally { await manager.shutdown(); await t.clean(); }
});

test('toolUse requires successful termination evidence for every call in the final batch', async () => {
  const { EventEmitter } = await import('node:events');
  for (const scenario of ['terminated', 'missing', 'error', 'mixed', 'stale']) {
    const t = setup();
    const rpc = new EventEmitter() as any;
    rpc.request = async (type: string, fields: any) => {
      if (type === 'get_commands') return { commands: [{ name: 'rpc-subagent-preflight' }] };
      if (type === 'get_state') return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
      if (type === 'prompt' && fields.message !== '/rpc-subagent-preflight') rpc.emit('event', { type: 'agent_start' });
    };
    rpc.stop = async () => {};
    const manager = new TaskManager(new TaskStore(t.dir), { command: 'unused', createRpc: () => rpc });
    const emit = (event: any) => rpc.emit('event', event);
    const assistant = (ids: string[]) => emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: ids.map(id => ({ type: 'toolCall', id, name: 'final' })) } });
    const ended = (id: string, terminate = true, isError = false) => emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'final', result: { terminate, content: [] }, isError });
    try {
      const record = await manager.launch({ task: scenario, access: "full", context: 'none', loadout: t.loadout });
      assistant(['one']);
      if (scenario === 'mixed') { assistant(['one', 'two']); ended('one'); ended('two', false); }
      else if (scenario !== 'missing') ended('one', true, scenario === 'error');
      if (scenario === 'stale') assistant(['later']);
      emit({ type: 'agent_settled' });
      await until(() => record.stopped);
      assert.equal(record.state, scenario === 'terminated' ? 'completed' : 'failed', scenario);
    } finally { await manager.shutdown(); await t.clean(); }
  }
});

test('accepted unstarted reconciliation preserves queued work and rechecks lifecycle races', async () => {
  const { EventEmitter } = await import('node:events');
  for (const race of [false, true]) {
    const t = setup();
    const rpc = new EventEmitter() as any;
    let accepted = false, pending = 1, stateReply: ((value: any) => void) | undefined;
    rpc.request = async (type: string, fields: any) => {
      if (type === 'get_commands') return { commands: [{ name: 'rpc-subagent-preflight' }] };
      if (type === 'get_state') {
        if (race && accepted && !stateReply) return new Promise(resolve => { stateReply = resolve; });
        return { isStreaming: false, isCompacting: false, pendingMessageCount: accepted ? pending : 0 };
      }
      if (type === 'prompt' && fields.message !== '/rpc-subagent-preflight') accepted = true;
    };
    rpc.stop = async () => {};
    const manager = new TaskManager(new TaskStore(t.dir), { command: 'unused', createRpc: () => rpc });
    try {
      const record = await manager.launch({ task: 'queued', access: "full", context: 'none', loadout: t.loadout });
      await sleep(10);
      assert.equal(record.stopped, false);
      pending = 0;
      rpc.emit('event', { type: 'agent_start' });
      stateReply?.({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      await sleep(10);
      assert.equal(record.stopped, false, 'old idle state must not close a newly started run');
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } });
      rpc.emit('event', { type: 'agent_settled' });
      await until(() => record.stopped);
      assert.equal(record.state, 'completed');
    } finally { await manager.shutdown(); await t.clean(); }
  }
});

test('startup diagnostics reach caller and persisted record without submitting a task after failed preflight', async () => {
  const { EventEmitter } = await import('node:events');
  for (const [failure, category] of [
    ['No API key found for test-provider', 'credentials'],
    ['Requested model was not selected: test/model', 'model/provider'],
    ['Inherited tool schema/provenance mismatch: read', 'loadout/extension'],
    ['unexpected failure', 'startup'],
  ]) {
    const t = setup(), rpc = new EventEmitter() as any;
    let prompts = 0, stops = 0;
    rpc.request = async (type: string) => {
      if (type === 'get_commands') return { commands: [{ name: 'rpc-subagent-preflight' }] };
      if (type === 'prompt') { prompts++; throw new Error(failure); }
      return {};
    };
    rpc.stop = async () => { stops++; };
    const manager = new TaskManager(new TaskStore(t.dir), { command: 'unused', createRpc: () => rpc });
    try {
      await assert.rejects(manager.launch({ task: 'never sent', access: 'full', context: 'none', loadout: t.loadout }), (e: Error) => {
        assert.ok(e.message.includes(`[subagent ${category}]`));
        assert.ok(e.message.includes(failure));
        return true;
      });
      const record = [...manager.records.values()][0];
      assert.match(record.error!, /phase=loadout preflight/);
      assert.ok(record.error!.includes(t.loadout.model));
      assert.ok(record.error!.includes(t.loadout.agentDir));
      assert.equal(record.state, 'failed'); assert.equal(record.stopped, true);
      assert.equal(prompts, 1); assert.equal(stops, 1);
      const release = manager.store.lock(record.id); release();
    } finally { await manager.shutdown(); await t.clean(); }
  }
});

test('late startup rejection cannot release an unconfirmed stopped writer lock', async () => {
  const { EventEmitter } = await import('node:events');
  const t = setup(), rpc = new EventEmitter() as any;
  let rejectStartup!: (error: Error) => void;
  rpc.request = () => new Promise((_resolve, reject) => { rejectStartup = reject; });
  rpc.stop = async () => { throw new Error('stop unconfirmed'); };
  const manager = new TaskManager(new TaskStore(t.dir), { command: 'unused', createRpc: () => rpc });
  try {
    const launch = manager.launch({ task: 'starting', access: "full", context: 'none', loadout: t.loadout });
    const record = [...manager.records.values()][0];
    rpc.emit('fault', new Error('startup fault'));
    await until(() => record.activity === 'failed');
    rejectStartup(new Error('late startup rejection'));
    await assert.rejects(launch, /late startup/);
    assert.equal(record.stopped, false);
    assert.match(record.recovery?.error ?? '', /stop unconfirmed/);
    assert.throws(() => manager.store.lock(record.id), /locked/);
  } finally { await manager.shutdown(); await t.clean(); }
});
