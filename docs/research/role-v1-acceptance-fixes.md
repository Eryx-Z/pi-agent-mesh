# Role V1 acceptance fixes

This repair follows the independent full-branch review of `87f150a`. It fixes the six reproduced findings; it is not a claim that passing the previous 399 tests established full acceptance. The original untracked plan/goals remain unchanged. No commit or push is included in this repair.

## Findings and regression proof

| Finding | Repair | Proof |
| --- | --- | --- |
| P1: read-only continuation can import/connect project resources without host trust | A live, nonpersisted `TaskManager.isProjectTrusted` callback is required before enabled local/MCP resources execute. Check initial launch, continuation before mutation, shared start, and immediately before spawn after reentrant persistence listeners. The same boundary covers workflow retry/recovery and PM-derived inherited resources. | `test/role-trust.test.ts`: 37 cases, including local/stdio/HTTP, missing/false/throwing trust, revoked grants, upgrades, retry/recovery, no child creation on denial, preserved history and builtin/read-only controls. Original actual-Pi `--no-approve` probe now rejects upgrade and never imports the marker entry. |
| P1: stalled PM authentication delays worker shutdown | Start PM drain and workflow/task cleanup independently, and await both even on failure. Do not acknowledge replacement while native authentication can still commit late state. | `test/role-lifecycle.test.ts`: real held RPC child stops before simulated native auth resolves; session replacement still waits. Original lifecycle probe now reports `workerStillLive:false`, `taskStopped:true`, `shutdownAcknowledged:false` while auth is pending. |
| P2: failed reload prevents use of retained valid directory | Reject only if there is no valid enabled catalog. Keep reload diagnostics without revoking the prior directory. | `test/role-pm-rpc.test.ts`: same reviewer dispatch completes before and after a failed reload. Original RPC probe passes. |
| P2: no-role/full cannot reconstruct PM-assembled tools | Preserve a frozen PM implementation mapping in the v2 inherited loadout, not a new worker role. The index wrapper lazily reconstructs selected local/native MCP tools at the same source path; ordinary child preflight still verifies the inherited wire inventory and skills. Read-only drops the bridge before loading; original available authorization remains for a later trusted upgrade. | Real public Pi RPC executes inherited local and stdio/HTTP tools, excludes ambient/extra resources, preserves worker model/context, and never imports/connects executable resources for read-only. |
| P2: competing native MCP extension can connect while PM reports ready | Reject another public native `/mcp` owner before PM model/resource activation. Check ownership again during PM verification. | `test/role-pm-acceptance.test.ts`: native factory in both load orders yields a diagnostic, no PM ready state, no PM-local import/model selection and no provider requests; ordinary non-role native MCP remains supported. |
| P2: fresh startup custom failure entry is not durable | Keep the native session file host-owned. Publish an immutable 0600 sibling failure record using no-clobber link, file/directory fsync, and an announced path; retain the custom entry too. Report storage failure explicitly without replacing the original error. | Real RPC checks failure survives without a conversation/session file; a later native first flush succeeds; existing files/symlinks/modes remain unchanged; repeated failures are independent; unwritable storage reports non-durability without a model request. |

## Independent review corrections

The read-only repair review identified three additional cases in the new bridge. Each received RED/GREEN runtime proof rather than a review-only dismissal:

- **Source metadata:** User/global settings or packages can retain original metadata despite CLI reconstruction. Project settings/package metadata can legitimately become CLI/temporary under child `--no-approve`. Validate the original parent snapshot, allow only that exact project-to-CLI transition for the same pinned wrapper at initial verification, then freeze the observed child provenance. Eight real RPC cases cover user/project settings/packages with local/HTTP tools.
- **Working directory:** Bind implicit stdio cwd to the actual task/isolated worktree; preserve explicit authored cwd. Recompute only the derived config identity from frozen configuration and actual cwd, retaining remote definition/source/schema authorization. Four real RPC cases cover standalone/isolated and implicit/explicit cwd.
- **Direct local owner:** Refuse an independently loaded entry owning a PM-selected local name before PM model/resource activation. Do not fall back to generic inheritance without the structured trust/hash mapping. Both extension load orders are tested.

