import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Ajv } from "ajv";
import { stringify } from "yaml";
import { RoleCatalog, resolveRoleDefaults } from "../pi-extension/subagents/roles.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "mesh-roles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = { schema_version: 1, id: "builder", description: "Build things", system_prompt: "./system.md", builtin_tools: ["read", "write"], defaults: { access: "full" } };
  const team = { schema_version: 1, enabled: true, main_role: "builder", roles: { builder: "./role.yaml" }, mcp_servers: {} };
  const config = join(dir, "team.yaml");
  writeFileSync(join(dir, "system.md"), "You build things.\n");
  function saveRole(value: unknown = manifest) { writeFileSync(join(dir, "role.yaml"), stringify(value)); }
  function saveTeam(value: unknown = team) { writeFileSync(config, stringify(value)); }
  saveRole(); saveTeam();
  return { dir, config, team, manifest, saveRole, saveTeam, catalog: () => new RoleCatalog(dir, config) };
}

test("catalog constructor is passive, default absence disables, explicit absence errors", t => {
  const f = fixture(t);
  const c = new RoleCatalog(f.dir, "missing.yaml");
  assert.equal(c.current, undefined); assert.equal(c.error, undefined); assert.equal(c.explicit, true);
  assert.throws(() => c.reload(), /missing.yaml/); assert.match(c.error!, /missing.yaml/);
  const before = process.env.PI_AGENT_MESH_CONFIG;
  try {
    process.env.PI_AGENT_MESH_CONFIG = "";
    const defaults = new RoleCatalog(f.dir);
    assert.equal(defaults.explicit, false);
    assert.equal(defaults.reload().enabled, false);
    process.env.PI_AGENT_MESH_CONFIG = "team.yaml";
    const selected = new RoleCatalog(f.dir);
    process.env.PI_AGENT_MESH_CONFIG = "missing.yaml";
    assert.equal(selected.reload().roles[0].id, "builder");
    assert.equal(defaults.reload().enabled, false);
    const capturedDefault = new RoleCatalog(f.dir, "");
    assert.equal(capturedDefault.explicit, false); assert.equal(capturedDefault.reload().enabled, false);
  } finally { if (before === undefined) delete process.env.PI_AGENT_MESH_CONFIG; else process.env.PI_AGENT_MESH_CONFIG = before; }
});

test("default discovery never searches parent directories", t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, ".pi"));
  writeFileSync(join(f.dir, ".pi", "agent-mesh.yaml"), stringify({ ...f.team, roles: { builder: "../role.yaml" } }));
  const nested = join(f.dir, "nested"); mkdirSync(nested);
  assert.equal(new RoleCatalog(nested, "").reload().enabled, false);
  assert.equal(new RoleCatalog(nested, "../.pi/agent-mesh.yaml").reload().roles[0].id, "builder");
});

test("role builtin capability declaration is explicit even when empty", t => {
  const f = fixture(t);
  const { builtin_tools: _tools, ...missing } = f.manifest;
  f.saveRole(missing);
  assert.throws(() => f.catalog().reload(), /builtin_tools/);
  f.saveRole({ ...f.manifest, builtin_tools: [] });
  assert.deepEqual(f.catalog().reload().roles[0].builtinTools, []);
});

test("enabled roles are canonical immutable snapshots and reload is atomic", t => {
  const f = fixture(t); const c = f.catalog(); const first = c.reload();
  const role = first.roles[0];
  assert.equal(first.mainRole, "builder"); assert.equal(first.configPath, realpathSync(f.config));
  assert.equal(role.source, realpathSync(join(f.dir, "role.yaml")));
  assert.equal(role.manifestPath, role.source); assert.equal(role.systemPrompt, "You build things.\n");
  assert.equal(role.systemPromptPath, realpathSync(join(f.dir, "system.md")));
  assert.match(role.manifestHash, /^[a-f0-9]{64}$/); assert.deepEqual(role.skills, []);
  assert.deepEqual(role.defaults, { access: "full" });
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(role.defaults));
  f.saveRole({ ...f.manifest, unsupported: true });
  assert.throws(() => c.reload(), /builder.*role.yaml.*unsupported/s);
  assert.equal(c.current, first); assert.ok(c.error);
  f.saveRole({ ...f.manifest, description: "Changed" });
  assert.equal(c.reload().roles[0].description, "Changed"); assert.equal(c.error, undefined);
  assert.equal(first.roles[0].description, "Build things");
});

