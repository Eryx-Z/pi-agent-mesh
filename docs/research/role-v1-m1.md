# Role V1 — M1 validation record

Scope: M1 (configuration, passive catalog, builtin role assets), on top of M0 commit `c92865b`. No M2–M5 execution or PM-activation claim. The user's untracked plan/goals files remain untouched. No commit is created by this stage unless requested.

## Delivered boundaries

- `roles.ts`: explicit team/role parsing; canonical document-relative paths; immutable in-memory catalog; atomic reload retaining the last valid directory on failure. Initial missing explicit configuration is a diagnostic, not an empty successful directory. Default discovery never searches ancestors.
- `schemas/{team-config-v1,role-manifest-v1}.schema.json`: draft-7 structural validation used directly by production AJV, and shipped for editors. Builtin capability lists are required explicitly, even if empty. YAML duplicate keys, custom tags, implicit merge/deep overrides, multiple documents, invalid UTF-8, unknown fields, role-ID mismatch, duplicate skill/tool names, and missing files are rejected.
- Pi's public skill loader reads exactly selected `SKILL.md` paths with defaults disabled. Skill metadata, hashes, original loader path, canonical identity, and `disableModelInvocation` are preserved; no neighbor discovery occurs.
- Static stdio/HTTP declarations preserve unresolved environment references; missing variables and unsupported credential commands are diagnosed without printing values. Explicit stdio cwd resolves against the team config; omitted cwd remains absent for future worktree binding. Native MCP server-name collisions are caught. Neither MCP nor extra-tool modules execute during catalog operations.
- `resolveRoleDefaults`: standalone dispatch precedence/validation only. Manifest omission of model/context stays distinguishable until resolution; effective partial requires explicit nonempty contextText. Non-partial rejects contextText. This helper is not connected to dispatch yet.
- `roles-ui.ts` and parent `index.ts`: `/roles`, `/roles inspect <id>`, `/roles reload`, and parent-only `roles_list`. Startup cwd/environment selection is captured before lazy first query; the parser is not loaded during ordinary legacy startup. Errors remain visible after failed reload. No credentials/server connection details or full role body are included in catalog output.
- `roles_list` is excluded by the existing delegation filter and is not registered by child entry paths.
- `roles/{pm,builder,tester,reviewer}`: distinct manifests, prompts, skills, and tools. PM is read-only, Builder has editing/shell, Tester has shell verification, Reviewer defaults to none/read-only. Prompts do not grant capabilities or enable automatic verdict/repair/merge orchestration.
- `examples/team/.pi/agent-mesh.yaml`: minimal four-builtin configuration, no external services.
- Published files now include `roles/`, `schemas/`, and `examples/`. Exact direct dependencies: `yaml@2.9.1` and `ajv@8.20.0`. npm also reconciled the lockfile's stale root package name; the three pinned Pi packages remain 1.0.2.

## Evidence

- Parser/unit tests: `test/roles.test.ts`, `test/roles-ui.test.ts`.
- Builtins resolved from a temporary cwd using only a copied example config: `test/builtin-roles.test.ts`.
- Real Pi CLI/RPC: `test/roles-rpc.test.ts`. List/inspect/reload have zero model requests; deliberately executable MCP/local-tool traps remain unexecuted. A changed manifest is invisible until reload; invalid reload keeps the previous directory. The real model-facing `roles_list` call uses the local scripted provider only.
- Existing child-loadout tests verify the added management-tool filter.
- Test-first evidence: initial real RPC test failed because `/roles` was absent. Additional required-builtin/contextText regressions failed before the narrow fixes. Focused parser/builtin/UI/RPC/loadout run: 34/34 passed, with typecheck passing.
- `npm pack --dry-run --json` lists all 12 builtin manifest/prompt/skill files, both schemas, and the hidden `.pi` example config.

## Final gates

| Gate | Result |
| --- | --- |
| Node 22.23.3 `npm run typecheck` + `npm test` | **230/230 passed** |
| Node 24.22.0 `npm run typecheck` + `npm test` | **230/230 passed** |
| Aligned Pi 1.0.2 clean tarball installation | Production parser loads both schemas and all four role packages; real installed Pi RPC list/inspect/reload pass, with zero conversation/model turns |
| Aligned Pi 0.99.0 clean tarball installation | Legacy parent dispatch and read-only child builtin read complete; roles_list is excluded from inheritance; catalog reports the version requirement |
| Parser isolation on legacy host | Installed roles.ts deliberately replaced with a throwing sentinel; legacy startup/dispatch and the catalog version guard still pass without loading it |
| Two-axis read-only review | Standards and M1 spec reviews completed; shared YAML coercion finding fixed and both narrow re-reviews confirm it resolved |

