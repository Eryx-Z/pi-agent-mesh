import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccessMode, Loadout, SkillSnapshot, ToolSnapshot } from "./loadout.ts";
import type { ResolvedRole, RoleDirectory, RoleMcpServerConfig } from "./roles.ts";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { accessMode, isDelegationTool, nonempty, snapshotSkills, snapshotTool, validateLoadout } from "./loadout.ts";
import { fileURLToPath } from "node:url";

export const ROLE_CHILD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "role-child.ts");
export const ROLE_MAIN_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
export const ROLE_MCP_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "role-mcp.ts");
export interface RoleMcpSource { server: string; configHash: string; tools: { rawName: string; name: string; definitionHash: string }[] }
export type RoleToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
export interface RolePlan {
  version: 1; schemaVersion: 1; roleId: string; manifestPath: string; manifestHash: string;
  systemPrompt: string; systemPromptHash: string; promptVersion: 1;
  skills: (SkillSnapshot & { hash: string })[];
  builtinTools: string[]; extraTools: { entry: string; hash: string; tools: string[] }[];
  mcp: { server: string; config: RoleMcpServerConfig; tools: string[] }[];
  model: string; thinking: string; context: "none" | "partial" | "full"; access: AccessMode;
  cwd: string; agentDir: string; providerExtensions?: string[];
}
export type RolePlanOptions = Pick<RolePlan, "model" | "thinking" | "context" | "access" | "cwd" | "agentDir" | "providerExtensions">;
export interface RoleBinding { taskId: string; run: number; attemptId: string; nonce: string; planHash: string }
export interface RoleToolSnapshot extends ToolSnapshot {
  semanticKind: "builtin" | "local-tool" | "mcp";
  sourceInfo: RoleToolInfo["sourceInfo"];
  entry?: string; hash?: string; server?: string; remoteName?: string; configHash?: string; definitionHash?: string;
}
export interface RoleSnapshot {
  version: 1; binding: RoleBinding; roleId: string; tools: RoleToolSnapshot[];
  skills: SkillSnapshot[]; reservedBridge: ToolSnapshot & { sourceInfo: RoleToolInfo["sourceInfo"] };
  piVersion: string; model: string; thinking: string; effectiveAccess: AccessMode; preflightComplete: true;
}
export interface RoleRun {
  version: 1; binding: RoleBinding; access: AccessMode;
  status: "planned" | "verified" | "submitting" | "submitted";
  continuationMessage?: string; snapshot?: RoleSnapshot;
  outcome?: "running" | "waiting" | "completed" | "failed" | "cancelled";
  error?: string; cleanup?: "pending" | "confirmed";
}
export interface RolePreflightResult { binding: RoleBinding; snapshot?: RoleSnapshot; error?: string }
export type RoleRuntimeLoadout = Omit<Loadout, "version"> & { version: 3 };
export type RoleLocalSource = RolePlan["extraTools"][number];

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fileHash = (path: string) => digest(readFileSync(path));
const builtins = new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
const readonlyBuiltins = new Set(["read", "grep", "find", "ls"]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function createRolePlan(role: ResolvedRole, directory: RoleDirectory, options: RolePlanOptions): RolePlan {
  const skills = snapshotSkills(role.skills.map(s => ({ ...s, filePath: s.loadPath }))).map((s, i) => ({ ...s, hash: role.skills[i].hash }));
  const plan: RolePlan = clone({ version: 1, schemaVersion: 1, roleId: role.id, manifestPath: role.manifestPath,
    manifestHash: role.manifestHash, systemPrompt: role.systemPrompt, systemPromptHash: digest(role.systemPrompt), promptVersion: 1,
    skills, builtinTools: role.builtinTools, extraTools: role.extraTools.map(t => ({ ...t, hash: fileHash(t.entry) })),
    mcp: role.mcp.map(m => {
      const config = directory.mcpServers[m.server];
      if (!config) throw new Error(`Missing MCP configuration: ${m.server}`);
      return { ...m, config };
    }), ...options, cwd: realpathSync(options.cwd), agentDir: resolve(options.agentDir) });
  return validateRolePlan(plan);
}
function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
}
function absolute(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be absolute`);
}
function hash(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label} hash`);
}
function identifier(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new Error(`Invalid ${label}`);
}
function toolNames(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(n => typeof n !== "string" || !/^[^\s*]+$/.test(n) || n === "ask_question" || isDelegationTool(n))) throw new Error(`Invalid ${label}: reserved management tool`);
  if (new Set(value).size !== value.length) throw new Error(`Duplicate ${label}`);
}
function canonicalFile(path: string, label: string): void {
  if (realpathSync(path) !== path || !statSync(path).isFile()) throw new Error(`Invalid ${label} source`);
}
function checkHash(path: string, expected: string, label: string): void {
  canonicalFile(path, label);
  if (fileHash(path) !== expected) throw new Error(`${label} source hash changed`);
}
/** No environment lookup or native MCP import. Configurations remain unresolved JSON. */
function mcpConfig(value: unknown): void {
  object(value, "MCP configuration");
  const c = value as RoleMcpServerConfig;
  const http = c.type === "http" || (c.type === undefined && c.url !== undefined);
  const keys = http ? ["type", "url", "headers", "timeout", "description"] : ["type", "command", "args", "cwd", "env", "timeout", "description"];
  if (Object.keys(c).some(k => !keys.includes(k)) || (c.type !== undefined && c.type !== (http ? "http" : "stdio"))) throw new Error("Invalid MCP configuration fields");
  if (http) {
    if (typeof c.url !== "string" || !/^https?:\/\/[^\s]+$/.test(c.url)) throw new Error("Invalid MCP URL");
    const u = new URL(c.url); if (!u.hostname) throw new Error("Invalid MCP URL");
  } else {
    if (typeof c.command !== "string" || !/^(?:[^\s;&|`$<>]+|(?:\.?\.?\/|\/|[A-Za-z]:[\\/])[^;&|`$<>]+)$/.test(c.command)) throw new Error("Invalid MCP command");
    if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some(a => typeof a !== "string"))) throw new Error("Invalid MCP arguments");
    if (c.cwd !== undefined) absolute(c.cwd, "MCP cwd");
  }
  if (c.timeout !== undefined && (typeof c.timeout !== "number" || !Number.isFinite(c.timeout) || c.timeout <= 0)) throw new Error("Invalid MCP timeout");
  if (c.description !== undefined && typeof c.description !== "string") throw new Error("Invalid MCP description");
  for (const field of ["env", "headers"] as const) if (c[field] !== undefined) {
    object(c[field], `MCP ${field}`);
    if (Object.entries(c[field]!).some(([k, v]) => ["__proto__", "constructor", "prototype"].includes(k) || typeof v !== "string" || v.startsWith("!"))) throw new Error(`Invalid MCP ${field} references`);
  }
}
export function validateRolePlan(value: unknown, options: { resources?: boolean; access?: AccessMode } = {}): RolePlan {
  object(value, "role plan");
  const p = value as unknown as RolePlan;
  if (p.version !== 1 || p.schemaVersion !== 1 || p.promptVersion !== 1 || !Array.isArray(p.skills) || !Array.isArray(p.extraTools) || !Array.isArray(p.mcp)) throw new Error("Invalid role plan version/structure");
  identifier(p.roleId, "role ID"); absolute(p.manifestPath, "manifestPath"); hash(p.manifestHash, "manifest");
  if (typeof p.systemPrompt !== "string" || !p.systemPrompt.trim()) throw new Error("Invalid embedded system prompt");
  hash(p.systemPromptHash, "system prompt");
  if (digest(p.systemPrompt) !== p.systemPromptHash) throw new Error("System prompt hash mismatch");
  accessMode(p.access); const access = accessMode(options.access ?? p.access);
  if (!["none", "partial", "full"].includes(p.context)) throw new Error("Invalid role context");
  const resources = options.resources !== false;
  toolNames(p.builtinTools, "builtin tools");
  if (p.builtinTools.some(n => !builtins.has(n))) throw new Error("Invalid role builtin tool");
  const names = new Set(p.builtinTools), entries = new Set<string>(), skillPaths = new Set<string>();
  for (const s of p.skills) {
    object(s, "skill snapshot"); hash(s.hash, "skill");
    if (skillPaths.has(s.filePath)) throw new Error("Duplicate skill identity"); skillPaths.add(s.filePath);
    if (resources) checkHash(s.filePath, s.hash, `Skill ${s.name}`);
  }
  for (const e of p.extraTools) {
    object(e, "local tool entry"); absolute(e.entry, "local tool entry"); hash(e.hash, "local tool"); toolNames(e.tools, "local tools");
    if (entries.has(e.entry)) throw new Error("Duplicate local tool entry"); entries.add(e.entry);
    for (const n of e.tools) {
      if (builtins.has(n) || names.has(n)) throw new Error(`Reserved tool collision: ${n}`);
      names.add(n);
    }
    if (resources && access === "full") checkHash(e.entry, e.hash, "Local tool");
  }
  const servers = new Map<string, { config: RoleMcpServerConfig; names: Set<string> }>();
  const nativeServers = new Map<string, string>();
  for (const m of p.mcp) {
    object(m, "MCP selection"); identifier(m.server, "MCP server"); toolNames(m.tools, "MCP tools"); mcpConfig(m.config);
    const native = m.server.replace(/-/g, "_");
    if (nativeServers.has(native) && nativeServers.get(native) !== m.server) throw new Error("Duplicate MCP native server identity");
    nativeServers.set(native, m.server);
    const previous = servers.get(m.server);
    if (previous && !isDeepStrictEqual(previous.config, m.config)) throw new Error("Conflicting MCP configurations");
    const selected = previous?.names ?? new Set<string>();
    for (const n of m.tools) { if (selected.has(n)) throw new Error("Duplicate MCP tool selection"); selected.add(n); }
    servers.set(m.server, { config: m.config, names: selected });
  }
  // Reuse canonical skill/load spelling and settings validation without v2 authorizing any role tools.
  validateLoadout({ ...initialRoleLoadout(p, access), version: 2 }, { resources });
  return p;
}
export function effectiveRole(plan: RolePlan, access: AccessMode): Pick<RolePlan, "builtinTools" | "extraTools" | "mcp" | "skills"> {
  accessMode(access);
  return clone({ builtinTools: plan.builtinTools.filter(n => access === "full" || readonlyBuiltins.has(n)),
    extraTools: access === "full" ? plan.extraTools : [], mcp: access === "full" ? plan.mcp : [], skills: plan.skills });
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function rolePlanDigest(plan: RolePlan): string { return digest(stable(validateRolePlan(plan, { resources: false }))); }
/** Preserve remote metadata absent from Pi ToolInfo (notably outputSchema) across runs. */
export function roleMcpDefinitionHash(definition: unknown): string { return digest(stable(definition)); }
export function roleMcpConfigHash(plan: RolePlan, server: string): string {
  const selected = plan.mcp.find(m => m.server === server);
  if (!selected) throw new Error(`MCP server is outside the role plan: ${server}`);
  const config = selected.config;
  const cwd = config.command !== undefined ? config.cwd ?? plan.cwd : undefined;
  // Values remain their authored references. Credential rotation never changes identity.
  return digest(stable({ server, config, ...(cwd !== undefined ? { cwd } : {}) }));
}
function skillMetadata(plan: RolePlan): SkillSnapshot[] { return plan.skills.map(({ hash: _hash, ...s }) => clone(s)); }
export function initialRoleLoadout(plan: RolePlan, access: AccessMode): RoleRuntimeLoadout {
  accessMode(access);
  return { version: 3, tools: ["ask_question"], toolMetadata: [], extensions: [], skills: skillMetadata(plan),
    model: plan.model, thinking: plan.thinking, cwd: plan.cwd, agentDir: plan.agentDir,
    ...(plan.providerExtensions ? { providerExtensions: [...plan.providerExtensions] } : {}) };
}
export function snapshotRoleLoadout(plan: RolePlan, snapshot: RoleSnapshot): RoleRuntimeLoadout {
  validateRoleSnapshot(snapshot, plan, snapshot.binding, snapshot.effectiveAccess);
  const toolMetadata = snapshot.tools.map(({ semanticKind: _kind, sourceInfo: _source, entry: _entry, hash: _hash, server: _server, remoteName: _remote, configHash: _configHash, definitionHash: _definitionHash, ...t }) => clone(t));
  return { ...initialRoleLoadout(plan, snapshot.effectiveAccess), tools: [...toolMetadata.map(t => t.name), "ask_question"], toolMetadata,
    extensions: [...new Set(toolMetadata.filter(t => t.source === "extension").map(t => t.path))], skills: clone(snapshot.skills) };
}
function sourceInfo(value: unknown): asserts value is RoleToolInfo["sourceInfo"] {
  object(value, "tool sourceInfo");
  nonempty(value.source, "tool sourceInfo.source"); nonempty(value.path, "tool sourceInfo.path");
  if (!["user", "project", "temporary"].includes(value.scope as string) || !["package", "top-level"].includes(value.origin as string) ||
      (value.baseDir !== undefined && (typeof value.baseDir !== "string" || !isAbsolute(value.baseDir)))) throw new Error("Invalid tool sourceInfo");
}
const bridgeDescription = "Ask the parent a decision question. This tool blocks until the matching answer arrives.";
const bridgeParameters = { type: "object", properties: { question: { minLength: 1, type: "string" } }, required: ["question"] };
function checkBridge(q: RoleSnapshot["reservedBridge"]): void {
  object(q, "reserved question bridge"); sourceInfo(q.sourceInfo);
  if (q.name !== "ask_question" || q.source !== "extension" || q.path !== ROLE_CHILD_EXTENSION ||
      q.sourceInfo.path !== ROLE_CHILD_EXTENSION || ["builtin", "sdk", "inline"].includes(q.sourceInfo.source) ||
      q.exposure !== "model-only" || q.description !== bridgeDescription || !isDeepStrictEqual(q.parameters, bridgeParameters) ||
      q.namespace !== undefined || q.annotations !== undefined || q.promptGuidelines !== undefined) throw new Error("Reserved ask_question bridge provenance/schema mismatch");
}
function checkTool(t: RoleToolSnapshot, plan: RolePlan, access: AccessMode, wrapper = ROLE_CHILD_EXTENSION): void {
  object(t, "role tool snapshot"); sourceInfo(t.sourceInfo);
  const effective = effectiveRole(plan, access);
  // Reuse all wire-definition checks from v2, but never treat that projection as role authorization.
  validateLoadout({ ...initialRoleLoadout(plan, access), version: 2, tools: [t.name, "ask_question"], toolMetadata: [t],
    extensions: t.source === "extension" ? [t.path] : [] }, { resources: false });
  if (t.exposure !== "direct") throw new Error(`Invalid role tool exposure: ${t.name}`);
  if (t.semanticKind === "builtin") {
    if (!effective.builtinTools.includes(t.name) || t.source !== "builtin" || t.sourceInfo.source !== "builtin" ||
        ![`builtin:${t.name}`, `<builtin:${t.name}>`].includes(t.sourceInfo.path) || t.entry !== undefined || t.hash !== undefined ||
        t.server !== undefined || t.remoteName !== undefined || t.configHash !== undefined || t.definitionHash !== undefined) throw new Error(`Builtin provenance mismatch: ${t.name}`);
  } else if (t.semanticKind === "local-tool") {
    const entry = effective.extraTools.find(e => e.entry === t.entry && e.tools.includes(t.name));
    if (!entry || entry.hash !== t.hash || t.source !== "extension" || ["builtin", "sdk", "inline"].includes(t.sourceInfo.source) ||
        t.sourceInfo.path !== t.path || ![wrapper, entry.entry].includes(t.path) || t.server !== undefined || t.remoteName !== undefined || t.configHash !== undefined || t.definitionHash !== undefined) throw new Error(`Local tool provenance mismatch: ${t.name}`);
  } else if (t.semanticKind === "mcp") {
    const selected = effective.mcp.find(m => m.server === t.server && m.tools.includes(t.remoteName ?? ""));
    hash(t.definitionHash, "MCP definition");
    if (!selected || t.configHash !== roleMcpConfigHash(plan, selected.server) || t.source !== "extension" ||
        ["builtin", "sdk", "inline"].includes(t.sourceInfo.source) || t.path !== wrapper || t.sourceInfo.path !== t.path ||
        t.namespace?.name !== `mcp__${selected.server.replace(/-/g, "_")}` || t.entry !== undefined || t.hash !== undefined) {
      throw new Error(`MCP tool provenance/configuration mismatch: ${t.name}`);
    }
  } else throw new Error(`Invalid role tool kind: ${t.name}`);
}
function expectedNames(plan: RolePlan, access: AccessMode, tools: RoleToolSnapshot[]): string[] {
  const e = effectiveRole(plan, access);
  const remote = e.mcp.flatMap(m => m.tools.map(raw => {
    const found = tools.filter(t => t.semanticKind === "mcp" && t.server === m.server && t.remoteName === raw);
    if (found.length !== 1) throw new Error(`Missing or duplicate required MCP tool: ${m.server}/${raw}`);
    return found[0].name;
  }));
  return [...e.builtinTools, ...e.extraTools.flatMap(t => t.tools), ...remote];
}
function checkInventory(plan: RolePlan, access: AccessMode, tools: RoleToolSnapshot[], wrapper = ROLE_CHILD_EXTENSION): void {
  const seen = new Set<string>();
  for (const t of tools) { if (seen.has(t.name)) throw new Error(`Duplicate role tool: ${t.name}`); seen.add(t.name); checkTool(t, plan, access, wrapper); }
  const expected = expectedNames(plan, access, tools);
  if (expected.length !== seen.size || expected.some(n => !seen.has(n))) throw new Error("Role tool inventory is missing required tools or contains unexpected tools");
}
/** Verify the actual Pi inventory, never parent active tools. Entries identify original
 * trusted code; sourceInfo identifies the extension that registered its copied wrapper. */
export function snapshotRoleTools(plan: RolePlan, access: AccessMode, tools: RoleToolInfo[], localSources: RoleLocalSource[] = [], mcpSources: RoleMcpSource[] = []): RoleToolSnapshot[] {
  const q = tools.find(t => t.name === "ask_question");
  if (!q) throw new Error("Reserved ask_question bridge is missing");
  checkBridge({ ...snapshotTool(q), sourceInfo: q.sourceInfo });
  return snapshotCapabilities(plan, access, tools, localSources, mcpSources, ROLE_CHILD_EXTENSION);
}
/** PM adds runtime-owned management tools separately; no worker question bridge is granted. */
export function snapshotMainRoleTools(plan: RolePlan, tools: RoleToolInfo[], localSources: RoleLocalSource[] = [], mcpSources: RoleMcpSource[] = []): RoleToolSnapshot[] {
  return snapshotCapabilities(plan, plan.access, tools, localSources, mcpSources, ROLE_MAIN_EXTENSION);
}
export function validateMainRoleTools(plan: RolePlan, tools: RoleToolSnapshot[]): void {
  validateRolePlan(plan, { resources: false }); checkInventory(plan, plan.access, tools, ROLE_MAIN_EXTENSION);
}
function snapshotCapabilities(plan: RolePlan, access: AccessMode, tools: RoleToolInfo[], localSources: RoleLocalSource[], mcpSources: RoleMcpSource[], wrapper: string): RoleToolSnapshot[] {
  validateRolePlan(plan, { access });
  const seen = new Set<string>();
  for (const t of tools) { if (seen.has(t.name)) throw new Error(`Duplicate actual role tool: ${t.name}`); seen.add(t.name); }
  const effective = effectiveRole(plan, access);
  if (!isDeepStrictEqual(localSources, effective.extraTools)) throw new Error("Local tool source mapping does not match the role plan");
  const servers = new Map<string, string[]>();
  for (const selected of effective.mcp) servers.set(selected.server, [...(servers.get(selected.server) ?? []), ...selected.tools]);
  if (servers.size !== mcpSources.length || new Set(mcpSources.map(s => s.server)).size !== mcpSources.length) throw new Error("Incomplete or duplicate MCP source mapping");
  for (const source of mcpSources) {
    const rawNames = servers.get(source.server);
    if (!rawNames || source.configHash !== roleMcpConfigHash(plan, source.server) || source.tools.length !== rawNames.length ||
        new Set(source.tools.map(t => t.rawName)).size !== rawNames.length || source.tools.some(t => !rawNames.includes(t.rawName) || typeof t.name !== "string" || !t.name || !/^[a-f0-9]{64}$/.test(t.definitionHash))) {
      throw new Error("MCP source mapping does not match the role plan");
    }
  }
  const snapshots: RoleToolSnapshot[] = [];
  for (const t of tools) {
    if (t.name === "ask_question") continue;
    const metadata = snapshotTool(t);
    // Pi keeps inactive builtins in getAllTools. Authenticate provenance before
    // ignoring them; never hide an extension that substituted a builtin name.
    if (metadata.source === "builtin" && !effective.builtinTools.includes(t.name)) continue;
    const local = localSources.find(e => e.tools.includes(t.name));
    const remoteSources = mcpSources.flatMap(source => source.tools.filter(tool => tool.name === t.name).map(tool => ({ source, tool })));
    if (remoteSources.length > 1 || local && remoteSources.length) throw new Error(`Duplicate role tool identity: ${t.name}`);
    const remote = remoteSources[0];
    snapshots.push(clone({ ...metadata, semanticKind: local ? "local-tool" as const : remote ? "mcp" as const : "builtin" as const, sourceInfo: t.sourceInfo,
      ...(local ? { entry: local.entry, hash: local.hash } : {}),
      ...(remote ? { server: remote.source.server, remoteName: remote.tool.rawName, configHash: remote.source.configHash, definitionHash: remote.tool.definitionHash } : {}) }));
  }
  checkInventory(plan, access, snapshots, wrapper);
  // Persist declaration order, independent of host inventory ordering.
  return expectedNames(plan, access, snapshots).map(n => snapshots.find(t => t.name === n)!);
}
function checkBinding(binding: RoleBinding): void {
  object(binding, "role binding");
  for (const key of ["taskId", "attemptId", "nonce"] as const) nonempty(binding[key], `binding.${key}`);
  if (!Number.isSafeInteger(binding.run) || binding.run < 1) throw new Error("Invalid role binding run");
  hash(binding.planHash, "binding plan");
}
/** Structural only: safe to read history after source deletion. Live resources are
 * separately rechecked by validateRolePlan before each execution boundary. */
export function validateRoleSnapshot(value: unknown, plan: RolePlan, binding: RoleBinding, access: AccessMode): RoleSnapshot {
  validateRolePlan(plan, { resources: false }); accessMode(access); checkBinding(binding);
  object(value, "role snapshot"); const s = value as unknown as RoleSnapshot;
  if (s.version !== 1 || s.preflightComplete !== true || !Array.isArray(s.tools) || !Array.isArray(s.skills)) throw new Error("Invalid role snapshot version/structure");
  checkBinding(s.binding);
  if (!isDeepStrictEqual(s.binding, binding) || binding.planHash !== rolePlanDigest(plan)) throw new Error("Role snapshot binding mismatch");
  if (s.roleId !== plan.roleId || s.model !== plan.model || s.thinking !== plan.thinking || s.effectiveAccess !== access) throw new Error("Role snapshot plan/settings mismatch");
  nonempty(s.piVersion, "snapshot.piVersion"); checkBridge(s.reservedBridge); checkInventory(plan, access, s.tools);
  const sorted = (skills: SkillSnapshot[]) => clone(skills).sort((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(sorted(s.skills), sorted(skillMetadata(plan)))) throw new Error("Role snapshot skill inventory/metadata mismatch");
  return s;
}
/** Append first observations only after comparing the entire candidate set.
 * Tightening access deliberately does not erase definitions no longer enabled. */
export function mergeRoleBaseline(previous: RoleToolSnapshot[], snapshot: RoleSnapshot): RoleToolSnapshot[] {
  if (!Array.isArray(previous) || !snapshot || !Array.isArray(snapshot.tools) || snapshot.preflightComplete !== true) throw new Error("Invalid role baseline/snapshot");
  const baseline = new Map<string, RoleToolSnapshot>();
  for (const t of previous) {
    object(t, "baseline tool"); nonempty(t.name, "baseline tool name"); sourceInfo(t.sourceInfo);
    if (baseline.has(t.name)) throw new Error(`Duplicate baseline tool: ${t.name}`);
    baseline.set(t.name, t);
  }
  const seen = new Set<string>();
  for (const t of snapshot.tools) {
    object(t, "snapshot tool"); nonempty(t.name, "snapshot tool name"); sourceInfo(t.sourceInfo);
    if (seen.has(t.name)) throw new Error(`Duplicate snapshot tool: ${t.name}`); seen.add(t.name);
    const old = baseline.get(t.name);
    if (old && !isDeepStrictEqual(old, t)) throw new Error(`Historical role tool definition/provenance mismatch: ${t.name}`);
  }
  return clone([...previous, ...snapshot.tools.filter(t => !baseline.has(t.name))]);
}
