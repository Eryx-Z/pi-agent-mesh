import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore, type TaskRecord } from '../pi-extension/subagents/store.ts';
import { RpcProcess } from '../pi-extension/subagents/rpc.ts';
import { SystemdExecutionController, readProcessIdentity, type ExecutionController } from '../pi-extension/subagents/execution.ts';
import { loadout } from './fixtures/loadout.ts';

const linux = { skip: process.platform !== 'linux', timeout: 15000 };
const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
const parent = fileURLToPath(new URL('./fixtures/recovery-parent.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(10); }
  throw new Error('Recovery condition did not become true');
}
async function setup(cleanup: ExecutionController['cleanup'] = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'task-recovery-'));
  const store = new TaskStore(dir);
  // Persist a real launcher's identity, then positively wait for its death.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const identity = readProcessIdentity(child.pid!);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.ok(identity);
  const boundary = { kind: 'systemd-scope' as const, unit: `pi-execution-${randomUUID()}.scope`, bootId: identity.bootId, uid: process.getuid!() };
  let starts = 0;
  const prompts: string[] = [];
  const controller: ExecutionController = {
    prepare: () => ({ ...boundary, unit: `pi-execution-${randomUUID()}.scope` }),
    wrap: launch => launch, cleanup,
  };
  const managers: TaskManager[] = [];
  function seed(intent: 'interrupted' | 'completed' | 'cancelled' = 'interrupted') {
    const id = randomUUID();
    const record: TaskRecord = {
      version: 2, id, name: id, task: 'finish retained work', context: 'none', access: 'full',
      loadout: loadout(dir), availableLoadout: loadout(dir), state: intent === 'interrupted' ? 'running' : intent,
      startedAt: Date.now(), updatedAt: Date.now(), sessionFile: join(dir, `${id}.session.jsonl`),
      output: 'retained terminal output', activity: 'old run', log: [], questions: [], stopped: false, run: 1,
      execution: { boundary, launcher: identity, ready: true, intent, cleanup: 'pending' },
    };
    writeFileSync(record.sessionFile, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: dir }) + '\n' +
      JSON.stringify({ type: 'message', id: 'retained', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Already inspected partial effects; preserve this history', timestamp: Date.now() } }) + '\n');
    store.save(record); writeFileSync(`${store.path(id)}.lock`, JSON.stringify({ token: 'stale', pid: child.pid }));
    return record;
  }
  async function open(recoveryDelayMs = 10) {
    const manager = await TaskManager.open(store, {
      command: process.execPath, executionController: controller, recoveryDelayMs,
      createRpc: launch => {
        starts++;
        const persisted = store.load().find(record => !record.stopped);
        if (persisted?.run === 2) {
          assert.equal(persisted.recoveryRuns, 1, 'Reserve recovery durably before launching its RPC');
          assert.ok(existsSync(persisted.sessionFile), 'Retain session before recovery launch');
        }
        const rpc = new RpcProcess({ ...launch, args: [fake] }, 1000, 100);
        const request = rpc.request.bind(rpc);
        rpc.request = (type, fields) => {
          if (type === 'prompt' && typeof fields?.message === 'string') prompts.push(fields.message);
          return request(type, fields);
        };
        return rpc;
      },
    });
    managers.push(manager); return manager;
  }
  return { dir, store, seed, open, prompts, get starts() { return starts; },
    async clean() { for (const manager of managers) await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('automatic cleanup retries failure, preserves terminal result and only then releases stale lock', linux, async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await setup(async () => { if (++calls === 1) throw new Error('injected bus failure'); await gate; });
  try {
    const old = t.seed('completed'), manager = await t.open(); manager.startRecovery();
    await until(() => calls === 2);
    const record = manager.get(old.id);
    assert.equal(record.stopped, false); assert.equal(record.state, 'completed');
    assert.ok(existsSync(`${t.store.path(old.id)}.lock`));
    assert.throws(() => t.store.lock(old.id), /locked/);
    release(); await until(() => record.stopped);
    assert.equal(record.output, old.output); assert.equal(record.execution?.cleanup, 'confirmed');
    assert.equal(t.starts, 0); assert.equal(existsSync(`${t.store.path(old.id)}.lock`), false);
    t.store.lock(old.id)();
  } finally { release(); await t.clean(); }
});

test('interrupted task resumes exactly once with retained history and durable attempt reservation', linux, async () => {
  const t = await setup();
  try {
    const old = t.seed();
    old.continuationTask = 'Review only; do not edit any files';
    old.supplementaryInstructions = ['Inspect auth.ts before drawing conclusions'];
    t.store.save(old);
    const manager = await t.open(); manager.startRecovery(); manager.startRecovery();
    const record = manager.get(old.id); await until(() => record.stopped && record.run === 2);
    assert.equal(t.starts, 1); assert.equal(record.recoveryRuns, 1); assert.equal(record.state, 'completed');
    assert.equal(record.sessionFile, old.sessionFile);
    assert.match(readFileSync(record.sessionFile, 'utf8'), /Already inspected partial effects/);
    const taskPrompts = t.prompts.filter(p => p !== '/rpc-subagent-preflight');
    assert.equal(taskPrompts.length, 1); assert.match(taskPrompts[0], /retained session history/);
    assert.match(taskPrompts[0], /Do not blindly repeat side effects/);
    assert.match(taskPrompts[0], /Review only; do not edit any files/);
    assert.match(taskPrompts[0], /Inspect auth.ts before drawing conclusions/);
    assert.equal(JSON.parse(readFileSync(t.store.path(old.id), 'utf8')).recoveryRuns, 1);
    manager.startRecovery(); await sleep(50); assert.equal(t.starts, 1);
    await manager.shutdown(); const reopened = await t.open(); reopened.startRecovery(); await sleep(50);
    assert.equal(t.starts, 1); assert.equal(reopened.get(old.id).run, 2);
  } finally { await t.clean(); }
});

for (const intent of ['cancelled', 'completed'] as const) {
  test(`${intent} cleanup never re-executes the task`, linux, async () => {
    const t = await setup();
    try {
      const old = t.seed(intent), manager = await t.open(); manager.startRecovery();
      const record = manager.get(old.id); await until(() => record.stopped);
      manager.startRecovery(); await sleep(40);
      assert.equal(record.state, intent); assert.equal(record.run, 1); assert.equal(record.output, old.output);
      assert.equal(t.starts, 0); assert.equal(record.execution?.cleanup, 'confirmed');
    } finally { await t.clean(); }
  });
}

test('unconfirmable cleanup stops after five retries and retains exclusive task lock', linux, async () => {
  let calls = 0;
  const t = await setup(async () => { calls++; throw new Error('injected persistent failure'); });
  try {
    const old = t.seed(), manager = await t.open(); manager.startRecovery();
    const record = manager.get(old.id); await until(() => record.recovery?.phase === 'blocked');
    assert.equal(calls, 5); assert.equal(record.recovery?.attempts, 5); assert.equal(record.stopped, false);
    assert.equal(t.starts, 0); assert.ok(existsSync(`${t.store.path(old.id)}.lock`));
    await sleep(80); assert.equal(calls, 5);
    await assert.rejects(manager.continue(old.id, 'unsafe'), /not confirmed/);
  } finally { await t.clean(); }
});

for (const missing of ['launcher', 'legacy'] as const) {
  test(`${missing} identity is automatically isolated without cleanup or prompts`, linux, async () => {
    let calls = 0;
    const t = await setup(async () => { calls++; });
    try {
      const old = t.seed();
      if (missing === 'launcher') delete old.execution!.launcher;
      else delete old.execution;
      t.store.save(old);
      const manager = await t.open(); manager.startRecovery(); const record = manager.get(old.id);
      await until(() => record.recovery?.phase === 'blocked');
      assert.equal(calls, 0); assert.equal(t.starts, 0); assert.equal(record.stopped, false);
      assert.ok(existsSync(`${t.store.path(old.id)}.lock`));
    } finally { await t.clean(); }
  });
}

test('workflow interruption cleanup is not a standalone auto-resume', linux, async () => {
  const t = await setup();
  try {
    const old = t.seed(); old.workflow = { id: randomUUID(), stepId: 'step' }; t.store.save(old);
    const manager = await t.open(); manager.startRecovery(); const record = manager.get(old.id);
    await until(() => record.stopped); assert.equal(t.starts, 0); assert.equal(record.run, 1);
  } finally { await t.clean(); }
});

test('shutdown waits for in-flight recovery and fences any replacement prompt', linux, async () => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await setup(async () => { entered = true; await gate; });
  try {
    const old = t.seed(), manager = await t.open(); manager.startRecovery(); await until(() => entered);
    let stopped = false; const shutdown = manager.shutdown().then(() => { stopped = true; });
    await sleep(40); assert.equal(stopped, false); assert.equal(t.starts, 0);
    await assert.rejects(t.open(), /ownership|owned|lease|lock/i);
    release(); await shutdown;
    assert.equal(t.starts, 0); assert.equal(manager.get(old.id).stopped, true);
    await assert.rejects(manager.continue(old.id, 'late'), /shutting down/);
    const replacement = await t.open(); await replacement.shutdown();
  } finally { release(); await t.clean(); }
});

test('live previous parent identity rejects takeover even without its kernel lease', linux, async () => {
  const t = await setup();
  try {
    writeFileSync(join(t.dir, '.owner.json'), JSON.stringify({ identity: readProcessIdentity(), active: true }));
    await assert.rejects(t.open(), /Previous parent is still alive/);
    // A failed open must release its newly acquired lease so a cleanly deactivated owner can be replaced.
    writeFileSync(join(t.dir, '.owner.json'), JSON.stringify({ identity: readProcessIdentity(), active: false }));
    const manager = await t.open(); await manager.shutdown();
  } finally { await t.clean(); }
});

for (const outcome of ['cancelled', 'completed'] as const) {
  test(`live ${outcome} boundary failure retains live handle and lock until automatic retry succeeds`, linux, async () => {
    let calls = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const t = await setup(async () => { if (++calls === 1) throw new Error('first boundary failure'); await gate; });
    try {
      const manager = await t.open(100);
      const record = await manager.launch({ task: outcome === 'cancelled' ? 'SCENARIO_HOLD' : 'finish', access: 'full', context: 'none', loadout: loadout(t.dir) });
      if (outcome === 'cancelled') await assert.rejects(manager.cancel(record.id), /could not confirm shutdown/);
      else await until(() => calls === 1 && record.recovery?.phase === 'cleaning');
      assert.equal(record.state, outcome); assert.equal(record.stopped, false); assert.equal(manager.isLive(record.id), true);
      assert.throws(() => t.store.lock(record.id), /locked/);
      await until(() => calls === 2);
      assert.equal(manager.isLive(record.id), true); assert.equal(record.stopped, false);
      release(); await until(() => record.stopped);
      assert.equal(manager.isLive(record.id), false); assert.equal(record.state, outcome);
      assert.equal(record.run, 1); assert.equal(t.starts, 1); t.store.lock(record.id)();
      manager.startRecovery(); await sleep(40); assert.equal(t.starts, 1);
    } finally { release(); await t.clean(); }
  });
}

test('graceful shutdown marks interruption and reopen resumes once without resurrecting cancellation', linux, async () => {
  const t = await setup();
  try {
    const first = await t.open();
    const record = await first.launch({ task: 'SCENARIO_HOLD', access: 'full', context: 'none', loadout: loadout(t.dir) });
    await first.shutdown();
    assert.equal(record.execution?.intent, 'interrupted'); assert.equal(record.stopped, true);
    const recovered = await t.open(); recovered.startRecovery();
    await until(() => recovered.get(record.id).run === 2 && recovered.isLive(record.id));
    const resumed = recovered.get(record.id);
    await until(() => t.prompts.filter(prompt => prompt !== '/rpc-subagent-preflight').length === 2);
    assert.equal(resumed.recoveryRuns, 1); assert.equal(t.starts, 2);
    await recovered.cancel(record.id); assert.equal(resumed.execution?.intent, 'cancelled');
    await recovered.shutdown(); const reopened = await t.open(); reopened.startRecovery(); await sleep(80);
    assert.equal(reopened.get(record.id).state, 'cancelled'); assert.equal(t.starts, 2);
  } finally { await t.clean(); }
});

test('unready alive launcher never permits absent-scope cleanup or new prompt', linux, async () => {
  let calls = 0;
  const t = await setup(async () => { calls++; });
  const launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    const old = t.seed(); old.execution!.launcher = readProcessIdentity(launcher.pid!); old.execution!.ready = false;
    assert.ok(old.execution!.launcher); t.store.save(old);
    const manager = await t.open(); manager.startRecovery(); const record = manager.get(old.id);
    await until(() => record.recovery?.phase === 'blocked');
    assert.match(record.recovery?.error ?? '', /launcher has not settled/);
    assert.equal(calls, 0, 'Even a cleanup reporting absent scope must not run before launcher settles');
    assert.equal(record.stopped, false); assert.equal(t.starts, 0); assert.throws(() => t.store.lock(old.id), /locked/);
  } finally {
    const exit = once(launcher, 'exit'); launcher.kill('SIGKILL'); await exit; await t.clean();
  }
});

