# pi-agent-mesh 可插拔角色 V1 Codex 实施指令

日期：2026-10-19  
目标仓库：https://github.com/Eryx-Z/pi-agent-mesh  
审查基线：`a16abfdda11751d7e518b2b910fd99860085a8d5`，包版本 4.0.1。  
配套产品目标：`pi-agent-mesh-goals.md`。  
本文件是待执行规范；不得把本文描述的新能力当作已经存在。

## 0. 执行目标

实现可插拔角色 V1：启用项目团队配置后，Pi 主会话进入 PM 模式；PM 按角色 ID 创建 Builder、Tester、Reviewer；每个实例按角色配置独立装配 system prompt、skills、MCP 和本地工具，并复用现有任务、RPC、DAG、worktree、恢复和 UI。

完成代码、配置 schema、四个内置角色、测试、样例与文档。按 M0–M5 推进，完成一个阶段后继续下一阶段，以第 13 节作为最终完成条件。

执行前读取仓库实际存在的 AGENTS.md、package.json、当前源码与测试。记录实际 HEAD 与本文基线的差异；已有等价实现直接复用，保留用户现有改动。本文函数名是建议的内部接口，外部配置和验收语义为实施约束。

### 范围与版本

- 本期包含 PM 入口、可插拔角色、两种 MCP transport、独立能力装配、持久快照、步骤级角色与上下文、恢复回归。
- 结构化 verdict、自动 repair round、自动合并、角色市场和跨任务连接池属于后续版本。
- 角色功能验证基线为对齐的 Pi 1.0.2 三包；测试 Node 22.19+ / Node 24。
- 保留无 `role` 的旧 API 行为和历史记录。优先通过按需加载新适配层维持 0.99.0 的原有非角色路径；角色模式在旧版本明确报不支持。不要让新原生 MCP 的静态导入破坏旧路径。
- 若实际 API 使上述版本分支不可维护，先用最小测试证明，再统一提高最低版本、更新 peerDependencies/README/迁移说明；不得继续宣称未验证的兼容范围。

## 1. 现有实现与必须保留的契约

| 位置 | 当前职责 | 本期接入方式 |
| --- | --- | --- |
| `index.ts` | 工具、生命周期、通知 | 分支解析 role，接入团队入口和角色目录 |
| `loadout.ts` | 父 active tools、全部 loaded skills 的快照与校验 | 原有继承路径保留；复用通用校验能力 |
| `tasks.ts` | 进程、预检、任务开始/停止/继续/恢复 | 加入角色启动计划与实际运行清单 |
| `child.ts` | ask_question、预检、工具调用保护 | 验证角色装配结果和实际能力 |
| `store.ts` | 任务记录、原子保存、锁 | 版本化角色快照与历史兼容 |
| `context.ts` | 上下文和共同协作指令 | 固定角色提示组合规则 |
| `workflows.ts` | DAG、步骤派工、整合验证 | 保存每步角色计划和独立上下文 |
| `execution.ts / lease.ts / rpc.ts` | 执行边界、所有权、RPC | 继续作为唯一生命周期基础 |
| `ui.ts / dashboard.ts` | 任务展示和控制 | 增加角色、配置摘要、能力和预检状态 |

保留以下语义：

1. 子任务不能再次派生或管理 Agent；团队管理工具只提供给主会话。
2. 请求 accepted、模型执行结束、进程确认停止、用户验收是不同状态。
3. `none / partial / full` 只控制会话信息，不授予能力。
4. 未指定 role 时继续使用父 active tools / loaded skills 继承。
5. 指定 role 时只装配角色显式声明的能力，不与 PM 的 active tools 求交。
6. `full` 不补齐宿主工具；`read-only` 保留原有严格过滤语义。
7. 继续旧任务不重新查询当前角色目录。
8. 清理未确认时保留任务锁，禁止启动替代写入者。
9. 保留 ask_question 的实现来源保护和模型 provider 明确选择，不能静默 fallback。

## 2. 配置协议

### 2.1 团队配置 TeamConfigV1

默认位置：`<启动 cwd>/.pi/agent-mesh.yaml`。

以下选择规则用于新会话；已有 PM 会话的恢复先按第 8 节读取持久快照：

1. `PI_AGENT_MESH_CONFIG` 非空时，只使用该路径；相对路径相对启动 cwd。
2. 否则只查默认位置，不递归向上搜索。
3. 默认文件不存在或 `enabled:false`：关闭团队模式，保留旧行为。
4. 显式指定的文件不存在，或启用文件无效：显示具体错误，阻止进入一个伪装成功的 PM 会话。
5. 路径在父会话启动时固定；子任务和 worktree 中不重新发现团队配置。
6. 沿用 Pi 的项目可信状态；角色目录摘要可以读取，项目代码资源的执行遵循宿主已有的信任机制。

```yaml
schema_version: 1
enabled: true
main_role: pm
roles:
  pm: builtin:pm
  builder: ./roles/builder/role.yaml
  tester: builtin:tester
  reviewer: builtin:reviewer
mcp_servers: {}
```

字段规则：

