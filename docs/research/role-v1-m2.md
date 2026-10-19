# Role V1 — M2 validation record

## Scope and baseline

Baseline: M1 commit `ed88643` on `feat/role-v1-m0`, package 4.0.1. M2 changes are not committed or pushed. The original untracked plan/goals files remain unchanged.

M2 implements the **internal** role execution and persistence branch. It does not activate PM, expose `subagent(role=...)`, alter public workflow inputs, or connect role MCP. Those remain M3/M4. The M1 catalog remains passive. Ordinary no-role dispatch retains its v2 inherited-loadout path and CLI allowlist.

## Implementation

- `role-loadout.ts`: serializable RolePlan, effective access, original-resource hashes, actual RoleSnapshot, private run binding, v3 display projection, cumulative verified-definition comparison. Role capabilities do not intersect parent active tools. Embedded role body remains authoritative; manifest/prompt deletion or edits do not silently replace it. Runtime skill and enabled local-entry hashes are checked before execution. Structural historical validation does not read deleted resources.
- `role-tools.ts`: exact entry/tool selection through a guarded tool-only factory adapter and isolated, never-bound Pi loader. Only selected definitions reach the actual child registry, forced direct; captured factory APIs close after loading. Hooks, commands, flags, providers, MCP registration, event subscriptions, pi.exec, duplicate/reserved names, returned resources, and late registration are rejected. Tools receive live context only through execute. Imported JavaScript is trusted, not sandboxed; arbitrary Node imports and referenced packages/scripts are not content-pinned.
- `role-child.ts`: role-only child entry, exact progressive skills, shared protected ask_question implementation, empty active tools/input handling before preflight, selected direct tools afterward, per-call schema/provenance/source checks and nested-call guards. The reserved bridge is sequential/model-only and separately recorded. Full MCP declarations fail before local-resource loading in M2; read-only excludes local/MCP resources entirely. Role execution explicitly requires Pi >=1.0.2, 1.x.
- `tasks.ts`: internal NewTask discriminates inherited loadout versus RolePlan. Startup preserves existing synchronous reservations, lock, execution boundary and RPC lifecycle. Role child discovery omits CLI --tools only on the role branch; child preflight then freezes the exact active inventory and call guard. Legacy launches retain their CLI filter. A private result must match taskId/run/attemptId/nonce/plan digest; slash-command acknowledgement alone never proves preflight success. Snapshot and cumulative baseline are saved atomically before durable submitting state and the first real prompt.
- `store.ts`: v1/v2 history is not guessed into a role or rewritten en masse. V3 records preserve TaskInput, available RolePlan, each RoleRun's phase/snapshot/outcome/cleanup, and verified definitions. Validation compares derived current loadout and cumulative baseline to the saved history. Role continuation uses the saved plan, not the catalog. Tightening access never erases previously verified definitions; a failed upgrade never replaces an earlier snapshot/baseline.
- `child.ts`: narrow extraction of the existing question-tool registrar, reused by both bridges; inherited provenance remains child.ts. `diagnostics.ts` accepts only the model/config fields it actually needs, supporting either projection without casting v3 to inherited authorization.

### Pi loader compatibility seam

Installed Pi 1.0.2 does not export loadExtensions at its package root; the role adapter loads its installed `dist/core/extensions/index.js`. The stock independent loader API still exposes pi.exec outside its runtime, and hooks registered then removed are invisible to collection inspection. Therefore M2 uses the spec's narrow adapter fallback: a temporary private shim invokes the original entry's factory through a proxy exposing only registerTool. It still uses Pi's actual loader for module handling. Temporary shim directories are private and removed; the isolated runtime is invalidated. Actual wrapper provenance and original canonical entry/hash are both recorded. This seam is covered by real Pi RPC and installed-tarball tests; it is not claimed as a stable root export or a code sandbox.

## Tests and review

| Gate | Evidence/result |
| --- | --- |
| Node 22.23.3 typecheck/full regression | `npm run typecheck && npm test`: **300/300 passed**, zero skipped |
| Node 24.22.0 typecheck/full regression | Same commands with Node 24 on PATH: **300/300 passed**, zero skipped |
| Plan and local-loader tests | `test/role-loadout.test.ts`, `test/role-tools.test.ts`: resource/identity/hash checks, baseline retention/drift, registration contract and exact selection |
| Child bridge tests | `test/role-child.test.ts`: static failures, skill/source checks, version guard; real Pi direct/nested allow/deny, unselected custom definitions never registered, zero model calls before preflight |
| Real task lifecycle | `test/role-tasks-rpc.test.ts`: saved body after manifest deletion, readonly/full/readonly/full, progressive visible/hidden skill isolation, local first enable, source drift, failed preflight, complete partial input |
| Parent private-result gates | `test/role-task-gates.test.ts`: absent/error/stale task/run/attempt/nonce/plan results rejected, snapshot+baseline durable before prompt, no partial baseline update, reentrant cancellation, unknown shutdown retains lock |
| Real plan-only recovery | `test/role-recovery.test.ts`: partial/full input; planned and verified checkpoints; missing original seed; submitting/submitted ambiguity; original selected context retained; no automatic access upgrade |
| Read-only review | Spec and safety reviews of immutable source; four concrete recovery findings fixed; both narrow re-reviews confirmed fixes with no further concrete regression |

