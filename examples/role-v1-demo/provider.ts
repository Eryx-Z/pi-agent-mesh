import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic offline model: actual tools still execute in real Pi processes. */
export default function (pi: ExtensionAPI) {
  pi.events.on("rpc-subagents:provider-source:v1", (request: any) => {
    if (request.provider === "mesh-demo") request.register(fileURLToPath(import.meta.url));
  });
  pi.registerProvider("mesh-demo", {
    baseUrl: "http://offline.invalid", apiKey: "offline", api: "openai-completions",
    models: ["pm", "worker", "override"].map(id => ({ id, name: id, contextWindow: 100000, maxTokens: 8192, reasoning: false,
      input: ["text"] as "text"[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = context.messages.at(-1) as any;
        const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const child = process.env.PI_RPC_SUBAGENT_CHILD === "1";
        const prompt = getCurrentSystemPrompt(context.messages);
        const tools = getCurrentTools(context.messages).map(t => t.name);
        if (process.env.MESH_DEMO_LOG) appendFileSync(process.env.MESH_DEMO_LOG,
          JSON.stringify({ child, model: `${model.provider}/${model.id}`, prompt, tools, messages: context.messages }) + "\n");
        let content: AssistantMessage["content"];
        const call = !child && last?.role === "user" && text.match(/^CALL (\{[^\n]+\})$/);
        let tool: Pick<Extract<AssistantMessage["content"][number], { type: "toolCall" }>, "name" | "arguments"> | undefined;
        if (call) tool = JSON.parse(call[1]);
        else if (child && last?.role !== "toolResult") {
          if (/Assigned task:\s*DEMO_BUILD/.test(text)) tool = { name: "write", arguments: { path: "built.txt", content: "ROLE_DEMO_CODE\n" } };
          else if (/Assigned task:\s*DEMO_TEST/.test(text)) tool = { name: "bash", arguments: { command: "test \"$(cat built.txt)\" = ROLE_DEMO_CODE && printf ROLE_DEMO_TEST_OK" } };
          else if (/Assigned task:\s*DEMO_REVIEW/.test(text)) tool = { name: "read", arguments: { path: "built.txt" } };
        }
        if (tool) content = [{ type: "toolCall", id: `demo-${Date.now()}`, ...tool }];
        else content = [{ type: "text", text: child ? `DEMO_REPORT_PRIVATE ${text}` : "PM received tool result or notification." }];
        const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: message.stopReason as "stop", message }); stream.end();
      });
      return stream;
    },
  });
}
