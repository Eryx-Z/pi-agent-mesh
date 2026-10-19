# Offline role V1 demonstration

Run from the **package root** (checkout or unpacked npm package), with aligned Pi packages installed. The verified baseline is Pi 1.0.2 and Node 22.19+:

```sh
# Checkout only: npm ci
node --import tsx examples/role-v1-demo/run.ts
```

`tsx` is a development runner, not a package runtime dependency. If running an unpacked published package, install/provide `tsx` yourself (for example `npm install --no-save tsx`) before running. All demo source and builtin roles are published under this package; nothing imports checkout-only `test/` files.

The script creates a temporary clean project with `.pi/agent-mesh.yaml`, isolated Pi agent storage, and the packaged builtin roles. It starts actual installed Pi CLI/RPC processes and loads `provider.ts`, a deterministic scripted provider: **no model API, external service, login, credentials or quota**. It then calls public tools through the PM's real provider tool-call loop:

1. `subagent` Builder writes `built.txt` with the actual `write` tool.
2. `subagent` Tester checks that file using actual `bash` and records the success marker.
3. `subagent` Reviewer independently reads it using actual `read`.
4. `workflow_run` executes Builder `partial` with step-selected context/model, followed by Reviewer `none`/`omit` using the workflow model.

Assertions inspect actual provider requests/tool results, successful public completion notifications, file contents, the persisted `agent_mesh_pm` entry, exact reviewer tools, absence of worker delegation, PM's lack of bash/write, role prompt separation and absence of upstream reports/context from Reviewer. Tool acceptance is not treated as task completion. This is a shared-workspace DAG; isolated dependency-code merging and native MCP lifecycle have separate integration tests and are not claimed by this demo.

Success prints `PASS: real offline Pi RPC; ...` and removes temporary artifacts after confirmed shutdown. Use `MESH_DEMO_KEEP=1` to retain request logs, sessions, role/task snapshots and output for inspection. Logs include test prompts/tool results; no real credentials should be supplied. The harness uses `--approve` only for its generated temporary fixture and explicitly supplied trusted package extensions.

No global Pi settings are changed. Do not load this scripted provider for ordinary work: it implements only this demo's fixed commands, not language understanding. Native MCP and custom-tool configuration are deliberately separate opt-ins, not prerequisites for this offline baseline.
