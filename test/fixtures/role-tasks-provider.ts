// Scripted, source-backed provider for M2 TaskManager integration. Never contacts a model service.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
export default function provider(pi: ExtensionAPI) {
  pi.events.on("rpc-subagents:provider-source:v1", value => {
    if (value && typeof value === "object" && "provider" in value && value.provider === "role-fixture" && "register" in value && typeof value.register === "function") value.register(fileURLToPath(import.meta.url));
  });
  pi.registerProvider("role-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "test", name: "Role scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const last = context.messages.at(-1);
      const input = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n")) : "";
      const inspected = { prompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(t => t.name), input };
      appendFileSync("model-called", JSON.stringify(inspected) + "\n");
      const tool = input.match(/(?:Assigned task:\n|Continuation task:\n)RUN_TOOL ([\w-]+)/)?.[1];
      const content: AssistantMessage["content"] = tool ? [{ type: "toolCall", id: "role-call", name: tool, arguments: {} }] :
        [{ type: "text", text: last?.role === "toolResult" ? JSON.stringify(last.content) : JSON.stringify(inspected) }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: tool ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      setImmediate(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(); });
      return stream;
    },
  });
}