test('default systemd controller wraps fake RPC, persists readiness and confirms scope cleanup', linux, async context => {
  const probe = new SystemdExecutionController();
  if (!probe.prepare(randomUUID(), 1)) { context.skip('User systemd execution scope unavailable'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'recovery-systemd-'));
  let manager: TaskManager | undefined;
  try {
    manager = await TaskManager.open(new TaskStore(dir), { command: process.execPath, baseArgs: [fake] });
    const record = await manager.launch({ task: 'SCENARIO_HOLD', access: 'full', context: 'none', loadout: loadout(dir) });
    assert.equal(record.execution?.boundary.kind, 'systemd-scope'); assert.equal(record.execution?.ready, true);
    assert.ok(record.execution?.launcher); assert.ok(manager.isLive(record.id));
    const durable = JSON.parse(readFileSync(manager.store.path(record.id), 'utf8'));
    assert.deepEqual(durable.execution.launcher, record.execution!.launcher); assert.equal(durable.execution.ready, true);
    await manager.message(record.id, 'finish remaining work'); await until(() => record.stopped);
    assert.equal(record.state, 'completed'); assert.equal(record.execution?.cleanup, 'confirmed');
    assert.equal(manager.isLive(record.id), false); assert.equal(existsSync(`${manager.store.path(record.id)}.lock`), false);
    // Re-verification uses real systemctl/cgroup proof, not an injected success.
    await probe.cleanup(record.execution!.boundary);
  } finally { await manager?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('death of kernel lease helper fences manager against new launches', linux, async () => {
  const t = await setup();
  try {
    const manager = await t.open();
    const children = readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    const helper = children.map(Number).find(pid => {
      try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(join(t.dir, '.owner.lease')); }
      catch { return false; }
    });
    assert.ok(helper, 'Find actual flock helper belonging to this directory');
    process.kill(-helper, 'SIGKILL');
    await until(() => { try { manager.assertOwnership(); return false; } catch { return true; } });
    await assert.rejects(manager.launch({ task: 'must not run', access: 'full', context: 'none', loadout: loadout(t.dir) }), /lease|ownership|shutting down/i);
    assert.equal(t.starts, 0); await manager.shutdown();
  } finally { await t.clean(); }
});

test('cancel during restored interruption cleanup durably fences recovery prompt', linux, async () => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await setup(async () => { entered = true; await gate; });
  try {
    const old = t.seed(), manager = await t.open(); manager.startRecovery();
    await until(() => entered);
    await assert.rejects(manager.cancel(old.id), /cleanup pending/);
    const cancelled = JSON.parse(readFileSync(t.store.path(old.id), 'utf8'));
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.execution.intent, 'cancelled');
    release(); await until(() => manager.get(old.id).stopped);
    manager.startRecovery(); await sleep(50);
    assert.equal(t.starts, 0); assert.equal(t.prompts.length, 0);
    const durable = JSON.parse(readFileSync(t.store.path(old.id), 'utf8'));
    assert.equal(durable.state, 'cancelled'); assert.equal(durable.execution.intent, 'cancelled'); assert.equal(durable.run, 1);
    await manager.shutdown(); const reopened = await t.open(); reopened.startRecovery(); await sleep(50);
    assert.equal(t.starts, 0); assert.equal(reopened.get(old.id).state, 'cancelled');
  } finally { release(); await t.clean(); }
});

