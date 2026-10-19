import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime, getPackageDir } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { accessMode, isDelegationTool, type AccessMode } from "./loadout.ts";

type LocalSource = { entry: string; hash: string; tools: string[] };
type LocalPlan = { cwd: string; builtinTools: string[]; extraTools: LocalSource[] };
type ToolAPI = Pick<ExtensionAPI, "registerTool">;
const builtins = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);
const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Compatibility seam: Pi 1.0.2 exports loadExtensions from this distribution
 * entry, not its package root. Keep this dependency isolated to the role adapter.
 */
async function publicLoader() {
  const url = pathToFileURL(join(getPackageDir(), "dist/core/extensions/index.js"));
  return await import(url.href) as typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js");
}

/** Narrow factory adapter (§5.1 fallback). The stock loader exposes pi.exec
 * outside its runtime, so an unbound runtime alone cannot enforce tool-only API use.
 * Exported only for the private loader shim, never passed a real session API.
 */
export function toolOnlyFactory(factory: (pi: ExtensionAPI) => unknown) {
  return async (pi: ExtensionAPI) => {
    let open = true;
    const violations: string[] = [];
    const names = new Set<string>();
    const deny = (key: PropertyKey): never => {
      violations.push(String(key)); throw new Error(`Tool-only entry used unsupported API: ${String(key)}`);
    };
    const registerTool = (tool: ToolDefinition) => {
      if (!open) return deny("late registerTool");
      if (names.has(tool.name)) { violations.push("duplicate tool"); throw new Error(`Duplicate local tool registration: ${tool.name}`); }
      names.add(tool.name); pi.registerTool(tool);
    };
    const api = new Proxy(Object.create(null), {
      get(_target, key) { return key === "registerTool" ? registerTool : deny(key); },
      set: (_target, key) => deny(key), defineProperty: (_target, key) => deny(key), deleteProperty: (_target, key) => deny(key),
      setPrototypeOf: () => deny("setPrototypeOf"), getPrototypeOf: () => deny("getPrototypeOf"),
      ownKeys: () => deny("ownKeys"), getOwnPropertyDescriptor: (_target, key) => deny(key),
    }) as ExtensionAPI;
    try {
      if (typeof factory !== "function") throw new Error("Tool-only entry must export a factory");
      const result = await factory(api);
      if (result !== undefined) throw new Error("Tool-only factory must return void (no background resources)");
      if (violations.length) throw new Error(`Tool-only entry used unsupported API: ${violations.join(", ")}`);
    } finally { open = false; }
  };
}

/** Race owned initialization against its shared deadline/cancellation signal. */
export async function waitForRoleResource<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Role initialization aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
/** Trusted JavaScript, NOT a sandbox. The independent, never-bound runtime cannot
 * mutate a real session. Only execute's supplied ctx can access that session.
 */