- `schema_version` 必须为 1；未知字段报错。
- `roles` 是 ID 到 `builtin:<id>` 或角色 manifest 文件路径的映射。
- 映射键必须与 manifest 的 id 一致；main_role 必须存在。
- 相对角色路径相对团队配置文件目录；canonicalize 后保存。
- 不做四级目录发现、字段深度合并或同名静默覆盖。
- 未选入 roles 的包不会出现在 PM 的可选目录中。
- 内置四个角色默认不依赖外部 MCP 或用户自定义工具，能够独立安装和测试。
- `mcp_servers` 保存服务定义；角色 manifest 只引用服务 ID 与精确工具名单。

MCP 服务配置沿用 Pi 1.0.2 支持的明确子集：stdio 的 `command/args/cwd/env`，Streamable HTTP 的 `url/headers`，以及 `timeout/description`。连接暴露由角色适配层生成，不接受用户在这里覆盖 exposure/toolExposure。

- command 是可执行文件，不是 shell 命令串。
- 省略 stdio cwd 时使用该任务实际 cwd，包含隔离 worktree。
- 显式相对 cwd 相对团队配置文件目录；在 RolePlan 中固定为绝对路径。
- args 按字面量传递，其相对路径由进程 cwd 解释，不尝试猜测哪些参数是文件。
- env/headers 可使用 Pi 的环境变量引用；缺失变量准确报错。
- V1 不增加凭据命令求值、后台交互登录或自己的 OAuth 流程。可使用预先配置的凭据；如需登录，报告角色和服务名。
- 凭据引用可持久化，解析后的值不得写入任务快照和日志。
- role 模式不读取全局/项目 mcp.json 来补充未声明服务。

### 2.2 角色配置 RoleManifestV1

```yaml
schema_version: 1
id: builder
description: 实现功能并修复缺陷
system_prompt: ./system.md
skills:
  - ./skills/coding/SKILL.md
builtin_tools: [read, grep, find, ls, edit, write, bash]
mcp: []
extra_tools:
  - entry: ./tools/test-runner.ts
    tools: [run_tests]
defaults:
  model: inherit
  context: partial
  access: full
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| id | 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$` |
| description | 非空，供 PM 选择角色 |
| system_prompt | 必填 UTF-8 文件路径；不同时解释成内联文本 |
| skills | 精确 SKILL.md 路径数组；不扫描邻近目录 |
| builtin_tools | 精确内置工具名，禁止通配符与重复项 |
| mcp | `{server: string, tools: string[]}` 数组；tools 为服务器原始工具名，非 Pi 包装名称 |
| extra_tools | `{entry: string, tools: string[]}` 数组；entry 为工具型 Pi 扩展文件 |
| defaults.access | 必填 `read-only / full` |
| defaults.context | 可选 none/partial/full；解析 manifest 时保留“未填写”，派工时按下述优先级决定 |
| defaults.model | 可选 provider/model 或 inherit；省略/inherit 表示本层不指定模型 |

所有资源路径相对 manifest 目录，解析后 canonicalize。资源缺失、重复 ID、重复技能名、重复工具名、未知字段、缺少 MCP 引用均报出角色 ID、来源文件和字段路径。

skills/MCP/extra_tools 缺省为空数组。加载 skill 元数据与正文时复用 Pi 公开的技能加载能力，保持 disableModelInvocation 行为。Skill 不自动扩大工具清单。

### 2.3 覆盖规则

- 独立派工的模型：调用显式 provider/model > 角色非 inherit 的 defaults.model > 父会话当前模型。
- 独立派工的上下文：调用显式值 > 角色明确填写的 defaults.context > partial。
- inherit 仅用于角色配置；调用参数仍要求实际 provider/model。静态解析不提前填入 partial 或当前父模型，工作流解析遵循第 3.3 节。
- access：调用显式值 > 角色 defaults.access。
- `partial` 始终要求有效 contextText；不能自动复制完整父历史补缺。
- task/cwd/name 属于任务实例，不写入可复用角色职责。
- V1 不允许模型通过 subagent 参数临时添加 skill、MCP 或扩展来源。
- `read-only` 在资源启动前移除 MCP 和 extra_tools，只保留角色声明中已有的 verified builtin read/grep/find/ls，加 ask_question。保留 available 能力计划，以便明确的 full continuation 恢复原授权清单。
- 输出必须能区分角色声明能力和当前 access 下实际启用能力。

## 3. 对外使用接口

### 3.1 主会话

新会话启用有效配置后，普通 `pi` 启动进入 main_role，默认 pm。默认文件不存在或明确 disabled 时保留普通会话；显式路径错误或启用配置无效时报告失败，不静默降级。

新增：

- `/roles`：角色目录、描述、来源、默认配置与静态配置错误。
- `/roles inspect <id>`：角色 prompt 路径、skills、声明工具及 MCP 引用；不因此连接服务。
- `/roles reload`：重新验证并原子替换目录。失败保留上一版。只影响之后的新任务和新工作流；PM 自身资源变更在新会话生效。
- `roles_list` 工具：PM 可读的精简目录，仅主会话注册。新增该名字时同时更新委派工具过滤规则。