test("config canonical identity stays pinned across symlink retarget and cwd/env changes", t => {
  const f = fixture(t); const other = join(f.dir, "other.yaml");
  writeFileSync(other, "schema_version: 1\nenabled: false\n");
  const alias = join(f.dir, "alias.yaml"); symlinkSync(f.config, alias);
  const c = new RoleCatalog(f.dir, alias); assert.equal(c.reload().enabled, true);
  unlinkSync(alias); symlinkSync(other, alias);
  assert.equal(c.reload().enabled, true); assert.equal(c.configPath, realpathSync(f.config));
  unlinkSync(f.config); assert.throws(() => c.reload(), /team.yaml/); assert.equal(c.current!.enabled, true);
});

test("symlinked configs use the canonical document directory and reject canonical target replacement", t => {
  const f = fixture(t); const aliasDir = join(f.dir, "aliases"); mkdirSync(aliasDir);
  const alias = join(aliasDir, "team.yaml"); symlinkSync(f.config, alias);
  const catalog = new RoleCatalog(f.dir, alias);
  assert.equal(catalog.reload().roles[0].manifestPath, realpathSync(join(f.dir, "role.yaml")));
  const previous = catalog.current;
  const replacement = join(f.dir, "replacement.yaml"); writeFileSync(replacement, "schema_version: 1\nenabled: false\n");
  unlinkSync(f.config); symlinkSync(replacement, f.config);
  assert.throws(() => catalog.reload(), /canonical configuration identity changed/);
  assert.equal(catalog.current, previous);
});

test("disabled configs validate structure but never dereference resources", t => {
  const f = fixture(t);
  f.saveTeam({ schema_version: 1, enabled: false, roles: { absent: "./missing.yaml" }, mcp_servers: { absent: { command: "not-installed" } } });
  assert.deepEqual(f.catalog().reload().roles, []);
  f.saveTeam({ schema_version: 1, enabled: false }); assert.equal(f.catalog().reload().enabled, false);
  f.saveTeam({ schema_version: 1, enabled: false, unknown: true }); assert.throws(() => f.catalog().reload(), /unknown/);
});

test("strict YAML rejects duplicates, tags, merges, extra documents and invalid UTF-8", t => {
  const f = fixture(t);
  for (const body of [
    "schema_version: 1\nenabled: false\nenabled: true\n",
    "schema_version: 1\nenabled: !custom false\n",
    "schema_version: 1\nenabled: false\n<<: {roles: {}}\n",
    "schema_version: 1\nenabled: false\n---\nenabled: false\n",
  ]) { writeFileSync(f.config, body); assert.throws(() => f.catalog().reload(), /team.yaml/); }
  for (const body of ["schema_version: 1\nenabled: !custom private-secret-value\n", "schema_version: 1\nenabled: false\nenabled: private-secret-value\n"]) {
    writeFileSync(f.config, body);
    assert.throws(() => f.catalog().reload(), error => { assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private-secret-value/); return true; });
  }
  writeFileSync(f.config, Buffer.from([0xff, 0xfe])); assert.throws(() => f.catalog().reload(), /UTF-8/);
  f.saveTeam(); writeFileSync(join(f.dir, "system.md"), Buffer.from([0xff]));
  assert.throws(() => f.catalog().reload(), /builder.*system_prompt.*UTF-8/s);
});

test("YAML rejects map-key coercion before role or MCP IDs can silently override", t => {
  const f = fixture(t);
  f.saveRole({ ...f.manifest, id: "true" });
  const prefix = "schema_version: 1\nenabled: true\nmain_role: 'true'\n";
  for (const body of [
    `${prefix}roles: { true: ./missing.yaml, \"true\": ./role.yaml }\n`,
    `${prefix}roles: { \"true\": ./role.yaml }\nmcp_servers: { true: {command: absent}, \"true\": {command: also-absent} }\n`,
    `${prefix}roles: { \"true\": ./role.yaml }\nmcp_servers: { api: {command: absent, env: { true: discarded, \"true\": kept }} }\n`,
  ]) {
    writeFileSync(f.config, body);
    assert.throws(() => f.catalog().reload(), /YAML.*mapping keys.*strings/);
  }
  writeFileSync(f.config, `${prefix}roles: { \"true\": ./role.yaml }\n`);
  assert.equal(f.catalog().reload().roles[0].id, "true", "Explicit string IDs remain valid");
});

