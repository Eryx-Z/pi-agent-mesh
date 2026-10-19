import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoleCatalog } from "../pi-extension/subagents/roles.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const expected = [
  { id: "pm", skill: "pm-planning", builtinTools: ["read", "grep", "find", "ls"], context: "partial", access: "read-only" },
  { id: "builder", skill: "builder-delivery", builtinTools: ["read", "grep", "find", "ls", "edit", "write", "bash"], context: "partial", access: "full" },
  { id: "tester", skill: "tester-verification", builtinTools: ["read", "grep", "find", "ls", "bash"], context: "partial", access: "full" },
  { id: "reviewer", skill: "reviewer-audit", builtinTools: ["read", "grep", "find", "ls"], context: "none", access: "read-only" },
];

test("minimal team resolves four distinct builtin packages outside the package cwd", t => {
  const cwd = mkdtempSync(join(tmpdir(), "mesh-builtin-roles-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"));
  const config = join(cwd, ".pi", "agent-mesh.yaml");
  copyFileSync(join(packageRoot, "examples", "team", ".pi", "agent-mesh.yaml"), config);

  // Explicit selection avoids inheriting a developer's PI_AGENT_MESH_CONFIG.
  // Only the example config is copied: builtins must resolve from the package.
  const directory = new RoleCatalog(cwd, config).reload();
  assert.equal(directory.enabled, true);
  assert.equal(directory.mainRole, "pm");
  assert.equal(directory.configPath, realpathSync(config));
  assert.deepEqual(directory.mcpServers, {});
  assert.deepEqual(directory.roles.map(role => role.id).sort(), expected.map(role => role.id).sort());
  assert.equal(new Set(directory.roles.map(role => role.systemPrompt)).size, 4);
  assert.equal(new Set(directory.roles.flatMap(role => role.skills.map(skill => skill.name))).size, 4);

  for (const spec of expected) {
    const role = directory.roles.find(role => role.id === spec.id)!;
    const root = join(packageRoot, "roles", spec.id);
    assert.equal(role.manifestPath, realpathSync(join(root, "role.yaml")));
    assert.equal(role.systemPromptPath, realpathSync(join(root, "system.md")));
    assert.equal(role.systemPrompt, readFileSync(role.systemPromptPath, "utf8"));
    assert.ok(role.description.trim());
    assert.ok(role.systemPrompt.trim());
    assert.deepEqual(role.builtinTools, spec.builtinTools);
    assert.deepEqual(role.defaults, { model: "inherit", context: spec.context, access: spec.access });
    assert.deepEqual(role.mcp, []);
    assert.deepEqual(role.extraTools, []);
    assert.equal(role.skills.length, 1);
    assert.equal(role.skills[0].name, spec.skill);
    assert.ok(role.skills[0].description.trim());
    assert.equal(role.skills[0].disableModelInvocation, false);
    assert.equal(role.skills[0].filePath, realpathSync(join(root, "skills", spec.skill, "SKILL.md")));
  }

  assert.equal(directory.roles.find(role => role.id === "pm")!.builtinTools.includes("bash"), false);
  assert.equal(directory.roles.find(role => role.id === "builder")!.builtinTools.includes("bash"), true);
  assert.equal(directory.roles.find(role => role.id === "reviewer")!.defaults.context, "none");
});