for (const outcome of ['unexpected exit', 'completed'] as const) {
  test(`cancel while live ${outcome} cleanup is delayed ${outcome === 'completed' ? 'preserves completion' : 'prevents interruption resumption'}`, linux, async () => {
    let entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const t = await setup(async () => { entered = true; await gate; });
    let cancellation: Promise<unknown> | undefined;
    try {
      const manager = await t.open();
      const record = await manager.launch({ task: outcome === 'unexpected exit' ? 'SCENARIO_DIE' : 'finish', access: 'full', context: 'none', loadout: loadout(t.dir) });
      await until(() => entered);
      assert.equal(manager.isLive(record.id), true); assert.equal(record.stopped, false);
      assert.equal(record.execution?.intent, outcome === 'completed' ? 'completed' : 'interrupted');
      cancellation = manager.cancel(record.id).then(() => undefined, error => error);
      const expected = outcome === 'completed' ? 'completed' : 'cancelled';
      assert.equal(record.state, expected); assert.equal(record.execution?.intent, expected);
      const midCleanup = JSON.parse(readFileSync(t.store.path(record.id), 'utf8'));
      assert.equal(midCleanup.state, expected); assert.equal(midCleanup.execution.intent, expected);
      release(); assert.equal(await cancellation, undefined);
      await until(() => record.stopped); manager.startRecovery(); await sleep(80);
      assert.equal(t.starts, 1); assert.equal(t.prompts.filter(prompt => prompt !== '/rpc-subagent-preflight').length, 1);
      assert.equal(record.state, expected); assert.equal(record.execution?.intent, expected); assert.equal(record.run, 1);
      await manager.shutdown(); const reopened = await t.open(); reopened.startRecovery(); await sleep(50);
      assert.equal(t.starts, 1); assert.equal(reopened.get(record.id).state, expected);
    } finally { release(); await cancellation; await t.clean(); }
  });
}

