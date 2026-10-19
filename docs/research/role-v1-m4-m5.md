# Role V1 — M4/M5 completion evidence

## Baseline and scope

M3 was committed on user request as `329fa29` (`feat: add native role MCP execution and lifecycle guards`). Branch: `feat/role-v1-m0`. Earlier stages are `c92865b`, `ed88643`, `a6d059e`. M4/M5 changes remain uncommitted; no push was requested or performed. The original plan/goals remain untracked and unchanged.

Implemented PM activation and persisted recovery, public role dispatch, per-step workflow configuration/report policy, role UI, published examples and final regression/installation validation. No verdict engine, automatic repair loop, automatic source merge, role marketplace or connection pool was added.

## Acceptance audit (plan §13)

| Required outcome | Concrete evidence |
| --- | --- |
| Enabled configuration controls first PM conversation | `pm.ts` assembles before session startup completes; `role-pm-rpc.test.ts` checks the first actual provider prompt, exact management/builtin tools and durable `agent_mesh_pm` entry |
| Four published roles with real differences | `roles/*`; offline demo actually executes Builder write, Tester bash and Reviewer read, and asserts distinct tool and skill/prompt inventories |
| New roles require configuration/resources only | `examples/role-resources/local/`; public RPC dispatch of new ID `greeter` calls its selected `greet` implementation and returns `Hello, Ada!` |
| Worker capabilities independent of PM | PM has no bash/write; public Builder executes bash; offline demo Builder writes a file |
| Skills/local tools/both MCP transports integrated | Existing M2/M3 real child tests retained; new PM RPC test executes selected local/HTTP tools with actual provenance; earlier stdio/HTTP suites remain green |
| Exact direct/nested authorization and no ambient supplementation | Existing child/native adapter tests plus PM router test with default builtin discovery enabled and a trap project mcp.json; trap never connects, selected tools execute |
| Failed readiness/resources cause zero model calls | PM invalid config, explicit missing path, restrictive CLI tools and untrusted executable tests; existing child missing tools/schema/deadline tests; PM stalled/late factory tests |
| Durable PM/worker plans, restoration and notification gate | PM manifest deletion + invalid current catalog restores saved body and allows existing task management, but rejects new role dispatch; actual cleanup result and recovering worker question arrive during delayed PM initialize with zero PM requests; failed initialize never flushes them |
| Complete inputs, access transitions, historical definitions | Existing v3 store/recovery/continuation suites remain passing; workflow fresh read-only retries retain original role authorization |
| Cancellation/cleanup boundaries and no new orphan services | PM HTTP client closes without killing remote service; loader cancellation invalidates isolated runtime/removes private shim; existing MCP cancellation/shutdown and process/worktree recovery suites pass |
| Mixed-context role DAG | `role-workflows.test.ts` and public RPC/demo use Builder partial and Reviewer none/omit; upstream code still merges in isolated worktrees while report/session text is omitted |
| Legacy behavior/history/worktrees/recovery | Full suites include original v1/v2/inheritance/workflow tests; packed install on aligned Pi 0.99.0 completes real no-role dispatch/read with throwing new-parser/MCP sentinels untouched |
| Consistent docs/schema/examples and independent package | README startup/default precedence/recovery/trust/limits, schemas, hidden team YAML and role resources published; clean dependency install executes packaged offline demo on both Nodes |

## Implementation seams

- `pm.ts`: `off/initializing/ready/failed`, saved PM plan/actual tools/runtime-management definitions, exact active list, own skills and stable prompt sections, shared readiness/cancellation and queued mesh notifications. Runtime mesh wakeups use non-triggering nextTurn custom messages and a serialized user follow-up so they traverse input/preparation; native custom triggerTurn is not used for ready PM notifications.
- The PM MCP router reserves /mcp during extension load, replacing the host's replaceable builtin. Ordinary sessions delegate to native MCP and retain builtin disable behavior. PM sessions install only their controlled adapter; dynamic startup handlers are explicitly replayed because native event dispatch snapshots registrations.
- `role-dispatch.ts`: shared standalone/workflow role resolution. Standalone call > role > current parent; workflow step > role non-inherit default > workflow > parent. Context preserves absence until resolution; partial text is mandatory. Only provider settings, not parent tools, are inherited. Native thinking clamping uses the selected model.
- Public tools keep non-role access mandatory at runtime. Role receipts show task ID, role ID/config digest and effective access/model/context. No source additions or role replacement are accepted on continuation.
- `workflows.ts`: legacy v1 retained; v2 freezes each effective configuration/RolePlan and only full steps' parent snapshots. Updates resolve explicitly changed/new pending steps; dispatch rebinds only cwd. Report omission does not remove Git dependency edges. Retry/access/worktree/retention rules are preserved.
- UI/dashboard render only persisted state: role/config, available vs effective capabilities, preflight/submission phase, model/context/access, actual tool sources and prior-run inventories. Deleted resources do not break history display.

## Review and diagnosed failures

Two independent read-only subagents reviewed an immutable full source/diff snapshot: spec (`ea91a547-5ab7-4ed9-b3e7-6323700c0201`) and standards/safety (`120565d8-eb36-4b9a-ab1f-2fd4e1593235`). They made no edits and did not run tests. Parent inspected findings, reproduced and fixed them, then supplied immutable fix snapshots for narrow rereviews. Both final rereviews reported no concrete introduced findings.