One Node 24 run concurrent with a complete Node 22 suite hit an existing 4-second fake-task polling timeout in `test/tasks.test.ts`. The affected file passed 16/16 independently; the subsequent complete Node 24 run passed 230/230. No production timeout or unrelated test timing was changed. The existing child-registration fixture was updated for the added parent roles_list tool and now locates the legacy subagent schema by tool name.

Review found that YAML `true` and quoted `"true"` keys are distinct during YAML duplicate checking but collide during JavaScript-object conversion. A new regression first reproduced the silent overwrite. Production now rejects non-string mapping keys at the YAML AST layer before conversion. Regression covers role IDs, MCP server IDs, env keys, and valid quoted string IDs. This prevents coercion-based silent overrides without exposing source values in diagnostics.

Review evidence: initial immutable snapshot `/tmp/pi-agent-mesh-m1-review.M9BeQQ`; narrow fix snapshot `/tmp/pi-agent-mesh-m1-fix-review.wVQdPe`. Reviewers made no edits. Final full-suite logs: `/tmp/pi-agent-mesh-m1-node22-final.log` and `/tmp/pi-agent-mesh-m1-node24-final.log`.

### Packaged-install procedure and host caveat

A fresh temporary npm project installed the actual `npm pack` tarball, tsx 4.23.0, and the Pi dependency family at matching versions. The smoke harness copied the **packaged** hidden example into a separate project, loaded production RoleCatalog from the installed package, and ran the installed Pi CLI, with no source-checkout imports or dependency symlinks. Parser source SHA-256 matched the checkout. Reproduction artifacts: `/tmp/pi-agent-mesh-m1-install.JkIoBI/{smoke.ts,pack-final.json,package-lock.json}` and `/tmp/pi-agent-mesh-m1-legacy.64cCrF/{smoke.ts,package-lock.json}`. Run `node --import tsx smoke.ts` from the corresponding directory.

For these fresh fixtures, the installed family was:

```bash
npm install --ignore-scripts --no-audit --no-fund ./pi-agent-mesh-4.0.1.tgz tsx@4.23.0 \
  @earendil-works/{pi-ai,pi-coding-agent,pi-tui,pi-agent-core,pi-codemode,pi-mcp,chord}@1.0.2
# The legacy fixture uses @0.99.0 for the same family instead.
```

Pinning only pi-coding-agent/pi-ai/pi-tui to 1.0.2 in a fresh install resolved 1.3.0 pi-agent-core/pi-codemode/pi-mcp through the host's caret dependencies. Importing that host failed with missing `MCP_TYPESCRIPT_PREAMBLE` before extension initialization. Aligning the whole family to 1.0.2 resolved it, and the packaged smoke then passed. This is an observed upstream dependency-skew limitation, not an extension parser failure; it is disclosed in README rather than hidden by changing the extension's legacy peer requirements.

## Try the catalog

With this checkout installed/loaded as the Pi extension, copy `examples/team/.pi/agent-mesh.yaml` to your project's `.pi/agent-mesh.yaml`, then run:

```text
/roles
/roles inspect builder
/roles reload
```

Requires aligned Pi 1.0.2 packages for this tested catalog path. The ordinary non-role APIs keep their existing behavior. A configured enabled team is **only a catalog preview in M1**: it does not activate PM, grant role tools, accept `subagent(role=...)`, or connect role MCP. The host's separate ambient MCP configuration is not replaced by catalog inspection.

## Remaining scope

M2: executable-tool contract, precise role loadout, preflight, persisted RolePlan/RoleSnapshot, continuation and drift checks. M3: native MCP role execution and lifecycle. M4: PM startup/recovery/notification gate, role dispatch, DAG fields, and runtime display. M5: complete compatibility and clean-install role-execution/end-to-end acceptance. Static catalog success must never be advertised as an operational readiness result.