PM 初始上下文只包含自己的角色正文、自己的 skills 和目录摘要。目录摘要不能宣称服务已就绪；角色真正可运行由派工预检判定。

### 3.2 subagent

给现有工具增加可选 role：

```json
{
  "role": "builder",
  "task": "实现已确认的变更",
  "context": "partial",
  "contextText": "需求、范围、验收条件和目标代码位置"
}
```

- 有 role：access 可由角色默认值提供。
- 无 role：保留 access 必填与现有全部语义。
- 采用 schema union 或等价的运行时条件验证，不能让旧调用意外获得默认 full。
- 回执显示 roleId、配置摘要、effective access/model/context 和任务 ID。
- 结果、问题和历史继续使用现有 subagent_control。
- continue 不接受新的 role；变更角色创建新任务。
- 主会话的管理能力由运行时注入，worker manifest 不能声明取得。

### 3.3 工作流

StepDefinition 新增可选 `role/model/context/contextText/dependencyReports`。

- 无 role 且无新增字段的旧步骤，完全保留当前行为。
- role 步骤模型：步骤显式 provider/model > 角色非 inherit 的 defaults.model > workflow 显式 provider/model > 父会话当前模型。角色省略/inherit 不截断 workflow 默认值。
- role 步骤上下文：步骤显式 context > 角色明确填写的 defaults.context > workflow context > partial。保留 manifest 中字段是否填写，直到创建 workflow 时再解析。
- partial 优先用步骤 contextText；缺省可用 workflow contextText；仍缺失则 workflow 创建失败。
- `dependencyReports` 为 include/omit：旧步骤默认 include；role 步骤当有效 context 为 none 时默认 omit，其余默认 include。可显式覆盖。
- omit 只省略上游文字报告和会话链接，仍正常合并 dependsOn 的代码版本。
- 创建 workflow 时，为各步骤保存已解析 RolePlan、默认值与父上下文快照；派工时只绑定实际 worktree cwd。
- 工具实际定义仍在各子进程预检后冻结；资源已漂移则暂停对应步骤，不重新套用最新角色。
- 配置 reload 不改变已创建工作流；显式 update 新增或修改未启动步骤时生成新的 RolePlan。
- 保留原有 retry、暂停、worktree、整合和清理语义，不引入循环图。

## 4. 数据模型与两阶段预检

建议新增 `role-loadout.ts`，区分三层：

### RoleManifest

用户配置。允许相对路径、inherit 和凭据引用；只用于解析新任务。

### RolePlan

父进程在派工前保存的可序列化计划：

- roleId、manifest canonical path、内容 hash、配置 schema 版本。
- 已解析 system prompt 正文及组合版本。
- 技能 canonical/load paths、SKILL.md hash、已知元数据。
- builtin 名单、extra_tools 的原始入口/hash/选中工具。
- MCP server ID、非秘密连接配置、凭据引用、选中原始工具名。
- 创建时解析的 model、thinking、context、初始 access、逻辑工作目录。
- 固定角色声明的 available 能力计划；每次 run 的 effective access 和启用计划另存，continue 不修改原授权范围。
- 工作流计划的 cwd 可在派工时绑定到本步骤 worktree，其余配置保持冻结。

同时持久化完整 TaskInput：原 task、有效 context、partial contextText、full 模式的父消息快照或其持久引用、parentSession 和实际 cwd。继续时另存该 run 的 continuation message 与 effective access。不能只保存 task 文本，依赖进程内变量恢复选定上下文。

### RoleSnapshot

每个 run 独立保存，子进程完成装配后得到的实际运行清单：

- RolePlan 摘要。
- 实际 ToolDefinition 元数据：name、schema、description、exposure、namespace、annotations。
- 语义来源：builtin / local-tool / mcp。
- Pi 返回的实际 sourceInfo，以及原始文件或 server/config 身份。
- 实际加载的 skill inventory。
- Pi 版本、最终模型参数、effective access 和预检完成标记。

另外保留任务级“历史已验证工具定义”基线，包含来源、名称和实际定义。收紧 access 不删除该基线；首次启用原已授权能力时的规则见第 7 节。

Pi 没有已确认的 `sourceInfo.source="mcp"` 类型。自行增加 semantic kind，原样保留实际 sourceInfo。通过文件 wrapper 注册的工具可能显示 wrapper 的来源；必须另外保存真正的入口文件或服务器配置身份。

### 启动顺序

1. 父进程保留现有同步容量/名称预留与任务锁，先保存 RolePlan、TaskInput 和本次 run 输入，标记尚未完成预检。
2. 在现有执行边界内启动 child，仅加载必要的角色桥接资源。
3. child 加载技能和选中的本地工具，连接选定 MCP，等待必需能力就绪。
4. child 校验实际清单，写入独立的 preflight 结果。
5. 父进程验证结果属于当前 taskId/run/attemptId/nonce，对比历史已验证定义，并原子保存本 run 的 RoleSnapshot 与更新后的定义基线。
6. 完成角色允许列表和来源校验后，才发送真实任务 prompt。

