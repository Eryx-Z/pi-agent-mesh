import { TaskManager } from '../../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../../pi-extension/subagents/store.ts';
import { RpcProcess } from '../../pi-extension/subagents/rpc.ts';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./fake-rpc.mjs', import.meta.url));

let manager;
try {
  manager = await TaskManager.open(new TaskStore(process.argv[2]), {
    command: process.execPath,
    executionController: { prepare() {}, wrap(launch) { return launch; }, async cleanup() {} },
    createRpc: launch => {
      const rpc = new RpcProcess({ ...launch, args: [fake] }, 1000, 100);
      const request = rpc.request.bind(rpc);
      rpc.request = (type, fields) => {
        if (type === 'prompt' && fields.message !== '/rpc-subagent-preflight') process.send({ type: 'recovery-prompt' });
        return request(type, fields);
      };
      return rpc;
    },
  });
  process.send({ type: 'opened' });
  if (process.argv[3] === 'recover') manager.startRecovery();
} catch (error) {
  process.send({ type: 'rejected', error: String(error) }, () => process.exit(0));
}
process.on('message', async message => {
  if (message === 'close') {
    await manager?.shutdown();
    process.send({ type: 'closed' }, () => process.exit(0));
  }
});
process.on('disconnect', async () => { await manager?.shutdown(); process.exit(0); });
