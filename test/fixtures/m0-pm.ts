// Throwaway M0 bridge: proves host APIs, not the production PM/role implementation.
import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function m0Pm(pi: ExtensionAPI) {
  let state: "initializing" | "ready" | "failed" = "initializing";
  let body = process.env.M0_ROLE_BODY ?? "M0_PM_ROLE";
  const pending: string[] = [];
  const lifecycle = (event: string) => {
    if (process.env.M0_LIFECYCLE_LOG) appendFileSync(process.env.M0_LIFECYCLE_LOG, event + "\n");
  };
  const notify = (content: string) => {
    if (state !== "ready") { pending.push(content); return; }
    // Pi 1.0.2 custom triggerTurn skips prompt preparation. Route the wake-up
    // through sendUserMessage so input and before_agent_start actually run.
    pi.sendMessage({ customType: "m0_result", content, display: true }, { deliverAs: "nextTurn" });
    pi.sendUserMessage("M0 internal notifications are ready; inspect their evidence.");
  };
  pi.on("session_start", (_event, ctx) => {
    lifecycle("session_start");
    const saved = ctx.sessionManager.getBranch().find(e => e.type === "custom" && e.customType === "m0_pm_snapshot");
    if (saved?.type === "custom") body = (saved.data as { body: string }).body;
    pi.registerTool({ name: "m0_dynamic", label: "M0 dynamic", description: "Dynamically registered probe", parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, toolCtx) {
        const result = await toolCtx.executeTool("m0_unselected", {});
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      } });
    pi.registerTool({ name: "m0_unselected", label: "Unselected", description: "Must never execute", exposure: "codemode", parameters: Type.Object({}),
      async execute() {
        if (process.env.M0_SIDE_EFFECT) writeFileSync(process.env.M0_SIDE_EFFECT, "unauthorized");
        return { content: [{ type: "text", text: "unauthorized" }], details: {} };
      } });
    // Simulate asynchronous recovery result/question delivery during PM initialization.
    notify("M0 recovery result");
    notify("M0 worker question");
  });
  pi.on("resources_discover", () => {
    lifecycle("resources_discover");
    return { skillPaths: process.env.M0_SKILL ? [process.env.M0_SKILL] : [] };
  });
  pi.on("input", () => state === "ready" ? { action: "continue" } : { action: "handled" });
  pi.on("before_agent_start", event => {
    lifecycle("before_agent_start");
    event.systemPromptOptions.sections.m0_role = body;
    // Failure here is deliberately not used as a request gate.
  });
  pi.on("tool_call", event => {
    if (event.toolName !== "read" && event.toolName !== "m0_dynamic") return { block: true, reason: "M0 exact allowlist" };
  });
  pi.registerCommand("m0-inspect", {
    description: "Persist probe inventory without a model call",
    async handler(_args, ctx) {
      if (process.env.M0_INVENTORY) writeFileSync(process.env.M0_INVENTORY, JSON.stringify({
        state, active: pi.getActiveTools(), tools: pi.getAllTools(), skills: ctx.getSystemPromptOptions().skills,
      }));
    },
  });
  pi.registerCommand("m0-ready", {
    description: "Complete probe preflight and persist before releasing pending notifications",
    async handler(_args, ctx) {
      if (state === "failed") throw new Error("M0 PM failed; cannot release notifications");
      pi.setActiveTools(["read", "m0_dynamic"]);
      if (!ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "m0_pm_snapshot")) {
        pi.appendEntry("m0_pm_snapshot", { body, tools: pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)) });
      }
      state = "ready";
      // Sequential queued custom notifications are not required for this API probe.
      // One combined delivery keeps the test deterministic and preserves both messages.
      if (pending.length) notify(pending.splice(0).join("\n"));
    },
  });
  pi.registerCommand("m0-fail", { description: "Fail the PM probe", async handler() { state = "failed"; } });
}
