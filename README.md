# pi-agent-mesh — context-based RPC

Lightweight parallel subagents for Pi, without tmux. Each task runs in a background Pi RPC process with its own conversation. Standalone tasks use the shared working directory unless an explicit `cwd` is supplied. Workflows can opt into isolated Git worktrees. The parent session displays progress, receives results and questions, and controls children.

This is the **4.0.0 breaking redesign** of the earlier tmux implementation. Requires aligned `@earendil-works` Pi packages **>=0.99.0 <2**, Node **22+**; development dependencies are pinned to **1.0.2**. Typechecking and real RPC integration tests cover 0.99.0 and 1.0.2. The earlier **0.84.2–0.85.x** compatibility claim was incorrect for the current implementation: those hosts lack inherited tool exposure/namespace/annotations, transcript system-message support and nested `ctx.executeTool()` APIs. Upgrade Pi to use this version; older hosts and `@mariozechner` Pi versions are not supported.

## Model of operation

- One task → one child process → one persistent session.
- Non-role tasks require `access: "read-only" | "full"`; role tasks may use their manifest's access default. Scope and coordination instructions belong in task text, not an `ownership` field.
- Access filters tools; it is **not a filesystem sandbox or lock**. Shared ports, databases, build outputs and edits can still conflict. The parent validates the combined result.
- Children do not receive delegation tools. Only the parent launches subagents.
- Optional persistent JSON DAG workflows reuse the same children. Isolated mode supports parallel writable worktrees and validated integration into a separate result worktree. No automatic application to the user checkout, automatic retries, loops, condition-expression language, alternative CLI backends, or background daemon.

## Three context modes

Context controls information inheritance independently of tool access, for both inherited and role-based tasks:

| Mode | Inherited parent conversation |
| --- | --- |
| `none` | None. Task, access and cooperation guidance only; workflow dependency reports are separately controlled. |
| `partial` (default) | Explicit `contextText` selected/written by the parent. Required; use `none` for an independent task. |
| `full` | Frozen snapshot of the parent's active conversation branch at dispatch, respecting compaction summaries and retained messages. Includes the current assistant tool-calling message, not abandoned branches or later sibling results. |

`full` copies effective stored conversation messages, not the parent's system prompt, runtime extension state, provider payload rewrites or context-hook transformations. Tool and skill inheritance is the same in all three modes. Pending parent tool calls get explicit placeholder results in the child copy; no parent history is changed. None of the modes continuously synchronizes conversations.

## Runtime inheritance

Without `role`, a new child receives a frozen snapshot of the parent's **active nondelegation tools**, restricted by access, and **all loaded skills**, plus the reserved blocking `ask_question` bridge. With `role`, only the role's declared resources are assembled; the parent tool/skill inventory is not inherited. The following describes the **non-role path**:

- `full` preserves the parent's active nondelegation tool capabilities; it does not grant extra OS permissions.
- `read-only` keeps only verified builtin `read`, `grep`, `find`, `ls` tools already active in the parent, plus `ask_question`. It excludes bash, edits, writes, all extension tools and builtin overrides, and does not load inherited tool-provider extensions. Explicit provider-only entrypoints are loaded separately and do not grant tool access. This is tool filtering, not OS isolation; builtins, skills and host configuration must still be trusted.

- Tool names, JSON schemas, descriptions, guidelines and canonical source paths come from Pi's live `getActiveTools()` / `getAllTools()` APIs at launch. Inactive tools are not granted; an empty parent tool set grants only `ask_question`.
- Skills come from the actual `before_agent_start.systemPromptOptions.skills` inventory, including package/CLI/extension-contributed skills and `disable-model-invocation` skills. Hidden skills retain their explicit-only behavior. Children load those exact skill files with `--skill`, not a fresh directory scan.
- Builtins are reconstructed by Pi. File-backed extension tools (including builtin overrides and tools registered at startup) reload from their canonical runtime provider files. Child preflight compares each tool's schema/metadata and canonical builtin/extension provenance, plus the complete skill inventory/metadata, **before sending the task to a model**. Builtin substitution, missing tools/skills, changed metadata and extra contributed skills fail explicitly. Tool-call guards also check for later tool replacement.
- The model defaults to the parent's current `provider/model` ID and thinking level. `model` explicitly overrides that ID; thinking is clamped by Pi to the selected model. The selected model must be available in the child; it never silently falls back to another model.