export async function loadRoleTools(plan: LocalPlan, access: AccessMode = "full", signal?: AbortSignal) {
  signal?.throwIfAborted();
  accessMode(access);
  let closed = false;
  const sources: LocalSource[] = [];
  const selected: { source: LocalSource; original: ToolDefinition; definition: ToolDefinition; metadata: unknown; execute: ToolDefinition["execute"] }[] = [];
  const dispose = () => { closed = true; };
  const verify = () => {
    if (closed) throw new Error("Local role tool loader is disposed");
    for (const source of sources) {
      if (realpathSync(source.entry) !== source.entry || hashFile(source.entry) !== source.hash) throw new Error(`Local tool source hash changed: ${source.entry}`);
    }
    for (const t of selected) {
      const { execute: _execute, ...metadata } = t.original;
      if (t.original.execute !== t.execute || !isDeepStrictEqual(json(metadata), t.metadata)) throw new Error(`Local tool definition/implementation changed: ${t.definition.name}`);
    }
  };
  const register = (pi: ToolAPI) => { verify(); for (const t of selected) pi.registerTool(t.definition); };
  if (access === "read-only") return { sources, register, verify, dispose };

  const entries = new Set<string>();
  const names = new Set<string>();
  try {
    for (const requested of plan.extraTools) {
      const entry = realpathSync(requested.entry);
      if (entry !== requested.entry || hashFile(entry) !== requested.hash) throw new Error(`Local tool source hash changed: ${requested.entry}`);
      if (entries.has(entry)) throw new Error(`Duplicate local tool entry: ${entry}`);
      entries.add(entry);
      const source = { entry, hash: requested.hash, tools: [...requested.tools] };
      if (!source.tools.length || new Set(source.tools).size !== source.tools.length) throw new Error(`Duplicate or missing local tool selection: ${entry}`);
      for (const name of source.tools) {
        if (name === "ask_question" || builtins.has(name) || plan.builtinTools.includes(name) || isDelegationTool(name)) throw new Error(`Forbidden reserved tool collision: ${name}`);
        if (names.has(name)) throw new Error(`Duplicate local tool name: ${name}`);
        names.add(name);
      }
      const runtime = createExtensionRuntime();
      let registrations = 0;
      const violations: string[] = [];
      const unsupported = (kind: string): never => { violations.push(kind); throw new Error(`Tool-only entry used unsupported API: ${kind}`); };
      const guarded = new Proxy(runtime, { get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === "refreshTools") return () => { registrations++; };
        if (["assertActive", "invalidate"].includes(String(key))) return typeof value === "function" ? value.bind(target) : value;
        if (typeof value === "function") return () => unsupported(String(key));
        return value;
      }});
      // No subscriptions survive even failed factories, and no events reach the host.
      const bus = { on: () => unsupported("events.on"), emit: () => unsupported("events.emit") };
      try {
        const { loadExtensions } = await waitForRoleResource(publicLoader(), signal);
        // No discovery and no real session: import this one canonical entry through
        // a private adapter which exposes only the ToolDefinition registrar.
        const dir = mkdtempSync(join(tmpdir(), "role-local-loader-")); chmodSync(dir, 0o700);
        const shim = join(dir, "entry.mjs");
        let loaded: Awaited<ReturnType<typeof loadExtensions>>;
        try {
          writeFileSync(shim, `import factory from ${JSON.stringify(entry)};\nimport {toolOnlyFactory} from ${JSON.stringify(fileURLToPath(import.meta.url))};\nexport default toolOnlyFactory(factory);\n`, {mode: 0o600, flag: "wx"});
          loaded = await waitForRoleResource(loadExtensions([realpathSync(shim)], plan.cwd, bus, guarded), signal);
        } finally { rmSync(dir, {recursive: true, force: true}); }
        signal?.throwIfAborted();
        if (loaded.errors.length) throw new Error(loaded.errors.map(e => e.error).join("; "));
        const ext = loaded.extensions[0];
        if (!ext || loaded.extensions.length !== 1) throw new Error(`Missing local tool entry: ${entry}`);
        if (violations.length || ext.handlers.size || ext.commands.size || ext.shortcuts.size || ext.flags.size ||
          ext.messageRenderers.size || ext.entryRenderers?.size || ext.toolRenderers?.length || ext.markdownTransformer ||
          runtime.pendingProviderRegistrations.length || runtime.pendingNativeProviderRegistrations.length ||
          runtime.pendingVirtualModelRegistrations.length || runtime.mcpServers.list().length) throw new Error(`Tool-only entry has unsupported registrations: ${entry} ${violations.join(", ")}`);
        if (registrations !== ext.tools.size) throw new Error(`Duplicate local tool registration: ${entry}`);
        for (const [name, tool] of ext.tools) {
          if (name === "ask_question" || builtins.has(name) || plan.builtinTools.includes(name) || isDelegationTool(name)) throw new Error(`Forbidden reserved tool collision: ${name}`);
          if (tool.definition.prepareLoadout) throw new Error(`Tool-only entry has unsupported loadout hook: ${name}`);
        }
        for (const name of source.tools) {
          const original = ext.tools.get(name)?.definition;
          if (!original) throw new Error(`Missing selected local tool: ${name} in ${entry}`);
          if (typeof original.execute !== "function") throw new Error(`Missing local tool implementation: ${name}`);
          const { execute, ...metadata } = original;
          const definition = { ...original, exposure: "direct" as const,
            async execute(...args: Parameters<ToolDefinition["execute"]>) {
              verify(); return execute.apply(original, args);
            } };
          selected.push({ source, original, definition, metadata: json(metadata), execute });
        }
        sources.push(source);
      } finally {
        // Invalidate captured pi APIs immediately. Tools must use execute's ctx;
        // late factory registrations and captured session actions cannot run.
        runtime.invalidate("Local tool-only loading is closed; use execute ctx");
      }
    }
    verify();
    return { sources, register, verify, dispose };
  } catch (error) { dispose(); throw error; }
}
