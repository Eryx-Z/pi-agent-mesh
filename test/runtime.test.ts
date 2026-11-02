import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piInvocation } from "../pi-extension/subagents/runtime.ts";
import { acquireExecutionLease } from "../pi-extension/subagents/lease.ts";

test("compiled Pi launches itself without a JavaScript entrypoint", () => {
  assert.deepEqual(piInvocation("/nonexistent-package", "/opt/pi/pi"), { command: "/opt/pi/pi", baseArgs: [] });
});

test("Node and Bun installations launch the package CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-runtime-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: { pi: "dist/cli.js" } }));
    writeFileSync(join(dir, "dist/cli.js"), "");
    for (const runtime of ["/usr/bin/node", "/usr/bin/bun"]) {
      assert.deepEqual(piInvocation(dir, runtime), { command: runtime, baseArgs: [join(dir, "dist/cli.js")] });
    }
    rmSync(join(dir, "dist/cli.js"));
    assert.throws(() => piInvocation(dir, "/usr/bin/node"), /CLI entrypoint not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lease enforces exclusive ownership and can be reacquired after release", { skip: process.platform !== "linux", timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-lease-"));
  const path = join(dir, ".owner.lease");
  const lease = await acquireExecutionLease(path);
  let lost = false;
  try {
    assert.equal(lease.alive, true);
    await assert.rejects(acquireExecutionLease(path), /owned by another manager/);
    await lease.release();
    await lease.release();
    assert.equal(lease.alive, false);
    const next = await acquireExecutionLease(path, () => { lost = true; });
    await next.release();
    assert.equal(lost, false, "Explicit release is not unexpected ownership loss");
  } finally {
    await lease.release();
    rmSync(dir, { recursive: true, force: true });
  }
});