**Reconstruction boundary:** Pi exposes tool metadata, not executable closures. Extension memory, interactive setup, runtime flags, parent-only hooks, in-memory authentication/provider registrations and SDK tool implementations are not copied. SDK/inline tools, virtual/missing skill files, providers that fail to reload, and dynamically configured tools that cannot recreate matching definitions are refused rather than silently dropped. File-backed providers must support fresh RPC startup; they may fail if they require interactive setup or other extensions not backing an inherited active tool. Provider extensions may opt in via the synchronous `rpc-subagents:provider-source:v1` event (`{ provider, register(absoluteEntrypointPath) }`). Advertised provider-only entrypoints are frozen in the loadout, revalidated on launch/continuation, and retained under read-only access. They must be trusted and must not restore another model, enable tools or install account-failover/session hooks. Unadvertised provider-only extensions are not inherited. `pi-multi-account` supplies a dedicated Antigravity entrypoint for this contract; it registers only the requested account, without rotation or model restore. Authentication comes from environment/config, not parent-only in-memory credentials.

Automatic extension, skill, prompt-template and context-file (`AGENTS.md`/`CLAUDE.md`) discovery is disabled in children. Required project instructions belong in task/context. Pi's normal system-prompt configuration may still apply, with child cooperation guidance appended; the parent system prompt is not copied. Files backing skills/extensions are not content-pinned: continuation revalidates inventories and metadata, but implementation/body changes with unchanged metadata can change behavior.

**No nested delegation:** this package's creation/management tools, legacy `subagent*` tools and conventional `spawn_agent`/`manage_agents`/`delegate_task` names are excluded. Non-role children retain the CLI allowlist. Role children discover exact dynamic tool names during preflight, then freeze active tools and enforce direct/nested call guards before task submission. The child entrypoint never registers parent controls. Pi has no semantic capability tags: arbitrary custom aliases and general shell tools are not a security sandbox. Do not expose disguised delegation tools; children are instructed not to delegate or launch agent CLIs. All inherited extension code and skills must remain trusted.

## Role team: shortest startup

Role mode requires aligned Pi **1.0.2+ (1.x)**; the verified role integration baseline is **1.0.2** on Node **22.19+**. The non-role path retains **>=0.99.0 <2** compatibility. Keep the entire Pi dependency family aligned, not just CLI/AI/TUI: mismatched `pi-agent-core`, `pi-codemode`, `pi-mcp` or `chord` versions can fail before extension loading. Do not interpret the peer range as role-mode validation on every 1.x release.

1. Install with `pi install npm:pi-agent-mesh` (or use the isolated trial command below).
2. Create `<startup cwd>/.pi/agent-mesh.yaml`:

```yaml
schema_version: 1
enabled: true
main_role: pm
roles:
  pm: builtin:pm
  builder: builtin:builder
  tester: builtin:tester
  reviewer: builtin:reviewer
mcp_servers: {}
```

3. Start a **new persistent** `pi` session in that directory with an authenticated model. Ask PM to delegate implementation, verification and independent review by role, supplying scope and acceptance conditions. Do not use `--no-session`.

No external MCP or custom tools are needed. PM has reading/coordination tools; Builder has editing and shell; Tester has shell but no edit/write tools; Reviewer defaults to read-only and `none` context. Workers gain their own declared capabilities, **not an intersection with PM's tools**. PM-only management tools are runtime-injected, never granted to workers. Tool filtering is not a sandbox: shell can modify files regardless of tool names.

See [the minimal team](examples/team/README.md) and [the deterministic offline demo](examples/role-v1-demo/README.md). The demo uses real Pi RPC and actual write/bash/read execution, with a scripted local provider instead of model quota. Separate [optional local-tool, stdio and HTTP MCP examples](examples/role-resources/README.md) include passive production-parser validation; external service readiness is not established.

### Configuration and catalog

`PI_AGENT_MESH_CONFIG` selects an explicit path relative to startup cwd; otherwise only the default location is checked, with no upward search. A missing default or `enabled: false` preserves ordinary non-team sessions. An explicit missing path or invalid enabled configuration fails PM startup rather than silently falling back.

Use `/roles` to list selected roles, `/roles inspect builder` for declared resources, and the parent-only `roles_list` tool for compact summaries. These queries do **not** import local tools, connect servers, or establish readiness. `/roles reload` validates and atomically replaces the dispatch directory; failure retains the previous valid directory. Success affects only **new tasks/workflows and explicitly updated unstarted steps**, not PM's own resources, running tasks, or frozen workflows. Start a new session to adopt a changed PM role or config selection.

Role references can name manifests relative to the canonical team config directory; resource paths are relative to the canonical manifest directory. Only explicit roles and exact `SKILL.md` paths are loaded, with no neighboring scans or deep merges. Unknown fields, duplicate names, mismatched IDs and missing resources fail with source/field diagnostics. The runtime uses the public JSON schemas in `schemas/`. See `roles/builder/role.yaml` for the manifest shape: prompt file, skills, builtin tools, selected MCP tools, local-tool entries and defaults.

