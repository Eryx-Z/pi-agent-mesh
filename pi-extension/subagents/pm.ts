import { getPackageDir, loadSkills, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type BeforeAgentStartEvent, type Skill, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { snapshotSkills, snapshotTool, type ToolSnapshot } from "./loadout.ts";
import { createRolePlan, effectiveRole, rolePlanDigest, ROLE_MAIN_EXTENSION, snapshotMainRoleTools, validateMainRoleTools, validateRolePlan, type RolePlan, type RoleToolSnapshot } from "./role-loadout.ts";
import { roleSettings, selectedModel } from "./role-dispatch.ts";
import { loadRoleTools, waitForRoleResource } from "./role-tools.ts";
import type { RoleMcpAdapter } from "./role-mcp.ts";
import type { RoleCatalogAccess } from "./roles-ui.ts";

export const PM_ENTRY = "agent_mesh_pm";
export const MANAGEMENT_TOOLS = ["subagent", "subagent_control", "workflow_run", "workflow_control", "roles_list"];
interface PmSnapshot { version: 1; plan: RolePlan; planHash: string; configPath: string; tools: RoleToolSnapshot[]; management: (ToolSnapshot & { sourceInfo: unknown })[]; piVersion: string; promptVersion: 1 }
type Notification = Parameters<ExtensionAPI["sendMessage"]>[0];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function roleHostSupported(): boolean {
  const version = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")).version as string;
  return /^1\.(?:[1-9]\d*\.\d+|0\.(?:[2-9]|\d{2,}))$/.test(version);
}

/** Native Pi does not flush setup/custom entries until a user/assistant message exists.
 * Keep failures independently, without precreating its session file (the host first flush uses wx).
 * Publish an immutable sibling with no-clobber link, private mode, and file + directory fsync. */
function retainPmFailure(ctx: ExtensionContext, error: string): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No persistent session path is available for a PM failure record");
  const path = `${sessionFile}.agent-mesh-pm-failure-${randomUUID()}.json`, temporary = `${path}.tmp`;
  let fd: number | undefined, created = false;
  try {
    fd = openSync(temporary, "wx", 0o600); created = true;
    writeFileSync(fd, JSON.stringify({ version: 1, state: "failed", error, timestamp: new Date().toISOString(),
      sessionFile, sessionId: ctx.sessionManager.getSessionId?.(), cwd: ctx.cwd }, null, 2) + "\n");
    fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, path); // Never follow or replace an existing destination, including symlinks.
  } finally {
    try { if (fd !== undefined) closeSync(fd); }
    finally { if (created) unlinkSync(temporary); }
  }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return path;
}

