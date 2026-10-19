import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";

const pkg = getPackageDir();
const cli = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin.pi);
const provider = fileURLToPath(new URL("./fixtures/m0-provider.ts", import.meta.url));
const bridge = fileURLToPath(new URL("./fixtures/m0-pm.ts", import.meta.url));
function lines(path: string): string[] { return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : []; }
async function waitUntil(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function launch(dir: string, tools = "read", extensions = [bridge], more: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    M0_REQUEST_LOG: join(dir, "requests.jsonl"), M0_LIFECYCLE_LOG: join(dir, "lifecycle.log"), M0_INVENTORY: join(dir, "inventory.json"), M0_SIDE_EFFECT: join(dir, "unauthorized"), ...more };
  for (const key of Object.keys(env)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete env[key];
  return new RpcProcess({ command: process.execPath, cwd: dir, env,
    args: [cli, "--mode", "rpc", "--session", join(dir, "session.jsonl"), "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve",
      ...(tools ? ["--tools", tools] : []), "--model", "m0-fixture/test", "--thinking", "off", "-e", provider, ...extensions.flatMap(e => ["-e", e])] });
}
async function idle(rpc: RpcProcess, dir: string, minimumRequests: number) {
  await waitUntil(async () => lines(join(dir, "requests.jsonl")).length >= minimumRequests && !(await rpc.request("get_state")).isStreaming, "provider completion");
}

test("M0: PM input and recovery notifications wait for readiness; first request has role and progressive skills", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "m0-pm-"));
  const skill = join(dir, "SKILL.md");
  writeFileSync(skill, "---\nname: pm-probe\ndescription: M0 PM skill description\n---\nM0_SKILL_BODY_NOT_IN_SYSTEM\n");
  const rpc = launch(dir, "read,m0_dynamic", [bridge], { M0_SKILL: skill });
  try {
    await rpc.request("get_state");
    await rpc.request("prompt", { message: "must be handled before readiness" });
    await rpc.request("prompt", { message: "/m0-inspect" });
    const initial = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf8"));
    assert.equal(initial.state, "initializing");
    assert.ok(initial.skills.some((s: { name: string }) => s.name === "pm-probe"));
    assert.equal(lines(join(dir, "requests.jsonl")).length, 0, "User and internal notifications must not invoke a provider");
    assert.deepEqual(lines(join(dir, "lifecycle.log")), ["session_start", "resources_discover"]);
    await rpc.request("prompt", { message: "/m0-ready" });
    await idle(rpc, dir, 1);
    const first = JSON.parse(lines(join(dir, "requests.jsonl"))[0]);
    assert.equal(first.prompt.split("M0_PM_ROLE").length - 1, 1);
    assert.match(first.prompt, /M0 PM skill description/);
    assert.doesNotMatch(first.prompt, /M0_SKILL_BODY_NOT_IN_SYSTEM/);
    assert.deepEqual(first.tools.sort(), ["m0_dynamic", "read"]);
    assert.ok(readFileSync(join(dir, "session.jsonl"), "utf8").includes('"customType":"m0_pm_snapshot"'));
    const messages = await rpc.request("get_messages");
    assert.match(JSON.stringify(messages), /M0 recovery result/);
    assert.match(JSON.stringify(messages), /M0 worker question/);
    await rpc.request("prompt", { message: "second user input" });
    await idle(rpc, dir, 2);
    assert.equal(JSON.parse(lines(join(dir, "requests.jsonl"))[1]).prompt.split("M0_PM_ROLE").length - 1, 1);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("M0: failed PM never releases queued internal notifications", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "m0-pm-failed-"));
  const rpc = launch(dir);
  try {
    await rpc.request("get_state");
    await rpc.request("prompt", { message: "/m0-fail" });
    await rpc.request("prompt", { message: "blocked user input" });
    const errors: unknown[] = [];
    rpc.on("event", event => { if (event.type === "extension_error") errors.push(event); });
    // Slash command throws are reported as events, NOT a failed RPC receipt.
    await rpc.request("prompt", { message: "/m0-ready" });
    assert.match(JSON.stringify(errors), /PM failed/);
    assert.equal(lines(join(dir, "requests.jsonl")).length, 0);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("M0: dynamic tools require a post-registration exact allowlist; direct and nested unauthorized calls are blocked", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "m0-dynamic-"));
  const rpc = launch(dir, "");
  try {
    await rpc.request("get_state");
    await rpc.request("prompt", { message: "/m0-inspect" });
    const inventory = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf8"));
    assert.ok(inventory.tools.some((t: { name: string }) => t.name === "m0_dynamic"));
    assert.equal(inventory.tools.find((t: { name: string }) => t.name === "m0_dynamic").sourceInfo.path, bridge);
    // No CLI list in this branch: unknown future MCP names cannot be enumerated.
    // No model request is allowed before the post-discovery exact active list.
    assert.equal(lines(join(dir, "requests.jsonl")).length, 0);
    await rpc.request("prompt", { message: "/m0-ready" });
    await idle(rpc, dir, 1);
    await rpc.request("prompt", { message: 'CALL {"name":"m0_dynamic","arguments":{}}' });
    await idle(rpc, dir, 3);
    await rpc.request("prompt", { message: 'CALL {"name":"m0_unselected","arguments":{}}' });
    await idle(rpc, dir, 5);
    assert.equal(existsSync(join(dir, "unauthorized")), false);
    const transcript = JSON.stringify(await rpc.request("get_messages"));
    assert.match(transcript, /M0 exact allowlist/);
    assert.match(transcript, /parentToolCallId|nestedCalls/);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("M0: restrictive CLI list cannot be expanded by a later setActiveTools call", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "m0-cli-filter-"));
  const rpc = launch(dir, "read");
  try {
    await rpc.request("prompt", { message: "/m0-ready" });
    await idle(rpc, dir, 1);
    const first = JSON.parse(lines(join(dir, "requests.jsonl"))[0]);
    assert.deepEqual(first.tools, ["read"], "Late m0_dynamic registration cannot escape the CLI registry filter");
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("M0: independently assembled worker has bash while PM declaration does not", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "m0-parent-worker-"));
  const dispatch = fileURLToPath(new URL("./fixtures/m0-dispatch.ts", import.meta.url));
  const parent = launch(dir, "read,m0_dispatch", [dispatch]);
  try {
    await parent.request("prompt", { message: 'CALL {"name":"m0_dispatch","arguments":{}}' });
    await idle(parent, dir, 2);
    const first = JSON.parse(lines(join(dir, "requests.jsonl"))[0]);
    assert.equal(first.tools.includes("bash"), false);
    assert.match(first.prompt, /M0_PM_ROLE/);
    const worker = JSON.parse(lines(join(dir, "worker-requests.jsonl"))[0]);
    assert.deepEqual(worker.tools, ["bash"]);
    assert.match(worker.prompt, /M0_BUILDER_ROLE/);
    assert.doesNotMatch(worker.prompt, /M0_PM_ROLE/);
    const messages = (await parent.request("get_messages")).messages;
    const dispatched = messages.find((m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "m0_dispatch");
    assert.equal(dispatched?.isError, false, JSON.stringify(dispatched));
    assert.match(JSON.stringify(dispatched.content), /M0_WORKER_BASH_OK/);
  } finally { await parent.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("M0: input and before_agent_start hooks do not intercept internal triggerTurn", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "m0-hook-negative-"));
  const extension = join(dir, "unsafe-hook.ts");
  writeFileSync(extension, `export default function(pi) {
    pi.on("input", event => event.text === "M0_THROW" ? {action:"continue"} : {action:"handled"});
    pi.on("before_agent_start", () => { throw new Error("M0 hook throw is not a gate"); });
    pi.registerCommand("m0-trigger", { description:"Probe", handler() {
      pi.sendMessage({customType:"m0_internal",content:"internal",display:true},{triggerTurn:true});
    }});
  }`);
  const rpc = launch(dir, "read", [extension]);
  try {
    await rpc.request("prompt", { message: "handled input" });
    assert.equal(lines(join(dir, "requests.jsonl")).length, 0);
    await rpc.request("prompt", { message: "/m0-trigger" });
    await idle(rpc, dir, 1);
    assert.equal(lines(join(dir, "requests.jsonl")).length, 1, "Internal sendMessage bypasses input and prompt preparation");
    const errors: unknown[] = [];
    rpc.on("event", event => { if (event.type === "extension_error") errors.push(event); });
    await rpc.request("prompt", { message: "M0_THROW" });
    await idle(rpc, dir, 2);
    assert.match(JSON.stringify(errors), /M0 hook throw is not a gate/);
    assert.equal(lines(join(dir, "requests.jsonl")).length, 2, "A real before_agent_start throw also fails to gate user requests");
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