### PM persistence and readiness

Before its first model request, PM persists an `agent_mesh_pm` session entry containing its frozen RolePlan, actual tool definitions/provenance, prompt-composition version and canonical team config path. Resume, session switch and extension reload restore that snapshot, not today's `main_role`. Changing/deleting the original manifest or prompt does not replace the saved body. Actual skills/local entries/tool definitions must still reconstruct without drift. History remains inspectable on failure.

The dispatch directory is loaded separately. If it is now invalid, a valid saved PM can still manage existing tasks; new role dispatch fails until configuration is fixed and `/roles reload` succeeds. It does not silently become a different PM.

PM transitions through `initializing / ready / failed`. User input and internal result/question/recovery notifications share the readiness gate. Notifications queue while initializing, flush only when ready, and cannot automatically start a model turn after failure. Cleanup and ownership checks can still run. Catalog presence or server registration alone is not readiness.

Local-tool imports and MCP execution follow Pi's project trust state; catalog inspection itself is passive. Grant project trust through the host only after reviewing executable resources. PM startup or role dispatch with required executable resources refuses an untrusted project. The builtins-only minimal team needs no such resources.

### Role execution and snapshots

The engine assembles only declared builtins, exact progressive skills, and selected local tools. It saves a private task/run/attempt/nonce-bound preflight result, validates actual tool definitions and sources, then persists a per-run snapshot and cumulative verified-definition baseline **before** submitting a model prompt. Exact active-tool and direct/nested call guards apply independently of parent capabilities. `read-only` does not import local tools or connect MCP.

Local tool entries must export a factory that only calls `pi.registerTool(...)` and returns void (or a promise of void). No hooks, commands, flags, providers, MCP registrations, `pi.exec`, or captured session APIs are allowed; tools use their `execute` context instead. A guarded factory adapter collects definitions in an isolated, never-bound loader and registers only selected tools as direct. Importing local JavaScript still executes trusted code: this is an API contract, **not a sandbox**. Pi 1.0.2 does not export `loadExtensions` from its package root; the adapter isolates access to its installed `dist/core/extensions/index.js`, covered by real RPC tests.

V3 role records preserve original task/context input, the role body, authorized capabilities, and each run's effective access. Continuation does not reread the manifest or prompt. Skills and enabled local entry hashes, tool schemas and sources are rechecked; access tightening does not erase the verified baseline. A failed upgrade does not replace a valid snapshot. History remains readable after resource deletion. Before any possible submission, recovery can reconstruct the original session seed from saved input; after any run may have submitted work, a missing transcript is an error, not permission to replay it. These guarantees do not content-pin referenced scripts/packages or remote implementations.

### Native role MCP

Team `mcp_servers` accepts stdio `command/args/cwd/env` or Streamable HTTP `url/headers`, plus `timeout/description`. Command is an executable, not a shell string; omitted stdio cwd uses the actual task/worktree cwd. Explicit relative server cwd is resolved against the team config directory; args remain literal. Manifests select server IDs and exact **raw** tool names. Exposure overrides, OAuth/login flows and credential-command evaluation are not supported.

Full-access role tasks use Pi's native stdio/Streamable HTTP clients, transports and result conversion. Only role-selected servers connect; global/project `mcp.json` and extension registrations do not supplement them. Unselected tools and automatic resource tools never enter the real child registry. Selected tools are direct; codemode/tool_search are not auto-enabled. Raw tool names map to Pi's actual collision-safe names, with server/config identity and complete remote-definition hashes retained for drift checks.

Role startup has one 30-second absolute deadline, including process readiness and discovery. Failed connections, missing credentials/tools, invalid schemas and deadline expiry fail before the model prompt and close owned resources. Cancelling readiness uses a private command to settle the pending preflight before normal RPC shutdown. Native per-request timeouts are separate: progress can reset them, but parent cancellation still aborts the request. HTTP close releases the task's client, not the remote server or its side effects.

Environment/header references resolve in the child, stay unresolved in persisted plans, and can rotate between runs. OAuth/login, credential commands and user-config writes are disabled on this path. Native connection diagnostics are sanitized; server log notifications are not persisted. Normal tool results preserve native text/images/structured content and the distinction between `isError` and protocol failures. As with all tool output, do not ask services to echo credentials. Tests use local deterministic peers and model fixtures, not external accounts.

## Tools

### Launch: `subagent`

```json
{
  "name": "auth",
  "task": "Fix expired-token handling and add tests",
  "access": "full",
  "context": "partial",
  "contextText": "The API returns 401 for expired tokens. Preserve the existing refresh contract."
}
```