沿用现有 slash-command preflight。角色结果建议写入任务目录的原子 sidecar，绑定每次启动 nonce；不要向 JSONL stdout 写自定义日志，不复用旧 run 的结果。

首次 actual tool schema 可在 child 中发现，但授权来源和允许工具由父进程先固定。收到 RPC receipt 不代表预检通过，必须检查对应 manifest 和所有必需资源。

### CLI 工具名单的实施门槛

MCP 工具名称可能规范化、截长和去重，不能提前简单拼接。M0 必须验证动态注册与 CLI --tools 的交互。

- 若可用实际发现名单构造 CLI 限制，则继续使用。
- 若未知名称导致无法提前列出，角色路径可延后形成工具清单；整个阶段必须禁止模型请求，预检后设置精确 active 列表并使用 tool_call 允许列表覆盖间接调用。
- 这种分支只适用于 role 路径；不能削弱无 role 路径的现有 CLI 限制。
- 不允许用通配授权、关闭 verifyTools 或移除来源检查解决命名问题。

## 5. 本地工具与系统提示词

### 5.1 extra_tools 的 V1 契约

entry 是“工具型 Pi 扩展”：加载时只注册 ToolDefinition，执行通过工具 execute 收到的 ctx 访问会话。V1 不把带任意 hook、command、provider、MCP 注册或后台服务的整个插件当作 extra_tools。

优先使用公开 `loadExtensions(paths, cwd, eventBus?, runtime?)` 在独立加载上下文收集工具定义：

1. 每个 canonical entry 只加载一次。
2. 检查加载错误与不支持的注册行为。
3. 按 entry + 精确工具名选择定义；缺失或重名报错。
4. 只将选中定义注册到真实会话，默认以 direct 暴露。
5. 保留实际 wrapper 来源与原 entry/hash 的映射。
6. 独立上下文不绑定到真实主会话；检查并释放 event bus 等资源。检查范围包括 handlers、commands、flags、providers、MCP registrations 等，不只看 tools 表。

不能仅加载大扩展后隐藏模型列表；未选择的定义不应进入真实会话的可调用集合。仍保留 tool_call 精确允许列表及 nested call 验证。

模块导入会执行可信本地代码；这个契约是接口范围，不是代码沙箱。若公开 loader 不能可靠支持工具型契约，实施一个更窄的工具工厂适配器，并同时修改 schema、示例和测试，保证对外语义不变。

### 5.2 提示词与 skills

- child 提示组合：Pi 基础系统提示 + 固定角色正文 + 运行时共同协作约束。
- task 和 context 是任务输入，不能写回角色文件。
- 保存最终采用的角色正文和组合版本；continue 不重新读取新正文。
- 保留 Pi skills 的渐进加载语义，不把所有 SKILL.md 正文拼进系统提示。
- PM 通过实际支持的 systemPromptOptions.sections/skills 设置自身内容，防止重复追加。
- 角色正文不可以取消运行时的委派限制、工具限制和问题桥接。

## 6. MCP 角色适配层

### 6.1 优先复用 Pi 1.0.2 原生实现

本地已确认根导出 `createMcpExtension` 和 `McpExtensionOptions`，有 `loadConfig` 注入点。新增文件型 `role-mcp.ts` wrapper，复用原生 transport、结果转换和关闭流程。不要预先增加第二套 MCP SDK。

需要以安装版本核对的文件：

- `node_modules/@earendil-works/pi-coding-agent/docs/mcp.md`
- `dist/index.d.ts`
- `dist/extensions/mcp/index.d.ts` 与 `index.js`
- `dist/core/extensions/types.d.ts`
- `dist/core/mcp-servers.d.ts`

### 6.2 连接集必须精确

- loadConfig 只返回本次角色的服务器配置；使用实际 LoadedMcpConfig 结构，不照抄未经类型验证的伪对象。
- 同时控制原生 extension registration 入口。原生 MCP 还会追加 getMcpServers() 和后续 mcp_servers_change 中的服务器；适配层必须过滤到角色清单，或向其提供空注册集合而完全由 loadConfig 供给。
- 不连接全局/项目 mcp.json 的服务器，不允许同名配置覆盖角色来源。
- 未选中的角色只出现在目录中，不启动其 MCP。
- 不通过修改用户全局 mcp.json 达到隔离。
- PM 自身 MCP 也遵守上述清单；团队模式中加载受控 wrapper 时，验证它与宿主默认 MCP 扩展的替换机制，避免重复连接。无法隔离的插件冲突必须准确报错。
- `--no-extensions` 会禁用内置 MCP；child 通过显式加载受控文件 wrapper 获得它。

### 6.3 暴露与授权

- V1 只将选中工具设为 direct；server 默认 hidden，精确 toolExposure 允许选中名称。
- autoEnableCodemode=false；本期不自动引入 codemode/tool_search。
- MCP 自动生成的 resource tools 不因连接而自动获得授权。
- setActiveTools 仅是其中一层；tool_call 必须对实际工具名单再次检查，包括 ctx.executeTool 的间接调用。
- 新增远端工具不自动进入允许名单。已授权工具被移除或定义变化时，在下一次调用前阻止漂移；重新运行需显式新任务。
- MCP readOnlyHint 等 annotations 是服务器声明，不能用来扩大 read-only 权限。
- 采用 Pi 实际生成的工具名及映射，不手写 mcp__server__tool 拼接替代其碰撞处理。

