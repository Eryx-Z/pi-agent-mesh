# pi-agent-mesh — context-based RPC

Lightweight parallel subagents for Pi, without tmux. Each task runs in a background Pi RPC process with its own conversation. Standalone tasks use the shared working directory unless an explicit `cwd` is supplied. Workflows can opt into isolated Git worktrees. The parent session displays progress, receives results and questions, and controls children.

This is the **4.0.0 breaking redesign** of the earlier tmux implementation. Requires aligned `@earendil-works` Pi packages **>=0.99.0 <2**, Node **22+**; development dependencies are pinned to **1.0.2**. Typechecking and real RPC integration tests cover 0.99.0 and 1.0.2. The earlier **0.84.2–0.85.x** compatibility claim was incorrect for the current implementation: those hosts lack inherited tool exposure/namespace/annotations, transcript system-message support and nested `ctx.executeTool()` APIs. Upgrade Pi to use this version; older hosts and `@mariozechner` Pi versions are not supported.

## Model of operation

- One task → one child process → one persistent session.
- Each task requires `access: "read-only" | "full"`. Scope and coordination instructions belong in the task text, not an `ownership` field.
- Access filters tools; it is **not a filesystem sandbox or lock**. Shared ports, databases, build outputs and edits can still conflict. The parent validates the combined result.
- Children do not receive delegation tools. Only the parent launches subagents.
- Optional persistent JSON DAG workflows reuse the same children. Isolated mode supports parallel writable worktrees and validated integration into a separate result worktree. No automatic application to the user checkout, automatic retries, loops, condition-expression language, alternative CLI backends, or background daemon.

## Three context modes

Context controls information inheritance independently of tool access. Current task execution uses inheritance, not role definitions or profiles; the optional role catalog below is a preview only:

| Mode | Inherited parent conversation |
| --- | --- |
| `none` | None. Task, access and cooperation guidance only (workflow steps also receive direct dependency results). |
| `partial` (default) | Explicit `contextText` selected/written by the parent. Required; use `none` for an independent task. |
| `full` | Frozen snapshot of the parent's active conversation branch at dispatch, respecting compaction summaries and retained messages. Includes the current assistant tool-calling message, not abandoned branches or later sibling results. |

`full` copies effective stored conversation messages, not the parent's system prompt, runtime extension state, provider payload rewrites or context-hook transformations. Tool and skill inheritance is the same in all three modes. Pending parent tool calls get explicit placeholder results in the child copy; no parent history is changed. None of the modes continuously synchronizes conversations.

## Runtime inheritance

Every new child receives a frozen snapshot of the parent's **active nondelegation tools**, restricted by access, and **all loaded skills**, plus the reserved blocking `ask_question` bridge. No profile or ambient-config tool/skill discovery is used:

- `full` preserves the parent's active nondelegation tool capabilities; it does not grant extra OS permissions.
- `read-only` keeps only verified builtin `read`, `grep`, `find`, `ls` tools already active in the parent, plus `ask_question`. It excludes bash, edits, writes, all extension tools and builtin overrides, and does not load inherited tool-provider extensions. Explicit provider-only entrypoints are loaded separately and do not grant tool access. This is tool filtering, not OS isolation; builtins, skills and host configuration must still be trusted.

- Tool names, JSON schemas, descriptions, guidelines and canonical source paths come from Pi's live `getActiveTools()` / `getAllTools()` APIs at launch. Inactive tools are not granted; an empty parent tool set grants only `ask_question`.
- Skills come from the actual `before_agent_start.systemPromptOptions.skills` inventory, including package/CLI/extension-contributed skills and `disable-model-invocation` skills. Hidden skills retain their explicit-only behavior. Children load those exact skill files with `--skill`, not a fresh directory scan.
- Builtins are reconstructed by Pi. File-backed extension tools (including builtin overrides and tools registered at startup) reload from their canonical runtime provider files. Child preflight compares each tool's schema/metadata and canonical builtin/extension provenance, plus the complete skill inventory/metadata, **before sending the task to a model**. Builtin substitution, missing tools/skills, changed metadata and extra contributed skills fail explicitly. Tool-call guards also check for later tool replacement.
- The model defaults to the parent's current `provider/model` ID and thinking level. `model` explicitly overrides that ID; thinking is clamped by Pi to the selected model. The selected model must be available in the child; it never silently falls back to another model.