Required: `task`, and **`access` when no `role` is supplied**. Optional: `role`, `access`, `name`, `model`, `cwd`, `context`, `contextText`. `contextText` is only accepted in `partial` mode. Names default to the context mode (`none`, `partial`, `full`); all names are deduplicated.

Role dispatch uses explicit call model > role non-`inherit` model > parent model; context uses explicit call > explicitly declared role context > `partial`; access uses explicit call > required role access default. `partial` always needs nonempty `contextText`. `inherit` is a manifest value, not a callable model ID. For example:

```json
{ "role": "builder", "task": "Implement the scoped fix", "contextText": "Owned paths, requirements and acceptance checks" }
{ "role": "tester", "task": "Run the focused tests", "contextText": "Exact test target and expected result" }
{ "role": "reviewer", "task": "Independently inspect the code against the stated requirements" }
```

Receipts/inspect include role ID, configuration digest and effective access/model/context; inspect distinguishes declared available capabilities from this run's enabled tools and preflight state. `full` never adds undeclared capabilities. Role `read-only` retains only declared verified builtin read/grep/find/ls plus `ask_question`, removing local tools and MCP **before** loading/connecting them.

Startup failures include the failing phase, target model, child agent directory, original error and a troubleshooting hint. Known credential, model/provider and loadout/extension errors are distinguished; unknown startup errors remain generic. Credential errors arriving after RPC acceptance also receive guidance. Classification is best-effort, not an authentication probe: preflight does not call the provider, and no automatic retry or account switch is added.

The call waits for startup/preflight and RPC acceptance, **not task completion**. Results and questions arrive automatically as parent messages. After launching, the parent can do independent work or end its turn. Do not poll to wait for completion.

For an independent review use `context: "none"`; for a continuation of a complex discussion use `context: "full"`. Tool and skill inheritance stays the same in every mode.

### Manage: `subagent_control`

```json
{ "action": "list" }
{ "action": "inspect", "id": "auth" }
{ "action": "history", "id": "auth", "limit": 20 }
{ "action": "message", "id": "auth", "message": "Also cover an empty refresh token" }
{ "action": "answer", "id": "auth", "questionId": "<ID from question>", "message": "Keep the existing API shape" }
{ "action": "cancel", "id": "auth" }
{ "action": "continue", "id": "auth", "message": "Address the review finding in the same module" }
```

`id` accepts the stable UUID or unique task name. `message` only targets a running task; use `continue` explicitly for a finished task. RPC acceptance means accepted/queued, not proven executed. When a question is pending, use `answer` with its ID instead of an ordinary message. Duplicate and stale answers are rejected.

`history` returns bounded tool calls/results from the retained session (default 20 entries, maximum 100). It is evidence of operations, **not an exact filesystem attribution audit**. Inspect actual diffs and verification too. A stopped standalone task can be continued with `access: "read-only"` to request explanations; continuation retains its saved access when omitted. Continue cannot select a new role; create a new task to change roles. Explicit full continuation may first discover previously disabled but originally authorized resources; later full runs still compare the cumulative verified definitions. Legacy records without `access` remain readable but require an explicit choice before continuation. Workflow steps use `workflow_control retry` rather than direct continuation.

### Workflows: `workflow_run` / `workflow_control`

```json
{
  "name": "auth-fix",
  "context": "partial",
  "contextText": "Fix expired-token handling without changing the refresh API.",
  "maxParallel": 3,
  "steps": [
    { "id": "investigate", "task": "Locate the bug and explain evidence", "access": "read-only", "dependsOn": [] },
    { "id": "fix", "task": "Implement the narrow fix and tests", "access": "full", "dependsOn": ["investigate"] },
    { "id": "validate", "task": "Run focused tests and report results", "access": "full", "dependsOn": ["fix"] },
    { "id": "review", "task": "Read the changes and validation report; identify remaining risks", "access": "read-only", "dependsOn": ["validate"] }
  ]
}
```

Definitions contain 1–64 steps, unique IDs, existing dependencies and no cycles. `maxParallel` is 1–16 (default 3). Legacy steps retain workflow-level context: `partial` requires `contextText`, and `full` freezes the branch at workflow creation. By default they also receive bounded direct-upstream reports and session paths. Reports are claims, not acceptance proof. Running tests usually requires `full` because `read-only` excludes bash.

#### Per-step roles and context

Each step accepts `role`, `model`, `context`, `contextText`, `dependencyReports`, and optional `access` (required without role). For role steps:

