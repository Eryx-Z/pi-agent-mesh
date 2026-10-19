import type { Skill } from "@earendil-works/pi-coding-agent";
import * as pi from "@earendil-works/pi-coding-agent";
import { Ajv, type ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isScalar, parseDocument, visit } from "yaml";
import { isDelegationTool, type AccessMode } from "./loadout.ts";

export interface RoleSkill extends Skill {
  /** Canonical identity and original absolute loader spelling are deliberately distinct. */
  loadPath: string;
  hash: string;
}
export interface RoleMcpServerConfig {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  description?: string;
}
export interface ResolvedRole {
  id: string;
  description: string;
  source: string;
  manifestPath: string;
  manifestHash: string;
  systemPromptPath: string;
  systemPrompt: string;
  skills: RoleSkill[];
  builtinTools: string[];
  mcp: { server: string; tools: string[] }[];
  extraTools: { entry: string; tools: string[] }[];
  defaults: { access: AccessMode; context?: "none" | "partial" | "full"; model?: string };
}
export interface RoleDirectory {
  enabled: boolean;
  configPath: string;
  mainRole?: string;
  roles: ResolvedRole[];
  mcpServers: Record<string, RoleMcpServerConfig>;
}
interface TeamConfigV1 {
  schema_version: 1;
  enabled: boolean;
  main_role?: string;
  roles?: Record<string, string>;
  mcp_servers?: Record<string, RoleMcpServerConfig>;
}
interface RoleManifestV1 {
  schema_version: 1;
  id: string;
  description: string;
  system_prompt: string;
  skills?: string[];
  builtin_tools: string[];
  mcp?: ResolvedRole["mcp"];
  extra_tools?: { entry: string; tools: string[] }[];
  defaults: ResolvedRole["defaults"];
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let schemas: { team: ValidateFunction; role: ValidateFunction } | undefined;
function validators() {
  if (!schemas) {
    const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true });
    // Published files are the sole source of structural validation; do not mirror their rules here.
    const compile = (name: string) => ajv.compile(JSON.parse(readFileSync(join(root, "schemas", name), "utf8")));
    schemas = { team: compile("team-config-v1.schema.json"), role: compile("role-manifest-v1.schema.json") };
  }
  return schemas;
}
function validate(value: unknown, schema: ValidateFunction, label: string): void {
  if (schema(value)) return;
  const fields = schema.errors?.map(e => {
    const property = e.keyword === "additionalProperties" ? e.params.additionalProperty :
      e.keyword === "required" ? e.params.missingProperty : e.keyword === "propertyNames" ? e.params.propertyName : undefined;
    return `${e.instancePath || "/"}${property ? `/${property}` : ""}: ${e.message}`;
  });
  throw new Error(`${label}: ${fields?.join("; ") || "invalid structure"}`);
}
function utf8(path: string, label: string): { body: string; hash: string } {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { throw new Error(`${label}: cannot read file ${path}`); }
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label}: invalid UTF-8 in ${path}`); }
  return { body, hash: createHash("sha256").update(bytes).digest("hex") };
}
function yaml(body: string, label: string): unknown {
  const doc = parseDocument(body, { version: "1.2", schema: "core", strict: true, uniqueKeys: true, merge: false, prettyErrors: false });
  // Never echo parser source lines or user values (they may contain credentials).
  const diagnostics = [...doc.errors, ...doc.warnings];
  if (diagnostics.length) throw new Error(`${label}: YAML ${diagnostics.map(e => `${e.code} at offset ${e.pos[0]}`).join("; ")}`);
  // toJS coerces map keys to strings. Reject non-string keys before conversion,
  // otherwise YAML-distinct keys such as true and "true" silently overwrite an ID.
  visit(doc, { Pair(_key, pair) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error(`${label}: YAML mapping keys must be strings`);
    }
  } });
  try { return doc.toJS({ maxAliasCount: 50 }); }
  catch { throw new Error(`${label}: invalid YAML aliases`); }
}
function resource(path: string, base: string, label: string, directory = false): string {
  const absolute = resolve(base, path);
  try {
    const canonical = realpathSync(absolute);
    const stat = statSync(canonical);
    if (directory ? stat.isDirectory() : stat.isFile()) return canonical;
  } catch { /* stable, field-specific diagnostic below */ }
  throw new Error(`${label}: missing or invalid ${directory ? "directory" : "file"} ${absolute}`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function noDelegation(name: string, label: string): void {
  if (name === "ask_question" || name === "roles_list" || isDelegationTool(name)) {
    throw new Error(`${label}: prohibited worker management tool ${name}`);
  }
}
/** Check Pi's environment reference syntax without resolving or persisting secret values. */
function credentialReference(value: string, label: string): void {
  if (value.startsWith("!")) throw new Error(`${label}: credential command evaluation is not supported`);
  // Mirror Pi's reference scanner, not its resolver (which can execute commands).
  // Invalid braced expressions remain literal, including any dollar signs inside them.
  let index = 0;
  while (index < value.length) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) break;
    const next = value[dollar + 1];
    let name: string | undefined;
    if (next === "$" || next === "!") { index = dollar + 2; continue; }
    if (next === "{") {
      const end = value.indexOf("}", dollar + 2);
      if (end < 0) { index = dollar + 1; continue; }
      const candidate = value.slice(dollar + 2, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) name = candidate;
      index = end + 1;
    } else {
      name = value.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      index = dollar + 1 + (name?.length ?? 0);
    }
    if (name && !process.env[name]) throw new Error(`${label}: missing environment variable ${name}`);
  }
}
function servers(team: TeamConfigV1, path: string): Record<string, RoleMcpServerConfig> {
  const resolved: Record<string, RoleMcpServerConfig> = {};
  const nativeNames = new Map<string, string>();
  for (const [id, config] of Object.entries(team.mcp_servers ?? {})) {
    const label = `${path} mcp_servers.${id}`;
    const nativeName = id.replace(/-/g, "_");
    const existing = nativeNames.get(nativeName);
    if (existing !== undefined) throw new Error(`${label}: duplicate native MCP server identity with ${existing}`);
    nativeNames.set(nativeName, id);
    const entry = structuredClone(config);
    if (entry.cwd !== undefined) entry.cwd = resource(entry.cwd, dirname(path), `${label}.cwd`, true);
    if (entry.url !== undefined) {
      try {
        const url = new URL(entry.url);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error();
      } catch { throw new Error(`${label}.url: expected an HTTP(S) URL`); }
    }
    for (const field of ["env", "headers"] as const) {
      for (const [key, value] of Object.entries(entry[field] ?? {})) credentialReference(value, `${label}.${field}.${key}`);
    }
    resolved[id] = entry;
  }
  return resolved;
}
function loadRole(id: string, source: string, configPath: string, mcpServers: Record<string, RoleMcpServerConfig>): ResolvedRole {
  const initialLabel = `role ${id} (${source})`;
  let manifestPath: string;
  if (source.startsWith("builtin:")) {
    const builtin = source.slice("builtin:".length);
    if (!["pm", "builder", "tester", "reviewer"].includes(builtin)) throw new Error(`${initialLabel}: unknown builtin role`);
    manifestPath = resource(join(builtin, "role.yaml"), join(root, "roles"), `${initialLabel} manifest`);
  } else manifestPath = resource(source, dirname(configPath), `${initialLabel} manifest`);
  const label = `role ${id} (${manifestPath})`;
  const raw = utf8(manifestPath, `${label} manifest`);
  const parsed = yaml(raw.body, label);
  validate(parsed, validators().role, label);
  const manifest = parsed as RoleManifestV1;
  if (manifest.id !== id) throw new Error(`${label} id: mapping key does not match manifest id ${manifest.id}`);
  const base = dirname(manifestPath);
  const systemPromptPath = resource(manifest.system_prompt, base, `${label} system_prompt`);
  const systemPrompt = utf8(systemPromptPath, `${label} system_prompt`).body;
  const names = new Set<string>();
  const identities = new Set<string>();
  const skills: RoleSkill[] = (manifest.skills ?? []).map((path, i) => {
    const field = `${label} skills[${i}]`;
    const loadPath = resolve(base, path);
    if (basename(loadPath) !== "SKILL.md") throw new Error(`${field}: expected an exact SKILL.md file path`);
    const filePath = resource(path, base, field);
    const { hash } = utf8(filePath, field);
    if (identities.has(filePath)) throw new Error(`${field}: duplicate skill file ${filePath}`);
    identities.add(filePath);
    if (typeof pi.loadSkills !== "function") throw new Error(`${field}: host does not expose the public loadSkills API`);
    // One exact file per call: Pi otherwise silently deduplicates identities and skill names.
    const result = pi.loadSkills({ cwd: base, agentDir: base, includeDefaults: false, skillPaths: [loadPath] });
    if (result.diagnostics.length || result.skills.length !== 1) {
      // Pi diagnostics can contain source content; field and diagnostic type suffice here.
      throw new Error(`${field}: invalid skill metadata (${result.diagnostics.map(d => d.type).join(", ") || "no skill loaded"})`);
    }
    const skill = result.skills[0];
    if (names.has(skill.name)) throw new Error(`${field}: duplicate skill name ${skill.name}`);
    names.add(skill.name);
    return { ...structuredClone(skill), filePath, baseDir: realpathSync(skill.baseDir),
      sourceInfo: { ...structuredClone(skill.sourceInfo), path: filePath }, loadPath, hash };
  });
  const builtinTools = [...manifest.builtin_tools];
  const localNames = new Set(builtinTools);
  const extraTools = (manifest.extra_tools ?? []).map((entry, i) => {
    const field = `${label} extra_tools[${i}]`;
    for (const tool of entry.tools) {
      noDelegation(tool, `${field}.tools`);
      if (localNames.has(tool)) throw new Error(`${field}.tools: duplicate tool name ${tool}`);
      localNames.add(tool);
    }
    const path = resource(entry.entry, base, `${field}.entry`);
    utf8(path, `${field}.entry`); // Read source bytes only; never import or execute an extension.
    return { entry: path, tools: [...entry.tools] };
  });
  const mcpNames = new Map<string, Set<string>>();
  const mcp = (manifest.mcp ?? []).map((entry, i) => {
    const field = `${label} mcp[${i}]`;
    if (!Object.hasOwn(mcpServers, entry.server)) throw new Error(`${field}.server: missing MCP reference ${entry.server}`);
    const tools = mcpNames.get(entry.server) ?? new Set<string>();
    mcpNames.set(entry.server, tools);
    for (const tool of entry.tools) {
      noDelegation(tool, `${field}.tools`);
      if (tools.has(tool)) throw new Error(`${field}.tools: duplicate MCP tool name ${entry.server}/${tool}`);
      tools.add(tool);
    }
    return { server: entry.server, tools: [...entry.tools] };
  });
  return { id, description: manifest.description, source: source.startsWith("builtin:") ? source : manifestPath,
    manifestPath, manifestHash: raw.hash, systemPromptPath, systemPrompt, skills, builtinTools, mcp, extraTools,
    defaults: structuredClone(manifest.defaults) };
}

/** Passive, synchronous catalog. Selection is pinned now; first reload pins canonical file identity. */
export class RoleCatalog {
  readonly explicit: boolean;
  private readonly selectedPath: string;
  private canonicalPath?: string;
  current?: RoleDirectory;
  error?: string;

  constructor(startupCwd: string, explicitPath?: string) {
    // An explicit empty string captures default selection without rereading a changed environment.
    const selected = explicitPath === undefined ? process.env.PI_AGENT_MESH_CONFIG : explicitPath;
    this.explicit = typeof selected === "string" && selected.trim().length > 0;
    this.selectedPath = resolve(startupCwd, this.explicit ? selected! : ".pi/agent-mesh.yaml");
  }
  get configPath(): string { return this.canonicalPath ?? this.selectedPath; }

  reload(): RoleDirectory {
    try {
      if (!this.canonicalPath) {
        try { lstatSync(this.selectedPath); }
        catch (error) {
          if (!this.explicit && (error as NodeJS.ErrnoException).code === "ENOENT") {
            const disabled = freeze({ enabled: false, configPath: this.selectedPath, roles: [], mcpServers: {} });
            this.current = disabled; this.error = undefined; return disabled;
          }
          throw new Error(`${this.selectedPath}: cannot read team configuration`);
        }
        // Relative resources are relative to the canonical configuration's directory, not an alias.
        this.canonicalPath = resource(this.selectedPath, dirname(this.selectedPath), "team configuration");
      }
      const path = this.canonicalPath;
      if (resource(path, dirname(path), "team configuration") !== path) {
        throw new Error(`${path}: canonical configuration identity changed; start a new session to select another file`);
      }
      const parsed = yaml(utf8(path, "team configuration").body, path);
      validate(parsed, validators().team, path);
      const team = parsed as TeamConfigV1;
      let next: RoleDirectory;
      if (!team.enabled) next = { enabled: false, configPath: path, roles: [], mcpServers: {} };
      else {
        const mcpServers = servers(team, path);
        const roles = Object.entries(team.roles ?? {}).map(([id, source]) => loadRole(id, source, path, mcpServers));
        const mainRole = team.main_role ?? "pm";
        if (!roles.some(role => role.id === mainRole)) throw new Error(`${path} main_role: role ${mainRole} is not selected in roles`);
        next = { enabled: true, configPath: path, mainRole, roles, mcpServers };
      }
      this.current = freeze(next);
      this.error = undefined;
      return this.current;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Invalid role configuration";
      throw new Error(this.error);
    }
  }
}

export interface RoleDefaultsOverrides {
  access?: AccessMode;
  model?: string;
  context?: "none" | "partial" | "full";
  contextText?: string;
}
export interface ResolvedRoleDefaults {
  access: AccessMode;
  model: string;
  context: "none" | "partial" | "full";
  contextText?: string;
}
/** Dispatch-time precedence only: no RolePlan, child resources, or implicit history copying. */
export function resolveRoleDefaults(role: ResolvedRole, overrides: RoleDefaultsOverrides, parentModel: string): ResolvedRoleDefaults {
  const label = `role ${role.id} (${role.manifestPath}) defaults`;
  const access = overrides.access !== undefined ? overrides.access : role.defaults.access;
  if (access !== "read-only" && access !== "full") throw new Error(`${label}.access: expected read-only or full`);
  const context = overrides.context !== undefined ? overrides.context : role.defaults.context ?? "partial";
  if (!["none", "partial", "full"].includes(context)) throw new Error(`${label}.context: expected none, partial or full`);
  const configuredModel = role.defaults.model;
  const model = overrides.model !== undefined ? overrides.model : (configuredModel && configuredModel !== "inherit" ? configuredModel : parentModel);
  if (typeof model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error(`${label}.model: expected an actual provider/model ID`);
  if (context === "partial" && (typeof overrides.contextText !== "string" || !overrides.contextText.trim())) {
    throw new Error(`${label}: partial context requires nonempty contextText`);
  }
  if (overrides.contextText !== undefined && typeof overrides.contextText !== "string") throw new Error(`${label}.contextText: expected a string`);
  if (overrides.contextText !== undefined && context !== "partial") throw new Error(`${label}.contextText: only supported for partial context`);
  return { access, context, model, ...(overrides.contextText !== undefined ? { contextText: overrides.contextText } : {}) };
}
