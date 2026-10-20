import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore, type TaskRecord } from '../pi-extension/subagents/store.ts';
import { seedSession } from '../pi-extension/subagents/context.ts';
import { loadout } from './fixtures/loadout.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-context-schema-'));
  const store = new TaskStore(dir), id = randomUUID();
  const record: TaskRecord = { version: 2, id, name: 'partial', task: 'inspect', context: 'partial', access: 'read-only',
    loadout: loadout(dir), state: 'completed', startedAt: Date.now(), updatedAt: Date.now(),
    sessionFile: join(dir, `${id}.session.jsonl`), output: '', activity: 'completed', log: [], questions: [], stopped: true, run: 1 };
  seedSession(record.sessionFile, dir, 'partial');
  return { dir, store, record, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const invalid: { name: string; value: unknown; version?: 1 | 2 | 3; context?: 'none' | 'full' }[] = [
  { name: 'null', value: null }, { name: 'string', value: 'lost context' }, { name: 'array', value: [] },
  { name: 'missing version', value: { contextText: 'scope' } },
  { name: 'unsupported version', value: { version: 2, contextText: 'scope' } },
  { name: 'missing selection', value: { version: 1 } },
  { name: 'blank selection', value: { version: 1, contextText: ' \n ' } },
  { name: 'non-string selection', value: { version: 1, contextText: 7 } },
  { name: 'unexpected access field', value: { version: 1, contextText: 'scope', access: 'full' } },
  { name: 'unexpected role field', value: { version: 1, contextText: 'scope', rolePlan: {} } },
  { name: 'context none', value: { version: 1, contextText: 'scope' }, context: 'none' },
  { name: 'context full', value: { version: 1, contextText: 'scope' }, context: 'full' },
  { name: 'v1 record', value: { version: 1, contextText: 'scope' }, version: 1 },
  { name: 'v3 role record', value: { version: 1, contextText: 'scope' }, version: 3 },
];
for (const { name, value, version, context } of invalid) {
  test(`recovery context rejects ${name} on save, load and continue validation`, () => {
    const t = setup();
    try {
      const record = { ...t.record, ...(version ? { version } : {}), ...(context ? { context } : {}), recoveryContext: value } as TaskRecord;
      if (version === 1) record.ownership = 'legacy';
      assert.throws(() => t.store.save(record), /recovery context/i);
      writeFileSync(t.store.path(record.id), JSON.stringify(record));
      assert.throws(() => t.store.load(), /recovery context/i);
      assert.throws(() => t.store.validateForContinue(record), /recovery context/i);
    } finally { t.clean(); }
  });
}

test('v2 partial recovery context round-trips verbatim without role data or read-time migration', () => {
  const t = setup();
  try {
    const contextText = '  Only inspect auth.ts.\n不得更改其他文件。  ';
    const record = { ...t.record, recoveryContext: { version: 1, contextText } } as TaskRecord;
    t.store.save(record);
    const before = readFileSync(t.store.path(record.id), 'utf8');
    const loaded = t.store.load()[0];
    assert.deepEqual((loaded as any).recoveryContext, { version: 1, contextText });
    assert.equal(loaded.taskInput, undefined); assert.equal(loaded.version, 2);
    t.store.validateForContinue(loaded);
    assert.equal(readFileSync(t.store.path(record.id), 'utf8'), before, 'Inspection must not mutate the record');
  } finally { t.clean(); }
});

test('v2 taskInput remains role-only rather than becoming an accidental recovery schema', () => {
  const t = setup();
  try {
    writeFileSync(t.store.path(t.record.id), JSON.stringify({ ...t.record,
      taskInput: { task: t.record.task, context: 'partial', contextText: 'scope', cwd: t.dir } }));
    assert.throws(() => t.store.load(), /Role data requires v3/);
  } finally { t.clean(); }
});