- Model: step explicit provider/model > role non-`inherit` default > workflow explicit model > parent current model.
- Context: step explicit > role explicitly declared default > workflow context > `partial`. Omitted role context/model does not hide workflow defaults.
- Partial text: step `contextText` > workflow `contextText`; missing text fails workflow creation. Text is not accepted for non-partial steps.
- Access: step explicit > role default. `dependencyReports`: explicit `include`/`omit` > role `none` defaults to `omit`; otherwise defaults to `include` (including legacy steps).

```json
{
  "context": "partial",
  "contextText": "Requirements and acceptance checks",
  "steps": [
    { "id": "build", "role": "builder", "task": "Implement the change", "context": "partial", "dependsOn": [] },
    { "id": "review", "role": "reviewer", "task": "Inspect code against the stated requirements", "context": "none", "dependencyReports": "omit", "dependsOn": ["build"] }
  ]
}
```

`omit` removes upstream report text and session links, **not dependency code merging** in isolated mode. Put independent review requirements in the review task itself. Each step's role plan/defaults and any full parent-history snapshot freeze at creation; dispatch only binds actual worktree cwd. Reload does not replace them. Explicit updates of unstarted steps generate new plans; resource drift pauses before model submission. Reports remain untrusted claims, not structured verdicts. No automatic repair round or merge follows a natural-language review finding.

Default `workspace: "shared"`: read-only steps may overlap; a full step runs alone **within its own workflow**. Other workflows, standalone subagents and external writers are not locked. Failure pauses new dispatch; active siblings finish normally. Questions use the existing child answer tool.

#### Isolated writable workflows

Add `"workspace": "isolated"` and an explicit `"validationCommand": "npm ci && npm test"` to `workflow_run`. This mode requires a **clean Git checkout**, including untracked files, an existing HEAD, no submodules, POSIX validation process groups, and workflow storage outside the repository. Initialization errors pause without launching children. Existing shared workflows remain compatible.

- Every step, including readers, gets a detached worktree. Independent writers overlap up to `maxParallel` and the owner-wide task cap.
- Before launching a dependent step, Git merges its direct dependencies' captured revisions into its own worktree. Reports alone are not used as code propagation. Diamond dependencies retain real Git ancestry.
- After a child has confirmed shutdown, tracked changes, deletions and non-ignored untracked files are committed in its worktree. Ignored files, dependency installations and external resources are **not** copied between worktrees. Prepare those explicitly in task instructions/validation commands.
- Final Git integration is serialized by the workflow owner into a separate result worktree. The explicit validation command runs there (in the original relative cwd), with a ten-minute deadline. Nonzero exit, dirty files, a changed HEAD, or conflicts pause completion. Logs are retained at `<result-worktree>.validation.log`. Validation success is only as meaningful as the supplied command.
- Inspect shows the result directory, removal status, and durable result ref. Review its diff against the source base before manually applying it. The extension never stashes, resets, cleans, commits in, or automatically merges into the source checkout.
- Paused workflows retain their scenes, including merge conflicts and manual pauses. Resolve and commit conflicts in the reported worktree; use `resume` for final-integration failures, or explicit step `retry` followed by `resume` for dependency-preparation failures before a child exists. Retrying an isolated step that had a child deliberately discards its old scene and creates a **new task/session/worktree** on resume, using dependency outputs/base, not uncommitted failed edits. Shared retries retain their original session.
- **Destructive terminal cleanup:** completed and cancelled isolated workflows automatically remove all their owned worktrees, including dirty, conflicted, ignored and uncommitted failed/cancelled scenes. Captured successful step outputs, the base and validated final result are first pinned under `refs/pi-workflows/<workflow-id>/…`; any ref failure blocks deletion. Refs are never automatically purged. Sessions, records and adjacent validation logs remain. Removal state is saved per tree; `workflow_control cleanup` retries interrupted/blocked cleanup on completed/cancelled records.
- Preparation, validation, live children and uncertain shutdown block removal. Parent shutdown itself does not delete scenes. Restart never resumes workflow scheduling automatically. Task executions with a verifiable systemd boundary are cleaned automatically; validation processes without such proof remain isolated. The extension never kills an unverified recovered PID.

Restore a saved result or step manually in a new directory: `git worktree add --detach /path/to/restored refs/pi-workflows/<workflow-id>/result` (substitute the step ref shown by inspect). Git refs preserve captured commits across GC; they do not preserve ignored installations or failed uncommitted edits.

**Worktrees are not sandboxes.** Full agents and validation commands can still use absolute paths, alter shared Git metadata, access credentials/network, contend for ports/databases, or create escaped daemons. Containers, external resource namespaces, cross-owner coordination and arbitrary daemon cleanup are not included. The concurrency cap is per parent TaskManager, not machine-wide.