### 6.4 就绪与故障

registerMcpServer 成功只表示登记配置。原生首轮等待最多约十秒，超时后可继续；现有 command preflight 不会自动得到这个等待行为。

实现有截止时间的 readiness 屏障：

- 所选服务已连接、所有必需工具已发现、schema 合法，才能完成角色预检。
- 角色启动 readiness 阶段共用一个 30 秒绝对 deadline，使用可注入的内部常量；各 RPC/服务使用剩余时间，不逐项重新计时。不要把等待伪装成模型任务。
- 当前 RpcProcess.request() 统一使用 15 秒并在超时后停止 child，不能直接拿它等待上述预检。增加单次请求 timeout 参数或等价专用方法；角色启动中的 readiness/preflight 请求使用剩余 deadline 加 5 秒通信余量，普通请求保持 15 秒。内部 30 秒门禁仍须按时失败，通信余量不延长能力就绪期限。
- 优先复用原生可验证的等待机制。Pi 1.0.2 的非 TUI /mcp 命令等待 pending，可在最小集成测试中验证；命令回执之后仍必须校验实际工具，不从自然语言状态文本猜成功。
- 如需包装 transport 工厂观察连接状态，使用公开接口并测试；不要臆造 awaitMcpReady API。
- 超时、鉴权缺失、服务失败、缺少工具时，本次真实模型调用次数必须为零，任务失败并清理已启动资源。
- Pi before_agent_start hook 抛错可能被宿主捕获后继续，因此不能单独依赖 throw 阻止模型请求。
- child 使用父端 command preflight 门禁；PM 未就绪时在 input handler 返回 handled 或其他已证实能阻止请求的路径，显示具体错误。运行时触发的恢复通知、问题和结果也必须通过第 8 节的同一就绪门禁。
- 测试服务在第 20 秒就绪可成功、超过第 30 秒则失败且零模型调用并完成清理；通过可注入时钟或按比例缩短时间避免让常规测试实际等待几十秒。

### 6.5 调用、结果和关闭

- 保留原生 content、structuredContent、isError 和协议错误差异，不降级为只取第一个文本块。
- 传递取消信号，分别测试连接超时、工具调用超时与父任务取消。
- 原生请求 timeout 可被 progress 重置；本期沿用其请求超时语义，不把它宣传为任务总时限。持续 progress 时，父任务取消仍必须及时生效并完成清理。
- 调用状态未知时不盲目重放有副作用的请求。
- 正常完成、启动失败、取消、父退出时关闭本任务连接和本地 stdio 服务。
- HTTP 关闭的是本任务客户端资源，不停止远端服务器，也不声称撤销远端副作用。
- stdio 进程位于当前 child 执行边界中；确认整个边界清理后才能释放锁。

## 7. 持久化、继续与恢复

### 记录版本

建议角色 TaskRecord/Loadout 使用 v3，旧 v1/v2 读取路径保留；WorkflowRecord 带新步骤计划时使用新版本。具体类型可以拆成 discriminated union，不能给旧记录猜测补 role。

- 展示历史记录不要求当前角色文件仍存在。
- 继续角色任务从记录里的 RolePlan/RoleSnapshot 重建。
- 更改 manifest 或 system.md 并成功 `/roles reload` 后，新任务用新配置；新会话也读取新配置。旧任务仍用已保存正文、名单和模型。
- 校验旧任务实际依赖的 skill 文件、本地工具入口、所选 MCP 工具定义与来源。
- 入口缺失/hash 变化或远端 schema/source 变化时，在模型请求前拒绝继续，保留历史可读。
- 原 manifest 删除本身不应阻止继续；只要快照所引用的实际运行资源仍可重建。
- 凭据正常轮换允许使用新值，不能把 secret 值纳入配置 hash 或记录。
- 明确 hash 范围：manifest 内容、system prompt 正文、SKILL.md、extra_tools 入口。它们引用的脚本、第三方包及远端实现不自动获得内容冻结保证。
- 旧快照迁移必须有测试；不要把所有历史记录在启动时无条件重写。

### access 变化与首次发现

- 原 RolePlan 的 available 能力范围不变，每次 continue 重新计算本 run 的 effective 能力。
- read-only 启动不加载 MCP/extra_tools，因此可能没有它们的 actual schema。显式 full continuation 可以首次加载原计划已授权但从未启用的能力；预检成功后冻结定义，在保存完成前不调用模型。
- 已发现过的能力始终与历史已验证定义比较。full → read-only 不清除基线，再次 full 时仍检查漂移；不能借 access 切换接受新定义。
- 自动恢复沿用被中断 run 的 effective access，不自行升级。显式升级已持久化但在预检期间中断时，恢复该已获授权的 run；新定义仍须完整预检。
- 升级预检失败只留下该 run 的失败与清理记录，不覆盖最后有效快照或用半份清单更新基线。