/** Session-scoped PM state. All mesh-owned wakeups route through this gate. */
export function createTeamRuntime(pi: ExtensionAPI, catalog: RoleCatalogAccess, options: { readinessMs?: number; observe?: (event: { state: "off" | "initializing" | "ready" | "failed"; error?: string }) => void } = {}) {
  const readinessMs = options.readinessMs ?? 30000;
  if (!Number.isSafeInteger(readinessMs) || readinessMs < 1 || readinessMs > 30000) throw new Error("PM readinessMs must be 1–30000");
  let state: "off" | "initializing" | "ready" | "failed" = "off", error = "";
  let plan: RolePlan | undefined, saved: PmSnapshot | undefined, skills: Skill[] = [], allowed: string[] = [];
  let local: Awaited<ReturnType<typeof loadRoleTools>> | undefined, mcp: RoleMcpAdapter | undefined;
  let abort = new AbortController(), generation = 0, context: ExtensionContext | undefined;
  let modelSelection: Promise<boolean> | undefined;
  let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  let hooks: (() => void)[] = [];
  let pending: Notification[] = [], flushScheduled = false, turnPending = false;
  pi.on("agent_settled", () => {
    // The host emits settled before Agent.activeRun is cleared. A later event
    // loop turn avoids racing a second prompt with that final cleanup.
    const current = generation;
    setImmediate(() => { if (current === generation) { turnPending = false; flush(); } });
  });
  const publish = (next: typeof state, nextError = error) => {
    if (next === state && nextError === error) return;
    state = next; error = nextError;
    try { options.observe?.({ state: next, error: nextError || undefined }); } catch { /* Observability must not affect readiness. */ }
  };
  const fail = (cause: unknown) => {
    publish("failed", cause instanceof Error ? cause.message : String(cause)); pi.setActiveTools([]);
    context?.ui.notify(`PM not ready: ${error}. Inspect /roles and start a new session after fixing resources.`, "error");
    context?.ui.setStatus("agent-mesh-role", "PM failed");
  };
  function verifyMcpOwnership() {
    // Pi exposes duplicate command owners as mcp:1, mcp:2, etc. Reserving our own
    // /mcp replaces the builtin, but cannot cancel an explicit factory's handlers.
    // Server registrations alone are not owners: our controlled adapter filters those.
    const competing = (pi.getCommands?.() ?? []).filter(command => command.source === "extension" && /^mcp(?::\d+)?$/.test(command.name) && command.sourceInfo.path !== ROLE_MAIN_EXTENSION);
    if (competing.length) throw new Error(`PM MCP ownership conflict: ${competing.map(command => `${command.name} (${command.sourceInfo.path})`).join(", ")}. Disable the competing MCP extension and start a new session; PM cannot isolate another extension's lifecycle connections`);
  }
  function verifyLocalOwnership(active: RolePlan) {
    const names = new Set(effectiveRole(active, active.access).extraTools.flatMap(entry => entry.tools));
    const competing = pi.getAllTools().find(tool => names.has(tool.name) && tool.sourceInfo.path !== ROLE_MAIN_EXTENSION);
    if (competing) throw new Error(`PM local tool ownership conflict: ${competing.name} (${competing.sourceInfo.path}). Disable the independently loaded entry and start a new session; selected local tools require the controlled PM loader`);
  }
  function management() {
    return MANAGEMENT_TOOLS.map(name => {
      const tool = pi.getAllTools().find(t => t.name === name);
      if (!tool || tool.sourceInfo.path !== ROLE_MAIN_EXTENSION || ["sdk", "inline", "builtin"].includes(tool.sourceInfo.source) || tool.exposure !== "direct") throw new Error(`PM runtime management tool provenance mismatch: ${name}`);
      return copy({ ...snapshotTool(tool), sourceInfo: tool.sourceInfo });
    });
  }
  function inventory() {
    if (!plan) throw new Error("PM plan is missing");
    const e = effectiveRole(plan, plan.access), names = new Set([...e.builtinTools, ...e.extraTools.flatMap(t => t.tools), ...(mcp?.sources().flatMap(s => s.tools.map(t => t.name)) ?? [])]);
    return snapshotMainRoleTools(plan, pi.getAllTools().filter(t => names.has(t.name)), local?.sources ?? [], mcp?.sources() ?? []);
  }
  function verify() {
    if (state !== "ready" || !plan || !saved) throw new Error(error || "PM is initializing");
    verifyMcpOwnership(); verifyLocalOwnership(plan); local?.verify(); mcp?.verify(); validateRolePlan(plan, { access: plan.access });
    if (!isDeepStrictEqual(copy(inventory()), saved.tools) || !isDeepStrictEqual(management(), saved.management)) throw new Error("PM actual tool definition/provenance changed after preflight");
  }
  function activate() {
    pi.setActiveTools(allowed);
    const actual = pi.getActiveTools();
    if (actual.length !== allowed.length || actual.some(t => !allowed.includes(t))) throw new Error("Exact PM active tools could not be applied (check CLI --tools/exclude settings)");
  }
  function flush() {
    if (flushScheduled || turnPending || !pending.length || state !== "ready") return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      if (state !== "ready" || turnPending || !pending.length) return;
      try { verify(); activate(); }
      catch (cause) { fail(cause); return; }
      for (const message of pending.splice(0)) pi.sendMessage(message, { deliverAs: "nextTurn" });
      // Native custom triggerTurn bypasses input/preparation; user follow-up does not.
      turnPending = true;
      pi.sendUserMessage("Team notifications arrived. Inspect task/workflow evidence and answer pending worker questions; stopping is not acceptance.", { deliverAs: "followUp" });
    });
  }
  async function stop() {
    generation++; abort.abort(); pending = []; turnPending = false; publish("off"); context = undefined;
    for (const unsubscribe of hooks.splice(0)) unsubscribe();
    local?.dispose(); local = undefined;
    // Pi model selection has no cancellation API and commits after async auth.
    // Fail readiness on time, but do not acknowledge a session replacement until
    // that operation drains. New generations must not inherit late model writes.
    await Promise.all([mcp?.close(), modelSelection?.catch(() => {})]);
    modelSelection = undefined; mcp = undefined;
    plan = undefined; saved = undefined; skills = []; allowed = []; command = undefined; context = undefined;
  }
  return {
    get state() { return state; },
    get error() { return error; },
    get command() { return command; },
    inheritance() {
      if (state === "off") return;
      verify();
      return copy({ version: 1 as const, plan: plan!, tools: saved!.tools });
    },
    notify(message: Notification) {
      if (!context) return;
      if (state === "off") { pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true }); return; }
      pending.push(message); flush();
    },
    async start(ctx: ExtensionContext) {
      const stopped = stop(); publish("initializing", ""); context = ctx;
      await stopped; context = ctx; error = ""; abort = new AbortController();
      const current = ++generation, deadline = Date.now() + readinessMs;
      const deadlineAbort = new AbortController();
      const timer = setTimeout(() => deadlineAbort.abort(new Error("PM readiness deadline expired")), readinessMs);
      const signal = AbortSignal.any([abort.signal, deadlineAbort.signal]);
      const legacy = () => { publish("off", ""); for (const message of pending.splice(0)) pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true }); };
      try {
        const entry = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === PM_ENTRY);
        const previous = entry?.type === "custom" ? entry.data as PmSnapshot : undefined;
        if (!roleHostSupported()) {
          const selected = process.env.PI_AGENT_MESH_CONFIG;
          if (!previous && !selected && !existsSync(join(ctx.cwd, ".pi/agent-mesh.yaml"))) { legacy(); return; }
          if (!previous) {
            const { RoleCatalog } = await import("./roles.ts");
            if (!new RoleCatalog(ctx.cwd, selected ?? "").reload().enabled) { legacy(); return; }
          }
          throw new Error("Team roles require Pi 1.0.2 or newer (1.x); disable the team config for legacy non-role calls");
        }
        if (previous) {
          if (previous.version !== 1 || previous.promptVersion !== 1 || !previous.plan || previous.planHash !== rolePlanDigest(previous.plan) || !isAbsolute(previous.configPath ?? "") || !Array.isArray(previous.management)) throw new Error("Invalid saved PM snapshot");
          validateMainRoleTools(previous.plan, previous.tools); plan = copy(previous.plan); saved = copy(previous); catalog.pin(ctx, previous.configPath);
        }
        const directory = await catalog.current(ctx);
        if (!plan) {
          if (directory.error) throw new Error(directory.error);
          if (!directory.current?.enabled) { legacy(); return; }
          const role = directory.current.roles.find(r => r.id === directory.current!.mainRole)!;
          const model = selectedModel(ctx, role.defaults.model !== "inherit" ? role.defaults.model : undefined);
          plan = createRolePlan(role, directory.current, { ...roleSettings(pi, ctx, model), cwd: ctx.cwd, context: "none", access: role.defaults.access });
        }
        if (!ctx.sessionManager.getSessionFile()) throw new Error("PM role mode requires a persistent session (remove --no-session)");
        verifyMcpOwnership();
        const active = plan;
        validateRolePlan(active, { access: active.access });
        const effective = effectiveRole(active, active.access);
        verifyLocalOwnership(active);
        if ((effective.extraTools.length || effective.mcp.length) && !ctx.isProjectTrusted()) throw new Error(`Role ${active.roleId}: project trust is required before local tools or MCP can execute`);
        const model = ctx.modelRegistry.find(active.model.slice(0, active.model.indexOf("/")), active.model.slice(active.model.indexOf("/") + 1));
        if (!model) throw new Error(`PM model is unavailable: ${active.model}`);
        modelSelection = pi.setModel(model);
        if (!await waitForRoleResource(modelSelection, signal)) throw new Error(`PM model is unavailable or unauthenticated: ${active.model}`);
        modelSelection = undefined;
        signal.throwIfAborted();
        if (current !== generation) return;
        pi.setThinkingLevel(active.thinking as ReturnType<ExtensionAPI["getThinkingLevel"]>);
        const loaded = loadSkills({ cwd: active.cwd, agentDir: active.agentDir, skillPaths: active.skills.map(s => s.loadPath ?? s.filePath), includeDefaults: false });
        skills = loaded.skills;
        if (!isDeepStrictEqual(snapshotSkills(skills), active.skills.map(({ hash: _hash, ...s }) => s))) throw new Error("PM skill inventory changed");
        const loadedLocal = await loadRoleTools(active, active.access, signal);
        if (current !== generation || signal.aborted) { loadedLocal.dispose(); signal.throwIfAborted(); return; }
        local = loadedLocal; local.register(pi);
        if (effective.mcp.length) {
          const starters: ((event: any, ctx: ExtensionContext) => unknown)[] = [];
          const controlled = new Proxy(pi, { get(target, key, receiver) {
            if (key === "registerCommand") return (name: string, value: typeof command) => { if (name !== "mcp") throw new Error("Unexpected PM MCP command"); command = value; };
            if (key === "on") return (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
              if (event === "session_start") { starters.push(handler); return () => {}; }
              // PM owns session cleanup; registering while session_start is already dispatching
              // cannot add to the native handler snapshot. Replay that event explicitly once.
              if (event === "session_shutdown") return () => {};
              const unsubscribe = (pi.on as Function)(event, handler); hooks.push(unsubscribe); return unsubscribe;
            };
            return Reflect.get(target, key, receiver);
          } });
          const { setupRoleMcp } = await waitForRoleResource(import("./role-mcp.ts"), signal);
          signal.throwIfAborted();
          const loadingMcp = setupRoleMcp(controlled, active, active.access, ROLE_MAIN_EXTENSION);
          void loadingMcp.then(value => { if (signal.aborted || current !== generation) return value.close(); }).catch(() => {});
          const loadedMcp = await waitForRoleResource(loadingMcp, signal);
          if (signal.aborted || current !== generation) { await loadedMcp.close(); signal.throwIfAborted(); return; }
          mcp = loadedMcp;
          for (const start of starters) await start({ type: "session_start", reason: "startup" }, ctx);
          // Native non-TUI /mcp status uses only ExtensionContext, never command-only navigation.
          await mcp.ready(ctx as ExtensionCommandContext, deadline, signal);
        }
        if (current !== generation) return;
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("PM readiness deadline expired");
        verifyMcpOwnership();
        const tools = inventory(), runtimeTools = management();
        if (saved && (!isDeepStrictEqual(tools, saved.tools) || !isDeepStrictEqual(runtimeTools, saved.management))) throw new Error("Saved PM tool definitions/provenance drifted");
        allowed = [...tools.map(t => t.name), ...MANAGEMENT_TOOLS]; activate();
        const next: PmSnapshot = { version: 1, plan: active, planHash: rolePlanDigest(active), configPath: saved?.configPath ?? directory.configPath, tools, management: runtimeTools,
          piVersion: JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")).version, promptVersion: 1 };
        if (!saved) pi.appendEntry(PM_ENTRY, copy(next));
        saved = copy(next); publish("ready", ""); ctx.ui.setStatus("agent-mesh-role", `PM ${active.roleId} ready`);
        if (directory.error) ctx.ui.notify(`PM restored; new role dispatch unavailable: ${directory.error}. Fix the directory and use /roles reload.`, "warning");
        flush();
      } catch (cause) {
        if (current !== generation) return;
        fail(cause);
        let recordPath: string | undefined, persistenceError: string | undefined;
        try {
          recordPath = retainPmFailure(ctx, error);
          ctx.ui.notify(`PM failure record: ${recordPath}`, "info");
        } catch (cause) {
          persistenceError = cause instanceof Error ? cause.message : String(cause);
          ctx.ui.notify(`PM failure record is not durable: ${persistenceError}. Original PM error: ${error}`, "error");
        }
        try { pi.appendEntry("agent_mesh_pm_failure", { version: 1, error, recordPath, persistenceError }); }
        catch (cause) { ctx.ui.notify(`PM failure session entry could not be appended: ${cause instanceof Error ? cause.message : String(cause)}. Original PM error: ${error}`, "error"); }
        local?.dispose(); await mcp?.close();
      } finally { clearTimeout(timer); }
    },
    stop,
    input(ctx: ExtensionContext) {
      if (state === "off") return;
      try { verify(); activate(); turnPending = true; }
      catch (cause) { if (state === "ready") fail(cause); else ctx.ui.notify(`PM ${state}: ${error || "waiting for required resources"}`, "error"); return { action: "handled" as const }; }
    },
    async prepare(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
      if (state !== "ready" || !plan) return;
      event.systemPromptOptions.sections.agent_mesh_role = plan.systemPrompt;
      event.systemPromptOptions.sections.agent_mesh_runtime = "You are the main-session coordinator. Delegate by configured role ID. Runtime management tools are parent-only. Inspect validation evidence before acceptance. Capability filters are not a sandbox.";
      event.systemPromptOptions.sections.agent_mesh_catalog = await catalog.summary(ctx);
      event.systemPromptOptions.skills = skills;
    },
    toolCall(name: string, parentToolCallId?: string) {
      if (state === "off") return;
      try { verify(); if (!allowed.includes(name) || parentToolCallId && MANAGEMENT_TOOLS.includes(name)) throw new Error("Tool outside PM verified role loadout (including nested management calls)"); }
      catch (cause) { if (allowed.includes(name)) fail(cause); return { block: true, terminate: true, reason: cause instanceof Error ? cause.message : String(cause) }; }
    },
  };
}

