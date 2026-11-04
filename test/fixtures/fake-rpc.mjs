// Deterministic fake child: protocol only, never loads Pi or calls a provider.
import { appendFileSync } from 'node:fs';
let buffer = '', scenario = '', question, busy = false;
const send = e => process.stdout.write(JSON.stringify(e) + '\n');
const response = (e, data) => send({ type: 'response', id: e.id, command: e.type, success: true, data });
const assistant = (value, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text: value }], stopReason, errorMessage: stopReason === 'error' ? 'provider failed' : undefined });
function complete(stop = 'stop') {
  busy = false;
  send({ type: 'message_end', message: assistant('finished ' + scenario, stop) });
  send({ type: 'agent_end', messages: [assistant('finished', stop)] });
  setTimeout(() => send({ type: 'agent_settled' }), 10);
}
function handle(e) {
  if (e.type === 'never') return;
  if (e.type === 'wrong') return send({ type: 'response', id: e.id, command: 'other', success: true });
  if (e.type === 'reject') return send({ type: 'response', id: e.id, command: e.type, success: false, error: 'rejected' });
  if (e.type === 'die') return process.exit(2);
  if (e.type === 'get_commands') return response(e, { commands: [{ name: 'rpc-subagent-preflight' }] });
  if (e.type === 'get_state') return response(e, { isStreaming: busy, isCompacting: false, pendingMessageCount: 0 });
  if (e.type === 'extension_ui_response') {
    if (!question || question.id !== e.id) return;
    send({ type: 'tool_execution_end', toolName: 'ask_question', toolCallId: 'ask-1', result: { content: [{ type: 'text', text: e.value }] } });
    question = undefined; complete(); return;
  }
  if (e.type === 'prompt' && e.message === '/rpc-subagent-preflight') return response(e);
  if (e.type === 'prompt') {
    if (e.message.includes('SCENARIO_REJECT_MESSAGE') && e.message.startsWith('Supplementary parent')) {
      return send({ type: 'response', id: e.id, command: 'prompt', success: false, error: 'supplement rejected' });
    }
    response(e);
    if (e.message.startsWith('Supplementary parent')) {
      busy = true;
      send({ type: 'queue_update', steering: [e.message], followUp: [] });
      // Deliberately inject an obsolete settled event while the new work is running.
      // The manager must consult current RPC state rather than stop this run.
      send({ type: 'agent_settled' });
      scenario = e.message;
      setTimeout(() => complete(), 80); return;
    }
    scenario = e.message;
    busy = true;
    send({ type: 'agent_start' });
    send({ type: 'message_start', message: assistant('') });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working 中文\u2028yes' } });
    send({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'src/auth.ts' } });
    send({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file read' }] } });
    if (scenario.includes('SCENARIO_QUESTION')) {
      send({ type: 'tool_execution_start', toolCallId: 'ask-1', toolName: 'ask_question', args: { question: 'Which interface?' } });
      question = { type: 'extension_ui_request', id: 'q-1', method: 'input', title: 'Which interface?' }; send(question);
    } else if (scenario.includes('SCENARIO_DIE')) setTimeout(() => process.exit(4), 15);
    else if (scenario.includes('SCENARIO_HOLD')) return;
    else if (scenario.includes('SCENARIO_ERROR')) setTimeout(() => complete('error'), 30);
    else if (scenario.includes('Assigned task:\nSCENARIO_TRANSPORT')) {
      busy = false;
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'terminated', content: [{ type: 'thinking', thinking: 'partial review' }] } });
      send({ type: 'agent_end', messages: [] });
      setTimeout(() => send({ type: 'agent_settled' }), 10);
    } else setTimeout(() => complete(), 30);
    return;
  }
  if (e.type === 'echo') return setTimeout(() => response(e, { value: e.value }), e.delay ?? 0);
  response(e);
}
process.stdin.on('data', d => {
  buffer += d.toString();
  let n;
  while ((n = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (line) handle(JSON.parse(line)); }
});
process.stdin.on('end', () => process.exit(0));
