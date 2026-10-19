# Role V1 — M3 validation record

## Baseline and scope

M2 was committed on request as `a6d059e` (`feat: add isolated role execution and durable run snapshots`), on branch `feat/role-v1-m0`. No push. M3 changes remain uncommitted. Original `pi-agent-mesh-plan.md` / `pi-agent-mesh-goals.md` remain untracked and unchanged.

M3 adds native stdio and Streamable HTTP MCP execution to the **internal** M2 role engine. The public subagent/workflow schemas and PM activation remain unchanged until M4. M1 catalog inspection still performs no connection or executable loading. No new package dependency or second MCP client stack was added.

## Delivered behavior

- `role-mcp.ts` invokes Pi 1.0.2 `createMcpExtension` with exact `LoadedMcpConfig`. Both initial `getMcpServers()` and later `mcp_servers_change` inputs are filtered to empty; ambient global/project mcp.json is never read. The native /mcp command is reserved for host replacement, while login/config mutation is disabled.
- Only selected servers connect. Default exposure is hidden with exact direct overrides. Only selected native definitions enter the real registry; unselected tools and automatic resource tools are not authorized. Native registration labels map raw server/tool identities to Pi's actual normalized, collision-suffixed, truncated names. No guessed name is used as an authorization source.
- Uses the host's own installed `@earendil-works/pi-mcp` transport constructors through the public native factory hook. Its package is resolved relative to Pi with Node `findPackageJSON` and its public import export. Pi's import-only exports do not support the attempted `createRequire().resolve()` seam. Clients, JSON-RPC parsing, result conversion, progress, cancellation and connection lifecycle remain native.
- Stdio omitted cwd binds to the actual task cwd; explicit cwd stays absolute/frozen. Args are passed literally. Environment/header references resolve once per child without command evaluation; native escaping and malformed-brace-as-literal behavior are preserved. Auth values remain in memory, while plan/config hashes retain authored references. OAuth stores, login/browser flows and config writes are disabled. Server log notifications and native connection UI diagnostics are not persisted. Runtime exception text redacts known resolved credential values after native error classification; ordinary tool results are not rewritten.
- `role-child.ts` lazily loads the adapter only when effective access includes role MCP. Read-only excludes MCP/local resources before imports/connections. Preflight validates actual tools, source paths, raw selected definitions and schemas before persisting a bound result. Direct and nested guards remain exact. Every outbound native tools/call also rechecks the frozen inventory, covering internal HTTP session renewal/retry that does not emit another Pi tool_call event.
- `role-loadout.ts` adds MCP semantic identity: original server/raw name, unresolved config hash, full remote-definition hash, actual wrapper sourceInfo and input metadata. Output schema/metadata drift therefore remains detectable across runs even though Pi ToolInfo omits outputSchema. Tightening access retains the verified historical baseline; re-expansion cannot accept changed remote definitions.
- `tasks.ts` starts one 30-second absolute role readiness deadline before process launch. Startup requests use remaining time plus 5 seconds for communication, not a separate per-server wait or the ordinary 15-second RPC limit. The private child preflight uses the same deadline. No task prompt is sent after deadline/failure. Tests can shorten the internal budget without adding user config.
- Cancellation/shutdown during readiness sends private `/rpc-role-cancel-preflight` before ordinary RPC stop. A normal RPC abort does not cancel an extension command, so this explicitly drains the pending command before claiming cleanup. Existing boundary/lock safety remains authoritative if shutdown cannot be proved. Stdio peers stop with the owned child; HTTP shutdown closes only the task client, never the remote service or its side effects.

## Evidence

| Gate | Result |
| --- | --- |
| Node 22.23.3 | `npm run typecheck && npm test`: **357/357 passed**, zero skipped |
| Node 24.22.0 | Same commands with Node 24 on PATH: **357/357 passed**, zero skipped |
| Adapter native-factory tests | `test/role-mcp.test.ts`: actual native factory/transports, precise selection, dynamic lists, timeout/progress/cancel, environment grammar, no OAuth/config side effects |
| Actual TaskManager / Pi CLI RPC | `test/role-mcp-rpc.test.ts`: both transports, same raw names across servers, normalization collision and long names, rich/error results, readiness failures/zero model calls, dynamic lists, access transitions, schema drift, cancellation, shutdown, ambient/extension filtering, credential rotation and error redaction |
| Serialized metadata | `test/role-mcp-loadout.test.ts`: MCP mapping/binding/config provenance, no extra/alias mappings, hash stability across credential rotation |
| Fixture transport selftests | `test/role-mcp-fixture.test.ts`: stdio/HTTP rich results, notifications, request cancellation, progress-reset timeout and client close |
| Legacy regressions | Existing v1/v2, recovery, workflow/worktree, inherited loadout and private-preflight gate tests remain passing |
| Read-only review | Spec and safety reviews completed, followed by two narrow fix reviews; final reviewers found their reported issues addressed and no concrete introduced regression |

