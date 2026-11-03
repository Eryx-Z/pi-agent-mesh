// Deterministic provider for real builtin inheritance. No network or model quota.
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export default function builtinProvider(pi: ExtensionAPI) {
  pi.events.on("rpc-subagents:provider-source:v1", (data) => {
    if (!data || typeof data !== "object" || !("provider" in data) || !("register" in data)) return;
    const request = data;
    if (typeof request.register !== "function") return;
    if (request.provider === "builtin-fixture") request.register(fileURLToPath(import.meta.url));
  });
  pi.registerProvider("builtin-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const input = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n")) : "";
      const content: AssistantMessage["content"] = input.startsWith("DISPATCH ")
        ? [{ type: "toolCall", id: "dispatch", name: "subagent", arguments: JSON.parse(input.slice(9)) }]
        : process.env.PI_RPC_SUBAGENT_CHILD === "1" && input.includes("Assigned task:\nCODEMODE_BUILTIN")
          ? [{ type: "toolCall", id: "codemode-input", name: "codemode", arguments: { code: 'text("codemode child executed")' } }]
        : process.env.PI_RPC_SUBAGENT_CHILD === "1" && input.includes("Assigned task:\nREAD_BUILTIN")
          ? [{ type: "toolCall", id: "read-input", name: "read", arguments: { path: "fixture-input.txt" } }]
          : process.env.PI_RPC_SUBAGENT_CHILD === "1" && input.includes("Assigned task:\nNESTED_ASK")
            ? [{ type: "toolCall", id: "nested-probe", name: "nested_probe", arguments: {} }]
            : [{ type: "text", text: last?.role === "toolResult" ? JSON.stringify(last.content) : "Finished" }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      setImmediate(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
