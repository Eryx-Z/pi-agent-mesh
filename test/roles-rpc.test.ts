import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";

const pkg = getPackageDir();
const cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
const entry = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/m0-provider.ts", import.meta.url));

function setup(config?: string) {
  const dir = mkdtempSync(join(tmpdir(), "roles-rpc-"));
  mkdirSync(join(dir, ".pi", "roles", "builder"), { recursive: true });
  const configPath = join(dir, ".pi", "agent-mesh.yaml");
  const requests = join(dir, "requests.jsonl");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_AGENT_MESH_CONFIG: "",
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", M0_REQUEST_LOG: requests };
  for (const key of Object.keys(env)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete env[key];
  if (config) writeFileSync(configPath, config);
  const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env, args: [cli, "--mode", "rpc", "--session", join(dir, "parent.jsonl"),
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--model", "m0-fixture/test", "--thinking", "off", "-e", provider, "-e", entry] });
  const events: { type: string; [key: string]: any }[] = [];
  rpc.on("event", e => events.push(e));
  const command = async (message: string) => {
    const start = events.length;
    await rpc.request("prompt", { message });
    return JSON.stringify(events.slice(start));
  };
  return { dir, rpc, configPath, requests, events, command, async close() { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("roles catalog command inspects and atomically reloads without executing configured resources", { timeout: 30000 }, async () => {
  const t = setup(`schema_version: 1\nenabled: true\nmain_role: pm\nroles:\n  pm: builtin:pm\n  builder: ./roles/builder/role.yaml\nmcp_servers:\n  trap:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", "require('node:fs').writeFileSync('mcp-started', 'unsafe')"]\n`);
  const rolePath = join(t.dir, ".pi", "roles", "builder", "role.yaml");
  const role = (description: string) => `schema_version: 1\nid: builder\ndescription: ${description}\nsystem_prompt: ./system.md\nbuiltin_tools: [read, bash]\nmcp: [{server: trap, tools: [echo]}]\nextra_tools: [{entry: ./tool.ts, tools: [run_tests]}]\ndefaults: {access: full, context: partial}\n`;
  writeFileSync(rolePath, role("Original builder"));
  writeFileSync(join(t.dir, ".pi", "roles", "builder", "system.md"), "Builder role body not to be injected by catalog queries.");
  writeFileSync(join(t.dir, ".pi", "roles", "builder", "tool.ts"), "import {writeFileSync} from 'node:fs'; writeFileSync('extension-imported', 'unsafe'); export default function() {}\n");
  try {
    assert.ok((await t.rpc.request("get_commands")).commands.some((c: { name: string }) => c.name === "roles"));
    const list = await t.command("/roles");
    assert.match(list, /Original builder/);
    assert.match(list, /catalog preview/i);
    assert.match(list, /not.*ready|not.*readiness|readiness.*not/i);
    const inspect = await t.command("/roles inspect builder");
    assert.match(inspect, /system\.md/);
    assert.match(inspect, /run_tests/);
    assert.match(inspect, /trap/);
    assert.match(inspect, /echo/);
    assert.doesNotMatch(inspect, /require\('node:fs'\)/, "Catalog must not reveal server configuration or credentials");
    writeFileSync(rolePath, role("Changed builder"));
    assert.match(await t.command("/roles"), /Original builder/, "Catalog stays frozen until explicit reload");
    assert.match(await t.command("/roles reload"), /Changed builder/);
    writeFileSync(t.configPath, readFileSync(t.configPath, "utf8") + "unexpected: true\n");
    const failure = await t.command("/roles reload");
    assert.match(failure, /unexpected/);
    assert.match(failure, /kept|retained/i);
    assert.match(await t.command("/roles"), /Changed builder/);
    assert.equal(existsSync(join(t.dir, "mcp-started")), false);
    assert.equal(existsSync(join(t.dir, "extension-imported")), false);
    assert.equal(existsSync(t.requests), false);
    assert.equal((await t.rpc.request("get_state")).messageCount, 0);
    await t.rpc.request("prompt", { message: 'CALL {"name":"roles_list","arguments":{}}' });
    for (let i = 0; i < 300; i++) {
      const messages = (await t.rpc.request("get_messages")).messages;
      if (messages.some((m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "roles_list") && !(await t.rpc.request("get_state")).isStreaming) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const messages = (await t.rpc.request("get_messages")).messages;
    const result = messages.find((m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "roles_list");
    assert.equal(result?.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /Changed builder/);
    assert.equal(existsSync(join(t.dir, "mcp-started")), false);
    assert.equal(existsSync(join(t.dir, "extension-imported")), false);
    assert.equal(t.events.some(e => e.type === "extension_error"), false);
  } finally { await t.close(); }
});
