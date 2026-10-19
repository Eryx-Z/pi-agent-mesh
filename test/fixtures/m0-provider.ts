// Scripted provider for M0 API probes. Never contacts a model service.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";

export default function m0Provider(pi: ExtensionAPI) {
  pi.registerProvider("m0-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "test", name: "M0 scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const last = context.messages.at(-1);
      const input = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n")) : "";
      if (process.env.M0_REQUEST_LOG) appendFileSync(process.env.M0_REQUEST_LOG, JSON.stringify({
        prompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(t => t.name), input,
      }) + "\n");
      const content: AssistantMessage["content"] = input.startsWith("CALL ")
        ? [{ type: "toolCall", id: "m0-call", ...JSON.parse(input.slice(5)) }]
        : [{ type: "text", text: last?.role === "toolResult" ? JSON.stringify(last.content) : "M0 finished" }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      setImmediate(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
