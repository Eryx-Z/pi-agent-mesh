// Deterministic local provider used only by role-child real-loader tests.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
export default function provider(pi: ExtensionAPI) {
  pi.registerProvider("role-local", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "test", name: "Role local fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      appendFileSync("requests.jsonl", JSON.stringify({ tools: getCurrentTools(context.messages).map(t => t.name) }) + "\n");
      const last = context.messages.at(-1);
      const input = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(c=>c.type==="text").map(c=>c.text).join("\n")) : "";
      const tool = /^CALL ([\w_]+)/.exec(input)?.[1];
      const content: AssistantMessage["content"] = tool ? [{ type:"toolCall",id:"local-call",name:tool,arguments:{} }] : [{type:"text",text:JSON.stringify(last?.content)}];
      const message: AssistantMessage = { role:"assistant",content,api:model.api,provider:model.provider,model:model.id,
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        stopReason:tool?"toolUse":"stop",timestamp:Date.now() };
      const stream=createAssistantMessageEventStream();
      setImmediate(()=>{stream.push({type:"start",partial:message});stream.push({type:"done",reason:message.stopReason as "toolUse"|"stop",message});stream.end();});return stream;
    },
  });
}