```json
{ "action": "inspect", "id": "auth-fix" }
{ "action": "pause", "id": "auth-fix" }
{ "action": "update", "id": "auth-fix", "steps": [{ "id": "extra-review", "task": "Check compatibility", "access": "read-only", "dependsOn": ["review"] }] }
{ "action": "retry", "id": "auth-fix", "stepId": "fix", "message": "Address the reported edge case", "access": "full" }
{ "action": "resume", "id": "auth-fix" }
{ "action": "cancel", "id": "auth-fix" }
{ "action": "cleanup", "id": "auth-fix" }
```

These are independent control examples, not a sequence. Pause stops future dispatch, not active children. Updates require a paused workflow and only upsert unstarted steps. Retry requires an explicit instruction, a paused workflow, no active steps in it, confirmed cleanup, and no already-started descendants. Shared retries continue the same child session; isolated child retries start fresh on resume (or requeue if no child was created), and never automatically resume scheduling. Completed workflows can be paused for a terminal-step follow-up; earlier steps with started descendants cannot be retried because that would invalidate their inputs. Use retained history for investigating those steps. No automatic blame attribution or rollback is provided.

Workflow JSON lives under the task directory's `workflows/` folder. Parent shutdown pauses scheduling before stopping children. Restart never auto-runs a workflow; explicitly resume its scheduler. Verifiable task executions are cleaned automatically. Unconfirmed legacy executions and validation shutdown remain isolated and block scheduling/retry; no manual confirmation bypass is provided. `/workflows [ID or name]` shows a snapshot; control changes use the tools.

### Child questions

`ask_question({ question })` blocks inside the child's tool execution through the RPC UI protocol. It is a sequential tool, so later child tools do not proceed past the question until the matching answer arrives. The parent gets the task and question IDs. Multiple different children can wait independently. Cancellation stops the waiting child.

## User interface

The main session has a compact live widget (up to five rows), showing task name/ID, state, elapsed time and current tool activity. It does not invent completion percentages.

Use **`/subagents`** for the live dashboard. It covers the full terminal while open (the conversation is hidden) and starts on **Prompt**. Press **Esc** to return to the conversation. A single outer frame separates the task list from details with one divider (side-by-side on wide terminals, stacked on narrow terminals). The selected task's name, state and saved `provider/model` ID stay in the header. Plain shortcut hints show **1 Overview**, **2 Prompt**, **3 Activity**, and **4 Trace**; the current view is highlighted and **Focus: Tasks/Detail** shows where the arrow keys act:

- **Overview** opens at the top with access, thinking/context, shutdown status, questions and errors. Role tasks additionally show role/config identity, declared versus effective capabilities and preflight state. Long IDs/session paths are omitted from this compact view.
- **Prompt** shows the complete parent-assigned task prompt (including direct dependency reports for workflow steps), not the generated system prompt or inherited conversation.
- **Activity** follows the latest assistant text and recent log. Manual scrolling pauses follow; **End** resumes it.
- **Trace** opens at the top of the child's complete recorded session JSONL, shown as pretty JSON without display truncation: messages, emitted thinking, tool-call parameters/results and other records. It may include inherited context and is not unrecorded internal reasoning. **End** follows newly recorded entries; manual scrolling pauses follow and **Home** returns to the start. Missing files and incomplete/malformed JSONL lines are shown as nonfatal notices (raw incomplete lines are retained). Terminal control sequences are removed. Only the selected Trace is loaded, and unchanged file contents are cached for the dashboard interaction.

Scroll positions are retained separately for each task/view while the dashboard is open, including when returning from an action dialog.

Use **↑↓** to select a task, **Enter/Tab** to switch task-list/detail focus, and **PgUp/PgDn**, **Home/End** to scroll details. Action keys are **m** message, **a** answer, **c** continue and **x** cancel. **Esc** closes the dashboard. An explicit **`/subagents <task ID>`** (or RPC client) retains the native menu, including:
- **Details**: scrollable snapshot of model/thinking, parent-assigned task prompt, access, latest assistant text, questions and recent tool activity. This is a snapshot, not a streaming terminal; reopen to refresh. Editing the displayed copy changes nothing.
- **Message**: send supplementary instructions.
- **Answer question**: select a pending question and reply.
- **Cancel**: confirm and stop the task.
- **Continue**: start another run using the saved child session/loadout.

Live updates remain in the main widget. Completion/question messages can be expanded with Pi's normal tool/message expansion shortcut. Headless clients can use the control tool or the same RPC dialog protocol. No standalone child terminal is created.

## State, persistence and shutdown