Reviewer `cc743093-bb4e-48b3-9350-76d65bc0b0a9` inspected final production code, tests, installed Pi contracts and RED/GREEN artifacts, reporting no remaining actionable findings. The reviewer ran no commands/tests and changed no files. Parent validation is separate.

## Validation

- Node 22.23.3: typecheck and **461/461 tests**, zero skipped.
- Node 24.22.0: typecheck and **461/461 tests**, zero skipped.
- Final suite logs: `/tmp/pi-agent-mesh-role-fix-validation-87f150a/node22.log` and `node24.log`.
- Original trust/reload/shutdown reproductions rerun successfully: same directory, `probe-{trust,reload,shutdown}.log`.
- RED/GREEN evidence: `/tmp/role-fix-{reload,shutdown,inherit-local,inherit-mcp,inherit-provenance,inherit-cwd,local-owner}-{red,green}.log`; trust worker evidence under `/tmp/pi-agent-mesh-role-trust.RP8umM/`; inherited trust RED under `/tmp/role-fix-inherit-trust-valid-red.log` and final GREEN covered by the complete suite.
- Initial parallel-suite runs exposed two fixture issues: 100–120ms MCP request timeouts were also timing out initialize/list under CPU load, and recursive inspection raced a disappearing native settings lock directory. Timing tests now allow a 1s native request budget while sustaining twelve 100ms progress updates to prove timeout reset; the hanging-call timeout/no-replay assertion remains. Record inspection ignores only transient ENOENT. No production MCP deadline or cancellation semantics were weakened.
- Fresh packaged validation: `/tmp/pi-mesh-final-security-package-VLsnZQUy/`. The final tarball has 57 regular files and SHA256 `1521fa5b184287e1044bb1fba27ae433ea5ec679c01c5061eb4d32b6388a15c1`; all published/installed bytes match the repaired working tree, including the new helper, final PM ownership guard and README.
- New clean installs align all eight Pi family packages to 1.0.2 (modern) or 0.99.0 (legacy). Installed demos/static examples pass on Node 22/24; real inherited local/stdio/HTTP smokes, cwd handling and both local-owner rejection orders pass. Legacy throwing-sentinel and disabled-config dispatch/read smokes pass with installed originals restored. Example parsing is passive, not external service readiness.
- Parent inspected the validator's scripts, logs, exit codes, lockfiles and persisted records, then reran final source/installed-byte/dependency/process audits: `/tmp/pi-agent-mesh-role-fix-validation-87f150a/package-parent-audit.log`. Across all four owned package candidates, 72 completed/stopped tasks, eight completed workflows, 22 recorded parent closes, 109 recorded PIDs gone and 72 inactive/removed scopes; zero live owned processes. Final-candidate-only coverage is 20 tasks, two workflows and eight recorded parent closes; earlier candidates are not substituted for final-package proof.
- All six reviewed findings are repaired and pass their focused/complete/package gates within the explicit limits below. No repository dependencies changed; original specifications and HEAD/remote tracking reference remain at their prior values. Repairs are left uncommitted and unpushed.

## Intentional limits

Ordinary v2 no-role startup retains the legacy 15-second RPC readiness budget, including cold local/MCP loading. Explicit role execution retains its 30-second readiness/preflight cancellation protocol. Process/scope cleanup remains authoritative if ordinary startup terminates before native close hooks install; remote side effects/server sessions are not rolled back.

Conflicting extension rejection cannot undo another trusted extension's imports or connections. JavaScript is not sandboxed. Authentication is not a diagnosed defect in user credentials; native model selection remains noncancellable, so replacement acknowledgement can wait while independent worker cleanup proceeds.

Failure sidecars are independent inspectable records, not fabricated conversation messages or mutations of native Pi JSONL. They cannot be guaranteed durable when the filesystem rejects writes; that case is reported explicitly.
