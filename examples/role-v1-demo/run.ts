import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../../pi-extension/subagents/rpc.ts";

// No test-directory imports or external model/service credentials.
const dir = mkdtempSync(join(tmpdir(), "mesh-role-demo-"));
const log = join(dir, "requests.jsonl"), session = join(dir, "pm.jsonl");
mkdirSync(join(dir, ".pi"));
writeFileSync(join(dir, ".pi/agent-mesh.yaml"), `schema_version: 1
enabled: true
main_role: pm
roles:
  pm: builtin:pm
  builder: builtin:builder
  tester: builtin:tester
  reviewer: builtin:reviewer
mcp_servers: {}
`);
const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_AGENT_MESH_CONFIG: "", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", MESH_DEMO_LOG: log };
for (const key of Object.keys(env)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete (env as NodeJS.ProcessEnv)[key];
const pkg = getPackageDir();
const cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env, args: [cli, "--mode", "rpc", "--session", session,
  "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve", "--model", "mesh-demo/pm", "--thinking", "off",
  "-e", fileURLToPath(new URL("./provider.ts", import.meta.url)), "-e", fileURLToPath(new URL("../../pi-extension/subagents/index.ts", import.meta.url))] });
const events: any[] = [];
rpc.on("event", event => events.push(event));
const requests = (): any[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 40000;
  while (!await check()) {
    if (Date.now() > end) throw new Error(`Demo timeout; artifacts: ${dir}\n${JSON.stringify(events.slice(-8))}`);
    await new Promise(r => setTimeout(r, 25));
  }
}
async function idle() { await until(async () => !(await rpc.request("get_state")).isStreaming); }
async function call(name: string, args: unknown, expectError = false) {
  await idle();
  const start = events.length;
  await rpc.request("prompt", { message: `CALL ${JSON.stringify({ name, arguments: args })}` });
  await until(() => events.slice(start).some(e => e.type === "tool_execution_end" && e.toolName === name));
  const result = events.slice(start).find(e => e.type === "tool_execution_end" && e.toolName === name);
  assert.equal(result.isError, expectError, JSON.stringify(result));
  await idle();
  return result;
}
function notification(type: string, name?: string) {
  return events.some(e => e.type === "message_end" && e.message?.customType === type && e.message.details?.state === "completed" && (!name || JSON.stringify(e.message.content).includes(name)));
}
try {
  for (const [role, task, contextText] of [["builder", "DEMO_BUILD", "BUILDER_SELECTED_ONLY"], ["tester", "DEMO_TEST", "TESTER_SELECTED_ONLY"], ["reviewer", "DEMO_REVIEW", undefined]]) {
    const name = `demo-${role}`;
    await call("subagent", { name, role, task, ...(contextText ? { contextText } : {}) });
    await until(() => notification("rpc_subagent_result", name));
  }
  assert.equal(readFileSync(join(dir, "built.txt"), "utf8"), "ROLE_DEMO_CODE\n");
  await call("workflow_run", { name: "demo-dag", model: "mesh-demo/worker", context: "partial", contextText: "WORKFLOW_FALLBACK_ONLY", steps: [
    { id: "build", role: "builder", model: "mesh-demo/override", context: "partial", contextText: "STEP_SELECTED_ONLY", task: "DEMO_BUILD", dependsOn: [] },
    { id: "review", role: "reviewer", context: "none", dependencyReports: "omit", task: "DEMO_REVIEW", dependsOn: ["build"] },
  ] });
  await until(() => notification("rpc_workflow_result"));
  await idle();
  const all = requests(), children = all.filter(r => r.child), parents = all.filter(r => !r.child);
  assert(parents.length && children.length);
  assert(parents.every(r => !r.tools.includes("bash") && !r.tools.includes("write")));
  assert.match(parents[0].prompt, /# PM/);
  assert.doesNotMatch(parents[0].prompt, /# Builder|# Tester|# Reviewer/);
  const builds = children.filter(r => /# Builder/.test(r.prompt));
  const tests = children.filter(r => /# Tester/.test(r.prompt));
  const reviews = children.filter(r => /# Reviewer/.test(r.prompt));
  assert(builds.length >= 4 && tests.length >= 2 && reviews.length >= 4);
  assert(builds.every(r => r.tools.includes("write") && r.tools.includes("bash")));
  assert(tests.every(r => r.tools.includes("bash") && !r.tools.includes("write") && !r.tools.includes("edit")));
  assert(reviews.every(r => r.tools.join(",") === "read,grep,find,ls,ask_question"));
  assert(children.every(r => !r.tools.some((t: string) => ["subagent", "subagent_control", "workflow_run", "workflow_control", "roles_list"].includes(t))));
  assert(tests.some(r => JSON.stringify(r.messages).includes("ROLE_DEMO_TEST_OK")));
  assert(reviews.every(r => !/BUILDER_SELECTED_ONLY|TESTER_SELECTED_ONLY|STEP_SELECTED_ONLY|WORKFLOW_FALLBACK_ONLY|DEMO_REPORT_PRIVATE|Direct dependency results/.test(JSON.stringify(r.messages))));
  assert(reviews.some(r => JSON.stringify(r.messages).includes("ROLE_DEMO_CODE"))); // actual read result
  assert(builds.some(r => r.model === "mesh-demo/override" && JSON.stringify(r.messages).includes("STEP_SELECTED_ONLY")));
  assert(reviews.some(r => r.model === "mesh-demo/worker"));
  assert(children.every(r => !/# PM/.test(r.prompt)));
  assert(builds.every(r => !/# Tester|# Reviewer/.test(r.prompt)));
  assert(tests.every(r => !/# Builder|# Reviewer/.test(r.prompt)));
  assert(reviews.every(r => !/# Builder|# Tester/.test(r.prompt)));
  const rejected = await call("subagent", { task: "Legacy still requires explicit access", context: "none" }, true);
  assert.match(JSON.stringify(rejected), /access/);
  assert.match(readFileSync(session, "utf8"), /agent_mesh_pm/);
  assert.equal(events.some(e => e.type === "extension_error"), false, JSON.stringify(events.filter(e => e.type === "extension_error")));
  console.log("PASS: real offline Pi RPC; PM snapshot; public Builder/Tester/Reviewer tools and execution; DAG partial vs none/omit; model/context separation.");
} finally {
  await rpc.stop();
  if (process.env.MESH_DEMO_KEEP === "1") console.log(`Artifacts: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
