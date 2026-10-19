import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, LoadedMcpConfig, McpExtensionOptions, McpTransportFactory, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { findPackageJSON } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AccessMode } from "./loadout.ts";
import { effectiveRole, roleMcpConfigHash, roleMcpDefinitionHash, ROLE_CHILD_EXTENSION, type RolePlan, type RoleMcpSource } from "./role-loadout.ts";
export type { RoleMcpSource } from "./role-loadout.ts";

export interface RoleMcpAdapter {
  ready(ctx: ExtensionCommandContext, deadline: number, signal?: AbortSignal): Promise<void>;
  sources(): RoleMcpSource[];
  verify(): void;
  close(): Promise<void>;
}
type Definition = Parameters<ExtensionAPI["registerTool"]>[0];
type Transport = ReturnType<McpTransportFactory>;
type Shutdown = (event: { type: "session_shutdown" }, ctx: ExtensionContext) => unknown;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const metadata = (t: Definition | ReturnType<ExtensionAPI["getAllTools"]>[number]) => copy({
  name: t.name, description: t.description, parameters: t.parameters, exposure: t.exposure,
  namespace: t.namespace, annotations: t.annotations, promptGuidelines: t.promptGuidelines,
});

/** The native template grammar, without its shell-command branch. Never include values in errors. */
function resolveCredential(value: string, label: string, secrets: Set<string>): string {
  if (typeof value !== "string" || value.startsWith("!")) throw new Error(`${label}: credential commands are not supported`);
  let result = "";
  for (let i = 0; i < value.length;) {
    if (value[i] !== "$") { result += value[i++]; continue; }
    const next = value[i + 1];
    if (next === "$" || next === "!") { result += next; i += 2; continue; }
    let name: string | undefined;
    if (next === "{") {
      const end = value.indexOf("}", i + 2);
      if (end < 0) { result += "$"; i++; continue; }
      name = value.slice(i + 2, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { result += value.slice(i, end + 1); i = end + 1; continue; }
      i = end + 1;
    } else {
      name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i + 1))?.[0];
      if (!name) { result += "$"; i++; continue; }
      i += name.length + 1;
    }
    const resolved = process.env[name];
    if (!resolved) throw new Error(`${label}: missing environment variable ${name}`);
    secrets.add(resolved); result += resolved;
  }
  if (result) secrets.add(result);
  return result;
}

