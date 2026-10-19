import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoleCatalog } from "../../pi-extension/subagents/roles.ts";

// Static production parsing only: no tool imports, server spawn or HTTP requests.
const root = dirname(fileURLToPath(import.meta.url));
const previous = process.env.ROLE_RESOURCES_HTTP_TOKEN;
process.env.ROLE_RESOURCES_HTTP_TOKEN ??= "static-validation-placeholder-not-a-credential";
try {
  for (const [kind, id, expected] of [
    ["local", "greeter", "greet"],
    ["stdio", "directory_reader", "list_directory"],
    ["http", "document_reader", "lookup_document"],
  ]) {
    const config = join(root, kind, "team.yaml");
    const directory = new RoleCatalog(root, config).reload();
    assert.equal(directory.enabled, true);
    assert.equal(directory.mainRole, "pm");
    const role = directory.roles.find(role => role.id === id)!;
    assert(role);
    assert.equal(role.defaults.access, "full");
    assert.deepEqual(kind === "local" ? role.extraTools[0].tools : role.mcp[0].tools, [expected]);
    console.log(`PASS static RoleCatalog: ${kind}/team.yaml (readiness NOT established)`);
  }
} finally {
  if (previous === undefined) delete process.env.ROLE_RESOURCES_HTTP_TOKEN;
  else process.env.ROLE_RESOURCES_HTTP_TOKEN = previous;
}