States: `running`, `waiting`, `completed`, `failed`, `cancelled`. `completed` means the child settled normally (including a successful terminating tool batch), **not that its changes passed acceptance**. The child is instructed to report completion/partial/block status, changes, validation and remaining issues; the parent decides acceptance.

Task records, frozen loadouts, prompt files and child JSONL sessions are stored under:

```text
<parent-session-directory>/rpc-subagents/<parent-session-id>/
```

Progress previews retain the latest 12,000 characters of assistant output, up to 100 log entries with approximately 1,000 characters each; tool responses are additionally bounded. Complete model/tool history is in the child session file. These records/sessions are not automatically deleted; terminal isolated workflow worktrees are removed under the policy above.

A completed/stopped child can be continued after a parent restart, with its original absolute cwd, model, tools, skills and extension paths. It uses its saved loadout, not the current parent inventory. Metadata is revalidated before continuation.

Shutdown/reload/session replacement stops managed children and suppresses late parent notifications. Partial file changes are not rolled back. Continuation requires confirmed cleanup and exclusive ownership.

### Automatic cleanup and recovery

On Linux, an owner-wide kernel `flock` lease is acquired **before** task/workflow records are loaded. Its lockfile is never removed. A previous active parent must be proven dead using kernel boot ID and process start time; an absent lease alone does not authorize takeover. Losing the lease fences further writes and starts shutdown.

When cgroup v2 and a compatible user systemd manager are available (`systemd-run` with `--expand-environment=no`, systemd 254+), each new RPC execution uses a unique scope. Its identity is saved before launch; launcher identity and RPC readiness are also recorded. Automatic cleanup kills the exact scope and verifies recursive cgroup emptiness and launcher exit, covering ordinary detached tool descendants. It is containment, not a sandbox against tools deliberately migrating cgroups or work launched on remote services.

Cleanup failures retain the live RPC handle and session lock. The plugin retries automatically up to five times with bounded backoff. On restart it cleans verifiable old executions before releasing stale task locks. Interrupted **standalone** tasks then get one automatic continuation from their retained history/loadout; that budget is saved before submission. The worker is told to inspect partial effects rather than blindly replay commands. Completed tasks are only cleaned; explicitly cancelled tasks never restart. Workflow children are cleaned but remain under the workflow's explicit pause/retry/resume contract.

No human confirmation is needed or offered. Legacy records without an execution boundary, missing launcher identity, unavailable systemd, or failed verification remain automatically isolated. A crash before launcher identity/readiness was recorded can therefore remain isolated rather than risk a late second writer. Unsupported platforms retain conservative RPC/process-group shutdown without automatic orphan adoption.

An owner-wide cap defaults to **8 child tasks**, configurable through `PI_SUBAGENT_MAX_CONCURRENT` (positive integer). It includes standalone and workflow children plus unconfirmed orphan records. Workflows wait for capacity; standalone launch/continue and explicit retry reject when full. Other parent processes are not counted. Validation commands have a separate ten-minute deadline and are not child-agent slots; ordinary agent tasks have no total execution deadline. Assign a small number of independent tasks and cancel unwanted work. RPC command acknowledgements have a 15-second timeout; unknown acceptance causes failure/cleanup, never blind re-submission. Cancellation first waits a bounded time for outstanding prompt preflight receipts, including late receipts after caller timeout, then clears queued work and waits for an abort/idle acknowledgement before stdin shutdown, with bounded signal escalation. For hosts without `clear_queue` over RPC, the defensive compatibility path aborts and then requires `get_state` to prove that the queue is empty; otherwise shutdown remains unconfirmed and retains the lock. This fallback does not imply support for Pi versions below the required API minimum. New submissions are rejected while stopping; an idle abort alone cannot confirm cleanup while a prompt hook remains unresolved. If agent/tool cleanup or process exit cannot be confirmed, cancellation reports failure and retains the lock; root-process exit alone is not confirmation. An accepted prompt consumed by an input hook without starting or queueing work fails explicitly instead of remaining live. For scoped executions, verified cgroup cleanup can establish shutdown even when RPC abort acknowledgement failed. Without a scope, arbitrary daemonized commands remain outside the lifecycle guarantee. Linux/macOS process groups are supported; full Windows descendant cleanup is not yet validated.

## Role troubleshooting and limits