test('reserved auto-resume crash checkpoint loads blocked with consumed budget and no pending loop', linux, async () => {
  let calls = 0;
  const t = await setup(async () => { calls++; });
  try {
    const old = t.seed(); old.state = 'failed'; old.stopped = true;
    old.execution!.cleanup = 'confirmed'; old.recoveryRuns = 1; old.recovery = { phase: 'resuming', attempts: 0 };
    t.store.save(old); rmSync(`${t.store.path(old.id)}.lock`);
    const manager = await t.open(), record = manager.get(old.id);
    assert.equal(record.recovery?.phase, 'blocked'); assert.equal(record.recoveryRuns, 1); assert.equal(record.stopped, true);
    assert.match(record.recovery?.error ?? '', /reserved.*budget consumed/);
    manager.startRecovery(); await sleep(100); manager.startRecovery(); await sleep(40);
    assert.equal(calls, 0); assert.equal(t.starts, 0); assert.equal(record.recovery?.phase, 'blocked');
    assert.notEqual(record.activity, 'automatic cleanup pending');
    await manager.shutdown(); const reopened = await t.open(); reopened.startRecovery(); await sleep(50);
    assert.equal(reopened.get(old.id).recovery?.phase, 'blocked'); assert.equal(reopened.get(old.id).recoveryRuns, 1);
    assert.equal(calls, 0); assert.equal(t.starts, 0);
  } finally { await t.clean(); }
});