test("schema validation names fields and forbids unsafe IDs and role mismatch", t => {
  const f = fixture(t);
  for (const team of [
    { ...f.team, schema_version: 2 }, { ...f.team, roles: [] }, { ...f.team, main_role: "missing" },
    { ...f.team, roles: JSON.parse('{"__proto__":"./role.yaml"}') },
    { ...f.team, roles: { constructor: "./role.yaml" } },
    { ...f.team, roles: { pm: "./role.yaml" }, main_role: "pm" },
  ]) { f.saveTeam(team); assert.throws(() => f.catalog().reload(), /team.yaml|role.yaml/); }
  f.saveTeam();
  for (const patch of [{ id: "wrong" }, { description: " " }, { defaults: { access: "unsafe" } }, { defaults: { access: "full", context: "auto" } }, { defaults: { access: "full", model: "bare-model" } }]) {
    f.saveRole({ ...f.manifest, ...patch }); assert.throws(() => f.catalog().reload(), /builder.*role.yaml/s);
  }
});

test("missing resources report role, canonical manifest and field without parsing unselected manifests", t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "unselected.yaml"), "invalid: !custom anything");
  assert.doesNotThrow(() => f.catalog().reload());
  for (const [patch, field] of [
    [{ system_prompt: "./missing.md" }, "system_prompt"],
    [{ skills: ["./missing/SKILL.md"] }, "skills"],
    [{ extra_tools: [{ entry: "./missing.ts", tools: ["test"] }] }, "extra_tools"],
  ] as const) {
    f.saveRole({ ...f.manifest, ...patch });
    assert.throws(() => f.catalog().reload(), error => { assert.ok(error instanceof Error); assert.match(error.message, /builder.*role.yaml/s); assert.ok(error.message.includes(field)); return true; });
  }
  f.saveRole({ ...f.manifest, extra_tools: [{ entry: "./invalid.ts", tools: ["test"] }] });
  writeFileSync(join(f.dir, "invalid.ts"), Buffer.from([0xff]));
  assert.throws(() => f.catalog().reload(), /builder.*extra_tools.*UTF-8/s);
});

test("exact skills use Pi metadata, preserve disabled invocation and do not scan neighbors", t => {
  const f = fixture(t);
  const selected = join(f.dir, "selected", "SKILL.md"); mkdirSync(dirname(selected));
  writeFileSync(selected, "---\nname: selected\ndescription: Selected skill\ndisable-model-invocation: true\n---\nOnly selected\n");
  mkdirSync(join(f.dir, ".pi", "skills", "neighbor"), { recursive: true });
  writeFileSync(join(f.dir, ".pi", "skills", "neighbor", "SKILL.md"), "---\nname: neighbor\ndescription: Must not load\n---\nNo\n");
  const alias = join(f.dir, "alias"); symlinkSync(dirname(selected), alias);
  f.saveRole({ ...f.manifest, skills: ["./alias/SKILL.md"] });
  const skills = f.catalog().reload().roles[0].skills;
  assert.equal(skills.length, 1); assert.equal(skills[0].name, "selected"); assert.equal(skills[0].disableModelInvocation, true);
  assert.equal(skills[0].filePath, realpathSync(selected)); assert.equal(skills[0].loadPath, join(alias, "SKILL.md")); assert.match(skills[0].hash, /^[a-f0-9]{64}$/);
  f.saveRole({ ...f.manifest, skills: ["./selected"] }); assert.throws(() => f.catalog().reload(), /skills/);
  f.saveRole({ ...f.manifest, skills: ["./selected/SKILL.md", "./alias/SKILL.md"] }); assert.throws(() => f.catalog().reload(), /duplicate.*skill|skill.*duplicate/i);
  const second = join(f.dir, "second", "SKILL.md"); mkdirSync(dirname(second)); writeFileSync(second, readFileSync(selected));
  f.saveRole({ ...f.manifest, skills: ["./selected/SKILL.md", "./second/SKILL.md"] }); assert.throws(() => f.catalog().reload(), /duplicate.*selected/i);
});

