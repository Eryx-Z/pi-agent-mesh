import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTeamRuntime } from "../pi-extension/subagents/pm.ts";
import { RoleCatalog } from "../pi-extension/subagents/roles.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

test("timed-out model selection is drained before a later session generation can start", { timeout: 3000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pm-auth-readiness-")); t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi/pm.md"), "PM");
  writeFileSync(join(dir, ".pi/pm.yaml"), "schema_version: 1\nid: pm\ndescription: PM\nsystem_prompt: ./pm.md\nbuiltin_tools: []\ndefaults: {access: read-only}\n");
  writeFileSync(join(dir, ".pi/agent-mesh.yaml"), "schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: ./pm.yaml}\n");
  const catalog = new RoleCatalog(dir, ""); catalog.reload();
  let resolveAuth!: (result: boolean) => void, selections = 0;
  const delayed = new Promise<boolean>(resolve => { resolveAuth = resolve; });
  const model = { provider: "fixture", id: "pm" };
  const pi = { on: () => () => {}, getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, setModel: () => { selections++; return delayed; }, setThinkingLevel() {}, appendEntry() {}, events: { emit() {} } } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, model, modelRegistry: { find: () => model }, thinkingLevel: "off", isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [], getSessionFile: () => join(dir, "session.jsonl") }, ui: { notify() {}, setStatus() {} } } as unknown as ExtensionContext;
  const runtime = createTeamRuntime(pi, { current: async () => catalog, pin() {}, summary: async () => "" }, { readinessMs: 100 });
  await runtime.start(ctx); assert.equal(runtime.state, "failed"); assert.equal(selections, 1);
  let stopped = false; const stop = runtime.stop().then(() => { stopped = true; });
  await new Promise(r => setTimeout(r, 25)); assert.equal(stopped, false, "Underlying host model selection must settle before shutdown/new-session is acknowledged");
  resolveAuth(true); await stop; assert.equal(runtime.state, "off");
});

for (const mode of ["never", "late", "shutdown"] as const) test(`PM ${mode} local factory is bounded and cannot register late into the real host`, { timeout: 7000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pm-local-readiness-")); t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, ".pi"));
  const factory = mode === "never" ? "await new Promise(() => {});" : "await new Promise(r => setTimeout(r, 2000));";
  writeFileSync(join(dir, ".pi/tool.mjs"), `import {writeFileSync} from 'node:fs'; export default async pi => { writeFileSync(${JSON.stringify(join(dir, "entered"))}, 'yes'); ${factory} pi.registerTool({name:'probe',label:'Probe',description:'Probe',parameters:{type:'object',properties:{}},async execute(){return {content:[],details:{}}}}); }`);
  writeFileSync(join(dir, ".pi/pm.md"), "PM local readiness test");
  writeFileSync(join(dir, ".pi/pm.yaml"), "schema_version: 1\nid: pm\ndescription: PM\nsystem_prompt: ./pm.md\nbuiltin_tools: []\nextra_tools: [{entry: ./tool.mjs, tools: [probe]}]\ndefaults: {access: full}\n");
  writeFileSync(join(dir, ".pi/agent-mesh.yaml"), "schema_version: 1\nenabled: true\nmain_role: pm\nroles: {pm: ./pm.yaml}\n");
  const catalog = new RoleCatalog(dir, ""); catalog.reload();
  const notifications: string[] = [], registered: string[] = [], entries: any[] = [];
  const model = { provider: "fixture", id: "pm" };
  const pi = { on: () => () => {}, getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, setModel: async () => true, setThinkingLevel() {},
    registerTool: (tool: any) => registered.push(tool.name), appendEntry: (type: string, data: any) => entries.push({ type, data }), events: { emit() {} } } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, model, modelRegistry: { find: () => model }, thinkingLevel: "off", isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [], getSessionFile: () => join(dir, "pm.jsonl") }, ui: { notify: (s: string) => notifications.push(s), setStatus() {} } } as unknown as ExtensionContext;
  const runtime = createTeamRuntime(pi, { current: async () => catalog, pin() {}, summary: async () => "catalog" }, { readinessMs: 1000 });
  const started = Date.now(), start = runtime.start(ctx);
  if (mode === "shutdown") { await new Promise(r => setTimeout(r, 30)); await runtime.stop(); }
  // Keep an independent guard so the RED reproduction finishes rather than hanging the runner.
  let guard: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([start, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("PM initialization was not bounded")), 3000); })]); }
  finally { clearTimeout(guard); }
  assert.ok(Date.now() - started < 3000);
  assert.equal(runtime.state, mode === "shutdown" ? "off" : "failed");
  if (mode !== "shutdown") { assert.match(notifications.join("\n"), /deadline|abort|timeout/i); assert.equal(readFileSync(join(dir, "entered"), "utf8"), "yes"); }
  await new Promise(r => setTimeout(r, mode === "never" ? 10 : 2100));
  assert.deepEqual(registered, []); assert.ok(!entries.some(e => e.type === "agent_mesh_pm"));
});
