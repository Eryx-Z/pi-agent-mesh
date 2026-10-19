import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { RolePlan, RoleToolSnapshot } from "./role-loadout.ts";

export const CHILD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "child.ts");
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);
const DELEGATION_TOOLS = new Set(["subagent", "subagent_message", "subagents_list", "subagent_control", "delegate", "delegate_task", "workflow_run", "workflow_control", "roles_list"]);
export type AccessMode = "read-only" | "full";
export function accessMode(value: unknown): AccessMode {
  if (value !== "read-only" && value !== "full") throw new Error("access must be read-only or full");
  return value;
}
/** Conservative tool restriction, not a filesystem sandbox. Never trust a tool name alone. */
export function applyAccess(loadout: Loadout, access: AccessMode): Loadout {
  accessMode(access);
  const l = structuredClone(validateLoadout(loadout));
  if (access === "read-only") {
    l.toolMetadata = l.toolMetadata.filter(t => t.source === "builtin" && ["read", "grep", "find", "ls"].includes(t.name));
    l.tools = [...l.toolMetadata.map(t => t.name), "ask_question"];
    l.extensions = [];
    delete l.parentRole;
  }
  return validateLoadout(l);
}
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
export interface ToolSnapshot {
  name: string; description: string; parameters: ToolInfo["parameters"]; promptGuidelines?: string[];
  source: "builtin" | "extension"; path: string;
  /** Missing exposure in legacy v2 records means the historical direct default. */
  exposure?: ToolInfo["exposure"]; namespace?: ToolInfo["namespace"]; annotations?: ToolInfo["annotations"];
}
export interface SkillSnapshot {
  name: string; description: string; filePath: string; baseDir: string; disableModelInvocation: boolean;
  /** Original absolute loader path; unlike canonical identity, symlink spelling affects skill metadata. */
  loadPath?: string;
}
export interface Loadout {
  version: 2; tools: string[]; toolMetadata: ToolSnapshot[]; extensions: string[]; skills: SkillSnapshot[];
  model: string; thinking: string; cwd: string; agentDir: string;
  /** Explicitly advertised provider-only entrypoints; independent of tool access. */
  providerExtensions?: string[];
  /** Frozen implementation mapping for PM-owned tools on the ordinary inherited path. */
  parentRole?: { version: 1; plan: RolePlan; tools: RoleToolSnapshot[] };
}
export function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}
/** Tool APIs have no capability tags. Exclude known and conventional delegation tool names. */
export function isDelegationTool(name: string): boolean {
  return DELEGATION_TOOLS.has(name) || /(?:^|[_-])subagents?(?:[_-]|$)/i.test(name) ||
    /^(?:(?:spawn|launch|create|manage|control|message|list|wait|close|stop|resume|send_input)[_-]agents?|agents?[_-](?:spawn|launch|create|manage|control|message|list|wait|close|stop|resume))$/i.test(name);
}
function file(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Cannot inherit ${label}: no absolute file-backed source`);
  try {
    const canonical = realpathSync(path);
    if (statSync(canonical).isFile()) return canonical;
  } catch {}
  throw new Error(`Cannot inherit ${label}: missing source file ${path}`);
}
export function snapshotTool(tool: ToolInfo): ToolSnapshot {
  const source = tool.sourceInfo?.source === "builtin" ? "builtin" : "extension";
  if (tool.sourceInfo?.source === "sdk") throw new Error(`Cannot inherit tool ${tool.name}: SDK tools have no reloadable implementation`);
  const path = source === "builtin" ? `<builtin:${tool.name}>` : file(tool.sourceInfo?.path, `tool ${tool.name}`);
  // Pi 1.0 uses builtin:<name>; older hosts used <builtin:<name>>.
  // Keep persisted snapshots canonical and reject mismatched names or sources.
  if (source === "builtin" && (!BUILTIN_TOOLS.has(tool.name) ||
      (tool.sourceInfo.path !== path && tool.sourceInfo.path !== `builtin:${tool.name}`))) throw new Error(`Invalid builtin provenance: ${tool.name}`);
  // Tool schemas are JSON on the wire; discard TypeBox's symbol metadata, not schema fields.
  return JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines, exposure: tool.exposure ?? "direct",
    namespace: tool.namespace, annotations: tool.annotations, source, path }));
}
export function snapshotSkills(skills: readonly Skill[]): SkillSnapshot[] {
  return skills.map(s => ({ name: s.name, description: s.description, filePath: file(s.filePath, `skill ${s.name}`),
    loadPath: s.filePath, baseDir: realpathSync(s.baseDir), disableModelInvocation: s.disableModelInvocation }));
}
/** Inputs come from the live parent API and prompt options, never resource rediscovery. */
export function resolveLoadout(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools"> & Partial<Pick<ExtensionAPI, "events">>, skills: readonly Skill[] | undefined,
  cwd: string, model: string, thinking: string, configDir = getAgentDir()): Loadout {
  if (!skills) throw new Error("Parent skill inventory is unavailable; launch during a parent agent turn");
  const all = new Map(pi.getAllTools().map(t => [t.name, t]));
  const names = [...new Set(pi.getActiveTools())].filter(n => n !== "ask_question" && !isDelegationTool(n));
  const toolMetadata = names.map(name => {
    const tool = all.get(name);
    if (!tool) throw new Error(`Cannot inherit active tool ${name}: runtime metadata is missing`);
    return snapshotTool(tool);
  });
  const providerExtensions: string[] = [];
  // Opt-in synchronous discovery. Only trusted loaded extensions may advertise an entrypoint.
  pi.events?.emit("rpc-subagents:provider-source:v1", { provider: model.split("/")[0],
    register: (path: string) => { providerExtensions.push(file(path, "model provider")); } });
  return validateLoadout({ version: 2, tools: [...names, "ask_question"], toolMetadata,
    ...(providerExtensions.length ? { providerExtensions: [...new Set(providerExtensions)] } : {}),
    extensions: [...new Set(toolMetadata.filter(t => t.source === "extension").map(t => t.path))],
    skills: snapshotSkills(skills), model, thinking, cwd: realpathSync(cwd), agentDir: resolve(configDir) });
}
export function validateLoadout(value: unknown, options: { resources?: boolean } = {}): Loadout {
  const resources = options.resources !== false;
  const sourcePath = (path: string, label: string) => {
    if (resources) return file(path, label);
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Cannot inherit ${label}: no absolute file-backed source`);
    return path;
  };
  const l = value as Loadout;
  if (!l || l.version !== 2 || !Array.isArray(l.tools) || !Array.isArray(l.toolMetadata) || !Array.isArray(l.extensions) || !Array.isArray(l.skills)) {
    throw new Error("Invalid v2 inherited loadout; legacy profile tasks cannot be continued, launch a new task");
  }
  for (const key of ["model", "thinking", "cwd", "agentDir"] as const) nonempty(l[key], `loadout.${key}`);
  if (!isAbsolute(l.cwd) || !isAbsolute(l.agentDir) || (resources && !statSync(l.cwd).isDirectory())) throw new Error("Loadout cwd/config must be absolute and cwd must exist");
  if (!/^[^/]+\/.+/.test(l.model)) throw new Error("Use a canonical provider/model ID");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(l.thinking)) throw new Error("Invalid thinking level");
  if (!l.tools.includes("ask_question") || new Set(l.tools).size !== l.tools.length ||
      l.tools.some(t => typeof t !== "string" || !/^[\w.-]+$/.test(t) || isDelegationTool(t))) throw new Error("Invalid child tool allowlist: nested delegation is disabled");
  if (!isDeepStrictEqual(l.toolMetadata.map(t => t.name), l.tools.filter(n => n !== "ask_question"))) throw new Error("Incomplete inherited tool metadata");
  for (const t of l.toolMetadata) {
    if (typeof t.description !== "string" || !t.parameters || typeof t.parameters !== "object" ||
        (t.exposure !== undefined && !["direct", "model-only", "codemode", "deferred", "hidden"].includes(t.exposure)) ||
        (t.namespace !== undefined && (!t.namespace || typeof t.namespace.name !== "string" || !t.namespace.name.trim())) ||
        (t.annotations !== undefined && (!t.annotations || typeof t.annotations !== "object" || Array.isArray(t.annotations) ||
          Object.values(t.annotations).some(v => typeof v !== "boolean")))) throw new Error(`Invalid tool metadata: ${t.name}`);
    if (t.source === "builtin") {
      if (!BUILTIN_TOOLS.has(t.name) || t.path !== `<builtin:${t.name}>`) throw new Error(`Invalid builtin provenance: ${t.name}`);
    } else if (t.source !== "extension" || sourcePath(t.path, `tool ${t.name}`) !== t.path) throw new Error(`Invalid tool provenance: ${t.name}`);
  }
  const extensions = [...new Set(l.toolMetadata.filter(t => t.source === "extension").map(t => t.path))];
  if (!isDeepStrictEqual(l.extensions, extensions)) throw new Error("Extension sources do not match inherited tools");
  if (l.parentRole !== undefined && (!l.parentRole || l.parentRole.version !== 1 || !l.parentRole.plan ||
      !Array.isArray(l.parentRole.tools) || !l.extensions.includes(join(dirname(CHILD_EXTENSION), "index.ts")))) {
    throw new Error("Invalid inherited PM implementation mapping");
  }
  if (l.providerExtensions !== undefined && (!Array.isArray(l.providerExtensions) ||
      new Set(l.providerExtensions).size !== l.providerExtensions.length ||
      l.providerExtensions.some(p => sourcePath(p, "model provider") !== p))) throw new Error("Invalid provider entrypoints");
  const names = new Set<string>();
  for (const s of l.skills) {
    nonempty(s.name, "skill.name"); nonempty(s.description, "skill.description");
    if (names.has(s.name) || sourcePath(s.filePath, `skill ${s.name}`) !== s.filePath ||
        (resources ? sourcePath(s.loadPath ?? s.filePath, `skill ${s.name} load path`) !== s.filePath :
          !isAbsolute(s.loadPath ?? s.filePath)) || !isAbsolute(s.baseDir) ||
        (resources && (realpathSync(s.baseDir) !== s.baseDir || !statSync(s.baseDir).isDirectory())) ||
        typeof s.disableModelInvocation !== "boolean") throw new Error(`Invalid skill snapshot: ${s.name}`);
    names.add(s.name);
  }
  return l;
}
export function verifyTools(loadout: Loadout, tools: ToolInfo[]): void {
  const all = new Map(tools.map(t => [t.name, t]));
  for (const expected of loadout.toolMetadata) {
    const actual = all.get(expected.name);
    if (!actual) throw new Error(`Child is missing required tool: ${expected.name}`);
    const normalized = { ...expected, exposure: expected.exposure ?? "direct" };
    if (!isDeepStrictEqual(snapshotTool(actual), normalized)) throw new Error(`Inherited tool schema/provenance mismatch: ${expected.name}`);
  }
  const question = all.get("ask_question");
  if (!question || file(question.sourceInfo?.path, "ask_question") !== realpathSync(CHILD_EXTENSION)) throw new Error("Child ask_question bridge was replaced");
}
export function verifySkills(loadout: Loadout, skills: readonly Skill[] | undefined): void {
  if (!skills) throw new Error("Child skill inventory is unavailable");
  const sorted = (s: SkillSnapshot[]) => s.map(({ loadPath: _loadPath, ...identity }) => identity).sort((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(sorted(snapshotSkills(skills)), sorted(loadout.skills))) throw new Error("Inherited skill inventory/metadata mismatch");
}