test("resources are checked but extra tool modules and MCP services are never executed", t => {
  const f = fixture(t); const marker = join(f.dir, "executed");
  writeFileSync(join(f.dir, "tool.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw Error('must never import');`);
  f.saveTeam({ ...f.team, mcp_servers: { stdio: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`] }, remote: { url: "http://127.0.0.1:1/mcp", timeout: 1 } } });
  f.saveRole({ ...f.manifest, extra_tools: [{ entry: "./tool.ts", tools: ["run_tests"] }], mcp: [{ server: "stdio", tools: ["search"] }, { server: "remote", tools: ["search"] }] });
  const directory = f.catalog().reload(); assert.equal(directory.roles[0].extraTools[0].entry, realpathSync(join(f.dir, "tool.ts")));
  assert.equal(directory.mcpServers.stdio.cwd, undefined); assert.equal(existsSync(marker), false);
  f.saveTeam({ ...f.team, mcp_servers: { stdio: { command: "missing", cwd: "." }, remote: { url: "https://example.invalid/mcp" } } });
  assert.equal(f.catalog().reload().mcpServers.stdio.cwd, realpathSync(f.dir));
});

test("tool collisions and delegation names are rejected without conflating distinct MCP servers", t => {
  const f = fixture(t); writeFileSync(join(f.dir, "tool.ts"), "throw new Error('never execute');");
  f.saveTeam({ ...f.team, mcp_servers: { a: { command: "missing" }, b: { command: "missing" } } });
  for (const patch of [
    { builtin_tools: ["read", "read"] }, { builtin_tools: ["*"] },
    { extra_tools: [{ entry: "./tool.ts", tools: ["read"] }] },
    { extra_tools: [{ entry: "./tool.ts", tools: ["x"] }, { entry: "./tool.ts", tools: ["x"] }] },
    { mcp: [{ server: "a", tools: ["search"] }, { server: "a", tools: ["search"] }] },
    { mcp: [{ server: "missing", tools: ["search"] }] },
    ...["ask_question", "subagent", "subagent_message", "subagents_list", "subagent_control", "workflow_run", "workflow_control", "roles_list", "spawn_agent"].flatMap(name => [
      { extra_tools: [{ entry: "./tool.ts", tools: [name] }] }, { mcp: [{ server: "a", tools: [name] }] },
    ]),
  ]) { f.saveRole({ ...f.manifest, ...patch }); assert.throws(() => f.catalog().reload(), /builder.*role.yaml/s); }
  f.saveRole({ ...f.manifest, mcp: [{ server: "a", tools: ["search"] }, { server: "b", tools: ["search"] }] });
  assert.equal(f.catalog().reload().roles[0].mcp.length, 2);
});

test("MCP subset is strict, credential refs stay unresolved and errors contain no values", t => {
  const f = fixture(t); const before = process.env.MESH_ROLES_TEST_SECRET;
  process.env.MESH_ROLES_TEST_SECRET = "private-secret-value";
  t.after(() => { if (before === undefined) delete process.env.MESH_ROLES_TEST_SECRET; else process.env.MESH_ROLES_TEST_SECRET = before; });
  const loadServer = (server: unknown) => { f.saveTeam({ ...f.team, mcp_servers: { api: server } }); return f.catalog().reload(); };
  assert.equal(loadServer({ url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${MESH_ROLES_TEST_SECRET}" } }).mcpServers.api.headers!.Authorization, "Bearer ${MESH_ROLES_TEST_SECRET}");
  for (const server of [
    { command: "node", oauth: {} }, { command: "node", exposure: "direct" }, { command: "node", toolExposure: {} },
    { command: "node", url: "https://example.invalid" }, { url: "file:///tmp/mcp" }, { command: "node --eval danger" },
    { command: "node", env: { TOKEN: "!touch should-not-run" } },
    { command: "node", timeout: 0 }, { url: "https://example.invalid", headers: { Authorization: "${MESH_ROLES_NONEXISTENT_123}" } },
  ]) { assert.throws(() => loadServer(server), error => { assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private-secret-value|touch should-not-run/); return /api|mcp_servers/.test(error.message); }); }
  const references = { TOKEN: "$MESH_ROLES_TEST_SECRET", LITERAL: "$${ESCAPED_MISSING}", ESCAPED_COMMAND: "$!not-a-command", INVALID_LITERAL: "${invalid-$MESH_ROLES_NONEXISTENT_123}" };
  assert.deepEqual(loadServer({ command: "node", env: references }).mcpServers.api.env, references);
});

test("native MCP server identity collisions fail enabled catalogs, while disabled catalogs skip resource checks", t => {
  const f = fixture(t);
  const mcp_servers = { "foo-bar": { command: "missing" }, foo_bar: { command: "missing" } };
  f.saveTeam({ ...f.team, mcp_servers });
  assert.throws(() => f.catalog().reload(), /mcp_servers.foo_bar.*duplicate native MCP server identity.*foo-bar/);
  f.saveTeam({ ...f.team, enabled: false, mcp_servers: { ...mcp_servers, api: { command: "missing", cwd: "./missing", env: { TOKEN: "${MESH_ROLES_NONEXISTENT_123}" } } } });
  assert.equal(f.catalog().reload().enabled, false);
});

test("defaults helper preserves precedence and requires explicit partial context text", t => {
  const f = fixture(t); let role = f.catalog().reload().roles[0];
  assert.throws(() => resolveRoleDefaults(role, {}, "parent/model"), /partial.*contextText/);
  assert.deepEqual(resolveRoleDefaults(role, { contextText: "Useful summary" }, "parent/model"), { access: "full", context: "partial", model: "parent/model", contextText: "Useful summary" });
  f.saveRole({ ...f.manifest, defaults: { access: "read-only", context: "none", model: "role/model" } }); role = f.catalog().reload().roles[0];
  assert.deepEqual(resolveRoleDefaults(role, {}, "parent/model"), { access: "read-only", context: "none", model: "role/model" });
  assert.deepEqual(resolveRoleDefaults(role, { access: "full", model: "override/model", context: "full" }, "parent/model"), { access: "full", context: "full", model: "override/model" });
  for (const value of ["inherit", "bare", "provider/", "/model", "provider/model extra"]) assert.throws(() => resolveRoleDefaults(role, { model: value }, "parent/model"), /provider\/model/);
  assert.throws(() => resolveRoleDefaults(role, { context: "partial", contextText: "  " }, "parent/model"), /contextText/);
  assert.throws(() => resolveRoleDefaults(role, { access: "unsafe" as "full" }, "parent/model"), /access/);
  assert.throws(() => resolveRoleDefaults(role, { context: "invalid" as "full" }, "parent/model"), /context/);
  assert.throws(() => resolveRoleDefaults(role, { access: null as unknown as "full" }, "parent/model"), /access/);
  assert.throws(() => resolveRoleDefaults(role, { model: null as unknown as string }, "parent/model"), /provider\/model/);
  assert.throws(() => resolveRoleDefaults(role, { contextText: 4 as unknown as string }, "parent/model"), /contextText/);
  f.saveRole({ ...f.manifest, defaults: { access: "full", model: "inherit" } });
  assert.equal(resolveRoleDefaults(f.catalog().reload().roles[0], { context: "none" }, "parent/model").model, "parent/model");
});

test("defaults helper rejects contextText outside partial mode", t => {
  const f = fixture(t); const role = f.catalog().reload().roles[0];
  for (const context of ["none", "full"] as const) {
    assert.throws(() => resolveRoleDefaults(role, { context, contextText: "Not a valid input for this mode" }, "parent/model"), /contextText.*partial/);
  }
});

test("published draft-7 schemas are the runtime structural source", t => {
  const f = fixture(t); const ajv = new Ajv({ allErrors: true, strict: true });
  const teamSchema = JSON.parse(readFileSync(new URL("../schemas/team-config-v1.schema.json", import.meta.url), "utf8"));
  const roleSchema = JSON.parse(readFileSync(new URL("../schemas/role-manifest-v1.schema.json", import.meta.url), "utf8"));
  const validateTeam = ajv.compile(teamSchema); const validateRole = ajv.compile(roleSchema);
  for (const patch of [{}, { unexpected: true }, { schema_version: 0 }, { roles: [] }, { enabled: "true" }]) {
    const candidate = { ...f.team, ...patch }; f.saveTeam(candidate);
    if (validateTeam(candidate)) assert.doesNotThrow(() => f.catalog().reload()); else assert.throws(() => f.catalog().reload());
  }
  f.saveTeam();
  for (const patch of [{}, { unexpected: true }, { skills: "all" }, { defaults: { access: "full", context: "auto" } }, { builtin_tools: ["read", "read"] }]) {
    const candidate = { ...f.manifest, ...patch }; f.saveRole(candidate);
    if (validateRole(candidate)) assert.doesNotThrow(() => f.catalog().reload()); else assert.throws(() => f.catalog().reload());
  }
});
