import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Tool-only factory: no hooks, commands, providers, MCP registrations or captured ctx.
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet", label: "Greet", description: "Return a deterministic greeting without I/O",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: { greetingVersion: 1 } };
    },
  });
}
