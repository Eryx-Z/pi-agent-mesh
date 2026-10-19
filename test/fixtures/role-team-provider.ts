import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.events.on("rpc-subagents:provider-source:v1", (request: any) => { if (request.provider === "role-team-fixture") request.register(fileURLToPath(import.meta.url)); });
  pi.registerProvider("role-team-fixture", { baseUrl: "http://fixture.invalid", apiKey: "fixture", api: "openai-completions", models: ["pm", "worker", "override", "reasoner"].map(id => ({ id, name: id, contextWindow: 100000, maxTokens: 8192, reasoning: id === "reasoner", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream(); queueMicrotask(() => {
        const last = context.messages.at(-1) as any;
        const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const log = process.env.ROLE_TEAM_LOG;
        if (log) appendFileSync(log, JSON.stringify({ child: process.env.PI_RPC_SUBAGENT_CHILD === "1", model: `${model.provider}/${model.id}`, prompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(t => t.name), messages: context.messages }) + "\n");
        let content: AssistantMessage["content"];
        const call = last?.role !== "toolResult" && text.match(/(?:^|\n)CALL (\{[^\n]+\})/);
        if (call) { const c = JSON.parse(call[1]); content = [{ type: "toolCall", id: `team-${Date.now()}`, name: c.name, arguments: c.arguments }]; }
        else if (last?.role !== "toolResult" && /Assigned task:\s*CHILD_BASH/.test(text)) content = [{ type: "toolCall", id: "worker-bash", name: "bash", arguments: { command: "printf ROLE_TEAM_BASH_OK" } }];
        else if (last?.role !== "toolResult" && /(?:Assigned task:|Original task:)\s*CHILD_QUESTION/.test(text)) content = [{ type: "toolCall", id: "worker-question", name: "ask_question", arguments: { question: "Which acceptance target?" } }];
        else content = [{ type: "text", text: last?.role === "toolResult" ? text : `ROLE_TEAM_DONE ${JSON.stringify({ tools: getCurrentTools(context.messages).map(t => t.name), task: text })}` }];
        const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: message.stopReason as "stop", message }); stream.end();
      }); return stream;
    },
  });
}
