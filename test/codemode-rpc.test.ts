import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import type { TaskRecord } from "../pi-extension/subagents/store.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const extension = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/builtin-provider.ts", import.meta.url));

test("real Pi codemode parent launches full and read-only children without weakening provenance", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codemode-rpc-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete env[key];
  const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env, args: [cli, "--mode", "rpc", "--session", join(dir, "parent.jsonl"),
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve",
    "--tools", "bash,codemode,subagent,subagent_control", "--model", "builtin-fixture/test", "--thinking", "off", "-e", "builtin:codemode", "-e", provider, "-e", extension] });
  try {
    const state = await rpc.request("get_state");
    const recordDir = join(dir, "rpc-subagents", state.sessionId);
    for (const access of ["full", "read-only"] as const) {
      await rpc.request("prompt", { message: `DISPATCH ${JSON.stringify({ task: access === "full" ? "CODEMODE_BUILTIN" : "Report available tools without calling any.", access, context: "none", name: access })}` });
      let record: TaskRecord | undefined;
      for (let i = 0; i < 500; i++) {
        const records = existsSync(recordDir) ? readdirSync(recordDir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(recordDir, f), "utf8")) as TaskRecord) : [];
        record = records.find(r => r.name === access && r.stopped);
        if (record) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(record, `Child ${access} did not settle`);
      assert.equal(record.state, "completed", record.error);
      const expected = access === "full" ? ["ask_question", "bash", "codemode"] : ["ask_question"];
      assert.deepEqual([...record.loadout.tools].sort(), expected);
      if (access === "full") {
        assert.match(record.output, /codemode child executed/);
        const entries = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
        const result = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "codemode");
        assert.ok(result, "Child did not execute codemode");
        assert.ok(!result.message.isError, JSON.stringify(result.message.content));
        assert.equal(record.loadout.toolMetadata.find(t => t.name === "codemode")?.path, "builtin:codemode");
        assert.deepEqual(record.loadout.extensions, ["builtin:codemode"]);
      } else {
        assert.equal(record.output, "Finished");
        assert.deepEqual(record.loadout.extensions, []);
      }
    }
  } finally {
    await rpc.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