### 只有 RolePlan 时的恢复

- 分清“预检未完成”“实际清单已保存”“模型提交已开始/回执未知”，使用持久状态，不能只看进程是否退出。
- 本 run 尚无有效 RoleSnapshot 时，根据启动顺序可知真实任务尚未提交。确认旧执行边界已清理后，使用原 RolePlan 和保存的 TaskInput/本 run 输入重新预检。
- 尚无历史定义的能力走首次发现；已有历史定义的能力继续比较。不得要求新任务匹配不存在的旧快照，也不得重新解析当前 manifest。
- 预检完成后才能进入现有提交与恢复流程，仍受容量和 recoveryRuns 限制。已进入提交而结果未知时保留现有保守恢复规则，不因新增角色机制盲目重放任务或工具调用。

### 两处恢复修复

**遗留锁：** completeCleanup 当前先保存 stopped=true，再删除任务锁。终态保存后崩溃会留下锁，恢复器可能跳过。取得 owner lease 后，针对清理已确认的终态记录执行幂等旧锁回收。不得仅靠文件年龄删除，也不得释放未确认停止的写入者锁。

**恢复容量：** 当前先消耗 recoveryRuns，再调用 continue；并发不足会留下 cleaning + 已耗尽预算。增加等待容量语义或等价队列：先清理，获得恢复执行容量后再持久化消耗预算并提交。等待期间不能消耗次数；不能因同一记录反复检查而重复启动。保存后尚未提交就崩溃，仍沿用原有保守的次数/不重复提交边界。

回归必须覆盖：三个中断任务以 maxConcurrent=1 重开，逐一释放容量后所有可恢复任务都获得一次恢复机会，且任何时刻不超限。

## 8. PM 与工作流具体行为

### PM

- 读取自身角色和角色目录摘要，保持主会话连续。
- 主要通过团队工具委派；自身 builtin_tools 可只含读取工具。
- 当前团队管理工具由运行时加到 PM 有效集合，不从 worker 配置继承。
- 使用 task + contextText 传递需求与验收条件；不默认复制全部主对话。
- 子任务提问回到 PM；用户继续只在主会话沟通。
- 检查子任务报告中的测试依据，再给用户交付。
- 对坏配置、未就绪角色和失败任务，输出具体错误及可执行下一步。

PM 自身也需要持久快照，不能只保存 worker 的 TaskRecord：

- 首次启用时，通过 pi.appendEntry 或等价的会话持久记录保存 PM RolePlan、实际清单、提示组合版本与团队配置路径；首次模型调用前完成保存。
- session_start 也可能发生在恢复、切换或扩展 reload 时。先检查当前会话是否已有 PM 记录；已有时恢复其提示词与资源，不重新用当前 main_role 替换。
- 原 PM manifest 修改或删除不影响读取旧会话；只验证快照所需实际资源能否重建。新建会话才采用新的 PM 配置。
- 派工目录独立加载。当前目录无效时报告无法派出新角色，仍可恢复有效 PM 快照并管理已有任务；不能把目录错误悄悄变成另一个 PM。会话内 `/roles reload` 失败保留上次有效目录，成功只更新派工目录及摘要。

用明确的 `initializing / ready / failed` 状态控制主会话启动：

- 用户输入与运行时内部触发都经过门禁；只设置 before_agent_start 并抛错不满足要求。
- TaskManager 的清理、所有权检查可继续执行。任务/工作流结果、问题和恢复通知在 initializing 期间入队，不执行 triggerTurn:true；ready 后按既有通知去重规则投递。
- failed 时保留可检查的记录并显示故障，不因排队通知自动启动模型。不得仅依赖 input handler 阻止 pi.sendMessage 的内部触发。
- 真实 RPC 测试覆盖 PM 尚未就绪时到达的恢复结果和提问，主模型调用计数必须为零。

实现 PM 的资源注入时使用实际 Pi API：registerFlag/getFlag 可选，但本期启动入口以配置文件为准；resources_discover / loadSkills / before_agent_start 的执行顺序必须用真实 RPC 测试确认。不要只在 session_start 修改一个变量就宣称首次系统提示已改变。

### Workflow

- 给有 role 的步骤冻结各自的 RolePlan，不复用一份全局 loadout 冒充不同角色。
- shared/isolated、写入排他与 maxParallel 继续按现有规则。
- 依赖代码版本照常传播；上游报告继承遵循 dependencyReports。
- Reviewer 的默认 none/omit 与 Builder 的 partial 可以出现在同一 workflow 中。
- 原有 capture、validationCommand、retained refs、cleanup 和 retry 限制保持回归覆盖。
- 本期不会把自然语言“审查失败”自动改成进程失败，亦不自动增加返工节点。

## 9. 建议文件变更

新增文件名可按仓库习惯调整，职责保持清晰。

