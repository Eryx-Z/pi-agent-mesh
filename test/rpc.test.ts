import { test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RpcProcess, JsonlDecoder } from "../pi-extension/subagents/rpc.ts";
const fixture = fileURLToPath(new URL("./fixtures/fake-rpc.mjs", import.meta.url));
// Protocol tests must not mistake parallel-suite scheduling delays for failed cleanup.
const rpc = (timeout = 5000) => new RpcProcess({ command: process.execPath, args: [fixture], cwd: process.cwd() }, timeout, 250);

test("JSONL preserves chunked UTF8, CRLF, Unicode separators and rejects oversized/malformed frames", () => {
  const events: any[] = []; const d = new JsonlDecoder(e => events.push(e));
  const b = Buffer.from(JSON.stringify({ type: "message", value: "中\u2028文\u2029" }) + "\r\n");
  for (const byte of b) d.push(Buffer.from([byte]));
  assert.equal(events[0].value, "中\u2028文\u2029");
  assert.throws(() => new JsonlDecoder(() => {}, 8).push(Buffer.from('123456789')), /limit/);
  assert.throws(() => d.push(Buffer.from('bad\n')));
});
test("RPC requests correlate out-of-order responses and reject failed/mismatched commands", async () => {
  const r = rpc();
  try {
    const [a, b] = await Promise.all([r.request("echo", { value: "a", delay: 20 }), r.request("echo", { value: "b" })]);
    assert.equal(a.value, "a"); assert.equal(b.value, "b");
    await assert.rejects(r.request("reject"), /rejected/);
    await assert.rejects(r.request("wrong"), /mismatch/);
  } finally { await r.stop(); }
});
test("RPC timeout is explicit and stops the child, rejecting outstanding requests", async () => {
  // Include process startup headroom when the full suite runs in parallel.
  const r = rpc(5000);
  await r.request("get_state");
  await assert.rejects(r.request("never"), /unknown/);
  await r.stop();
  await assert.rejects(r.request("get_state"), /stopping/);
});
test("per-request timeout can extend preflight without changing ordinary request deadlines", async () => {
  const r = rpc(250);
  try {
    await r.request("get_state", {}, { timeoutMs: 5000 });
    const result = await r.request("echo", { value: "ready", delay: 600 }, { timeoutMs: 2000 });
    assert.equal(result.value, "ready");
    await assert.rejects(r.request("echo", { delay: 600 }), /timed out.*unknown/);
    await r.stop();
    assert.equal(r.exited, true);
  } finally { await r.stop().catch(() => {}); }
});
test("per-request timeout rejects invalid deadlines without submitting or stopping the child", async () => {
  const r = rpc();
  try {
    for (const timeoutMs of [0, -1, NaN, Infinity, 2147483648]) {
      await assert.rejects(r.request("echo", {}, { timeoutMs }), /timeoutMs/);
    }
    assert.equal((await r.request("echo", { value: "still alive" })).value, "still alive");
  } finally { await r.stop(); }
});
test("unexpected child exit rejects pending requests; shutdown is idempotent", async () => {
  const r = rpc();
  await assert.rejects(r.request("die"), /closed/);
  const first = r.stop();
  assert.equal(r.stop(), first);
  await assert.rejects(first, /without confirmed agent\/tool cleanup/);
  assert.throws(() => r.send({ type: "prompt", message: "hi" }), /closed/);
  await assert.rejects(r.request("get_state"), /stopping/);
});
test("JsonlDecoder ignores empty lines and rejects missing type or non-object payloads", () => {
  const events: any[] = [];
  const decoder = new JsonlDecoder(e => events.push(e));
  decoder.push(Buffer.from("\n\n" + JSON.stringify({ type: "first" }) + "\r\n\n" + JSON.stringify({ type: "second" }) + "\n"));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "first");
  assert.equal(events[1].type, "second");

  assert.throws(() => decoder.push(Buffer.from(JSON.stringify({ notype: true }) + "\n")), /Invalid RPC event/);
  assert.throws(() => decoder.push(Buffer.from(JSON.stringify("string-not-object") + "\n")), /Invalid RPC event/);
});