test('five failed restored cleanup attempts remain blocked across shutdown and reopen', linux, async () => {
  let calls = 0;
  const t = await setup(async () => { calls++; throw new Error('persistent restored cleanup failure'); });
  try {
    const old = t.seed(), manager = await t.open(); manager.startRecovery();
    await until(() => manager.get(old.id).recovery?.phase === 'blocked');
    assert.equal(calls, 5); assert.equal(manager.isLive(old.id), false);
    const before = JSON.parse(readFileSync(t.store.path(old.id), 'utf8'));
    assert.equal(before.recovery.phase, 'blocked'); assert.equal(before.recovery.attempts, 5);
    await manager.shutdown(); assert.equal(calls, 5, 'No retained live run requiring a shutdown cleanup attempt');
    const reopened = await t.open(), record = reopened.get(old.id);
    assert.equal(record.recovery?.phase, 'blocked'); assert.equal(record.recovery?.attempts, 5);
    reopened.startRecovery(); await sleep(100); reopened.startRecovery(); await sleep(50);
    assert.equal(calls, 5); assert.equal(t.starts, 0); assert.equal(record.stopped, false);
    assert.ok(existsSync(`${t.store.path(old.id)}.lock`));
    await assert.rejects(reopened.continue(old.id, 'unsafe resume'), /not confirmed/);
    assert.equal(JSON.parse(readFileSync(t.store.path(old.id), 'utf8')).recovery.attempts, 5);
  } finally { await t.clean(); }
});

