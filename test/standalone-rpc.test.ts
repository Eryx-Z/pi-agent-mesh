import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import type { TaskRecord } from "../pi-extension/subagents/store.ts";

// Opt in with an absolute standalone Pi path. Uses a scripted local provider only.
const binary = process.env.PI_MESH_TEST_BINARY;
test("standalone Pi initializes ownership and runs RPC children", { skip: !binary, timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-standalone-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_RPC_SUBAGENT_") || key === "PI_SESSION_FILE" || key === "PI_SESSION_ID") delete env[key];
  const entry = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
  const provider = fileURLToPath(new URL("./fixtures/builtin-provider.ts", import.meta.url));
  writeFileSync(join(dir, "fixture-input.txt"), "standalone inheritance verified");
  const rpc = new RpcProcess({ command: binary!, cwd: dir, env, args: [
    "--mode", "rpc", "--session", join(dir, "parent.jsonl"), "--no-extensions", "--no-skills",
    "--no-context-files", "--no-prompt-templates", "--no-approve", "--tools", "read,subagent,subagent_control",
    "--model", "builtin-fixture/test", "--thinking", "off", "-e", provider, "-e", entry,
  ] });
  const errors: unknown[] = [];
  rpc.on("event", event => {
    if (event.type === "extension_error" || (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error")) errors.push(event);
  });
  let ownerPath: string | undefined;
  try {
    const state = await rpc.request("get_state");
    const recordDir = join(dir, "rpc-subagents", state.sessionId);
    ownerPath = join(recordDir, ".owner.json");
    assert.ok(existsSync(ownerPath), "Command registration alone must not count as successful session initialization");
    assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).active, true);
    await rpc.request("prompt", { message: "/subagents" });
    for (const access of ["full", "read-only"] as const) {
      await rpc.request("prompt", { streamingBehavior: "followUp", message: `DISPATCH ${JSON.stringify({ name: access, task: "READ_BUILTIN", access, context: "none" })}` });
      let record: TaskRecord | undefined;
      for (let i = 0; i < 1000; i++) {
        record = readdirSync(recordDir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))
          .map(f => JSON.parse(readFileSync(join(recordDir, f), "utf8")) as TaskRecord).find(r => r.name === access && r.stopped);
        if (record) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(record, `Standalone ${access} task did not settle`);
      assert.equal(record.state, "completed", record.error);
      assert.match(record.output, /standalone inheritance verified/);
      const transcript = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(transcript.some(e => e.message?.role === "toolResult" && e.message.toolName === "read" && !e.message.isError));
    }
    assert.deepEqual(errors, []);
  } finally {
    try {
      await rpc.stop();
      if (ownerPath && existsSync(ownerPath)) assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).active, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