**Reconstruction boundary:** Pi exposes tool metadata, not executable closures. Extension memory, interactive setup, runtime flags, parent-only hooks, in-memory authentication/provider registrations and SDK tool implementations are not copied. SDK/inline tools, virtual/missing skill files, providers that fail to reload, and dynamically configured tools that cannot recreate matching definitions are refused rather than silently dropped. File-backed providers must support fresh RPC startup; they may fail if they require interactive setup or other extensions not backing an inherited active tool. Provider extensions may opt in via the synchronous `rpc-subagents:provider-source:v1` event (`{ provider, register(absoluteEntrypointPath) }`). Advertised provider-only entrypoints are frozen in the loadout, revalidated on launch/continuation, and retained under read-only access. They must be trusted and must not restore another model, enable tools or install account-failover/session hooks. Unadvertised provider-only extensions are not inherited. `pi-multi-account` supplies a dedicated Antigravity entrypoint for this contract; it registers only the requested account, without rotation or model restore. Authentication comes from environment/config, not parent-only in-memory credentials.

Automatic extension, skill, prompt-template and context-file (`AGENTS.md`/`CLAUDE.md`) discovery is disabled in children. Required project instructions belong in task/context. Pi's normal system-prompt configuration may still apply, with child cooperation guidance appended; the parent system prompt is not copied. Files backing skills/extensions are not content-pinned: continuation revalidates inventories and metadata, but implementation/body changes with unchanged metadata can change behavior.

**No nested delegation:** this package's creation/management tools, legacy `subagent*` tools and conventional `spawn_agent`/`manage_agents`/`delegate_task` names are excluded. The CLI allowlist prevents providers from enabling extra tools, and the child entrypoint never registers parent controls. Pi has no semantic capability tags: arbitrary custom aliases and general shell tools are not a security sandbox. Do not expose disguised delegation tools; children are instructed not to delegate or launch agent CLIs. All inherited extension code and skills must remain trusted.

## Role catalog preview (M1)

**The catalog is available; PM activation and public role-based dispatch are not implemented yet.** `enabled: true` currently enables configuration/catalog validation only. It does not change your main prompt, tool access, or the existing `subagent` / workflow API. Do not add a `role` argument to those APIs yet. Catalog queries require Pi **1.0.2+ (1.x)**; the existing non-role path keeps its prior version requirements. Keep the host's Pi dependency family aligned, not just its CLI/AI/TUI packages. A fresh install of those three at 1.0.2 can resolve incompatible 1.3.x `pi-agent-core` / `pi-codemode` / `pi-mcp` dependencies and fail before extension loading. For the tested 1.0.2 setup, align those packages and `@earendil-works/chord` to 1.0.2 as well.

Create `<startup cwd>/.pi/agent-mesh.yaml` (or copy `examples/team/.pi/agent-mesh.yaml`):

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

Use `/roles` to list the selected roles, `/roles inspect builder` for declared resources, and `/roles reload` to validate and atomically replace the directory. The parent-only `roles_list` tool returns compact summaries. Queries do **not** import local tool modules, connect role MCP servers, or establish service readiness. Prompts and skills are read for validation, not injected into the main session.

`PI_AGENT_MESH_CONFIG` selects an explicit path relative to startup cwd; otherwise only the default location is checked, with no upward search. The selection is captured at parent startup. A missing default or `enabled: false` yields a disabled catalog. An explicit missing path or invalid configuration is an error, not an empty successful directory. Failed reload retains the previous directory and reports the static error; reload does not change running tasks. Catalog loading is lazy until the first query, so ordinary legacy sessions do not load the new parser.

Role references may also name manifest files relative to the team config's canonical directory. Manifest resource paths are relative to the canonical manifest directory. Once loaded, the canonical config identity stays fixed for reload; changing the selected file requires a new session. Roles are explicitly registered; neighboring files and directories are not scanned or merged. Unknown fields, duplicate names, mismatched IDs, missing resources, and malformed UTF-8/YAML are rejected with source/field diagnostics. Public JSON schemas in `schemas/` are also used by runtime validation.

