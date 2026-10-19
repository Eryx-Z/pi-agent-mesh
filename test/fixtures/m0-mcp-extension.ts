// M0 feasibility probe only: not the production role adapter or PM readiness gate.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createMcpExtension, type ExtensionAPI, type ExtensionCommandContext, type LoadedMcpConfig, type McpExtensionOptions, type McpServerEntry, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";

interface ProbeConfig {
  servers: McpServerEntry[];
  selected: Record<string, string[]>;
  unwanted: McpServerEntry;
  report: string;
  requests: string;
  events: string;
}
export default function m0McpProbe(pi: ExtensionAPI) {
  const config: ProbeConfig = JSON.parse(readFileSync(process.env.M0_MCP_CONFIG!, "utf8"));
  const event = (name: string) => appendFileSync(config.events, name + "\n");
  const labels = new Map<string, string>();
  let mcpCommand: RegisteredCommand | undefined;
  // Both registration entry points are intentionally exercised. Neither is a role source.
  pi.registerMcpServer(config.unwanted.name, config.unwanted.config);
  const isolated: ExtensionAPI = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "getMcpServers") return () => { event("filtered-getMcpServers"); return []; };
      if (property === "on") return ((name: string, handler: (...args: any[]) => any) => {
        if (name === "mcp_servers_change") return pi.on(name, (change, ctx) => {
          event(`filtered-mcp_servers_change:${change.servers.length}`);
          return handler({ ...change, servers: [] }, ctx);
        });
        return (pi.on as Function)(name, handler);
      });
      if (property === "registerCommand") return (name: string, command: RegisteredCommand) => {
        if (name === "mcp") mcpCommand = command;
        pi.registerCommand(name, command);
      };
      if (property === "registerTool") return ((definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        if (definition.name.startsWith("mcp__")) labels.set(definition.name, definition.label);
        pi.registerTool(definition);
      });
      return Reflect.get(target, property, receiver);
    },
  });
  // Compile-checked against Pi 1.0.2's public LoadedMcpConfig and options, not a mock shape.
  const loadConfig: NonNullable<McpExtensionOptions["loadConfig"]> = (): LoadedMcpConfig => ({
    servers: config.servers, errors: [], autoEnableCodemode: false,
  });
  createMcpExtension({ loadConfig, startupWaitMs: 1 })(isolated);
  pi.on("session_start", () => {
    event("session-start");
    pi.registerMcpServer(config.unwanted.name + "_late", config.unwanted.config);
  });
  const inventory = () => pi.getAllTools().map(tool => ({ ...tool, label: labels.get(tool.name) }));
  const save = (value: unknown) => {
    writeFileSync(config.report + ".tmp", JSON.stringify(value));
    renameSync(config.report + ".tmp", config.report);
  };
  pi.registerCommand("m0-inventory", { description: "M0 actual inventory", handler: async () => save({ tools: inventory(), active: pi.getActiveTools() }) });
  pi.registerCommand("m0-preflight", {
    description: "M0 bounded native MCP command plus actual inventory validation",
    handler: async (args, ctx: ExtensionCommandContext) => {
      // Caller supplies one absolute deadline. No per-server or per-step restart.
      const deadline = Number(args);
      const remaining = () => Math.max(0, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      let failure: string | undefined;
      try {
        if (!remaining()) throw new Error("MCP readiness deadline expired");
        await Promise.race([
          mcpCommand!.handler("", ctx),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP readiness deadline expired")), remaining()); }),
        ]);
        if (!remaining()) throw new Error("MCP readiness deadline expired");
        const actual = inventory();
        const allowed: string[] = [];
        for (const [server, names] of Object.entries(config.selected)) {
          for (const raw of names) {
            const found = actual.find(tool => tool.label === `${server}/${raw}` && tool.exposure === "direct");
            if (!found) throw new Error(`Missing required MCP tool ${server}/${raw}`);
            if ((found.parameters as Record<string, unknown>).type !== "object") throw new Error(`Invalid MCP tool schema ${server}/${raw}`);
            allowed.push(found.name);
          }
        }
        pi.setActiveTools(allowed);
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      finally { clearTimeout(timer); }
      save({ ready: !failure, failure, deadline, finishedAt: Date.now(), tools: inventory(), active: pi.getActiveTools() });
    },
  });
  pi.registerProvider("m0-mcp", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      appendFileSync(config.requests, JSON.stringify({ tools: getCurrentTools(context.messages).map(tool => tool.name) }) + "\n");
      const last = context.messages.at(-1);
      const input = last?.role === "user" && typeof last.content === "string" ? last.content : last?.role === "user" && Array.isArray(last.content) ? last.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
      const content: AssistantMessage["content"] = input.startsWith("CALL ") ? [{ type: "toolCall", id: "m0-call", name: input.slice(5), arguments: {} }] : [{ type: "text", text: "M0 complete" }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      setImmediate(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(); });
      return stream;
    },
  });
}