Review snapshots: `/tmp/pi-agent-mesh-m45-review.qZZB1o`, `/tmp/pi-agent-mesh-m45-fix-review.TZ1xHR`, `/tmp/pi-agent-mesh-m45-fix2-review.NPXRgk`. A final examples/docs/test-delta check used `/tmp/pi-agent-mesh-m45-final-review.UMu3Xv`; both reviewers reported no concrete findings. These were static reviews, not independent test executions.

Red→green cases:

1. Catalog state survived repeated session_start and returned old role bytes. A catalog-boundary test reproduced ORIGINAL_BODY instead of CHANGED_BODY; initialization now resets the directory cache while preserving process-start path selection. Saved PM restoration remains independent.
2. Role receipt lacked effective settings. A public RPC assertion failed, then passed after role/config/access/model/context were included. Non-role receipt content is unchanged.
3. An unresolved local factory hung initialization; a late factory registered into the host after shutdown. Scaled PM-boundary tests use the actual Pi local loader. Abortable waits now unwind its finally blocks, invalidate the isolated runtime and remove temporary shims. PM applies the remaining deadline before host registration; late results cannot register.
4. Timing out native model selection did not drain its noncancellable authentication operation before shutdown. A delayed host-boundary regression demonstrated premature shutdown acknowledgment. PM now fails readiness on time but drains outstanding model selection before acknowledging replacement. This safety tradeoff is documented below.
5. Parent inspection found a reasoning-PM/high → nonreasoning-worker override failed preflight because high was saved unchanged. Real RPC reproduced zero child requests and a thinking mismatch; resolution now uses native model-specific thinking clamping.
6. The offline demo exposed concurrent notification wakeups racing native prompt preparation. PM serializes wakeups until agent_settled and the host's subsequent cleanup turn. Demo keeps its strict zero-extension-errors assertion.
7. A full-suite MCP cancellation regression exposed that inventory refresh's immediate callback can run before native renewal resumes. Outbound calls now always observe a registration/cancellation turn and then recheck cancellation/connection/inventory before submission; existing changed/unchanged renewal proofs remain intact.
8. Node 24 exposed an old recovery test observing prompt submission before its receipt was accepted, then sending supplementary instructions too early. Test now waits for persisted public acceptance before messaging; no production recovery guard was relaxed. Both full suites subsequently passed.

## Final gates

| Command / environment | Result |
| --- | --- |
| Node 22.23.3 `npm run typecheck && npm test` | **399/399 passed**, zero skipped; `/tmp/role-v1-m45-node22-final.log` |
| Node 24.22.0, same commands with Node 24 on PATH | **399/399 passed**, zero skipped; `/tmp/role-v1-m45-node24-final.log` |
| `node --import tsx examples/role-v1-demo/run.ts` | Real offline public PM/Builder/Tester/Reviewer and mixed role DAG passed; also part of full suites |
| `node --import tsx examples/role-resources/validate.ts` | All three opt-in local/stdio/HTTP authored teams parsed through production RoleCatalog; no connections/readiness claimed |
| npm tarball, clean temporary project, entire Pi family 1.0.2 + tsx 4.23.0 | Packaged offline demo passed under Node 22 and 24; packaged optional configurations parsed |
| Same tarball, aligned Pi 0.99.0 | Ordinary dispatch/read completed as v2; new parser/native-MCP throwing sentinels not imported; catalog rejected old host clearly |
| `git diff --check`, pack asset audit, plan/goals hashes | Passed; original user files unchanged |

Clean install artifacts: `/tmp/pi-agent-mesh-m45-install.ENDcnQ/{pack-final.json,package-lock.json,install.log,reinstall-final.log}`. This installation used real installed dependencies, not symlinks to the checkout. From that directory: `node --import tsx node_modules/pi-agent-mesh/examples/role-v1-demo/run.ts`. Legacy proof: `/tmp/pi-agent-mesh-m3-legacy.lin7pX/smoke.ts` and its `reinstall-m45-final.log` (the reused harness prints its original M3 label, but installs the final M4/M5 tarball). After restoring actual parser/MCP sources, `smoke-disabled.ts` separately passed ordinary dispatch/read with disabled team configuration on Pi 0.99.0 under both Node 22 and 24.

Optional filesystem/HTTP example endpoints were not connected. Their prerequisites/contracts are explicitly illustrative, unlike deterministic MCP peers in integration tests. No real-model quota/authentication trial was performed; scripted providers prove plumbing, not model reasoning. These are explicit non-gates, not skipped automated acceptance tests.

## Startup and remaining boundaries

Copy `examples/team/.pi/agent-mesh.yaml` to the project's `.pi/agent-mesh.yaml`, then start a new persistent `pi` session with this extension and an authenticated model. Default team resources need no external service. For a no-quota demonstration run the packaged offline example above.

Native authentication/model selection is not cancellable. A deadline reports PM failure on time, but an indefinitely stalled auth provider can hold session replacement until that operation settles; this prevents detached late writes. Fix the provider or restart Pi rather than bypassing the gate.

Trusted JS is not sandboxed: arbitrary top-level side effects or CPU-blocking factories cannot be undone by Promise cancellation. Hashes do not freeze transitive dependencies or remote implementations. Access filtering is not OS confinement; HTTP client close/cancellation is not remote rollback. Completion is not acceptance. Version compatibility beyond the tested aligned Pi baselines is not claimed as exhaustive validation.
