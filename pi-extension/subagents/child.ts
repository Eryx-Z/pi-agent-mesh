import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { validateLoadout, verifySkills, verifyTools } from "./loadout.ts";

/** Register through the caller's API so Pi retains the caller's actual sourceInfo. */
export function registerQuestionTool(pi: ExtensionAPI): ToolDefinition {
  const parameters = Type.Object({ question: Type.String({ minLength: 1 }) });
  const tool: ToolDefinition<typeof parameters> = {
    name: "ask_question", label: "Ask parent", description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.",
    executionMode: "sequential", exposure: "model-only",
    parameters,
    async execute(_id, params, signal, _update, ctx) {
      if (ctx.mode !== "rpc") throw new Error("ask_question requires the RPC parent bridge");
      const answer = await ctx.ui.input(params.question, "Parent answer", { signal });
      if (answer === undefined || signal?.aborted) throw new Error("Question cancelled without an answer");
      return { content: [{ type: "text", text: answer }], details: {} };
    },
  };
  pi.registerTool(tool);
  return tool;
}

/** Only this bridge and source-backed inherited tool extensions are loaded in children. */
export default function childBridge(pi: ExtensionAPI) {
  const path = process.env.PI_RPC_SUBAGENT_LOADOUT;
  if (!path) throw new Error("Child bridge requires a validated loadout file");
  const loadout = validateLoadout(JSON.parse(readFileSync(path, "utf8")));
  const allowed = new Set(loadout.tools);
  // Register after load-time conflict checks. This bridge is loaded first, so its
  // reserved question tool wins even when an inherited provider also defines it.
  pi.on("session_start", () => { registerQuestionTool(pi); });
  pi.registerCommand("rpc-subagent-preflight", {
    description: "Internal child loadout validation (no model call)",
    async handler(_args, ctx) {
      verifyTools(loadout, pi.getAllTools());
      verifySkills(loadout, ctx.getSystemPromptOptions().skills);
      pi.setActiveTools(loadout.tools);
      if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== loadout.model) throw new Error(`Requested model was not selected: ${loadout.model}`);
      const active = pi.getActiveTools();
      if (active.length !== allowed.size || active.some(t => !allowed.has(t))) throw new Error("Child tool allowlist was not applied");
    },
  });
  pi.on("tool_call", event => {
    if (!allowed.has(event.toolName)) return { block: true, reason: "Tool outside child loadout; nested delegation is disabled", terminate: true };
    // Detect tools replaced by dynamic registrations after startup as well.
    verifyTools(loadout, pi.getAllTools());
  });
}