Logs: `/tmp/pi-agent-mesh-m2-node22-final.log`, `/tmp/pi-agent-mesh-m2-node24-final.log`. Initial review snapshot: `/tmp/pi-agent-mesh-m2-review.O68nDq`; fix snapshot: `/tmp/pi-agent-mesh-m2-fix-review.xsNnVJ`. Review agents made no edits. Implementation workers hit provider limits; their partial files were inspected and validated by the parent, not accepted solely from worker claims.

### Review findings and regression fixes

1. **Initial preflight failure + manual retry lost saved original input.** Never-submitted retries now compose saved task/context and the explicit continuation instruction. The regression failed before the fix and passes afterward.
2. **Submission-ambiguous recovery lost saved partial context.** Conservative recovery now includes original selected context while retaining warnings to inspect existing side effects instead of blindly replaying the task. Tests cover retained seeds in submitting/submitted checkpoints.
3. **A later planned run could recreate a missing transcript despite earlier submitted work.** Missing-transcript validation now checks the entire run history. Any possible prior submission prevents reconstruction. The prior-submitted/later-planned regression failed before the fix.
4. **Pre-start recovery validation failure could strand a cleaned task with consumed budget.** Such exhausted recovery is now explicitly blocked with the original error, not left cleaning with no scheduled work. The submitting/missing-transcript regression timed out before the fix; it now reaches blocked with no replacement model prompt.

Before any run may have submitted work, saved TaskInput can recreate the original seed. After possible submission, missing history is a hard error. This distinction applies across all runs, not just the most recent run. Existing cleanup/capacity/one-recovery-budget regressions continue to pass.

## Packaging and compatibility

`npm pack` includes the three new role runtime modules plus existing builtin manifests/prompts/skills, schemas and hidden example. The actual tarball was installed into a temporary project with the **whole aligned Pi 1.0.2 family** (including agent-core/codemode/mcp/chord, as documented in M1). The installed internal engine used a packaged builtin Builder skill/prompt, selected a local tool through the isolated adapter, executed it through real Pi RPC and a scripted provider, then persisted a submitted v3 run snapshot and confirmed stop. Passed on Node 22.23.3 and 24.22.0. Reproduction: `/tmp/pi-agent-mesh-m1-install.JkIoBI/smoke-m2.ts`, run via `node --import tsx smoke-m2.ts` in that directory. No checkout dependency links were used.

Aligned Pi 0.99.0 fresh-workspace installed-tarball smoke passed ordinary parent dispatch and read-only child builtin execution. It deliberately replaces the installed M1 parser with a throwing sentinel: old startup/dispatch never imports it, catalog query reports its version requirement, and roles_list is not inherited. Artifact: `/tmp/pi-agent-mesh-m1-legacy.64cCrF/{smoke.ts,smoke-m2.log}`. The temporary smoke now uses a unique project per run: reusing the old M1 smoke's existing session first failed and its finally cleanup obscured the earlier error; that reused-state attempt is not counted as clean-install evidence. No compatibility production code was changed to suppress the failure.

## How to exercise M2

For the current internal seam, construct a RoleCatalog, call createRolePlan with explicit resolved model/thinking/context/access/cwd/config directory (and trusted provider-only sources if needed), then call `TaskManager.launch({ task, context, access, rolePlan, contextText?, snapshot?, parentSession? })`. Partial requires explicit nonempty contextText; full requires an explicit frozen parent snapshot. Do not supply a rolePlan and inherited loadout together. Follow the fixture in `test/role-tasks-rpc.test.ts` for an executable no-network example.

This is internal integration/test usage, not a new model-facing API. Public role dispatch, PM readiness/recovery and DAG role/context fields remain M4. Native stdio/HTTP MCP execution, credentials/readiness/name mapping/cancellation remain M3. No role V1 end-to-end completion or remote-service readiness is claimed.