| 文件或目录 | 交付内容 |
| --- | --- |
| `pi-extension/subagents/roles.ts` | TeamConfig/RoleManifest 验证、显式注册、目录快照 |
| `pi-extension/subagents/role-loadout.ts` | RolePlan/RoleSnapshot、默认值解析、能力与来源验证 |
| `pi-extension/subagents/role-tools.ts` | 本地工具型扩展加载和选择注册 |
| `pi-extension/subagents/role-mcp.ts` | Pi 原生 MCP 的受控配置、就绪与生命周期适配 |
| `pi-extension/subagents/pm.ts` | 团队启动、PM 持久快照、资源与目录注入、所有触发路径的就绪门禁 |
| `roles/{pm,builder,tester,reviewer}/` | role.yaml、system.md、需要的 skills |
| `schemas/` | 团队和角色 JSON Schema，便于编辑器验证 YAML |
| `examples/team/` | 无外部 MCP 依赖的最小团队；独立自定义工具/MCP 示例 |
| `test/fixtures/` | 工具型扩展、stdio/HTTP MCP 服务、角色配置、脚本化 provider |

修改 index/tasks/child/loadout/store/context/workflows/ui/dashboard，并在 package.json 的发布 files 中包含所有运行时角色资源、schema 和示例。

YAML 若缺少直接依赖，添加成熟解析库并锁定验证版本；不要手写 YAML parser，也不要依赖未声明的传递依赖。验证逻辑统一，避免 schema 与运行时规则各写一份而漂移。

## 10. 分阶段实施

### M0 基线、恢复与 API 最小验证

- 记录当前 HEAD、依赖版本、类型检查和现有测试结果。
- 复现并修复第 7 节的两个恢复场景；若已修复，补足回归。
- 用真实 Pi RPC + 脚本化 provider 验证：角色提示进入首轮请求；PM 无 bash 时 worker 仍能独立获得 bash；动态工具注册与 CLI allowlist 的交互。
- 验证 createMcpExtension(loadConfig)、额外注册过滤、就绪屏障、专用 RPC 请求期限和未就绪零模型请求。
- 明确本期采用的主/子会话 MCP wrapper 装配与 PM 门禁。不能用 hook throw 当作未证明的停止机制。

通过条件：关键 API 有可运行证据；没有通过放松权限或验证解决集成问题。

### M1 配置、目录与内置角色

- 实现第 2 节协议及精确诊断。
- 提供四个角色包，每个具有相应职责、skills 和工具清单。
- 提供无网络副作用的目录查询与 reload。
- 校验路径 canonicalization、未知字段、重复名称、partial 缺少 contextText。

通过条件：配置样例可由生产解析器加载；角色目录展示与配置一致。

### M2 角色执行与快照

- 保留旧继承分支，新增角色计划分支。
- 实现本地工具选择注册、技能精确加载、提示组合。
- 实现两阶段 preflight、实际清单保存和本次调用来源保护。
- 完成历史显示、每 run 快照、read-only/full 切换、完整输入恢复、资源漂移检查和版本迁移。

通过条件：不同角色实际能力不同；未选中能力不能直接或间接调用；配置修改不改变旧任务正文与授权名单。

### M3 原生 MCP 桥接

- 支持 stdio 与 Streamable HTTP 的角色服务子集。
- 完成环境引用解析、就绪、名称映射、hidden/direct、schema 校验。
- 完成结果、错误、请求超时、父任务取消与关闭流程。
- 覆盖全局 mcp.json、同名配置、扩展注册等旁路来源。

通过条件：假 MCP fixture 覆盖完整生命周期，未声明服务没有连接，失败零模型调用。

### M4 PM、DAG 与展示

- 实现配置启用后的首次 PM 对话、PM 快照恢复与目录工具；内部通知也经过就绪门禁。
- 接入 subagent role 和步骤级 role/model/context/dependencyReports。
- UI 展示 roleId、配置摘要、声明/有效能力和预检阶段。
- 使用同一 workflow 验证 Builder partial 与 Reviewer none/omit。

通过条件：用户可以只与 PM 交流，由其调用三个角色；DAG 和 standalone 使用同一解析与验证逻辑。

### M5 回归、打包与文档

- 运行完整测试与类型检查，核实角色和非角色兼容矩阵。
- 用 npm pack --dry-run 或等价方式检查发布文件。
- 在临时干净项目加载打包结果，验证 builtin:pm 等资源均可解析。
- README 增加最短启动流程、配置说明、能力边界、故障诊断与版本要求。
- 提供脚本化端到端演示；真实模型试用作为补充，不代替自动化门槛。
- 最终汇报实际完成项、命令与结果、跳过原因和剩余限制。

## 11. 最小测试矩阵

