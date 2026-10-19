# Role V1 — M0 validation record

Scope: M0 only from `pi-agent-mesh-plan.md` (§7 and §10). This is not an implementation or completion claim for role V1. The new role/PM/MCP bridges in `test/fixtures/m0-*` are API probes, not runtime features.

## Baseline

- HEAD: `a16abfdda11751d7e518b2b910fd99860085a8d5` (package 4.0.1).
- Initial working tree: only the user's untracked `pi-agent-mesh-goals.md` and `pi-agent-mesh-plan.md`; no staged changes.
- `npm ci`: successful, 123 packages installed, audit reports zero vulnerabilities.
- Node 22.23.3 / npm 9.2.0; the three Pi packages resolve to 1.0.2.
- `npm run typecheck`: passed.
- `npm test`: 183 tests passed, zero failures/skips in this environment. The older environment-dependent failure/skips in the plan were not reproduced here.
- Validation ran against the M0 working-tree changes atop this baseline, before their commit. No peer dependency or legacy CLI change.

## Runtime fixes

### Confirmed terminal lock checkpoint

`TaskManager.open` now completes stale task-lock release while holding the owner lease, only when the persisted record is terminal, stopped, and has `execution.cleanup = confirmed`. Neither lock age nor `stopped` alone is accepted as proof. Existing output/state are preserved. Reopening is idempotent.

Regression coverage: completed/failed/cancelled checkpoints, unleased manager, missing/pending cleanup proof. Tests seed the precise durable crash checkpoint; they use a real kernel owner lease and an injected boundary controller, not a probabilistic process kill at the checkpoint.

### Recovery capacity

The recovery loop cleans old executions first. When capacity is unavailable, the task waits without consuming `recoveryRuns`. Once capacity exists, it durably reserves its one recovery attempt and enters the existing synchronous continuation reservation without exposing an intervening change callback. Budget reservation still precedes submission; crash-after-reservation retains the conservative no-replay rule.

Regression coverage: three interrupted tasks with `maxConcurrent=1` each get one recovery opportunity; repeated ticks do not duplicate submission; old RPC exit precedes slot reuse; waiting-task cancellation and shutdown fencing preserve unused budget. Existing systemd and owner-takeover tests remain applicable.

Spec review found a synchronous-subscriber reentrancy window: cleanup briefly cleared the waiting recovery guard before force-releasing the old lock. A subscriber could start a replacement whose fresh lock was then deleted. The new regression reproduced that exact missing-lock failure. Recovery now suppresses cleanup callbacks until old-lock release and waiting-state/continuation-slot reservation. Terminal/workflow listeners are still notified after lock release; result delivery checks that a subscriber has not changed the run. An initial suppression-only attempt failed the existing workflow-capture regression; restoring the deferred terminal announcement fixed that regression. The final focused affected gate passed 57/57, and the read-only spec re-review confirmed the finding resolved.

### Per-request RPC deadline

`RpcProcess.request(type, fields, { timeoutMs })` can use the remaining role-readiness deadline plus communication margin. Ordinary calls retain the existing 15-second default. Invalid Node timer values reject before submission; timeout still stops the child and retains unknown-acceptance cleanup semantics.

Red/green: the two new request-deadline tests failed against the original implementation and passed after the narrow API change. Recovery regressions were likewise run red before the fixes. Logs for this session are under `/tmp/pi-agent-mesh-m0-*` and `/tmp/m0-recovery-*`; repository tests, not temporary logs, are the reproducible evidence.

## Host API findings and chosen direction

### PM prompt, skills, and notifications

Evidence: `test/m0-pm-rpc.test.ts`, using the installed Pi CLI/RPC and a deterministic local provider that captures actual request prompt/tool declarations.

- Startup order is `session_start` → `resources_discover` → `before_agent_start` for an ordinary accepted input. Skills discovered after session start are available to the first request.
- `systemPromptOptions.sections` injects the role exactly once. Skills remain progressive: their description appears, not their full body.
- A PM-side tool can launch a real child with builtin bash even when bash is absent from the PM's own declaration. The child receives its own role text, not the PM role.
- CLI `--tools` is a hard registry filter. A filtered dynamic tool cannot be recovered with `setActiveTools`. Unknown future MCP names must not be guessed.
- The plan's role-only fallback is viable: omit the CLI list while discovery runs, prohibit model requests, then install an exact actual active set. A `tool_call` allowlist must also block indirect calls to registered codemode/deferred tools. The probe verifies direct and nested attempts have no side effect. The legacy inherited-loadout CLI branch is unchanged.
- **Actual Pi 1.0.2 differs from its documentation on internal custom turns:** `sendMessage(..., { triggerTurn: true })` bypasses both the input hook and `before_agent_start`; an initial custom turn also skips normal prompt-section preparation. Mutating base prompt options alone does not fix that path.
- Chosen PM direction: all task/workflow/recovery notifications pass through one owned readiness bridge. Queue during initializing; never trigger on failure. After ready, queue custom content with `deliverAs: nextTurn` and wake through `sendUserMessage`, which exercises normal input and prompt preparation. The probe checks the first actual provider request includes the role even when recovery result/question notifications arrive first. Production deduplication and session lifecycle integration remain M4 work.
- A thrown `before_agent_start` handler does not prevent an ordinary provider request. Slash-command handler throws are reported as extension errors but may still produce successful RPC receipts. Neither is an authorization/readiness gate.