- Invalid config: follow the source file and field diagnostic; use `/roles inspect <id>` and fix missing paths/unknown fields, then `/roles reload`. A bad reload retains the prior valid directory.
- PM failed/not ready: inspect status and saved failure/session entries. Fix model authentication, trust, missing resources or service readiness; use a new session when changing PM's frozen configuration. Do not bypass readiness by injecting internal turns. Readiness fails at its deadline even for a stalled local factory. Host model authentication has no cancellation API: after timeout, session shutdown/replacement waits for the outstanding model-selection operation to settle, rather than permitting late writes into a replacement. An indefinitely stalled auth provider can therefore hold replacement; fix the provider or restart Pi.
- `partial` error: supply meaningful `contextText` (step text overrides workflow text), or deliberately choose `none`. `full` does not supply missing tools.
- Continuation drift: restore the saved skill/local entry/tool definition, or create a new task to authorize new resources. Reload is not permission to mutate an old task's role. Remote credential references may rotate; resolved secrets are not persisted in plans.
- MCP failure: check the named role/server, environment reference, transport, required raw tool names and 30-second readiness deadline. Registration/catalog presence is not proof of a connection. No model request occurs on a failed preflight; no automatic account switch or side-effect replay is attempted.

All executable local code and selected servers must be trusted. Hashes freeze the manifest, role body, skill files and local entrypoints, **not** their transitive scripts/packages or remote implementations. Tool access is not OS isolation. Natural-language verdicts are not machine-enforced acceptance; no automatic repair rounds, automatic application/merge, role marketplace or cross-task MCP connection pool is provided. Native MCP request timeouts (which progress may reset) are not total task deadlines. The offline demo proves deterministic plumbing, not real-model reasoning or your provider's authentication.

## Development and isolated trial

```bash
npm ci
npm test
npm run typecheck
```

Tests use deterministic fake RPC children, installed-Pi command-only preflight tests, and real parent/child RPC sessions with a local scripted provider. They exercise custom tool execution, builtin overrides, startup tools, skills, all context modes, model selection and questions without external provider calls or model quota. They do **not** establish that your configured provider will authenticate or complete a real task.

To try the extension without changing your global installation, from the project directory you want children to work in:

```bash
pi --no-extensions -e /absolute/path/to/pi-agent-mesh/pi-extension/subagents/index.ts
```

This intentionally disables the currently installed subagent extension for this trial process. Do not load both packages together: they register conflicting tool names. Start with a `none` investigation task, `access: "read-only"` and a model available to the child. Read-only filters tools but is not a filesystem sandbox. Trial tasks use real model quota. The extension requires a persistent parent session (not `--no-session`). Nothing in the source migration changes your current global settings or enables this package automatically.

## Source map

- `index.ts`: tools, session lifecycle, parent notifications
- `loadout.ts`: live runtime snapshots, canonical sources and inherited-loadout verification
- `roles.ts`: team/role validation, canonical resource metadata, atomic catalog reload
- `roles-ui.ts`: parent-only catalog commands and summaries
- `pm.ts`: main-role assembly, persistent PM snapshots and readiness/notification gates
- `role-dispatch.ts`: shared standalone/workflow role defaults and trust checks
- `workflows.ts`: frozen per-step plans, DAG scheduling, worktrees and report policy
- `role-loadout.ts`: frozen role plans, actual snapshots, effective-access and historical-definition validation
- `role-tools.ts` / `role-child.ts`: isolated local-tool selection and role-only child preflight/call guards
- `role-mcp.ts`: selected native MCP configuration, discovery, credential handling and lifecycle
- `context.ts`: none/partial/full snapshots and cooperation instructions
- `rpc.ts`: JSONL framing, request correlation and process cleanup
- `tasks.ts`: launch/control/question/completion lifecycle
- `store.ts`: durable records, bounded previews and session locks
- `child.ts`: blocking question tool and loadout preflight
- `ui.ts`: main widget, task menu and result rendering

Role profiles, `agents/`, the `agent` launch argument, `subagents_list` and bundled profile-only `safe_bash` are removed. Existing profile directories are ignored, not modified. Legacy v1 profile loadouts remain inspectable but cannot be continued; launch a new context-based task instead. The former tmux/Claude plugin registries are not migrated or automatically resumed.

## Origin and acknowledgements

This project builds on the interactive-subagent work of [HazAT](https://github.com/HazAT) and [Amos Blomqvist](https://github.com/amosblomqvist), via [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents). Their original work provided the foundation for this project.

The RPC-based architecture and subsequent development are maintained by [Eryx-Z](https://github.com/Eryx-Z). The redesign replaces terminal multiplexing with background Pi RPC processes and adds explicit context/tool inheritance, persistent DAG workflows, isolated Git worktrees, and process recovery and result-retention mechanisms. Git history is retained to preserve attribution and make the contribution boundary inspectable.

Distributed under the MIT License. The original HazAT copyright notice is retained alongside the notice for subsequent contributions; see [LICENSE](LICENSE).