| 组 | 必测条件 |
| --- | --- |
| 配置 | 默认/显式路径、enabled、错误字段、重复 ID、缺资源、角色引用与 ID 不符 |
| Skills | 只加载本角色、重复名、disableModelInvocation、文件缺失、入口 hash 漂移 |
| 本地工具 | 精确选择、重名、非工具型扩展拒绝、未选中直接/嵌套调用失败 |
| 权限 | PM 无 write/bash，Builder 有；full 不增加未声明工具；read-only 在连接前排除扩展 |
| 提示词 | 首轮真实 provider 请求含正确角色正文；PM 不含全部角色正文；无重复追加 |
| PM 恢复 | manifest 修改/删除后恢复旧 PM；新会话采用新配置；未就绪时恢复通知与问题不触发模型 |
| MCP 来源 | 只连接选中服务；ambient mcp.json 和额外 extension registrations 不混入 |
| MCP 就绪 | 超过旧 15 秒但在 30 秒内就绪可成功；超期、连接失败、鉴权缺失、缺工具、schema 错误时零模型调用 |
| MCP 名称 | 同名工具跨服务、名称规范化碰撞、超长名字、动态新工具保持未授权 |
| MCP 结果 | 文本/图片/结构化结果、isError 与协议错误的区别 |
| MCP 生命周期 | 连接期间取消、调用期间取消、持续 progress、启动失败、父退出、无孤儿进程 |
| 持久化 | 仅有 RolePlan 时从已存 TaskInput 恢复 partial/full 上下文；快照完成后重启；nonce/run 不匹配；源资源删除 |
| 继续 | reload 后新任务用新 manifest；旧任务用旧正文；read-only→full→read-only→full；升级失败；凭据轮换；schema 漂移拒绝 |
| DAG | 每步 role/context；role inherit + workflow model + step override；角色省略 context；代码与报告继承分离；worktree cwd；创建时冻结与 update |
| 恢复 | 遗留终态锁、低并发恢复排队、取消恢复、一次预算和超限保护 |
| 兼容 | 无角色 API、v1/v2 历史显示与原有继续语义、现有所有回归 |
| 打包 | 角色 YAML、prompt、skills、schema 被包含；干净安装可启动 |

使用现有测试的 fake RPC 与脚本化 provider，再添加必要的小型 MCP fixture。至少一组集成测试运行真实 Pi CLI/RPC；只测 mock 对象不足以证明 hook、加载顺序和工具来源正确。

若宿主不提供 systemd user scope 或 /proc children，按能力检测清晰标记环境依赖的测试。不能把权限/断言失败一律当作跳过；普通配置、角色与 MCP 测试应在无 systemd 环境照常执行。

## 12. 审查基线的验证记录

此前对 a16abfd / 锁定 Pi 1.0.2 的本地运行结果：

- typecheck 通过。
- npm test：183 项，180 通过，1 失败，2 跳过。
- 唯一失败在读取 /proc/self/task/<pid>/children 时 ENOENT，位于断言前；当前执行环境缺少该接口。
- 两项跳过依赖真实 systemd 用户作用域。
- 两个恢复缺口以真实 flock、TaskManager.open、RpcProcess 和 fake-rpc fixture 复现。
- 这只是实施前基线，不能替代修改后的验证。

源码依据：

- [loadout.ts](https://github.com/Eryx-Z/pi-agent-mesh/blob/a16abfdda11751d7e518b2b910fd99860085a8d5/pi-extension/subagents/loadout.ts)
- [tasks.ts](https://github.com/Eryx-Z/pi-agent-mesh/blob/a16abfdda11751d7e518b2b910fd99860085a8d5/pi-extension/subagents/tasks.ts)
- [workflows.ts](https://github.com/Eryx-Z/pi-agent-mesh/blob/a16abfdda11751d7e518b2b910fd99860085a8d5/pi-extension/subagents/workflows.ts)
- [Pi 官方 MCP 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)
- [Pi 扩展 API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [MCP Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

Pi API 的具体实现事实来自安装的 1.0.2 dist 类型和源码；上游 main 链接可能变化。不要把最新 MCP 规范的每一项能力都假定为当前 Pi 已实现；transport 与协议协商由原生实现承担。

## 13. 最终完成定义

以下条件全部满足，才报告角色 V1 完成：

- [ ] 一份有效团队配置可启用 PM 首次对话。
- [ ] 四个内置角色随安装包发布，角色之间有真实的资源与能力区别。
- [ ] 新增角色只改配置与角色文件，不改调度器。
- [ ] Builder 能获得 PM 自己未激活的声明能力。
- [ ] skills、extra_tools、stdio MCP、Streamable HTTP MCP 均有真实集成验证。
- [ ] 角色限制覆盖直接与间接工具调用；无环境服务自动混入。
- [ ] 预检失败、资源缺失和必需工具未就绪时零模型调用。
- [ ] PM 和子任务均保存角色计划与实际清单；继续与恢复不静默换角色配置，未就绪的 PM 不被内部通知触发。
- [ ] 完整任务输入可恢复；read-only/full 切换遵循原授权及历史已验证定义。
- [ ] 取消和清理保留现有安全边界，新增本地服务不成为孤儿进程。
- [ ] 同一 DAG 可分别配置 Builder 和 Reviewer 的角色与上下文。
- [ ] 无角色调用、历史任务、worktree 和现有恢复回归通过。
- [ ] 文档、schema、配置示例与实现一致，打包后可独立使用。

最终给出：实际基线和完成提交、文件变更摘要、测试命令与结果、可复制的启动步骤、尚存限制。未通过项必须明示，不用“框架已搭好”替代完成目标。