/** Loaded only by role children. Read-only/empty selections do not load the native MCP runtime. */
export async function setupRoleMcp(pi: ExtensionAPI, plan: RolePlan, access: AccessMode): Promise<RoleMcpAdapter> {
  const selected = effectiveRole(plan, access).mcp;
  const required = new Map<string, Set<string>>();
  for (const m of selected) {
    const names = required.get(m.server) ?? new Set<string>();
    for (const raw of m.tools) names.add(raw);
    required.set(m.server, names);
  }
  let closed = false, ready = false, closing: Promise<void> | undefined;
  let context: ExtensionContext | undefined;
  let command: RegisteredCommand | undefined;
  let failure: string | undefined;
  const shutdowns: Shutdown[] = [];
  const transports = new Set<Transport>();
  const connections = new Map<string, { initialized: boolean; alive: boolean; refreshing: boolean; inventoryFailed: boolean }>();
  const definitions = new Map<string, { server: string; rawName: string; definition: Definition }>();
  const baseline = new Map<string, unknown>();
  const rawInventory = new Map<string, unknown[]>();
  const rawBaseline = new Map<string, unknown[]>();
  const credentials = new Set<string>();
  const redactDiagnostic = (value: string): string => {
    const literals = [...credentials].filter(Boolean).sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return literals.length ? value.replace(new RegExp(literals.join("|"), "g"), "[redacted]") : value;
  };
  const configHashes = new Map([...required.keys()].map(server => [server, roleMcpConfigHash(plan, server)]));
  const sources = (): RoleMcpSource[] => [...required].map(([server, names]) => ({
    server, configHash: configHashes.get(server)!, tools: [...names].map(rawName => {
      const matches = [...definitions.values()].filter(d => d.server === server && d.rawName === rawName && d.definition.exposure === "direct");
      if (matches.length !== 1) throw new Error(`Role ${plan.roleId} MCP ${server}: missing or ambiguous selected tool ${rawName}`);
      const raw = (rawInventory.get(server) ?? []).filter((tool: any) => tool.name === rawName);
      if (raw.length !== 1) throw new Error(`Role ${plan.roleId} MCP ${server}: missing or duplicate raw tool definition (${rawName})`);
      return { rawName, name: matches[0].definition.name, definitionHash: roleMcpDefinitionHash(raw[0]) };
    }),
  }));
  const verify = () => {
    if (closed) throw new Error(`Role ${plan.roleId}: MCP adapter closed`);
    if (failure) throw new Error(failure);
    for (const server of required.keys()) {
      const state = connections.get(server);
      if (!state?.initialized || !state.alive || state.refreshing || state.inventoryFailed) throw new Error(`Role ${plan.roleId} MCP ${server}: connection or inventory not ready`);
      if (roleMcpConfigHash(plan, server) !== configHashes.get(server) ||
          (ready && !isDeepStrictEqual(rawBaseline.get(server), rawInventory.get(server)))) {
        throw new Error(`Role ${plan.roleId} MCP ${server}: selected tool schema/configuration changed`);
      }
    }
    const actual = pi.getAllTools();
    for (const source of sources()) for (const { rawName, name } of source.tools) {
      const definition = definitions.get(name)!.definition;
      const tool = actual.find(t => t.name === name);
      if (!tool || !isDeepStrictEqual(metadata(tool), metadata(definition)) ||
          tool.sourceInfo?.path !== ROLE_CHILD_EXTENSION || (ready && !baseline.has(name)) ||
          (baseline.has(name) && !isDeepStrictEqual(baseline.get(name), copy({ metadata: metadata(tool), sourceInfo: tool.sourceInfo })))) {
        throw new Error(`Role ${plan.roleId} MCP ${source.server}: selected tool definition/provenance changed (${rawName})`);
      }
    }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; ready = false;
    // Close observed transports too: native connection.close() alone cannot reach a client still initializing.
    closing = (async () => {
      await Promise.allSettled([
        ...[...transports].map(t => t.close()),
        ...shutdowns.map(h => Promise.resolve().then(() => h({ type: "session_shutdown" }, context!))),
      ]);
    })();
    return closing;
  };
  if (!selected.length) return {
    sources: () => [], verify: () => { if (closed) throw new Error("Role MCP adapter closed"); }, close,
    ready: async (_ctx, deadline, signal) => {
      if (closed || signal?.aborted || !Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("Role MCP readiness deadline expired or cancelled");
    },
  };

  const native = await import("@earendil-works/pi-coding-agent");
  // Resolve Pi's own transport dependency, not an undeclared dependency of this package. Clients,
  // protocol handling, tool execution and result conversion remain entirely in createMcpExtension.
  // pi-mcp has import-only exports, so createRequire().resolve() cannot resolve its root.
  const transportPackage = findPackageJSON("@earendil-works/pi-mcp", pathToFileURL(join(native.getPackageDir(), "package.json")));
  if (!transportPackage) throw new Error("Role MCP requires Pi's native transport package");
  const transportEntry = JSON.parse(readFileSync(transportPackage, "utf8")).exports?.["."]?.import;
  if (typeof transportEntry !== "string") throw new Error("Role MCP native transport import is unavailable");
  const { StdioTransport, StreamableHttpTransport } = await import(pathToFileURL(resolve(dirname(transportPackage), transportEntry)).href) as typeof import("@earendil-works/pi-mcp");
  const ajv = new Ajv({ strict: false, validateSchema: true, addUsedSchema: false, logger: false });
  const ajv2020 = new Ajv2020({ strict: false, validateSchema: true, addUsedSchema: false, logger: false });
  const validateSchema = (schema: unknown) => {
    const cloned = copy(schema) as Record<string, unknown>;
    const validator = cloned.$schema === "https://json-schema.org/draft/2020-12/schema" ? ajv2020 : ajv;
    validator.compile(cloned);
  };
  const entries: LoadedMcpConfig["servers"] = [];
  for (const [server, names] of required) {
    const config = selected.find(m => m.server === server)!.config;
    const http = "url" in config;
    const allowed = http ? ["type", "url", "headers", "timeout", "description"] : ["type", "command", "args", "cwd", "env", "timeout", "description"];
    if (Object.keys(config).some(k => !allowed.includes(k))) throw new Error(`Role ${plan.roleId} MCP ${server}: unsupported configuration/authentication`);
    if (!http && config.cwd !== undefined && !isAbsolute(config.cwd)) throw new Error(`Role ${plan.roleId} MCP ${server}: cwd must be frozen absolute`);
    // Validate and resolve here, before any server is launched. The resolved copy is never persisted.
    const values = http ? config.headers : config.env;
    const resolved = Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key,
      resolveCredential(value, `Role ${plan.roleId} MCP ${server} ${http ? "headers" : "env"}.${key}`, credentials)]));
    const common = { ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      ...(config.description !== undefined ? { description: config.description } : {}),
      exposure: "hidden" as const, toolExposure: Object.fromEntries([...names].map(n => [n, "direct" as const])) };
    entries.push({ name: server, source: ROLE_CHILD_EXTENSION, config: http ? {
      ...common, type: "http", url: config.url!, headers: resolved,
    } : { ...common, type: "stdio", command: config.command!, args: config.args ? [...config.args] : undefined,
      cwd: config.cwd ?? plan.cwd, env: resolved } });
  }
  const createTransport: McpTransportFactory = (entry, _cwd, _authProvider) => {
    if (closed || !required.has(entry.name)) throw new Error(`Role ${plan.roleId}: MCP connection unavailable`);
    const config = entry.config;
    // Do not give the transport the native OAuth provider. Only explicitly supplied headers are used.
    const transport = "url" in config ? new StreamableHttpTransport({ url: config.url, headers: config.headers }) :
      new StdioTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env, stderr: "pipe" });
    const state = { initialized: false, alive: true, refreshing: false, inventoryFailed: false };
    connections.set(entry.name, state); transports.add(transport);
    const requests = new Map<string | number, string>();
    let inventory: { name: string; inputSchema: Record<string, unknown>; outputSchema?: unknown }[] = [];
    let inventoryComplete = false;
    const pendingSends = new Set<string | number>(), cancelledSends = new Set<string | number>();
    transport.onClose(() => { state.alive = false; });
    transport.onError(() => { state.alive = false; });
    // Observe protocol envelopes, never alter native tool call results, progress or cancellation.
    const originalSend = transport.send.bind(transport);
    transport.send = async message => {
      if (closed) throw new Error(`Role ${plan.roleId}: MCP adapter closed`);
      const callId = "method" in message && message.method === "tools/call" && "id" in message ? message.id : undefined;
      if ("method" in message && message.method === "notifications/cancelled") {
        const id = (message.params as { requestId?: string | number } | undefined)?.requestId;
        if (id !== undefined && pendingSends.has(id)) cancelledSends.add(id);
      }
      if (callId !== undefined) pendingSends.add(callId);
      try {
        if (callId !== undefined) {
          // Native renewal retries do not pass through Pi's tool_call hook again.
          // Let pending registrations settle, but never forward a cancelled retry.
          if (state.refreshing && !state.inventoryFailed) await new Promise<void>(resolve => setImmediate(resolve));
          if (closed || cancelledSends.has(callId)) throw new Error("MCP tool request cancelled before transport submission");
          if (!ready || connections.get(entry.name) !== state) throw new Error(`Role ${plan.roleId} MCP ${entry.name}: tool call before verified connection`);
          verify();
        }
        if ("method" in message && "id" in message) {
          requests.set(message.id, message.method);
          if (message.method === "tools/list" && !(message.params as { cursor?: unknown } | undefined)?.cursor) {
            inventory = []; inventoryComplete = false; state.refreshing = true; state.inventoryFailed = false;
          }
        }
        return await originalSend(message);
      } finally {
        if (callId !== undefined) { pendingSends.delete(callId); cancelledSends.delete(callId); }
      }
    };
    const originalOnMessage = transport.onMessage.bind(transport);
    transport.onMessage = listener => originalOnMessage(message => {
      if ("method" in message && message.method === "notifications/message") return; // no credential-bearing server logs
      if ("method" in message && message.method === "notifications/tools/list_changed") state.refreshing = true;
      if ("id" in message && !("method" in message)) {
        const method = requests.get(message.id);
        requests.delete(message.id);
        if (method === "initialize" && "result" in message) state.initialized = true;
        if (method === "tools/list") {
          if ("result" in message) {
            const page = message.result as { tools?: typeof inventory; nextCursor?: unknown } | null;
            const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
            const cursor = page?.nextCursor;
            const ended = cursor === undefined || cursor === null || cursor === "";
            // Match native validateListPage, including unselected entries. Native
            // rejection of any page must never restore an older authorization.
            if (!object(page) || !Array.isArray(page.tools) ||
                page.tools.some(t => !object(t) || typeof t.name !== "string" || !object(t.inputSchema)) ||
                !ended && typeof cursor !== "string") state.inventoryFailed = true;
            if (!state.inventoryFailed) {
              inventory.push(...page!.tools!.filter(t => required.get(entry.name)!.has(t.name)));
              if (ended) {
                inventoryComplete = true;
                rawInventory.set(entry.name, copy(inventory.sort((a, b) => a.name.localeCompare(b.name))));
              }
            }
          } else state.inventoryFailed = true;
          // Native processes the response and synchronously registers the complete list (incl. hidden
          // withdrawals). Keep calls fail-closed while paginated discovery is still in flight.
          setImmediate(() => { if (![...requests.values()].includes("tools/list")) state.refreshing = state.inventoryFailed || !inventoryComplete; });
        }
      }
      listener(message);
    });
    return transport;
  };
  const isolated = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "getMcpServers") return () => [];
      if (property === "registerCommand") return (name: string, registered: RegisteredCommand) => {
        if (name !== "mcp") throw new Error("Unexpected native MCP command");
        command = registered;
        // Reserve the command to replace host default MCP, but never expose login/config mutations.
        pi.registerCommand(name, { description: "Role MCP configuration is frozen", handler: async () => { throw new Error(`Role ${plan.roleId}: MCP management/login is disabled`); } });
      };
      if (property === "registerTool") return (definition: Definition) => {
        if (closed) return;
        const server = [...required.keys()].find(s => definition.label.startsWith(`${s}/`));
        if (!server) return;
        const rawName = definition.label.slice(server.length + 1);
        if (!required.get(server)!.has(rawName)) return;
        try {
          if (definition.exposure !== "hidden") {
            if (definition.exposure !== "direct" || (definition.parameters as { type?: unknown }).type !== "object") throw new Error("schema");
            validateSchema(definition.parameters);
            // Pi wraps remote outputSchema inside CallToolResult; root-relative
            // references still belong to the original schema, not that wrapper.
            const raw = (rawInventory.get(server) ?? []).find((tool: any) => tool.name === rawName) as { outputSchema?: unknown } | undefined;
            if (!raw) throw new Error("missing raw definition");
            if (raw.outputSchema !== undefined) validateSchema(raw.outputSchema);
          }
        } catch {
          failure = `Role ${plan.roleId} MCP ${server}: invalid selected tool schema (${rawName})`;
          return;
        }
        definitions.set(definition.name, { server, rawName, definition });
        pi.registerTool({ ...definition, async execute(...args) {
          try { return await definition.execute(...args); }
          catch (error) {
            // Redact exceptions only, after native retry/auth classification.
            // Successful and isError protocol results remain byte-for-byte native.
            const safe = new Error(redactDiagnostic(error instanceof Error ? error.message : String(error)));
            if (error instanceof Error) safe.name = redactDiagnostic(error.name);
            throw safe;
          }
        } });
      };
      if (property === "on") return (event: string, handler: (...args: any[]) => any) => {
        if (event === "session_shutdown") {
          shutdowns.push(handler);
          return pi.on("session_shutdown", async () => { await close(); });
        }
        return (pi.on as Function)(event, (value: any, ctx: ExtensionContext) => {
          context = ctx;
          if (closed) return;
          const safeCtx = new Proxy(ctx, { get(t, p, r) {
            if (p === "ui") return new Proxy(ctx.ui, { get(ui, method, uiReceiver) {
              if (method === "notify" || method === "setStatus") return () => {}; // native failures may contain credentials/stderr
              return Reflect.get(ui, method, uiReceiver);
            } });
            return Reflect.get(t, p, r);
          } });
          return handler(event === "mcp_servers_change" ? { ...value, servers: [] } : value, safeCtx);
        });
      };
      return Reflect.get(target, property, receiver);
    },
  });
  // Public methods only; the native class's private storage makes this deliberately file-free
  // implementation nominally incompatible. No browser/refresh/login path receives usable state.
  const emptyCredentials: Pick<NonNullable<McpExtensionOptions["credentials"]>, "forServer" | "tokens" | "remove"> = {
    forServer: () => ({ load: async () => undefined, save: async () => { throw new Error("Role MCP credential persistence disabled"); }, withRefreshLock: async fn => fn() }),
    tokens: () => undefined, remove: () => { throw new Error("Role MCP credential persistence disabled"); },
  };
  await native.createMcpExtension({ loadConfig: (): LoadedMcpConfig => ({ servers: entries, errors: [], autoEnableCodemode: false }),
    createTransport, credentials: emptyCredentials as NonNullable<McpExtensionOptions["credentials"]>,
    openUrl: () => { throw new Error("Role MCP interactive login disabled"); },
    updateConfig: () => { throw new Error("Role MCP configuration is frozen"); }, startupWaitMs: 0,
  })(isolated);
  return {
    sources, verify, close,
    async ready(ctx, deadline, signal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        if (closed || signal?.aborted || !Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("deadline or cancellation");
        if (!command) throw new Error("native MCP command unavailable");
        const barrier = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("deadline")), Math.max(0, deadline - Date.now()));
          onAbort = () => reject(new Error("cancellation"));
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        // Force non-TUI status: unlike the first-prompt wait this awaits ALL native pending tasks.
        const safeCtx = new Proxy(ctx, { get(t, p, r) {
          if (p === "mode") return "rpc";
          if (p === "ui") return new Proxy(ctx.ui, { get(ui, method, uiReceiver) { return method === "notify" ? () => {} : Reflect.get(ui, method, uiReceiver); } });
          return Reflect.get(t, p, r);
        } });
        await Promise.race([command.handler("", safeCtx), barrier]);
        // Let native response callbacks finish tool registration before clearing
        // the in-flight inventory flag; no model work is submitted by this turn.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (Date.now() >= deadline || signal?.aborted) throw new Error("deadline or cancellation");
        verify();
        if (!ready) {
          for (const source of sources()) for (const { name } of source.tools) {
            const actual = pi.getAllTools().find(t => t.name === name)!;
            baseline.set(name, copy({ metadata: metadata(actual), sourceInfo: actual.sourceInfo }));
          }
          for (const server of required.keys()) rawBaseline.set(server, copy(rawInventory.get(server) ?? []));
          ready = true;
        }
      } catch {
        await close();
        throw new Error(failure ?? `Role ${plan.roleId} MCP ${[...required.keys()].join(",")}: readiness failed (deadline, cancellation, connection, authentication or required tools)`);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
