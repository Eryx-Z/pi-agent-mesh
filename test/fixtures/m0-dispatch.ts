// M0 prototype only: a parent tool assembles a child independently of its own tools.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RpcProcess } from "../../pi-extension/subagents/rpc.ts";

export default function dispatchProbe(pi: ExtensionAPI) {
  pi.on("before_agent_start", event => { event.systemPromptOptions.sections.m0_role = "M0_PM_ROLE"; });
  pi.registerTool({
    name: "m0_dispatch", label: "M0 dispatch", description: "Dispatch a scripted worker with independent builtin bash", parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const pkg = getPackageDir();
      const cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
      const provider = fileURLToPath(new URL("./m0-provider.ts", import.meta.url));
      const child = new RpcProcess({ command: process.execPath, cwd: ctx.cwd,
        env: { ...process.env, M0_REQUEST_LOG: join(ctx.cwd, "worker-requests.jsonl") },
        args: [cli, "--mode", "rpc", "--session", join(ctx.cwd, "worker.jsonl"), "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve",
          "--tools", "bash", "--model", "m0-fixture/test", "--thinking", "off", "--append-system-prompt", "M0_BUILDER_ROLE", "-e", provider] });
      const cancel = () => { void child.stop().catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        signal?.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("M0 worker did not settle")), 10000);
          child.on("event", event => { if (event.type === "agent_settled") resolve(); });
          child.on("closed", () => reject(new Error("M0 worker exited before settling")));
        });
        try {
          // Attach rejection handling before submission in case startup fails.
          await Promise.all([
            child.request("prompt", { message: 'CALL {"name":"bash","arguments":{"command":"printf M0_WORKER_BASH_OK"}}' }), settled,
          ]);
        } finally { clearTimeout(timer); }
        const messages = await child.request("get_messages");
        return { content: [{ type: "text", text: JSON.stringify(messages) }], details: {} };
      } finally { signal?.removeEventListener("abort", cancel); await child.stop(); }
    },
  });
}
