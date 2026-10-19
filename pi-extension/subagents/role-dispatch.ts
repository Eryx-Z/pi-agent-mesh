import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { accessMode, resolveLoadout, type AccessMode } from "./loadout.ts";
import { taskPrompt, type ContextMode } from "./context.ts";
import { createRolePlan, effectiveRole, type RolePlan } from "./role-loadout.ts";
import type { RoleCatalogAccess } from "./roles-ui.ts";
export interface RoleRequest { role: string; model?: string; context?: ContextMode; contextText?: string; access?: AccessMode; cwd?: string }
export function selectedModel(ctx: ExtensionContext, requested?: string): string {
  const id = requested ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
  const slash = id.indexOf("/"); if (slash < 1 || slash === id.length - 1) throw new Error("Use a canonical provider/model ID");
  const model = ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1));
  if (!model) throw new Error(`Model not found: ${id}`);
  return `${model.provider}/${model.id}`;
}
/** Only provider settings are inherited here, never the parent's active capabilities. */
export function roleSettings(pi: ExtensionAPI, ctx: ExtensionContext, model: string, cwd = ctx.cwd) {
  const selected = ctx.modelRegistry.find(model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1));
  if (!selected) throw new Error(`Model not found: ${model}`);
  const thinking = clampThinkingLevel(selected, (ctx.thinkingLevel ?? "medium") as ModelThinkingLevel);
  const settings = resolveLoadout({ getAllTools: () => [], getActiveTools: () => [], events: pi.events }, [], cwd, model, thinking);
  return { model: settings.model, thinking: settings.thinking, agentDir: settings.agentDir, providerExtensions: settings.providerExtensions };
}
export async function resolveRoleDispatch(pi: ExtensionAPI, ctx: ExtensionContext, catalog: RoleCatalogAccess, request: RoleRequest,
  workflow: { model?: string; context?: ContextMode; contextText?: string } = {}): Promise<{ plan: RolePlan; contextText?: string }> {
  const loaded = await catalog.current(ctx), directory = loaded.current;
  if (!directory?.enabled) throw new Error(`Role dispatch requires a valid enabled role catalog: ${loaded.error ?? "team mode disabled"}`);
  const role = directory.roles.find(r => r.id === request.role); if (!role) throw new Error(`Role not found: ${request.role}`);
  const model = selectedModel(ctx, request.model ?? (role.defaults.model !== "inherit" ? role.defaults.model : undefined) ?? workflow.model);
  const context = request.context ?? role.defaults.context ?? workflow.context ?? "partial", access = accessMode(request.access ?? role.defaults.access);
  const contextText = request.contextText ?? (context === "partial" ? workflow.contextText : undefined);
  taskPrompt("role dispatch preflight", access, context, contextText);
  const plan = createRolePlan(role, directory, { ...roleSettings(pi, ctx, model, resolve(ctx.cwd, request.cwd ?? ".")), context, access, cwd: resolve(ctx.cwd, request.cwd ?? ".") });
  const effective = effectiveRole(plan, access);
  if ((effective.extraTools.length || effective.mcp.length) && !ctx.isProjectTrusted()) throw new Error(`Role ${plan.roleId}: project trust is required before executing local tools or connecting MCP`);
  return { plan, contextText };
}
