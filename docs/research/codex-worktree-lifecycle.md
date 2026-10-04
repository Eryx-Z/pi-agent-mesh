# Codex 本地子代理、worktree 与结果保留：边界核查

核查时间：2026-10-04（UTC）。仅使用 OpenAI 官方 `openai/codex` 源码及 `developers.openai.com/codex` 文档；本仓库源码仅作比较对象。没有启动模型、修改配置或执行 worktree 创建/删除。

## 结论先行

**不能把 Codex 的四种机制合并理解：本地 `spawn_agent` 默认继承父代理 cwd；当前 CLI 已有独立的 `--worktree` 模式；桌面应用另有自动回收及删除前快照；云任务 apply 则是把服务端 diff 应用到本地。** 本仓库 isolated workflow 的“每步骤隔离、依赖提交合并、集成验证、保留目录”不等于上述任一种机制。

特别纠正：对本次安装的 **codex-cli 0.159.0**，声称“CLI 根本没有 Git worktree 模式”是错误的；但有 CLI worktree 功能，也不意味着每次 `spawn_agent` 都创建自己的 worktree。

## 固定版本与证据范围

- 本机 `codex --version`：`codex-cli 0.159.0`；`codex --help` 明示 `--worktree: Run the session in a new managed Git worktree`。只执行了 version/help。
- 官方 release tag [`rust-v0.159.0`](https://github.com/openai/codex/releases/tag/rust-v0.159.0) 解引用到 commit **`687a119f0fcaace47e1f1abcc77cec6c813fd6da`**；官方 [tag API](https://api.github.com/repos/openai/codex/git/tags/377f7f557a6bdea0f3a2d26d4d899c66db4789d0) 给出的日期为 2026-09-29。以下源码链接均固定到该 commit，而非漂移的 main。
- 网页文档为 2026-10-04 实时读取，未固定历史版本。官方旧域名 URL 返回的文档正文现已使用“ChatGPT desktop app”等新名称；本文仍用“桌面应用”与 CLI 区分，不能将它倒推成早期版本行为。

## 1. CLI 本地 `spawn_agent`：会话隔离，不是自动文件隔离

实现链：[`tools/handlers/multi_agents/spawn.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs) 调用 `prepare_agent_spawn_config`；[`agent/child_config.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/child_config.rs#L102-L194) 从父 turn 构造配置，明确执行 `config.cwd = turn.cwd.clone()`，并继承运行时 sandbox/审批设置。

因此普通子代理共享父 cwd 的文件及 Git 工作区；父会话已经位于 managed worktree 时，子代理默认共享的是**那一个** worktree，而非各建一个。该 spawn 路径未包含 worktree 创建、步骤 commit 捕获或依赖 merge。共享 cwd 并不保证代理绝不能通过工具访问/创建别的目录；这里描述的是默认启动语义。

[`close_agent.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs#L31-L98) 调用 local-agent control 的 `close_agent`，处理关闭状态以及后代关闭失败；它不是 Git 清理 API，也没有删除 checkout、回滚文件或保存 diff 的动作。这里的 shutdown/close 与“清理文件工作区”必须分开：共享目录里已经写出的文件不能据此视为被撤销。

## 2. 当前 CLI managed Git worktree 模式

[`cli/src/main.rs::reject_unsupported_worktree_for_subcommand`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/cli/src/main.rs#L2157-L2198) 明确允许新交互会话、带显式 session ID 的 `codex fork`、`codex exec`、`codex exec fork`；不支持直接用该开关 resume 已有会话或 code review。它是**会话/执行入口级**隔离，不是 spawn 的逐子代理隔离。

实际分层：

- [`tui/src/worktree_startup.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/tui/src/worktree_startup.rs) 负责交互启动分配、来源信任检查及 thread 绑定；启动未完成绑定时，明确保留 checkout，并报告手动 `git worktree remove` 的恢复路径（提示不要用 `--force`）。
- [`exec/src/lib.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/exec/src/lib.rs#L292-L520) 有同样的 managed checkout 启动路径，检查 `worktrees` feature、local execution、来源信任；不允许与 `--ephemeral` / `--ignore-user-config` 同用，启动后将 cwd 改为新 checkout。约 L1100 将 checkout 绑定到 primary thread。正常退出路径关闭 app-server，没有看到自动删除该 checkout。
- [`worktree/src/lib.rs::WorktreeManager::create`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/worktree/src/lib.rs#L62-L165) 解析 base（默认 HEAD），执行 `git worktree add --detach --no-checkout`，再在目标目录 materialize 文件。该低层 create 不创建结果分支/ref，也未将 source 的脏文件复制为步骤输入；不能把桌面文档的未提交更改搬运语义直接套在此函数上。

### 已核实的清理触发和保留边界

1. **创建内部失败**：Git add 失败移除空 bucket；materialize 或 cwd 检查失败，内部 rollback 使用 `git worktree remove --force`。这是不完整创建的回滚，不是任务成功后的自动删除。
2. **已创建但启动/绑定失败**：交互启动保留目录并提示恢复；[`tui/src/app/managed_worktree_creation.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/tui/src/app/managed_worktree_creation.rs) 对后续失败同样报告 retained checkout。
3. **显式浏览器删除**：[`tui/src/worktree_browser.rs::remove`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/tui/src/worktree_browser.rs#L150-L170) 调用 manager remove；[`WorktreeManager::remove`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/worktree/src/lib.rs#L284-L330) 拒绝删除当前 checkout，额外拒绝 ignored 本地文件，最终调用**不带 force** 的 `git worktree remove`，让 Git 拒绝 dirty/untracked 工作区。

这些已检查的 CLI 路径**没有删除前自动 snapshot、结果专用 refs 或 diff 归档**。thread owner 元数据/会话记录不是代码快照。干净 detached checkout 若含新提交，不能因为“目录删除前检查干净”就推断其提交永久可达；该 remove 实现没有建立救援 ref。需要持久结果时，应先创建分支/保留提交或导出 diff，再手动删除。短时核查未穷尽所有 archive/delete/定时维护调用点，因此不将“未发现退出自动回收”升级成“所有 CLI 路径绝无回收”。

## 3. 桌面应用 worktrees：有独立自动回收与快照契约

官方 [Worktrees 文档](https://developers.openai.com/codex/app/worktrees) 当前明确规定：

- managed worktrees 默认位于 `$CODEX_HOME/worktrees`，默认 detached HEAD；选中有本地改动的 branch 时会把未提交更改应用过去；可以 Handoff 回 Local，或创建 branch 长期工作。
- 默认保留最近 **15** 个 managed worktrees；可调整上限或关闭自动删除。
- 自动删除触发为**归档关联 chat**，或**超过配置数量而删除旧 worktrees**；关联 pinned chat、仍进行中的 chat、permanent worktree 不自动删除。
- **删除 managed worktree 前保存工作快照**；重新打开关联 chat 后可恢复。permanent worktree 不因归档 chat 自动删除。

这是桌面应用产品文档的契约；不能推断 CLI `close_agent`、CLI 会话结束或上述 `WorktreeManager::remove` 都有同样机制。文档没有公开快照的具体 Git ref 命名、存储格式、GC 保活策略、精确保留期限；不能虚构 `refs/...` 或承诺快照包含所有 ignored 文件。该网页也明确限制 `.worktreeinclude` 复制说明的产品范围，不宜泛化到任何 CLI/Git checkout。

## 4. 云任务 apply：取回 diff，不是本地 worktree 生命周期

官方 [Cloud 文档](https://developers.openai.com/codex/cloud) 将 cloud task 定位为远端环境中的工作；CLI 可启动/查看云任务。本地 apply 的可见源码是：

- [`chatgpt/src/apply_command.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/chatgpt/src/apply_command.rs)：获取 task，读取 `current_diff_task_turn` 的 PR `output_diff`，构造 `ApplyGitRequest` 并调用 `apply_git_patch` 到本地 cwd。
- [`cloud-tasks/src/lib.rs::run_apply_command`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/cloud-tasks/src/lib.rs#L607-L626) 及 [`cloud-tasks-client/src/http.rs`](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/cloud-tasks-client/src/http.rs#L102-L126)：另一 cloud-task 命令路径调用 `apply_task` / preflight。

可验证的是**服务端任务输出 diff → 本地应用**，不是把本地 spawned child 的 worktree merge 回来。该客户端源码不能证明云容器的回收时机、服务端 diff 保留期限或内部 rescue refs；对此留白。

## 5. 与本仓库 isolated workflow 的比较（本地源码观察）

比较对象为本次读取的工作区文件，其他代理正在修改仓库，不是已发布版本保证：

- `pi-extension/subagents/workspaces.ts`：`initialize` 要求源 Git 工作区干净并固定 base；`prepare` 为每步骤创建 detached worktree，把直接依赖 output revisions merge 进去；`capture` 用 `git add -A` / `write-tree` / `commit-tree` / `update-ref HEAD` 捕获非 ignored 更改，记录 output SHA。
- `pi-extension/subagents/workflows.ts`：逐步骤 capture；单独 result worktree 合并叶步骤输出；isolated 模式要求 validation command，验证通过才完成。取消中的 cleanup 报错关注进程停止是否确认，不是抹掉成果目录。
- 已检查的两文件没有 worktree 自动 remove；目录、output SHA、验证日志保留供检查。**output SHA 记录不是专用保活 ref**：该实现更新的是 detached worktree HEAD，不应承诺外部删除 worktrees 后仍永久保留成果。

| 机制 | 文件隔离粒度 | 结果如何到达用户 | 已核实清理/保留 |
|---|---|---|---|
| 本地 spawn_agent | 默认共享父 cwd | 原地文件改动 + 子会话结果 | close 是代理关闭，不是目录清理 |
| CLI --worktree | 新主会话/exec checkout | 保留 checkout；用户自行集成 | 创建失败 rollback；显式删除拒绝脏/ignored 文件；未见这些路径有救援 ref |
| 桌面 managed worktree | 通常一 chat 一个 | Handoff / branch / 快照恢复 | archive/数量上限触发；保护 pinned/运行中/permanent；删除前 snapshot |
| Cloud task apply | 远端 task 环境 | 下载输出 diff 后本地 apply | 云端环境/输出保留期限未核实 |
| 本仓库 isolated | 每步骤 + 集成结果 checkout | dependency commit merges + validation | 保留 checkout/记录/日志；未见自动 remove 或专用持久 ref |

## 未解决范围

未运行实际任务或恢复/删除实验；未审计全部 CLI archive/delete 生命周期；桌面快照内部实现与 cloud 服务端生命周期未在允许来源中确认。结论只覆盖固定 0.159.0 源码路径和当日产品文档，不能当作旧 Codex CLI/旧桌面版本的行为说明。
