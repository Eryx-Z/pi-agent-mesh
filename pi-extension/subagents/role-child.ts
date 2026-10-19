import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { registerQuestionTool } from "./child.ts";
import { accessMode, snapshotSkills, snapshotTool, verifySkills, type Loadout } from "./loadout.ts";
import { effectiveRole, rolePlanDigest, ROLE_CHILD_EXTENSION, snapshotRoleTools, validateRolePlan, validateRoleSnapshot,
  ROLE_MCP_EXTENSION, type RoleBinding, type RolePlan, type RoleRun, type RoleSnapshot } from "./role-loadout.ts";
import type { RoleMcpAdapter } from "./role-mcp.ts";
import { loadRoleTools } from "./role-tools.ts";

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function assertRoleHostVersion(version = VERSION): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) !== 1 || Number(match[2]) === 0 && Number(match[3]) < 2) {
    throw new Error("Role execution requires Pi 1.0.2 or newer (1.x); legacy non-role execution is unchanged");
  }
}

/** Validate identity before reading or importing any run resources. */
export function validateRoleRunInput(value: unknown): { plan: RolePlan; run: RoleRun; resultPath: string; readinessDeadline: number } {
  const input = value as { plan: unknown; run: RoleRun; resultPath: string; readinessDeadline?: number };
  if (!input || typeof input !== "object" || !isAbsolute(input.resultPath ?? "")) throw new Error("Invalid role run result path");
  const run = input.run;
  if (!run || run.version !== 1 || !["planned", "verified", "submitting", "submitted"].includes(run.status)) throw new Error("Invalid role run status/version");
  accessMode(run.access);
  const binding = run.binding;
  if (!binding || !Number.isSafeInteger(binding.run) || binding.run < 1 ||
    ["taskId", "attemptId", "nonce", "planHash"].some(k => typeof binding[k as keyof RoleBinding] !== "string" || !(binding[k as keyof RoleBinding] as string).trim())) throw new Error("Invalid role run binding");
  if (run.continuationMessage !== undefined && typeof run.continuationMessage !== "string") throw new Error("Invalid role run continuation message");
  const plan = validateRolePlan(input.plan, { resources: false });
  if (binding.planHash !== rolePlanDigest(plan)) throw new Error("Role run binding plan digest mismatch");
  if (run.snapshot !== undefined) validateRoleSnapshot(run.snapshot, plan, binding, run.access);
  const readinessDeadline = input.readinessDeadline ?? Date.now() + 30000;
  if (!Number.isSafeInteger(readinessDeadline) || readinessDeadline < 1) throw new Error("Invalid role readiness deadline");
  return { plan, run: json(run), resultPath: input.resultPath, readinessDeadline };
}
function atomicResult(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Role-only child extension. The legacy bridge never imports this module. */
export default async function roleChild(pi: ExtensionAPI) {
  const env = process.env.PI_RPC_SUBAGENT_ROLE_RUN;
  if (!env) throw new Error("Role child requires PI_RPC_SUBAGENT_ROLE_RUN");
  if (!isAbsolute(env)) throw new Error("Role child requires an absolute private run JSON file path");
  const { plan, run, resultPath, readinessDeadline } = validateRoleRunInput(JSON.parse(readFileSync(env, "utf8")));
  const effective = effectiveRole(plan, run.access);
  const allowed = new Set([...effective.builtinTools, ...effective.extraTools.flatMap(e => e.tools), "ask_question"]);
  let local: Awaited<ReturnType<typeof loadRoleTools>> | undefined;
  let mcp: RoleMcpAdapter | undefined;
  const startupAbort = new AbortController();
  let startupError: unknown;
  let ready: RoleSnapshot | undefined;
  let question: ToolDefinition | undefined;
  let questionExecute: ToolDefinition["execute"] | undefined;
  const helperPath = fileURLToPath(new URL("./child.ts", import.meta.url));
  const implementationSources = new Map([ROLE_CHILD_EXTENSION, helperPath].map(path => [path, hashFile(path)]));
  const disable = () => { ready = undefined; pi.setActiveTools([]); };
  const verify = (ctx: ExtensionContext) => {
    if (!ready) throw new Error("Role child preflight is not complete");
    local?.verify(); mcp?.verify();
    for (const [path, hash] of implementationSources) if (hashFile(path) !== hash) throw new Error(`Role tool implementation source changed: ${path}`);
    const actual = snapshotRoleTools(plan, run.access, pi.getAllTools(), local?.sources ?? [], mcp?.sources() ?? []);
    if (!isDeepStrictEqual(json(actual), ready.tools)) throw new Error("Role tool schema/provenance changed after preflight");
    const bridge = pi.getAllTools().find(t => t.name === "ask_question");
    if (!bridge || !isDeepStrictEqual(json({ ...snapshotTool(bridge), sourceInfo: bridge.sourceInfo }), ready.reservedBridge) ||
      !question || question.execute !== questionExecute || question.executionMode !== "sequential" || question.exposure !== "model-only") throw new Error("Role ask_question bridge definition/implementation changed");
    if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== ready.model || pi.getThinkingLevel() !== ready.thinking) throw new Error("Role model/thinking changed after preflight");
  };
  pi.on("session_start", () => {
    disable();
    question = registerQuestionTool(pi); questionExecute = question.execute;
    // Registering a direct/model-only tool activates it: clear again until preflight.
    disable();
  });
  pi.on("input", () => ready ? undefined : { action: "handled" });
  pi.on("tool_call", (event, ctx) => {
    if (!ready || !allowed.has(event.toolName) || (event.toolName === "ask_question" && event.parentToolCallId)) return { block: true, reason: "Tool outside verified role loadout (including nested calls)", terminate: true };
    try { verify(ctx); }
    catch (error) { disable(); return { block: true, reason: error instanceof Error ? error.message : String(error), terminate: true }; }
  });
  pi.on("session_shutdown", async () => { ready = undefined; local?.dispose(); await mcp?.close(); });
  pi.registerCommand("rpc-role-cancel-preflight", {
    description: "Internal cancellation of role readiness (no model call)",
    async handler() { startupAbort.abort(); disable(); await mcp?.close(); },
  });
  pi.registerCommand("rpc-subagent-preflight", {
    description: "Internal role preflight (private bound snapshot, no model call)",
    async handler(_args, ctx: ExtensionCommandContext) {
      disable();
      try {
        if (startupError) throw startupError;
        if (!local) throw new Error("Role tool loading was not completed");
        local.verify();
        validateRolePlan(plan, { access: run.access });
        const skills = plan.skills.map(({ hash: _hash, ...skill }) => skill);
        verifySkills({ skills } as Loadout, ctx.getSystemPromptOptions().skills);
        if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== plan.model) throw new Error(`Requested role model was not selected: ${plan.model}`);
        if (pi.getThinkingLevel() !== plan.thinking) throw new Error(`Requested role thinking level was not selected: ${plan.thinking}`);
        if (Date.now() >= readinessDeadline) throw new Error("Role readiness deadline expired");
        await mcp?.ready(ctx, readinessDeadline, ctx.signal ? AbortSignal.any([startupAbort.signal, ctx.signal]) : startupAbort.signal);
        startupAbort.signal.throwIfAborted();
        const mcpSources = mcp?.sources() ?? [];
        for (const source of mcpSources) for (const tool of source.tools) allowed.add(tool.name);
        const all = pi.getAllTools();
        const bridge = all.find(t => t.name === "ask_question");
        if (!bridge || realpathSync(bridge.sourceInfo.path) !== realpathSync(ROLE_CHILD_EXTENSION) || bridge.exposure !== "model-only") throw new Error("Role ask_question bridge source/exposure was replaced");
        const tools = snapshotRoleTools(plan, run.access, all, local.sources, mcpSources);
        const snapshot: RoleSnapshot = json({ version: 1, binding: run.binding, roleId: plan.roleId, tools,
          skills: snapshotSkills(ctx.getSystemPromptOptions().skills ?? []),
          reservedBridge: { ...snapshotTool(bridge), sourceInfo: bridge.sourceInfo },
          piVersion: VERSION, model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel(),
          effectiveAccess: run.access, preflightComplete: true });
        for (const [path, hash] of implementationSources) if (hashFile(path) !== hash) throw new Error(`Role bridge implementation source changed: ${path}`);
        for (const t of [...tools, snapshot.reservedBridge]) {
          if (t.sourceInfo.source !== "builtin" && !implementationSources.has(t.sourceInfo.path)) implementationSources.set(t.sourceInfo.path, hashFile(t.sourceInfo.path));
        }
        pi.setActiveTools([...allowed]);
        const active = pi.getActiveTools();
        if (active.length !== allowed.size || active.some(name => !allowed.has(name))) throw new Error("Exact role active tool allowlist was not applied");
        atomicResult(resultPath, { binding: run.binding, snapshot });
        ready = snapshot;
      } catch (error) {
        disable();
        await mcp?.close();
        atomicResult(resultPath, { binding: run.binding, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  try {
    assertRoleHostVersion();
    if (Date.now() >= readinessDeadline) throw new Error("Role readiness deadline expired");
    validateRolePlan(plan, { access: run.access });
    local = await loadRoleTools(plan, run.access, AbortSignal.any([startupAbort.signal, AbortSignal.timeout(Math.max(1, readinessDeadline - Date.now()))]));
    local.register(pi);
    if (effective.mcp.length) {
      implementationSources.set(ROLE_MCP_EXTENSION, hashFile(ROLE_MCP_EXTENSION));
      const { setupRoleMcp } = await import("./role-mcp.ts");
      mcp = await setupRoleMcp(pi, plan, run.access);
    }
  } catch (error) { startupError = error; local?.dispose(); await mcp?.close(); }
}
