import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { bounded } from "./store.ts";
import type { RoleCatalog, ResolvedRole } from "./roles.ts";

const PREVIEW = "Role catalog preview (M1; no PM activation or role dispatch). Service readiness is not checked.";
function summary(role: ResolvedRole): string {
  return `${role.id}: ${role.description}\n  source: ${role.source}\n  defaults: access=${role.defaults.access}, context=${role.defaults.context ?? "unspecified"}, model=${role.defaults.model ?? "inherit"}`;
}
function listing(catalog: RoleCatalog): string {
  const directory = catalog.current;
  return [PREVIEW, `Config: ${catalog.configPath}`, ...(catalog.error ? [`Static configuration error: ${catalog.error}`] : []),
    !directory ? "No valid directory loaded." : !directory.enabled ? "Team configuration is disabled or the default file is absent." :
      `Main role: ${directory.mainRole}\n${directory.roles.map(summary).join("\n")}`].join("\n");
}
function inspection(role: ResolvedRole): string {
  return [summary(role), `Manifest: ${role.manifestPath}`, `Prompt: ${role.systemPromptPath}`,
    `Skills:\n${role.skills.map(skill => `  ${skill.name}: ${skill.filePath}${skill.disableModelInvocation ? " (manual invocation only)" : ""}`).join("\n") || "  (none)"}`,
    `Declared builtin tools: ${role.builtinTools.join(", ") || "(none)"}`,
    `Declared MCP tools:\n${role.mcp.map(ref => `  ${ref.server}: ${ref.tools.join(", ")}`).join("\n") || "  (none)"}`,
    `Declared local tools:\n${role.extraTools.map(ref => `  ${ref.entry}: ${ref.tools.join(", ")}`).join("\n") || "  (none)"}`,
    "Declarations only; no service connection or extension execution has been performed."].join("\n");
}

/** Passive M1 surface. Do not activate a PM or load executable role resources here. */
export function registerRoles(pi: ExtensionAPI): void {
  if (process.env.PI_RPC_SUBAGENT_CHILD === "1") return;
  let startup: { cwd: string; explicitPath: string } | undefined;
  let pending: Promise<RoleCatalog> | undefined;
  const capture = (ctx: ExtensionContext) => {
    startup ??= { cwd: ctx.cwd ?? process.cwd(), explicitPath: process.env.PI_AGENT_MESH_CONFIG ?? "" };
  };
  pi.on("session_start", (_event, ctx) => { capture(ctx); });
  async function current(ctx: ExtensionContext): Promise<RoleCatalog> {
    capture(ctx);
    // Keep the old no-role runtime free of new parser/native-MCP dependencies.
    pending ??= (async () => {
      const version = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")).version as string;
      const [major, minor, patch] = version.split(".").map(Number);
      if (!(major === 1 && (minor > 0 || minor === 0 && patch >= 2))) {
        throw new Error("Role catalog requires Pi 1.0.2 or newer (1.x); legacy non-role calls remain available.");
      }
      const { RoleCatalog } = await import("./roles.ts");
      return new RoleCatalog(startup!.cwd, startup!.explicitPath);
    })();
    const catalog = await pending;
    if (!catalog.current && !catalog.error) {
      try { catalog.reload(); } catch { /* Show parser diagnostics, not a misleading empty-success directory. */ }
    }
    return catalog;
  }
  pi.registerCommand("roles", {
    description: "Preview role catalog: /roles, /roles inspect <id>, /roles reload (no service connections)",
    async handler(args, ctx) {
      try {
        const catalog = await current(ctx);
        const words = args.trim().split(/\s+/).filter(Boolean);
        let text: string;
        if (!words.length) text = listing(catalog);
        else if (words.length === 1 && words[0] === "reload") {
          try { catalog.reload(); text = `Role directory reloaded.\n${listing(catalog)}`; }
          catch { text = `Reload failed; ${catalog.current ? "kept the previous valid directory" : "no previous valid directory"}.\n${listing(catalog)}`; }
        } else if (words.length === 2 && words[0] === "inspect") {
          const role = catalog.current?.roles.find(role => role.id === words[1]);
          if (!role) throw new Error(`Role not found: ${words[1]}${catalog.error ? `; ${catalog.error}` : ""}`);
          text = `${PREVIEW}\n${catalog.error ? `Static configuration error (retained directory): ${catalog.error}\n` : ""}${inspection(role)}`;
        } else throw new Error("Usage: /roles [inspect <id> | reload]");
        ctx.ui.notify(text, catalog.error ? "warning" : "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerTool({
    name: "roles_list", label: "Role catalog",
    description: "List configured role summaries and static errors. Catalog preview only: does not dispatch agents, connect MCP, or assert role readiness.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const catalog = await current(ctx);
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: bounded(listing(catalog), 16000) }], details: {} };
    },
  });
}
