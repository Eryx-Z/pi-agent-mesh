import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ROLE_CHILD_EXTENSION, roleMcpConfigHash, snapshotRoleTools, rolePlanDigest, validateRoleSnapshot, mergeRoleBaseline,
  type RolePlan, type RoleSnapshot, type RoleToolInfo } from "../pi-extension/subagents/role-loadout.ts";
import { snapshotTool } from "../pi-extension/subagents/loadout.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "role-mcp-loadout-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan: RolePlan = { version: 1, schemaVersion: 1, promptVersion: 1, roleId: "builder", manifestPath: join(dir, "role.yaml"), manifestHash: hash("old"), systemPrompt: "Saved", systemPromptHash: hash("Saved"),
    skills: [], builtinTools: [], extraTools: [], mcp: [{ server: "alpha", config: { command: "missing", env: { TOKEN: "${ROLE_MCP_ROTATING}" } }, tools: ["a-b", "a_b"] }, { server: "beta", config: { url: "http://127.0.0.1:1/mcp" }, tools: ["a-b"] }],
    model: "fake/test", thinking: "off", context: "none", access: "full", cwd: dir, agentDir: dir };
  const sourceInfo = { path: ROLE_CHILD_EXTENSION, source: "cli", scope: "temporary" as const, origin: "top-level" as const };
  const q = { name: "ask_question", description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.", parameters: Type.Object({ question: Type.String({ minLength: 1 }) }), exposure: "model-only", sourceInfo } as RoleToolInfo;
  const names = ["mcp__alpha__a_b_111", "mcp__alpha__a_b_222", "mcp__beta__a_b"];
  const tools = names.map((name, i) => ({ name, description: "MCP declared tool", parameters: { type: "object", properties: {} }, exposure: "direct", namespace: { name: i < 2 ? "mcp__alpha" : "mcp__beta" }, sourceInfo } as RoleToolInfo));
  const sources = [{ server: "alpha", configHash: roleMcpConfigHash(plan, "alpha"), tools: [{ rawName: "a-b", name: names[0], definitionHash: hash("alpha/a-b") }, { rawName: "a_b", name: names[1], definitionHash: hash("alpha/a_b") }] }, { server: "beta", configHash: roleMcpConfigHash(plan, "beta"), tools: [{ rawName: "a-b", name: names[2], definitionHash: hash("beta/a-b") }] }];
  return { plan, q, tools, sources };
}
test("MCP metadata freezes actual names, raw names, config identity and unmodified wrapper provenance", t => {
  const f = fixture(t);
  const tools = snapshotRoleTools(f.plan, "full", [...f.tools, f.q], [], f.sources);
  assert.deepEqual(tools.map(t => t.name), f.tools.map(t => t.name));
  assert.deepEqual(tools.map(t => t.remoteName), ["a-b", "a_b", "a-b"]);
  assert.deepEqual(tools.map(t => t.server), ["alpha", "alpha", "beta"]);
  assert.ok(tools.every(t => t.semanticKind === "mcp" && t.source === "extension" && t.sourceInfo.path === ROLE_CHILD_EXTENSION));
  const binding = { taskId: "task", run: 1, attemptId: "attempt", nonce: "nonce", planHash: rolePlanDigest(f.plan) };
  const snapshot: RoleSnapshot = { version: 1, binding, roleId: "builder", tools, skills: [], reservedBridge: { ...snapshotTool(f.q), sourceInfo: f.q.sourceInfo }, piVersion: "1.0.2", model: f.plan.model, thinking: "off", effectiveAccess: "full", preflightComplete: true };
  assert.equal(validateRoleSnapshot(snapshot, f.plan, binding, "full"), snapshot);
  const baseline = mergeRoleBaseline([], snapshot);
  assert.throws(() => mergeRoleBaseline(baseline, { ...snapshot, tools: tools.map((t, i) => i ? t : { ...t, parameters: { type: "object", properties: { drift: { type: "boolean" } } } }) }), /Historical/);
  for (const patch of [{ server: "unselected" }, { remoteName: "unselected" }, { configHash: hash("other") }, { sourceInfo: { ...tools[0].sourceInfo, path: "/unrelated.ts" } }]) {
    assert.throws(() => validateRoleSnapshot({ ...snapshot, tools: [{ ...tools[0], ...patch }, ...tools.slice(1)] }, f.plan, binding, "full"));
  }
});
test("missing, extra, alias and config-mismatched MCP mappings cannot become authorized", t => {
  const f = fixture(t);
  for (const sources of [[], f.sources.slice(0, 1), [...f.sources, f.sources[0]], f.sources.map(s => ({ ...s, configHash: hash("wrong") })),
    f.sources.map(s => ({ ...s, tools: [...s.tools, { rawName: "unselected", name: "extra", definitionHash: hash("extra") }] })),
    f.sources.map(s => ({ ...s, tools: s.tools.map(tool => ({ ...tool, name: "same_name" })) }))]) {
    assert.throws(() => snapshotRoleTools(f.plan, "full", [...f.tools, f.q], [], sources));
  }
  assert.deepEqual(snapshotRoleTools(f.plan, "read-only", [f.q], [], []), []);
  assert.throws(() => snapshotRoleTools(f.plan, "read-only", [...f.tools, f.q], [], f.sources));
});
test("MCP config identity persists references, not resolved rotating environment values", t => {
  const f = fixture(t), before = process.env.ROLE_MCP_ROTATING;
  try {
    process.env.ROLE_MCP_ROTATING = "secret-one"; const first = roleMcpConfigHash(f.plan, "alpha");
    process.env.ROLE_MCP_ROTATING = "secret-two"; assert.equal(roleMcpConfigHash(f.plan, "alpha"), first);
    assert.equal(JSON.stringify(f.plan).includes("secret-two"), false);
    const changed = { ...f.plan, cwd: "/another-worktree" }; assert.notEqual(roleMcpConfigHash(changed, "alpha"), first);
  } finally { if (before === undefined) delete process.env.ROLE_MCP_ROTATING; else process.env.ROLE_MCP_ROTATING = before; }
});
