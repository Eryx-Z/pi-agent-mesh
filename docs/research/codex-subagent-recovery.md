# Codex 子代理关闭与恢复：源码核查

研究基线：OpenAI 官方 `openai/codex`，固定 commit [`687a119f0fcaace47e1f1abcc77cec6c813fd6da`](https://github.com/openai/codex/tree/687a119f0fcaace47e1f1abcc77cec6c813fd6da)（任务指定的 rust-v0.159.0 基线）。只读源码研究，未启动 Codex、模型或故障注入测试；不涉及 worktree 生命周期。以下区分源码事实、推论和未证实事项，不能把“没有检查错误”解释成“保证成功”。

## 结论先行

- **本地子代理不是每个代理一个独立 OS 进程**：它们是同一运行时管理的 `Arc<CodexThread>` / `Arc<Session>`，session loop 是 Tokio task。代理使用的 shell、MCP、executor 工具才可能有独立进程或远端执行位置。[1][2]
- **close 等待代理运行时终止，不是证明所有工具后代进程已消失**。`Closed` 是持久化的关闭意图/图边状态，也不是关闭确认。[3][8][9]
- **resume 是读取保存的线程历史并创建新运行时，不是复活旧 OS 进程**；已加载的线程直接复用，不会先替换它。V1 可自动恢复 Open 后代，V2 不走同一个 eager 恢复逻辑。[4][5]
- **不能据此宣称“关闭失败以后总会全自动恢复，无需用户”**。有自动清理、缺失/死亡容错和有条件的后代恢复；核查到的 app-server 退出路径超时后只记录警告，没有重试循环。[6][7]

## 1. spawn / ThreadManager 的运行时边界

本地 `spawn` 调用 manager 的 `spawn_new_thread_with_source` / `spawn_new_thread`；ThreadManager 随后调用 `Session::spawn`。`CodexThread` 持有 session 的 Arc 和 SessionIo，`Session::spawn` 用 `tokio::spawn` 启动 submission loop，并保存其终止 future。[1][2] 因而“父线程退出”与“整个宿主 OS 进程退出”必须分开讨论：前者不等于整个运行时死亡；后者会失去这些内存中的代理 task。不能从本地实现推广到自定义/远端 AgentControl。

## 2. close 确认、失败记录和重试

`close_agent` 的实际顺序见 [3]：

1. 获取目标当前状态/配置快照；非 ephemeral、图存储可用时，**先**把 spawn edge 写成 `Closed`。
2. live 目标持久化失败只 `warn!` 并继续关闭；known 但 unloaded 目标写 Closed 失败则返回错误。因此“关闭成功”和“关闭意图已经可靠落盘”也不能完全等同。
3. `shutdown_live_agent` 先 materialize/flush rollout，提交 `Op::Shutdown`（已 Shutdown 时不再提交），然后等待 `wait_until_terminated`；随后移除内存线程、释放 slot。
4. `shutdown_agent_tree` 获取内存树可达的 live 后代，关闭目标并逐个关闭后代；后代 `ThreadNotFound` / `InternalAgentDied` 可忽略，其他错误提前返回。known 目标的同类错误也可被 `close_agent` 转成成功。

**确认强度的限制**：终止 future 本身 `let _ = handle.await`，忽略 JoinError；因此“session loop 已结束”不保证它无 panic、且完成了所有清理。`shutdown_and_wait` 也允许 InternalAgentDied 后继续等待终止。[2] `close_agent` 返回的是关闭前快照；工具 handler 遇错误使用 previous status 生成完成事件，再返回错误，不提供独立的 `shutdown_unconfirmed` 状态或残留进程证明。[10]

**超时/记录**：上述 close 路径本身没有内置 timeout/retry 循环，flush、等待或后代关闭均可能失败或等待。另一个接口 `shutdown_all_threads_bounded(timeout)` 并发关闭所有已跟踪线程，分别返回 `completed`、`submit_failed`、`timed_out`；仅 completed 从 manager 删除，失败/超时保持内存跟踪，以便调用者检查或再次调用。[6] 这是**支持重试**，不是**自动重试**，报告也不是跨进程持久化的恢复队列。

app-server `shutdown_threads` 使用 10 秒 deadline，对失败/超时只 warning；in-process app-server 收尾调用它一次。服务器正常退出也调用它，而 forced shutdown 跳过这一优雅收尾分支。[7] 这些已检查路径中没有“重试直到确认”的控制器；不能由此断言整个仓库所有入口都没有其他策略。

## 3. resume：线程恢复，不是旧进程恢复

`resume_agent` 仅在 manager 返回 `ThreadNotFound` 时调用 `resume_agent_from_rollout`；其他错误直接返回，已加载实例直接返回。[4] 后者读取 stored thread（允许 archived），加载模型上下文，构造 `InitialHistory::Resumed`，沿已有线程启动路径创建 runtime、重新注册 metadata/listener、持久化 spawn edge。[5] 这不会恢复旧 shell PID、旧 stdin 或旧 RPC 连接。

V1 的恢复队列只查询持久图的 **Open** 子边；父恢复成功后逐层恢复，图查询或某个后代恢复失败只 warning，失败节点不再向下遍历。Closed 后代不会被该队列自动重开，但显式按 id resume 可以重新打开目标。配置或恢复出的版本为 V2 时直接返回，不 eager 恢复后代；ThreadManager 的 root V2 resume 分支另行恢复 metadata，供 lazy loading 使用。[5][11]

因此，“父恢复时自动恢复有条件的子线程”是直接证据；“重开父会话后所有中断任务自动继续执行/补跑副作用”不是这里证明的行为。恢复入口必须先被调用；历史文件/图存储可用、容量/配置允许也是前提。

## 4. 父退出时工具进程清理：有机制，但不是全树存活证明

### 正常 Session shutdown

`shutdown_session_runtime` 依次取消任务/预热、关闭 hooks，调用 unified-exec manager 的 `terminate_all_processes`、code-mode shutdown、MCP runtime shutdown 等；之后刷新线程持久化并发出 `ShutdownComplete`。持久化 shutdown 失败会发 Error，但仍可发 ShutdownComplete。[8]

unified-exec 的批量清理**先 drain 进程表，再调用 `terminate()`**。本地 handle 的 terminate 尝试 kill 并停止 I/O，kill 结果被忽略；远端 ExecServer 分支另起 Tokio task 调 terminate，结果也被忽略。即使源码另有 `terminate_confirmed`，批量 session cleanup 用的不是它；其本地分支也不是等待所有进程后代退出。[9] 所以 manager 表为空、ShutdownComplete 或代理 loop 已结束，均不能作为“所有工具进程都确认不存在”的充分证据。

### 本地 shell / PTY 和异常宿主死亡

Unix pipe 路径建立独立 process group，清理发送组信号；Linux parent-death helper 使用 `PR_SET_PDEATHSIG(SIGTERM)` 并复查 parent PID，非 Linux 该 helper 是 no-op。pipe 启动调用 parent-death 设置；ProcessHandle Drop 也尝试 terminate。[12] 这是降低遗留概率的机制，不是跨平台全部后代的保证：逃离原 process group 的进程不属于该组；parent-death signal 作用于设置它的直接子进程，不等价于递归杀死所有后代；SIGTERM 也不等于不可忽略的 SIGKILL。宿主 SIGKILL/崩溃不能依赖正常 Rust Drop 或 shutdown 完整执行。

### MCP：明确的升级策略，但仍有边界

本地 Unix MCP launcher 使用 NewGroup。其 terminate 对进程组先发终止信号，在“仍存在”的返回下开标准线程等 2 秒再 SIGKILL；第一次信号出错只警告，不进入该升级分支。transport close 先 terminate，再关闭 stdio；本地 transport 等子进程最多 3 秒后 kill。[13][14] 这是自动升级，**不是持久化的关机失败恢复控制器**。

远端 MCP terminate 失败会把 `terminated` 标记改回 false，允许后来再尝试；Drop 清理需要可用的 Tokio runtime，否则 warning 后返回。远端任务异步调度也不保证宿主退出前完成。[13] 本地 Unix 组机制与 Windows Job/Process fallback 不应混作一种保证。未穷举所有平台、executor backend、工具类型或逃逸场景，未验证 HTTP MCP 服务端任务是否因客户端断开而停止。

## 5. 对本插件的借鉴与不可照搬点

本地对照只读当前脏工作区：`pi-extension/subagents/rpc.ts:40-54` 每个代理 spawn 独立 RPC 进程；`tasks.ts:249-256` stop 失败保留 `stopped=false`，并丢掉 live 映射；`store.ts:65-81` 重载把不确认关闭的任务置失败并拒绝 continue。行号以本次研究快照为准，并非固定的插件 commit。

**可借鉴的设计方向（本研究不实施）**：

- 分离“用户/父代理希望关闭”“运行时终止确认”“工具进程清理确认”“可恢复的线程历史”，不要让一个 stopped 布尔值承载全部语义。
- 保留未确认实例的可操作 handle/记录，提供统一 reconciliation/retry 路径；Codex bounded shutdown 保留失败实例这一点，比“只留阻塞状态、没有恢复入口”更有启发性。
- 宿主正常退出自动清理 + 信号升级 + 可验证身份的残留检查；确认旧执行实例结束后，沿持久会话创建新执行实例。无需把常规恢复调查推给用户，但身份/确认失败时应安全阻塞而非冒险并发重开。
- 明确哪些子边仍需恢复，哪些是显式 Closed；把恢复失败作为可观察结果，避免只有 warning 却宣称整棵树已恢复。

**不可照搬**：Codex 的 ThreadNotFound 是内存 ThreadManager 事实；本插件重载后“live map 无记录”不证明独立 RPC 进程已死亡。Codex 释放 Arc/thread slot 也不等于外部进程 kill/wait。不能直接把 `stopped=false` 改 true、以历史存在代替停机证明，或在旧 RPC 是否活着未知时直接启动第二个写入者。进程身份、重用 PID、防重复实例和进程组/平台清理边界必须另行设计验证。

## 证据与未证实清单

全部远端引用均来自同一官方固定 commit；研究仅下载源码至 `/tmp/codex-recovery-research/` 并逐段核查，未执行上游测试。源码中的测试可作为设计意图补充，但不计作本次运行通过。**未证实**：每类工具在强制宿主死亡后无孤儿、全自动跨重启重试、所有 Open 后代恢复成功、恢复后自动重放未完成任务。现有直接证据支持“内存线程生命周期 + 历史恢复 + best-effort 工具清理”，不支持“普遍的 shutdown-unconfirmed 自动消解保证”。

[1]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/control/spawn.rs#L711-L807
[2]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/session/mod.rs#L925-L938
[3]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/control/legacy.rs#L7-L122
[4]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/control/resume.rs#L13-L37
[5]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/control/spawn.rs#L1245-L1433
[6]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/thread_manager.rs#L1375-L1424
[7]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/app-server/src/request_processors/thread_processor.rs#L1283-L1294
[8]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/session/handlers.rs#L292-L381
[9]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/unified_exec/process.rs#L239-L272
[10]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs#L67-L108
[11]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/thread_manager.rs#L2172-L2182
[12]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/utils/pty/src/process_group.rs#L1-L118
[13]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L429-L548
[14]: https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/rmcp-client/src/local_stdio_transport.rs#L91-L100

补充精确定位：

- `Arc<Session>` / SessionIo 字段：[codex_thread.rs:189–197](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/codex_thread.rs#L189-L197)；ThreadManager 调 Session::spawn：[thread_manager.rs:2256–2320](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/thread_manager.rs#L2256-L2320)。
- 终止确认忽略 JoinError：[session/mod.rs:1042–1051](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/session/mod.rs#L1042-L1051)、[1121–1128](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/session/mod.rs#L1121-L1128)。
- app-server 收尾调用点：[in_process.rs:591–599](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/app-server/src/in_process.rs#L591-L599)、[lib.rs:1314–1326](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/app-server/src/lib.rs#L1314-L1326)。
- 批量工具清理 drain：[process_manager.rs:1796–1812](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/unified_exec/process_manager.rs#L1796-L1812)；本地 best-effort kill/Drop：[pty/process.rs:219–276](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/utils/pty/src/process.rs#L219-L276)；pipe 配置：[pty/pipe.rs:150–170](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/utils/pty/src/pipe.rs#L150-L170)。
- MCP NewGroup：[stdio_server_launcher.rs:278–294](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L278-L294)；transport close：[136–146](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L136-L146)。
