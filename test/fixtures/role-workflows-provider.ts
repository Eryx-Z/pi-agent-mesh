// Scripted provider for workflow integration: deterministic models, tools and no network.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
export default function provider(pi: ExtensionAPI) {
  pi.events.on("rpc-subagents:provider-source:v1", value => {
    if (value && typeof value === "object" && "provider" in value && value.provider === "role-workflow-fixture" && "register" in value && typeof value.register === "function") value.register(fileURLToPath(import.meta.url));
  });
  pi.registerProvider("role-workflow-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: ["parent", "workflow", "role", "step"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4000 })),
    streamSimple(model, context, options) {
      const last = context.messages.at(-1);
      const input = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n")) : "";
      const inspected = { prompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(t => t.name), input,
        history: JSON.stringify(context.messages), cwd: process.cwd(), model: model.id,
        built: existsSync("built.txt") ? readFileSync("built.txt", "utf8") : null };
      const audit = input.match(/AUDIT_PATH=(\S+)/)?.[1];
      if (audit) appendFileSync(audit, JSON.stringify(inspected) + "\n");
      const write = input.includes("WORKFLOW_WRITE");
      const fail = input.includes("WORKFLOW_FAIL") && !input.includes("Retry instruction:");
      const content: AssistantMessage["content"] = write ? [{ type: "toolCall", id: "workflow-write", name: "write", arguments: { path: "built.txt", content: "BUILDER_CODE\n" } }] : [{ type: "text", text: JSON.stringify(inspected) }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: fail ? "error" : write ? "toolUse" : "stop", ...(fail ? { errorMessage: "Scripted workflow failure" } : {}), timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      const wait = input.match(/WAIT_FOR=(\S+)/)?.[1];
      const finish = () => {
        if (wait && !existsSync(wait) && !options?.signal?.aborted) { setTimeout(finish, 10); return; }
        stream.push({ type: "start", partial: message });
        if (fail) stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end();
      };
      setImmediate(finish);
      return stream;
    },
  });
}