test("stop escalates without EOF when abort cleanup cannot be confirmed", async () => {
  const r = new RpcProcess({ command: process.execPath, cwd: process.cwd(), args: ['-e', `
    let buffer = '';
    process.stdin.on('data', data => {
      buffer += data;
      let n;
      while ((n = buffer.indexOf('\\n')) >= 0) {
        const e = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        if (e.type === 'abort') continue;
        process.stdout.write(JSON.stringify({type:'response', id:e.id, command:e.type, success:true}) + '\\n');
      }
    });
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'eof'}) + '\\n'));
    process.on('SIGTERM', () => process.exit(0));
  `] }, 2000, 50);
  const events: string[] = [];
  r.on('event', e => events.push(e.type));
  await r.request('get_state');
  await assert.rejects(r.stop(), /without confirmed agent\/tool cleanup/);
  assert.equal(events.includes('eof'), false);
});

test("Pi 0.84 fallback confirms an empty queue after abort and rejects a nonempty one", async () => {
  for (const pendingMessageCount of [0, 1]) {
    const r = new RpcProcess({ command: process.execPath, cwd: process.cwd(), args: ['-e', `
      let buffer = '';
      const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
      process.stdin.on('data', data => {
        buffer += data;
        let n;
        while ((n = buffer.indexOf('\\n')) >= 0) {
          const e = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
          if (e.type === 'clear_queue') send({type:'response', id:e.id, command:e.type, success:false, error:'Unknown command: clear_queue'});
          else if (e.type === 'get_state') send({type:'response', id:e.id, command:e.type, success:true, data:{isStreaming:false, isCompacting:false, pendingMessageCount:${pendingMessageCount}}});
          else send({type:'response', id:e.id, command:e.type, success:true});
        }
      });
    `] }, 2000, 50);
    await r.request('get_state');
    if (pendingMessageCount === 0) await r.stop();
    else await assert.rejects(r.stop(), /cannot confirm an empty queue/);
  }
});

