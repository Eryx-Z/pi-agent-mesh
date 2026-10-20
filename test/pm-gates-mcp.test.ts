import { test } from "node:test";
import assert from "node:assert/strict";
import { installMainMcpRouter } from "../pi-extension/subagents/pm.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

for (const flag of ["--no-extensions", "-ne"]) for (const explicit of [false, true]) for (const exclusion of [undefined, "-builtin:mcp", "-builtin:*"]) {
  test(`native MCP lifecycle gate: ${flag}, explicit=${explicit}, exclusion=${exclusion}`, async () => {
    const argv = process.argv;
    process.argv = [...argv, flag, ...(explicit ? ["-e", "builtin:mcp"] : [])];
    const hooks = new Map<string, Function[]>();
    let entered = 0;
    const sentinel = new Error("native lifecycle entered");
    const pi = new Proxy({
      getSettings: () => ({ extensions: exclusion ? [exclusion] : [] }),
      registerCommand() {},
      on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    }, { get(target, key) { return key in target ? Reflect.get(target, key) : () => {}; } }) as unknown as ExtensionAPI;
    try {
      await installMainMcpRouter(pi, { state: "off", error: "" } as any);
      // Stop at the first native config read: no process, credentials or external connection.
      const ctx = { get cwd() { entered++; throw sentinel; }, isProjectTrusted: () => false };
      for (const hook of hooks.get("session_start") ?? []) {
        try { await hook({ type: "session_start", reason: "startup" }, ctx); }
        catch (error) { assert.equal(error, sentinel); }
      }
      assert.equal(entered, explicit && !exclusion ? 1 : 0);
    } finally { process.argv = argv; }
  });
}
