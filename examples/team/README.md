# Minimal role team

Copy `.pi/agent-mesh.yaml` from this directory into your project's `.pi/` directory, install `pi-agent-mesh`, then start a new persistent `pi` session in the project. Requires aligned Pi 1.0.2+ (verified baseline: 1.0.2) and Node 22.19+.

The four packaged roles require no external services or credentials beyond your chosen model:

| Role | Default context/access | Capabilities |
| --- | --- | --- |
| pm | main session/read-only | reading + runtime parent-only team management |
| builder | partial/full | reading, editing, writing, shell |
| tester | partial/full | reading, shell; no edit/write tools |
| reviewer | none/read-only | reading only |

Ask PM to assign a scoped Builder task, a separate Tester check, then an independent Reviewer inspection. Builder/Tester need explicit partial `contextText`; Reviewer needs requirements in its task because it receives no parent conversation by default. PM checks evidence before accepting completion.

`/roles` and `/roles inspect builder` inspect declarations without executing tools or connecting services. `/roles reload` affects future dispatch, not the saved PM resources or existing tasks/workflows. Use a new session for a new PM definition.

For automation without a model account or network, run the [offline real-RPC demo](../role-v1-demo/README.md). This minimal team deliberately does not enable MCP or custom local code. Add those only after reviewing the manifest, granting host project trust, and arranging credentials/readiness; do not mix optional services into the basic startup path.