const preflightFixture = fileURLToPath(new URL('./fixtures/prompt-preflight-rpc.mjs', import.meta.url));
function preflightRpc(timeout = 1000, grace = 500) {
  const rpc = new RpcProcess({ command: process.execPath, args: [preflightFixture], cwd: process.cwd() }, timeout, grace);
  const events: any[] = [];
  rpc.on('event', event => events.push(event));
  return { process: rpc, events };
}
async function waitForPreflight(events: any[]) {
  for (let i = 0; i < 100; i++) {
    if (events.some(e => e.type === 'preflight')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not start prompt preflight');
}

test('prompt caller timeout leaves unknown acceptance tracked and forbids EOF confirmation', async () => {
  const { process: r, events } = preflightRpc();
  try {
    await r.request('get_state');
    await assert.rejects(r.request('prompt', { message: 'never accepted' }), /timed out.*unknown/);
    await assert.rejects(r.stop(), /Prompt preflight did not settle/);
    assert.ok(events.some(e => e.type === 'signal_received'));
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});

test('late success/rejection receipts after caller cancellation drain preflight before cleanup, not model completion', async () => {
  for (const accepted of [true, false]) {
    const { process: r, events } = preflightRpc();
    try {
      await r.request('get_state');
      const prompt = assert.rejects(r.request('prompt', { message: 'gated', receiptDelay: 200, accepted }), /stopping/);
      await waitForPreflight(events);
      const stopping = r.stop();
      for (const type of ['prompt', 'steer', 'follow_up']) {
        await assert.rejects(r.request(type, { message: 'new work' }), /stopping/);
        assert.throws(() => r.send({ type, message: 'raw new work' }), /stopping/);
      }
      await stopping;
      await prompt;
      assert.deepEqual(events.map(e => e.type), ['preflight', 'receipt', 'cleanup_command', 'cleanup_command', 'eof']);
      assert.deepEqual(events.filter(e => e.type === 'cleanup_command').map(e => e.command), ['clear_queue', 'abort']);
      assert.equal(events.some(e => e.type === 'model_complete'), false);
    } finally { await r.stop().catch(() => {}); }
  }
});

test('late prompt receipt after caller timeout can confirm cleanup only inside the bounded preflight wait', async () => {
  const { process: r, events } = preflightRpc(1000, 1000);
  try {
    await r.request('get_state');
    await assert.rejects(r.request('prompt', { message: 'slow receipt', receiptDelay: 1300 }), /timed out.*unknown/);
    await r.stop();
    assert.deepEqual(events.map(e => e.type), ['preflight', 'receipt', 'cleanup_command', 'cleanup_command', 'eof']);
  } finally { await r.stop().catch(() => {}); }
});

test('mismatched prompt receipts do not erase unknown acceptance', async () => {
  const { process: r, events } = preflightRpc();
  try {
    await r.request('get_state');
    await assert.rejects(r.request('prompt', { message: 'wrong receipt', receiptDelay: 10, wrongCommand: true }), /mismatch/);
    await assert.rejects(r.stop(), /Prompt preflight did not settle/);
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});

test('synchronous stdin write failure does not leave a phantom prompt preflight', async () => {
  const r = rpc();
  const child = (r as unknown as { child: ChildProcessWithoutNullStreams }).child;
  let closed = false;
  r.on('closed', () => { closed = true; });
  await r.request('get_state');
  const write = child.stdin.write;
  child.stdin.write = () => { throw new Error('synchronous write failure'); };
  try {
    assert.throws(() => r.send({ type: 'prompt', id: 'failed-send', message: 'not sent' }), /synchronous write failure/);
    await assert.rejects(r.request('prompt', { message: 'not sent either' }), /synchronous write failure/);
  } finally { child.stdin.write = write; }
  await r.stop();
  assert.equal(closed, true, 'successful stop must observe child closure');
});

test('stdin backpressure and asynchronous errors retain unknown prompt acceptance', async () => {
  const { process: r, events } = preflightRpc();
  const child = (r as unknown as { child: ChildProcessWithoutNullStreams }).child;
  let closed = false;
  r.on('closed', () => { closed = true; });
  try {
    await r.request('get_state');
    const write = child.stdin.write;
    // A false return is backpressure, not a synchronous submission failure.
    child.stdin.write = () => false;
    try { r.send({ type: 'prompt', message: 'possibly submitted' }); }
    finally { child.stdin.write = write; }
    child.stdin.emit('error', new Error('asynchronous stream failure'));
    await assert.rejects(r.stop(), /without confirmed agent\/tool cleanup.*Prompt preflight did not settle/);
    assert.equal(closed, true, 'failed cleanup still waits for child closure');
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});

test('child closure interrupts preflight wait promptly without confirming cleanup', async () => {
  const { process: r, events } = preflightRpc(1000, 5000);
  const child = (r as unknown as { child: ChildProcessWithoutNullStreams }).child;
  try {
    await r.request('get_state');
    r.send({ type: 'prompt', message: 'unresolved on exit' });
    await waitForPreflight(events);
    const stopping = r.stop();
    // Let stop enter its preflight wait before the process closes.
    await new Promise(resolve => setImmediate(resolve));
    const closed = new Promise<void>(resolve => r.once('closed', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        assert.rejects(stopping, /without confirmed agent\/tool cleanup.*acceptance is unknown after child exit/),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stop waited for preflight grace after child closure')), 1000); }),
      ]);
    } finally { clearTimeout(timer); }
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});

test('all unresolved prompts count, including unawaited raw sends without caller promises', async () => {
  const { process: r, events } = preflightRpc();
  try {
    await r.request('get_state');
    r.send({ type: 'prompt', message: 'raw unresolved prompt' });
    await r.request('prompt', { message: 'later handled prompt', receiptDelay: 10, accepted: false }).catch(() => {});
    await assert.rejects(r.stop(), /Prompt preflight did not settle/);
    assert.equal(events.filter(e => e.type === 'preflight').length, 2);
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});
