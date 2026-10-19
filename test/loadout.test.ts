import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { CHILD_EXTENSION, isDelegationTool, resolveLoadout, verifyTools, verifySkills, validateLoadout, applyAccess } from "../pi-extension/subagents/loadout.ts";
import { readInfo } from "./fixtures/loadout.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loadout-"));
  const source = join(dir, "unrelated-provider-name.ts");
  writeFileSync(source, "export default function () {}\n");
  const tool = { ...readInfo(dir), name: "custom_search", description: "Search custom data", sourceInfo: { path: source, source: "package:custom", scope: "project" as const, origin: "package" as const } };
  const api = { getActiveTools: () => ["custom_search", "read", "subagent", "subagent_control"], getAllTools: () => [readInfo(dir), tool] };
  const question = { ...tool, name: "ask_question", sourceInfo: { ...tool.sourceInfo, path: CHILD_EXTENSION } };
  const skillPath = join(dir, "SKILL.md"); writeFileSync(skillPath, "---\nname: hidden\ndescription: Hidden skill\ndisable-model-invocation: true\n---\nInstructions");
  const skill: Skill = { name: "hidden", description: "Hidden skill", filePath: skillPath, baseDir: dir, disableModelInvocation: true, sourceInfo: { ...tool.sourceInfo, path: skillPath } };
  return { dir, source, tool, api, question, skill, clean: () => rmSync(dir, {recursive: true, force: true}) };
}
test("loadout freezes actual active tools and all skills, not names guessed from config", () => {
  const t = setup();
  try {
    const alias = join(t.dir, "alias.ts"); symlinkSync(t.source, alias); t.tool.sourceInfo.path = alias;
    const l = resolveLoadout(t.api, [t.skill], t.dir, "fake/test", "high", t.dir);
    assert.deepEqual(l.tools, ["custom_search", "read", "ask_question"]);
    assert.deepEqual(l.extensions, [t.source]);
    assert.equal(l.skills[0].disableModelInvocation, true);
    assert.equal(l.thinking, "high");
    t.skill.description = "later change"; t.tool.description = "later tool change";
    assert.equal(l.skills[0].description, "Hidden skill");
    assert.equal(l.toolMetadata[0].description, "Search custom data");
  } finally { t.clean(); }
});
test("provider-only sources are frozen independently of tool access and validated", () => {
  const t = setup();
  try {
    const api = { ...t.api, events: { emit(channel: string, data: unknown) {
      assert.equal(channel, 'rpc-subagents:provider-source:v1');
      const request = data as { provider: string; register: (path: string) => void };
      assert.equal(request.provider, 'fake'); request.register(t.source);
    }, on() { return () => {}; } } };
    const l = resolveLoadout(api, [], t.dir, 'fake/test', 'low', t.dir);
    assert.deepEqual(l.providerExtensions, [t.source]);
    const ro = applyAccess(l, 'read-only');
    assert.deepEqual(ro.providerExtensions, [t.source]);
    assert.deepEqual(ro.tools, ['read', 'ask_question']);
    assert.deepEqual(ro.extensions, []);
    assert.throws(() => validateLoadout({ ...ro, providerExtensions: ['relative.ts'] }), /absolute/);
    assert.throws(() => validateLoadout({ ...ro, providerExtensions: [t.source, t.source] }), /Invalid provider/);
    unlinkSync(t.source);
    assert.throws(() => validateLoadout(ro), /missing source/);
  } finally { t.clean(); }
});
test("read-only drops custom tools and extension overrides; full preserves inheritance", () => {
  const t = setup();
  try {
    const l = resolveLoadout(t.api, [], t.dir, "fake/test", "high", t.dir);
    assert.deepEqual(applyAccess(l, "full"), l);
    const restricted = applyAccess(l, "read-only");
    assert.deepEqual(restricted.tools, ["read", "ask_question"]);
    assert.deepEqual(restricted.extensions, []);
    assert.ok(l.tools.includes("custom_search"));
    t.tool.name = "read";
    t.api.getActiveTools = () => ["read"];
    t.api.getAllTools = () => [t.tool];
    const overridden = resolveLoadout(t.api, [], t.dir, "fake/test", "high", t.dir);
    assert.deepEqual(applyAccess(overridden, "read-only").tools, ["ask_question"]);
    assert.ok(isDelegationTool("workflow_run")); assert.ok(isDelegationTool("workflow_control"));
  } finally { t.clean(); }
});
test("empty parent active set remains empty except ask_question; delegation names are excluded", () => {
  const t = setup();
  try {
    const names = ["subagent", "subagent_message", "subagents_list", "subagent_control", "spawn_agent", "manage_agents", "agent_spawn", "delegate_task", "mcp_subagent_launch", "roles_list"];
    assert.ok(names.every(isDelegationTool));
    assert.ok(!isDelegationTool("read")); assert.ok(!isDelegationTool("ask_question"));
    for (const active of [[], names]) {
      const l = resolveLoadout({ ...t.api, getActiveTools: () => active }, [], t.dir, "fake/test", "off", t.dir);
      assert.deepEqual(l.tools, ["ask_question"]); assert.deepEqual(l.extensions, []);
    }
  } finally { t.clean(); }
});
test("unavailable inventory, inline/SDK tools, missing source and missing metadata fail explicitly", () => {
  const t = setup();
  try {
    const resolve = (skills: Skill[] | undefined = []) => resolveLoadout(t.api, skills, t.dir, "fake/test", "off", t.dir);
    assert.throws(() => resolveLoadout(t.api, undefined, t.dir, "fake/test", "off", t.dir), /skill inventory is unavailable/);
    t.tool.sourceInfo.source = "sdk"; assert.throws(() => resolve(), /SDK tools/);
    t.tool.sourceInfo.source = "inline"; t.tool.sourceInfo.path = "<inline:tools>"; assert.throws(() => resolve(), /no absolute file-backed/);
    t.tool.sourceInfo.path = join(t.dir, "gone.ts"); assert.throws(() => resolve(), /missing source file/);
    t.api.getAllTools = () => [readInfo(t.dir)]; assert.throws(() => resolve(), /runtime metadata is missing/);
  } finally { t.clean(); }
});
test("tool preflight rejects absent tools, builtin substitution, changed schemas and replaced question bridge", () => {
  const t = setup();
  try {
    const l = resolveLoadout(t.api, [], t.dir, "fake/test", "off", t.dir);
    const all = [...t.api.getAllTools(), t.question]; verifyTools(l, all);
    assert.throws(() => verifyTools(l, [readInfo(t.dir), t.question]), /missing required tool/);
    t.tool.parameters = JSON.parse(JSON.stringify({ ...t.tool.parameters, required: [] }));
    assert.throws(() => verifyTools(l, all), /schema\/provenance mismatch/);
    const override = { ...readInfo(t.dir), sourceInfo: { ...t.tool.sourceInfo, path: t.source } };
    const overridden = resolveLoadout({getActiveTools: () => ["read"], getAllTools: () => [override]}, [], t.dir, "fake/test", "off", t.dir);
    assert.throws(() => verifyTools(overridden, [readInfo(t.dir), t.question]), /schema\/provenance mismatch/);
    t.question.sourceInfo.path = t.source;
    assert.throws(() => verifyTools({...l, tools: ["ask_question"], toolMetadata: []}, [t.question]), /bridge was replaced/);
  } finally { t.clean(); }
});
test("builtin provenance accepts Pi 1.0 paths and normalizes legacy snapshots without trusting names", () => {
  const t = setup();
  try {
    const legacy = readInfo(t.dir);
    const modern = { ...legacy, sourceInfo: { ...legacy.sourceInfo, path: "builtin:read" } };
    const api = (tool: typeof legacy) => ({ getActiveTools: () => ["read"], getAllTools: () => [tool] });
    const l = resolveLoadout(api(modern), [], t.dir, "fake/test", "off", t.dir);
    assert.deepEqual(l, resolveLoadout(api(legacy), [], t.dir, "fake/test", "off", t.dir));
    assert.equal(l.toolMetadata[0].path, "<builtin:read>");
    verifyTools(l, [modern, t.question]);
    verifyTools(l, [legacy, t.question]);
    assert.deepEqual(applyAccess(l, "read-only").tools, ["read", "ask_question"]);
    for (const path of ["builtin:write", "<builtin:write>", t.source, "read", ""]) {
      assert.throws(() => resolveLoadout(api({ ...modern, sourceInfo: { ...modern.sourceInfo, path } }), [], t.dir, "fake/test", "off", t.dir), /Invalid builtin provenance/);
    }
    const custom = { ...modern, sourceInfo: { ...modern.sourceInfo, source: "extension", path: t.source } };
    assert.deepEqual(applyAccess(resolveLoadout(api(custom), [], t.dir, "fake/test", "off", t.dir), "read-only").tools, ["ask_question"]);
    assert.throws(() => resolveLoadout({ getActiveTools: () => ["unknown"], getAllTools: () => [{ ...modern, name: "unknown", sourceInfo: { ...modern.sourceInfo, path: "builtin:unknown" } }] }, [], t.dir, "fake/test", "off", t.dir), /Invalid builtin provenance/);
  } finally { t.clean(); }
});
test("tool inheritance freezes exposure, namespace and annotations and rejects semantic drift", () => {
  const t = setup();
  try {
    const tool = { ...t.tool, exposure: "model-only" as const, namespace: { name: "fixture", description: "Original group" }, annotations: { readOnlyHint: true } };
    const api = { getActiveTools: () => [tool.name], getAllTools: () => [tool] };
    const l = resolveLoadout(api, [], t.dir, "fake/test", "off", t.dir);
    verifyTools(l, [tool, t.question]);
    assert.equal(l.toolMetadata[0].exposure, "model-only");
    tool.namespace.description = "Changed group";
    assert.equal(l.toolMetadata[0].namespace?.description, "Original group");
    assert.throws(() => verifyTools(l, [tool, t.question]), /schema\/provenance mismatch/);
    tool.namespace.description = "Original group";
    for (const changed of [{ ...tool, exposure: "direct" as const }, { ...tool, annotations: { readOnlyHint: false } }]) {
      assert.throws(() => verifyTools(l, [changed, t.question]), /schema\/provenance mismatch/);
    }
    const legacy = resolveLoadout(t.api, [], t.dir, "fake/test", "off", t.dir);
    for (const metadata of legacy.toolMetadata) delete metadata.exposure;
    verifyTools(legacy, [...t.api.getAllTools(), t.question]);
    assert.throws(() => verifyTools(legacy, [{ ...t.tool, exposure: "model-only" }, readInfo(t.dir), t.question]), /schema\/provenance mismatch/);
  } finally { t.clean(); }
});
test("historical loadout validation checks structure without requiring live resources", () => {
  const t = setup();
  try {
    const l = resolveLoadout(t.api, [t.skill], t.dir, "fake/test", "off", t.dir);
    l.providerExtensions = [t.source];
    t.clean();
    assert.equal(validateLoadout(l, { resources: false }), l);
    assert.throws(() => validateLoadout(l));
    assert.throws(() => validateLoadout({ ...l, cwd: "relative" }, { resources: false }), /absolute/);
    assert.throws(() => validateLoadout({ ...l, extensions: [] }, { resources: false }), /Extension sources/);
    assert.throws(() => validateLoadout({ ...l, providerExtensions: ["relative"] }, { resources: false }), /absolute/);
  } finally { t.clean(); }
});
test("skill preflight verifies exact canonical inventory and metadata, including hidden skills", () => {
  const t = setup();
  try {
    const l = resolveLoadout(t.api, [t.skill], t.dir, "fake/test", "off", t.dir);
    verifySkills(l, [t.skill]);
    assert.throws(() => verifySkills(l, []), /inventory\/metadata mismatch/);
    assert.throws(() => verifySkills(l, [t.skill, {...t.skill, name: "extra"}]), /inventory\/metadata mismatch/);
    assert.throws(() => verifySkills(l, [{...t.skill, disableModelInvocation: false}]), /inventory\/metadata mismatch/);
    assert.throws(() => verifySkills(l, [{...t.skill, filePath: "/virtual/SKILL.md"}]), /missing source file/);
  } finally { t.clean(); }
});


test("skill loader path is separate from canonical identity and retargeted aliases are rejected", () => {
  const t = setup();
  try {
    const alias = join(t.dir, "alias.md"); symlinkSync(t.skill.filePath, alias);
    const l = resolveLoadout(t.api, [{ ...t.skill, filePath: alias }], t.dir, "fake/test", "off", t.dir);
    assert.equal(l.skills[0].filePath, t.skill.filePath);
    assert.equal(l.skills[0].loadPath, alias);
    verifySkills(l, [t.skill]); // Provenance comparison remains canonical.
    const other = join(t.dir, "other.md"); writeFileSync(other, "different target");
    unlinkSync(alias); symlinkSync(other, alias);
    assert.throws(() => validateLoadout(l), /Invalid skill snapshot/);
  } finally { t.clean(); }
});
