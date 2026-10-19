import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("published offline example exercises public role dispatch and mixed-context DAG with real Pi RPC", { timeout: 120000 }, async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ["--import", "tsx", "examples/role-v1-demo/run.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 110000,
      env: { ...process.env, MESH_DEMO_KEEP: "0" }, maxBuffer: 1024 * 1024,
    });
  assert.match(stdout, /PASS: real offline Pi RPC/);
  assert.equal(stderr, "");
});