### MCP

Evidence: `test/m0-mcp-rpc.test.ts`, with real stdio and Streamable HTTP fixtures.

- `createMcpExtension({ loadConfig })` accepts the public `LoadedMcpConfig` shape with server entries, errors, and `autoEnableCodemode: false`.
- A file wrapper registering `/mcp` replaces the builtin even without `--no-extensions`. With explicit project trust, ambient/project configurations (including same-name entries) do not connect. Filtering both `getMcpServers()` and `mcp_servers_change` excludes initial and late extension registrations.
- Native `/mcp` waits pending connections in RPC mode. An absolute deadline bounds that wait and subsequent inventory checks together; a successful receipt alone is not readiness.
- Selected raw tool names use direct exposure under a hidden server default. Actual native names resolve normalization collisions and 64-character truncation. Only the exact discovered selected names become active; codemode, tool_search, and resource tools are not activated.
- The actual `sourceInfo.source` is `cli` with the wrapper path, not `mcp`. The adapter must separately persist server/config identity and raw-to-actual mapping. The fixture uses captured native registration labels; production must verify that mapping against its fixed server definitions and reject drift.
- Scaled timing uses an ordinary RPC deadline of 1350ms, discovery at 1800ms, and a shared readiness deadline of 2700ms (15/20/30 seconds scaled equally). Explicit per-request timeout allows success beyond the ordinary deadline. A delayed 5000ms service fails against a 700ms absolute deadline; the communication margin does not extend readiness.
- Deadline, missing-tool, connection, and restrictive-CLI failures leave provider invocation count zero. Normal completion and failed-start shutdown remove stdio fixture PIDs. HTTP client closure does not stop the remote fixture server.

Chosen adapter: a lazily imported file wrapper around native MCP, injected role-only configuration, filtered registration inputs, no ambient discovery, bounded native `/mcp` wait, then actual inventory/source verification before the parent submits any task. Use the deferred role-only CLI strategy described above.

Limits: these fixtures honor stdin closure. Adversarial/pending stdio transport cleanup still needs execution-boundary verification. OAuth, malformed schemas, changing tool definitions, call cancellation/progress, and competing MCP plugins are not proven by these M0 probes and remain explicit M2–M4 tests.

## Final validation

| Gate | Result |
| --- | --- |
| Node 22.23.3 / Node 24.22.0 TypeScript typecheck | Passed on both |
| Node 22.23.3 `npm test` | 206/206 passed, no failures/skips |
| Node 24.22.0 `node --import tsx --test test/*.test.ts` | 206/206 passed, no failures/skips |
| Focused recovery/task/workflow/workspace gate after reentrancy fix | 57/57 passed |
| Dedicated real MCP probes | 6/6 passed |
| Read-only review | Standards: no actionable findings; Spec: one P2, reproduced, fixed, and re-reviewed as resolved |

The 23 added cases comprise nine recovery regressions, two RPC deadline cases, six PM/host probes, and six MCP probes. Full-suite logs: `/tmp/pi-agent-mesh-m0-final-node22.log` and `/tmp/pi-agent-mesh-m0-final-node24.log`. Node 24 was run through `npm exec --yes --package=node@24 -- node …`; project dependencies/lockfile were not changed.

## Reproduce

```bash
npm ci
npm run typecheck
node --import tsx --test test/rpc.test.ts test/task-recovery.test.ts
node --import tsx --test test/m0-pm-rpc.test.ts test/m0-mcp-rpc.test.ts
npm test
```

These tests do not use real model credentials or external MCP services. Environment-specific lifecycle tests use the existing capability checks, not blanket skipping of assertion failures.

## Not delivered by M0

No team/role YAML parser, built-in role packages, production role loadout/snapshots, PM activation, or workflow role fields. Those remain M1–M5. Fixture-side checks are feasibility evidence only; they must not be advertised as the production authorization or persistence implementation. The compatibility matrix for completed role functionality, schema drift, credentials, remote cancellation/progress, and packaged clean-install behavior remains future work.