The package includes four independent role manifests, prompts, and skills: PM (reading/coordination), Builder (editing and shell), Tester (shell verification), Reviewer (`none` + read-only). These are declarations for future role execution, **not currently applied restrictions**. Shell access is not a sandbox. Custom manifests declare exact builtin tools, exact `SKILL.md` paths, MCP server/raw-tool references, and tool-only extension entries. Their availability and executable-tool contract are checked during future execution preflight, not by the passive catalog. See `roles/builder/role.yaml` and the two schemas for the full configuration shape.

MCP config accepts stdio `command/args/cwd/env` or HTTP `url/headers`, plus timeout and description; exposure overrides, OAuth configuration, and credential-command evaluation are not accepted. Environment references remain unresolved in catalog snapshots; missing referenced variables are diagnosed without showing values. Role MCP never supplements its declarations from ambient `mcp.json`. This catalog guarantee does not disable the host's independently configured MCP extensions in an ordinary non-PM session.

### Internal role execution engine (M2–M3)

The internal `TaskManager` now accepts a frozen `rolePlan` instead of an inherited loadout. This is not yet connected to the public `subagent` or workflow tools; continue using their existing parameters. Native MCP role execution is available internally; PM/public role integration remains M4.

The engine assembles only declared builtins, exact progressive skills, and selected local tools. It saves a private task/run/attempt/nonce-bound preflight result, validates actual tool definitions and sources, then persists a per-run snapshot and cumulative verified-definition baseline **before** submitting a model prompt. Exact active-tool and direct/nested call guards apply independently of parent capabilities. `read-only` does not import local tools or connect MCP.

Local tool entries must export a factory that only calls `pi.registerTool(...)` and returns void (or a promise of void). No hooks, commands, flags, providers, MCP registrations, `pi.exec`, or captured session APIs are allowed; tools use their `execute` context instead. A guarded factory adapter collects definitions in an isolated, never-bound loader and registers only selected tools as direct. Importing local JavaScript still executes trusted code: this is an API contract, **not a sandbox**. Pi 1.0.2 does not export `loadExtensions` from its package root; the adapter isolates access to its installed `dist/core/extensions/index.js`, covered by real RPC tests.

V3 role records preserve original task/context input, the role body, authorized capabilities, and each run's effective access. Continuation does not reread the manifest or prompt. Skills and enabled local entry hashes, tool schemas and sources are rechecked; access tightening does not erase the verified baseline. A failed upgrade does not replace a valid snapshot. History remains readable after resource deletion. Before any possible submission, recovery can reconstruct the original session seed from saved input; after any run may have submitted work, a missing transcript is an error, not permission to replay it. These guarantees do not content-pin referenced scripts/packages or remote implementations.

### Native role MCP (M3)

Internal full-access role tasks use Pi's native stdio/Streamable HTTP clients, transports and result conversion. Only role-selected servers connect; global/project `mcp.json` and extension registrations do not supplement them. Unselected tools and automatic resource tools never enter the real child registry. Selected tools are direct; codemode/tool_search are not auto-enabled. Raw tool names map to Pi's actual collision-safe names, with server/config identity and complete remote-definition hashes retained for drift checks.

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

Required: `task`, `access`. Optional: `name`, `model`, `cwd`, `context`, `contextText`. `contextText` is only accepted in `partial` mode. Names default to the context mode (`none`, `partial`, `full`); all names are deduplicated.

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

`history` returns bounded tool calls/results from the retained session (default 20 entries, maximum 100). It is evidence of operations, **not an exact filesystem attribution audit**. Inspect actual diffs and verification too. A stopped standalone task can be continued with `access: "read-only"` to request explanations; new tasks retain their original access when omitted. Legacy records without `access` remain readable but require an explicit choice before continuation. Workflow steps use `workflow_control retry` rather than direct continuation.

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

Definitions contain 1–64 steps, unique IDs, existing dependencies and no cycles. `maxParallel` is 1–16 (default 3). Context defaults to `partial`, requiring `contextText`; `full` freezes the current branch **once per workflow**, not once per step. Each step also receives bounded direct-upstream reports and their session paths. Reports are claims, not acceptance proof. Running tests usually requires `full` because `read-only` excludes bash.

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

- **Overview** opens at the top with access, thinking/context, shutdown status, questions and errors. Long IDs/session paths are omitted from this compact view.
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
- `roles.ts`: passive team/role validation, canonical resource metadata, atomic catalog reload
- `roles-ui.ts`: parent-only catalog preview commands and summaries (no PM activation)
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
