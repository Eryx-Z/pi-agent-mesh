import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRoles } from "../pi-extension/subagents/roles-ui.ts";

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const messages: string[] = [];
  const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
  const context = (cwd: string) => ({ cwd, ui: { notify: (text: string) => messages.push(text) } }) as unknown as ExtensionContext;
  return { api, context, handlers, commands, tools, messages };
}

test("role directory controls are not registered in a child", () => {
  const before = process.env.PI_RPC_SUBAGENT_CHILD;
  process.env.PI_RPC_SUBAGENT_CHILD = "1";
  try {
    const h = harness(); registerRoles(h.api);
    assert.equal(h.commands.size, 0); assert.equal(h.tools.size, 0); assert.equal(h.handlers.size, 0);
  } finally { if (before === undefined) delete process.env.PI_RPC_SUBAGENT_CHILD; else process.env.PI_RPC_SUBAGENT_CHILD = before; }
});

test("catalog UI pins startup directory and explicit selection before lazy first query", async t => {
  const dir = mkdtempSync(join(tmpdir(), "roles-ui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "agent-mesh.yaml"), "schema_version: 1\nenabled: false\n");
  const before = process.env.PI_AGENT_MESH_CONFIG;
  try {
    process.env.PI_AGENT_MESH_CONFIG = "";
    const h = harness(); registerRoles(h.api);
    await h.handlers.get("session_start")!({}, h.context(dir));
    process.env.PI_AGENT_MESH_CONFIG = "missing-explicit-config.yaml";
    await h.handlers.get("session_start")!({}, h.context(join(dir, "different-session")));
    await h.commands.get("roles").handler("", h.context(join(dir, "worktree")));
    assert.match(h.messages.at(-1)!, /disabled/);
    assert.ok(h.messages.at(-1)!.includes(join(dir, ".pi", "agent-mesh.yaml")));
    assert.doesNotMatch(h.messages.at(-1)!, /missing-explicit|Static configuration error/);
    await h.commands.get("roles").handler("inspect", h.context(dir));
    assert.match(h.messages.at(-1)!, /Usage:/);
    await h.commands.get("roles").handler("inspect unknown", h.context(dir));
    assert.match(h.messages.at(-1)!, /Role not found/);
  } finally { if (before === undefined) delete process.env.PI_AGENT_MESH_CONFIG; else process.env.PI_AGENT_MESH_CONFIG = before; }
});

test("each session_start rereads the selected catalog while retaining process-start path selection", async t => {
  const dir = mkdtempSync(join(tmpdir(), "roles-ui-session-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi/agent-mesh.yaml"), "schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: ./pm.yaml}\n");
  writeFileSync(join(dir, ".pi/pm.yaml"), "schema_version: 1\nid: pm\ndescription: PM\nsystem_prompt: ./pm.md\nbuiltin_tools: []\ndefaults: {access: read-only}\n");
  const body = join(dir, ".pi/pm.md"); writeFileSync(body, "ORIGINAL_BODY");
  const old = process.env.PI_AGENT_MESH_CONFIG; process.env.PI_AGENT_MESH_CONFIG = "";
  try {
    const h = harness(), access = registerRoles(h.api)!;
    await h.handlers.get("session_start")!({}, h.context(dir));
    assert.equal((await access.current(h.context(dir))).current!.roles[0].systemPrompt, "ORIGINAL_BODY");
    writeFileSync(body, "CHANGED_BODY");
    assert.equal((await access.current(h.context(dir))).current!.roles[0].systemPrompt, "ORIGINAL_BODY");
    await h.handlers.get("session_start")!({}, h.context(dir));
    assert.equal((await access.current(h.context(dir))).current!.roles[0].systemPrompt, "CHANGED_BODY");
  } finally { if (old === undefined) delete process.env.PI_AGENT_MESH_CONFIG; else process.env.PI_AGENT_MESH_CONFIG = old; }
});

test("first invalid catalog never becomes a successful empty list and can recover by reload", async t => {
  const dir = mkdtempSync(join(tmpdir(), "roles-ui-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "team.yaml");
  const before = process.env.PI_AGENT_MESH_CONFIG;
  try {
    process.env.PI_AGENT_MESH_CONFIG = config;
    const h = harness(); registerRoles(h.api);
    await h.handlers.get("session_start")!({}, h.context(dir));
    await h.commands.get("roles").handler("", h.context(dir));
    assert.match(h.messages.at(-1)!, /Static configuration error/);
    assert.match(h.messages.at(-1)!, /No valid directory/);
    writeFileSync(config, "schema_version: 1\nenabled: false\n");
    await h.commands.get("roles").handler("reload", h.context(dir));
    assert.match(h.messages.at(-1)!, /reloaded/);
    assert.doesNotMatch(h.messages.at(-1)!, /Static configuration error/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(h.tools.get("roles_list").execute("test", {}, abort.signal, undefined, h.context(dir)), /abort/i);
  } finally { if (before === undefined) delete process.env.PI_AGENT_MESH_CONFIG; else process.env.PI_AGENT_MESH_CONFIG = before; }
});
