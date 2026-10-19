import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedRole, RoleDirectory } from "../pi-extension/subagents/roles.ts";
import { createRolePlan, effectiveRole, initialRoleLoadout, rolePlanDigest, validateRolePlan,
  snapshotRoleTools, validateRoleSnapshot, snapshotRoleLoadout, mergeRoleBaseline, ROLE_CHILD_EXTENSION,
  type RoleToolInfo, type RolePlan, type RoleSnapshot, type RoleBinding } from "../pi-extension/subagents/role-loadout.ts";
import { snapshotTool } from "../pi-extension/subagents/loadout.ts";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "role-plan-"));
  const skillPath = join(dir, "SKILL.md"), alias = join(dir, "alias.md"), entry = join(dir, "tool.ts"), manifest = join(dir, "role.yaml");
  writeFileSync(skillPath, "skill bytes"); symlinkSync(skillPath, alias);
  writeFileSync(entry, "throw new Error('must not execute')"); writeFileSync(manifest, "manifest bytes");
  const role: ResolvedRole = { id: "worker", description: "Worker", source: manifest, manifestPath: manifest, manifestHash: hash("manifest bytes"),
    systemPromptPath: join(dir, "prompt.md"), systemPrompt: "Original instructions", builtinTools: ["read", "bash"],
    skills: [{ name: "fixture", description: "Fixture skill", filePath: skillPath, loadPath: alias, baseDir: dir,
      disableModelInvocation: true, hash: hash("skill bytes"), sourceInfo: { source: "absolute", path: skillPath, scope: "project", origin: "top-level" } }],
    extraTools: [{ entry, tools: ["lookup"] }], mcp: [{ server: "remote", tools: ["search"] }], defaults: { access: "read-only" } };
  const directory: RoleDirectory = { enabled: true, configPath: join(dir, "team.yaml"), roles: [role], mcpServers: { remote: { command: "node", env: { TOKEN: "$ROLE_TEST_TOKEN" } } } };
  const options = { model: "fake/test", thinking: "high", context: "partial" as const, access: "read-only" as const, cwd: dir, agentDir: dir };
  return { dir, skillPath, alias, entry, manifest, role, directory, options,
    plan: () => createRolePlan(role, directory, options), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test("plan freezes all declared capabilities and unresolved references independently of effective access", () => {
  const t = setup();
  try {
    const p = t.plan();
    assert.deepEqual(p.builtinTools, ["read", "bash"]);
    assert.equal(p.extraTools[0].hash, hash("throw new Error('must not execute')"));
    assert.equal(p.mcp[0].config.env?.TOKEN, "$ROLE_TEST_TOKEN");
    assert.equal(p.skills[0].loadPath, t.alias);
    const ro = effectiveRole(p, "read-only");
    assert.deepEqual(ro.builtinTools, ["read"]); assert.deepEqual(ro.extraTools, []); assert.deepEqual(ro.mcp, []);
    assert.deepEqual(ro.skills, p.skills);
    assert.deepEqual(effectiveRole(p, "full").builtinTools, ["read", "bash"]);
    t.role.systemPrompt = "later"; t.directory.mcpServers.remote.env!.TOKEN = "changed";
    assert.equal(p.systemPrompt, "Original instructions"); assert.equal(p.mcp[0].config.env?.TOKEN, "$ROLE_TEST_TOKEN");
    assert.equal(p.systemPromptHash, hash("Original instructions"));
    assert.equal(initialRoleLoadout(p, "full").version, 3);
    assert.deepEqual(initialRoleLoadout(p, "full").tools, ["ask_question"]);
  } finally { t.clean(); }
});
test("history is structural; live checks preserve prompt authority and enforce access-sensitive resource hashes", () => {
  const t = setup();
  try {
    const p = t.plan();
    unlinkSync(t.manifest); // Embedded instructions, not the current manifest, are authoritative.
    writeFileSync(t.entry, "changed implementation");
    assert.equal(validateRolePlan(p, { access: "read-only" }), p);
    assert.throws(() => validateRolePlan(p, { access: "full" }), /hash|source/i);
    assert.equal(validateRolePlan(p, { resources: false }), p);
    writeFileSync(t.skillPath, "changed skill");
    assert.throws(() => validateRolePlan(p, { access: "read-only" }), /hash|skill/i);
    assert.throws(() => validateRolePlan({ ...p, systemPrompt: "tampered" }, { resources: false }), /prompt.*hash/i);
    assert.throws(() => validateRolePlan({ ...p, builtinTools: ["read", "read"] }, { resources: false }), /duplicate/i);
    assert.throws(() => validateRolePlan({ ...p, extraTools: [{ ...p.extraTools[0], tools: ["write"] }] }, { resources: false }), /reserved|collision/i);
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as RolePlan;
    assert.equal(rolePlanDigest(reordered), rolePlanDigest(p));
    const historical = structuredClone(p); t.clean();
    assert.equal(validateRolePlan(historical, { resources: false }), historical);
    assert.throws(() => validateRolePlan(historical));
  } finally { t.clean(); }
});
function info(name: string, source = "builtin", path = `builtin:${name}`): RoleToolInfo {
  return { name, description: `Tool ${name}`, parameters: { type: "object", properties: {} }, exposure: "direct",
    sourceInfo: { source, path, scope: "temporary", origin: "top-level" } };
}
function question(): RoleToolInfo {
  return { ...info("ask_question", "absolute", ROLE_CHILD_EXTENSION), exposure: "model-only",
    description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.",
    parameters: { type: "object", properties: { question: { minLength: 1, type: "string" } }, required: ["question"] } };
}
function binding(p: RolePlan): RoleBinding { return { taskId: "task-1", run: 1, attemptId: "attempt-1", nonce: "nonce-1", planHash: rolePlanDigest(p) }; }
function snapshot(p: RolePlan, access: "full" | "read-only", tools: RoleToolInfo[]): RoleSnapshot {
  const q = question();
  return { version: 1, binding: binding(p), roleId: p.roleId, tools: snapshotRoleTools(p, access, [...tools, q], access === "full" ? p.extraTools : []),
    skills: p.skills.map(({ hash: _hash, ...s }) => s), reservedBridge: { ...snapshotTool(q), sourceInfo: q.sourceInfo },
    piVersion: "1.0.2", model: p.model, thinking: p.thinking, effectiveAccess: access, preflightComplete: true };
}
test("snapshot records actual definitions and protects complete tool inventory, provenance, bridge and binding", () => {
  const t = setup();
  try {
    const p = t.plan(), q = question(), read = info("read");
    const s = snapshot(p, "read-only", [read]);
    assert.deepEqual(s.tools.map(t => t.name), ["read"]);
    assert.equal(s.tools[0].semanticKind, "builtin"); assert.equal(s.tools[0].sourceInfo.path, "builtin:read");
    assert.equal(validateRoleSnapshot(s, p, binding(p), "read-only"), s);
    assert.deepEqual(snapshotRoleLoadout(p, s).tools, ["read", "ask_question"]);
    assert.throws(() => snapshotRoleTools(p, "read-only", [q]), /missing|inventory/i);
    assert.throws(() => snapshotRoleTools(p, "read-only", [read, read, q]), /duplicate/i);
    assert.deepEqual(snapshotRoleTools(p, "read-only", [read, info("write"), info("bash"), q]), s.tools);
    assert.throws(() => snapshotRoleTools(p, "read-only", [read, info("lookup", "absolute", t.entry), q]), /provenance|inventory/i);
    assert.throws(() => snapshotRoleTools(p, "read-only", [read, { ...info("write"), sourceInfo: { ...read.sourceInfo, path: "builtin:read" } }, q]), /builtin.*provenance/i);
    assert.throws(() => snapshotRoleTools(p, "read-only", [{ ...read, sourceInfo: { ...read.sourceInfo, source: "absolute", path: t.entry } }, q]), /builtin|provenance/i);
    assert.throws(() => snapshotRoleTools(p, "read-only", [read, { ...q, sourceInfo: { ...q.sourceInfo, path: t.entry } }]), /bridge/i);
    assert.throws(() => validateRoleSnapshot({ ...s, binding: { ...s.binding, nonce: "replayed" } }, p, binding(p), "read-only"), /binding/i);
    assert.throws(() => validateRoleSnapshot({ ...s, skills: [] }, p, binding(p), "read-only"), /skill/i);
    assert.throws(() => validateRoleSnapshot({ ...s, reservedBridge: { ...s.reservedBridge, parameters: {} } }, p, binding(p), "read-only"), /bridge/i);
    t.clean(); // Historical verification never depends on today's original manifest/resources.
    assert.equal(validateRoleSnapshot(s, p, binding(p), "read-only"), s);
  } finally { t.clean(); }
});
test("verified baselines survive tightening, reject drift on re-expansion and never partially mutate", () => {
  const t = setup();
  try {
    const p = t.plan(); p.mcp = [];
    const lookup = info("lookup", "absolute", ROLE_CHILD_EXTENSION);
    const full = snapshot(p, "full", [info("bash"), lookup, info("read")]);
    assert.equal(full.tools[2].entry, t.entry); assert.equal(full.tools[2].sourceInfo.path, ROLE_CHILD_EXTENSION);
    const baseline = mergeRoleBaseline([], full);
    assert.deepEqual(baseline.map(t => t.name), ["read", "bash", "lookup"]);
    const ro = snapshot(p, "read-only", [info("read")]);
    assert.deepEqual(mergeRoleBaseline(baseline, ro), baseline);
    const changed = structuredClone(full); changed.tools[1].description = "Drifted bash";
    const prior = structuredClone(baseline);
    assert.throws(() => mergeRoleBaseline(baseline, changed), /definition|drift|mismatch/i);
    assert.deepEqual(baseline, prior);
    assert.deepEqual(mergeRoleBaseline(baseline, full), baseline);
    full.tools[0].description = "mutated caller";
    assert.equal(baseline[0].description, "Tool read");
    const lazy = mergeRoleBaseline(mergeRoleBaseline([], ro), snapshot(p, "full", [info("read"), info("bash"), lookup]));
    assert.deepEqual(lazy.map(t => t.name), ["read", "bash", "lookup"]);
  } finally { t.clean(); }
});
