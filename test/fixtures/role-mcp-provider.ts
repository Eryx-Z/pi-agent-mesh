// Deterministic M3 model fixture. Selects actual declared names; never calls an external provider.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
export default function provider(pi: ExtensionAPI) {
  pi.registerProvider("role-mcp-fixture", { api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "test", name: "Role MCP fixture", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const last = context.messages.at(-1), tools = getCurrentTools(context.messages);
      const input = last?.role === "user" ? typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "";
      appendFileSync("m3-requests.jsonl", JSON.stringify({ input, tools: tools.map(t => t.name), prompt: getCurrentSystemPrompt(context.messages) }) + "\n");
      let content: AssistantMessage["content"];
      const call = /(?:Assigned task:\n|Continuation task:\n)RAW ([^\s/]+)\/([^\s]+)(?: (\{[^\n]*\}))?/.exec(input);
      const direct = /(?:Assigned task:\n|Continuation task:\n)DIRECT ([^\s]+)(?: (\{[^\n]*\}))?/.exec(input);
      if (call) {
        const found = tools.find(t => t.description === `raw:${call[2]}` && t.name.startsWith(`mcp__${call[1].replace(/-/g, "_")}__`));
        content = [{ type: "toolCall", id: "m3-call", name: found?.name ?? "MISSING_ACTUAL_TOOL", arguments: call[3] ? JSON.parse(call[3]) : {} }];
      } else if (direct) content = [{ type: "toolCall", id: "m3-call", name: direct[1], arguments: direct[2] ? JSON.parse(direct[2]) : {} }];
      else content = [{ type: "text", text: last?.role === "toolResult" ? JSON.stringify(last) : "M3 finished" }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      setImmediate(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(); });
      return stream;
    },
  });
}