Full logs: `/tmp/pi-agent-mesh-m3-node22-final.log`, `/tmp/pi-agent-mesh-m3-node24-final.log`. Review snapshots: `/tmp/pi-agent-mesh-m3-review.uVzAbX`, `/tmp/pi-agent-mesh-m3-fix-review.210lSV`, `/tmp/pi-agent-mesh-m3-fix2-review.eQmZwl`. Reviewers did not edit files or run tests; the parent inspected changes and executed regressions. The adapter worker stopped on a provider limit; its partial implementation was not accepted without parent inspection/tests.

The readiness fixture uses shortened delays rather than making every suite wait 20–30 seconds: delayed discovery succeeds before the shared deadline, over-deadline initialize fails and stops with zero model calls. Parent gate tests separately assert role startup receives a greater-than-15-second RPC budget and the model prompt retains ordinary timeout semantics. An initial 2.6-second scaled success budget was too small under the full suite's concurrent startup load; its test-only budget was increased to 6 seconds. No production deadline was relaxed.

## Diagnosed regressions and fixes

- Actual Pi sourceInfo includes optional undefined fields that disappear through JSON snapshots. A raw-vs-serialized comparison rejected valid calls; both sides now compare the same JSON wire representation.
- Native structuredContent is present in execution results but not persisted in Pi's tool-result transcript. Tests verify the actual tool_execution_end result for structured data and use the transcript for model-facing content/error semantics rather than claiming the host stores omitted fields.
- Cancellation during initialize originally left a command preflight unresolved and could not prove RPC cleanup. The private cancellation command now aborts readiness, closes transports and allows normal receipt draining. A real RPC regression reproduced and then passed the stop condition.
- Remote output-schema-only changes originally escaped the historical ToolInfo comparison. A persisted remote-definition hash now catches them before another model prompt.
- Native HTTP404 renewal can reconnect and retry within one execute call. A real native-factory regression proved a changed-schema call was sent before the fix. Wire-level authorization now blocks it, while an unchanged-schema renewal is allowed exactly once. Both tests verify at least two initialize requests. The bundled CLI fixture's terminal-error case alone was not used as retry proof.
- Failed JSON-RPC refreshes, malformed numeric cursors/entries, and repeated pagination cursors originally restored stale authorization. Native-compatible page validation and an explicit complete-inventory flag now keep calls blocked after unsuccessful discovery, including when only an unselected entry is malformed.
- Repeated absolute `$id` schemas originally collided in Ajv's persistent cache; validators now disable implicit used-schema registration. Reordering unchanged selected tools does not count as drift.
- Invalid selected output schemas originally passed readiness. Validation now includes original remote output schemas, in their own resource scope. Compiling Pi's enclosing CallToolResult wrapper incorrectly rejected valid root-relative `$defs` references; a regression reproduced that and now passes while malformed schemas still fail.
- HTTP error bodies could include resolved authorization values in tool errors and task logs. The red/green HTTP403 regression proves redaction in both durable task records and transcripts without hiding status/classification. Ordinary MCP isError results, images and structured content remain native.
- Cancellation during the deferred registration-settled turn could still send an aborted HTTP retry. The deterministic regression scheduled abort at re-registration and observed one remote call before the fix; pending-send cancellation tracking now proves zero remote calls afterward.

## Packaged install / compatibility

A fresh temporary npm project installed the actual tarball, tsx 4.23.0 and the whole aligned Pi 1.0.2 family, as documented in M1. The installed package loaded all four packaged builtin role assets, executed selected stdio and HTTP MCP tools (including collision-safe mappings), preserved native rich results, saved per-run snapshots, tightened to read-only without losing its baseline, and closed owned resources. Passed under Node 22.23.3 and 24.22.0. Installed role-child/role-loadout/role-mcp/tasks SHA-256 matched checkout sources.

Reproduction artifacts: `/tmp/pi-agent-mesh-m3-install.oJejcs/{smoke-m3.ts,package-lock.json,pack-final.json}`. From that directory run `node --import tsx smoke-m3.ts`. Only copied deterministic test peers/providers accompany the installed tarball; no checkout dependency links or external services are used.

A second fresh project installed the tarball with the entire Pi 0.99.0 family. Its ordinary parent dispatch/read-only child read completed as v2. Installed roles.ts and role-mcp.ts were deliberately replaced with throwing sentinels: neither loaded on the non-role path, while the catalog returned its version requirement. Artifact: `/tmp/pi-agent-mesh-m3-legacy.lin7pX/smoke.ts`.

## Remaining scope and boundaries

M4: PM activation, persistent PM plan/snapshot and internal notification gates, public subagent role integration, step-level role/model/context/report inheritance and role UI. M5: final combined acceptance/demo/packaging matrix. This stage does not claim complete Role V1 or automatic PM orchestration.

Trusted extensions remain executable code, not a sandbox. Credentials supplied as literals are authored config; use environment references for secrets. Do not ask remote tools to echo secrets: transport/protocol exception redaction is not a general-purpose tool-output filter. Native request timeout can reset on progress and is not a total task time limit. Neither cancellation nor HTTP client close proves remote side-effect rollback. Hashes freeze declared files and definitions, not all referenced scripts/packages or remote implementation behavior.