async function startParent(dir: string, recover = false): Promise<{ child: ChildProcess; message: any; messages: any[] }> {
  const child = fork(parent, [dir, ...(recover ? ['recover'] : [])], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: any[] = []; child.on('message', message => messages.push(message));
  const message = await once(child, 'message'); return { child, message: message[0], messages };
}
async function stopParent(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  if (child.connected) child.send('close'); else child.kill('SIGKILL');
  await exit;
}

test('two concurrent contenders after killed owner deliver only one recovery prompt', linux, async () => {
  const t = await setup(); const children: ChildProcess[] = [];
  try {
    const old = t.seed();
    const original = await startParent(t.dir); children.push(original.child); assert.equal(original.message.type, 'opened');
    const exit = once(original.child, 'exit'); original.child.kill('SIGKILL'); await exit;
    const contenders = await Promise.all([startParent(t.dir, true), startParent(t.dir, true)]);
    children.push(...contenders.map(result => result.child));
    assert.equal(contenders.filter(result => result.message.type === 'opened').length, 1);
    assert.equal(contenders.filter(result => result.message.type === 'rejected').length, 1);
    await until(() => JSON.parse(readFileSync(t.store.path(old.id), 'utf8')).stopped === true);
    await sleep(80);
    assert.equal(contenders.flatMap(result => result.messages).filter(message => message.type === 'recovery-prompt').length, 1);
    const durable = JSON.parse(readFileSync(t.store.path(old.id), 'utf8'));
    assert.equal(durable.run, 2); assert.equal(durable.recoveryRuns, 1); assert.equal(durable.state, 'completed');
  } finally { for (const child of children) await stopParent(child); await t.clean(); }
});

test('separate parents exclude concurrent owners and permit takeover after dead owner despite stale files', linux, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-owner-'));
  const children: ChildProcess[] = [];
  try {
    const first = await startParent(dir); children.push(first.child); assert.equal(first.message.type, 'opened');
    const contender = await startParent(dir); children.push(contender.child);
    assert.equal(contender.message.type, 'rejected');
    assert.equal(JSON.parse(readFileSync(join(dir, '.owner.json'), 'utf8')).identity.pid, first.child.pid);
    const exit = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exit;
    assert.equal(existsSync(join(dir, '.owner.lease')), true);
    assert.equal(JSON.parse(readFileSync(join(dir, '.owner.json'), 'utf8')).active, true);
    const replacement = await startParent(dir); children.push(replacement.child); assert.equal(replacement.message.type, 'opened');
    await stopParent(replacement.child);
    const afterClose = await startParent(dir); children.push(afterClose.child); assert.equal(afterClose.message.type, 'opened');
  } finally { for (const child of children) await stopParent(child); rmSync(dir, { recursive: true, force: true }); }
});