/** Reserve /mcp during extension loading, before Pi selects its replaceable builtin.
 * Ordinary sessions delegate to that same native factory, honoring builtin disable settings. */
export async function installMainMcpRouter(pi: ExtensionAPI, team: ReturnType<typeof createTeamRuntime>) {
  if (!roleHostSupported()) return;
  let nativeCommand: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  const enabled = () => {
    const disabled = pi.getSettings().extensions ?? [];
    return (!process.argv.includes("--no-extensions") || process.argv.includes("builtin:mcp")) && !disabled.includes("-builtin:mcp") && !disabled.includes("-builtin:*");
  };
  pi.registerCommand("mcp", { description: "MCP status (team configuration is frozen)", async handler(args, ctx) {
    const selected = team.state === "off" ? enabled() ? nativeCommand : undefined : team.command;
    if (!selected) { ctx.ui.notify(team.error || "MCP is disabled or no PM MCP services are selected", "info"); return; }
    await selected.handler(args, ctx);
  } });
  const native = await import("@earendil-works/pi-coding-agent");
  await native.createMcpExtension()(new Proxy(pi, { get(target, key, receiver) {
    if (key === "registerCommand") return (name: string, value: typeof nativeCommand) => { if (name === "mcp") nativeCommand = value; };
    if (key === "on") return (event: string, handler: (...args: any[]) => unknown) => (pi.on as Function)(event, (...args: any[]) => {
      if (team.state === "off" && enabled()) return handler(...args);
    });
    return Reflect.get(target, key, receiver);
  } }));
}
