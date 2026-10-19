import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { validateLoadout, type Loadout } from "./loadout.ts";
import { ROLE_MAIN_EXTENSION, roleMcpConfigHash, snapshotMainRoleTools, validateMainRoleTools, validateRolePlan, type RoleToolSnapshot } from "./role-loadout.ts";
import { loadRoleTools } from "./role-tools.ts";
import type { RoleMcpAdapter } from "./role-mcp.ts";

/** Reconstruct PM-owned implementations at their original index.ts provenance.
 * The ordinary child bridge still owns tools, context, skills and preflight. */
export async function inheritMainRoleTools(pi: ExtensionAPI, input: Loadout): Promise<void> {
  const loadout = validateLoadout(input), bridge = loadout.parentRole;
  if (!bridge) throw new Error("Inherited PM tools require a frozen implementation mapping");
  validateRolePlan(bridge.plan, { access: bridge.plan.access });
  validateMainRoleTools(bridge.plan, bridge.tools);
  const names = new Set(loadout.tools), inherited = loadout.toolMetadata.filter(t => t.path === ROLE_MAIN_EXTENSION);
  const wire = ({ semanticKind: _kind, sourceInfo: _source, entry: _entry, hash: _hash, server: _server,
    remoteName: _remote, configHash: _config, definitionHash: _definition, ...metadata }: RoleToolSnapshot) => metadata;
  for (const tool of inherited) {
    const expected = bridge.tools.find(t => t.name === tool.name && t.path === ROLE_MAIN_EXTENSION);
    if (!expected || !isDeepStrictEqual(wire(expected), tool)) throw new Error(`Inherited PM tool definition/provenance mismatch: ${tool.name}`);
  }
  const selected = { ...bridge.plan, cwd: loadout.cwd,
    builtinTools: bridge.plan.builtinTools.filter(n => names.has(n)),
    extraTools: bridge.plan.extraTools.map(e => ({ ...e, tools: e.tools.filter(n => names.has(n)) })).filter(e => e.tools.length),
    mcp: bridge.plan.mcp.map(m => ({ ...m, tools: m.tools.filter(raw => bridge.tools.some(t =>
      t.semanticKind === "mcp" && t.server === m.server && t.remoteName === raw && names.has(t.name))) })).filter(m => m.tools.length),
  };
  // Validate the original parent inventory above, then bind only the implicit
  // stdio cwd/config identity to this task (explicit server cwd stays authored).
  const expected = bridge.tools.filter(t => names.has(t.name)).map(tool => tool.semanticKind === "mcp" ?
    { ...tool, configHash: roleMcpConfigHash(selected, tool.server!) } : tool);
  const local = await loadRoleTools(selected, selected.access);
  local.register(pi);
  let mcp: RoleMcpAdapter | undefined;
  if (selected.mcp.length) {
    const { setupRoleMcp } = await import("./role-mcp.ts");
    mcp = await setupRoleMcp(pi, selected, selected.access, ROLE_MAIN_EXTENSION);
  }
  let verified: RoleToolSnapshot[] | undefined;
  const verify = () => {
    local.verify(); mcp?.verify();
    const actual = snapshotMainRoleTools(selected, pi.getAllTools().filter(t => names.has(t.name) && t.name !== "ask_question"), local.sources, mcp?.sources() ?? []);
    // --no-approve omits project metadata, so explicit -e can legitimately become
    // CLI/temporary. User/package metadata may instead survive --no-extensions.
    // Permit only this exact startup transition for the same pinned wrapper, then
    // freeze the observed child sourceInfo; later owner changes remain drift.
    const cliSource: RoleToolSnapshot["sourceInfo"] = { source: "cli", scope: "temporary", origin: "top-level", path: ROLE_MAIN_EXTENSION };
    const target = verified ?? expected.map(tool => tool.path === ROLE_MAIN_EXTENSION && tool.sourceInfo.scope === "project" &&
      isDeepStrictEqual(actual.find(t => t.name === tool.name)?.sourceInfo, cliSource) ? { ...tool, sourceInfo: cliSource } : tool);
    if (!isDeepStrictEqual(actual, target)) throw new Error("Inherited PM tool definition/provenance drifted");
    verified ??= structuredClone(actual);
  };
  pi.on("session_start", async (_event, ctx) => {
    await mcp?.ready(ctx as ExtensionCommandContext, Date.now() + 30000);
    verify();
  });
  pi.on("session_shutdown", async () => { local.dispose(); await mcp?.close(); });
  pi.on("tool_call", () => {
    try { verify(); }
    catch (error) { return { block: true, terminate: true, reason: error instanceof Error ? error.message : String(error) }; }
  });
}
