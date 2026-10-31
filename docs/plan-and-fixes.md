# 子智能体允许列表 + 模型切换：调研、设计、修复与验证

目标仓库：`/Users/mark/1/craft/dsh-agent-team-model`（目录名未改；插件包名是 dsh-subagent-model-router）
参考实现：官方 `dsh-tool-subagent` / `dsh-experimental-agent-team`（含 tool 与 client 半侧）/ `dsh-subagents-model` 1.2.1
调研来源：本机安装的编译产物（`app.asar` 解包到 `/tmp/dsh-recon`，行号均指该编译产物），详见 `docs/recon/` 下三份报告。

---

## 1. 调研结论

### 1.1 官方子智能体（dsh-tool-subagent）

- 已存在「会话级」概念，但只是**组合期快照**：策略以 `subagent/model-selection-policy` 事件写进会话（`lib/index.js:259-293`），组合该会话的 delegation 工具时读一次（`:540-558`）。子会话没写时向上取父会话，取不到且「会话是全新的」时才用部署默认值（`:542-554`）。**已有历史的主会话永远拿不到部署默认值** —— 这就是「全局设置不生效」的机制原因。
- 强门禁只覆盖**显式选择**：`assertAllowedModelSelection`（`:88-97`）注释原文 "Pure inheritance remains outside this policy because no model-facing choice occurred"。不带 provider/model 的 spawn 直接继承父路由，不受列表约束。
- 部署默认值来自 `subagent-model-selection-settings` 服务的 schemastery `Config`（`lib/model-selection-settings.js:41-66`，本机 profile 在 `profiles/desktop/cordis.patch.yml:207-212` 配了 enabled + 2 条路由）。
- 子 Agent 的路由**每步只来自创建时的 AgentOptions**（`dsh-agent-loop/lib/index.js:1179-1184`）；`model/selection` 事件只被 `dsh-api-session-controller` 给普通会话装的选择闭包消费（`:534-536`），而它明确拒绝 subagent 会话（`:128-134`、`:225`）。

### 1.2 官方 Agent Teams（dsh-experimental-agent-team + tool + client）

- spawn 调用链：`tool-agent-team` 的 `spawn_teammate`（`lib/index.js:250-291`）→ `agentTeams.spawnTeammate` → `subagents.startActivation`（`dsh-experimental-agent-team/lib/index.js:1032-1042`）**不传 agentOptions**，prompt 数组按引用透传 → subagent manager 只读 `request.agentOptions`（`dsh-subagent/lib/types/manager.js:327`）。本插件原有的 prompt-ticket 接缝因此成立。
- 耐久权威是 `subagent/descriptor`（只存 `agentProvider/agentModel/agentReasoningEffort`，`manager.js:331-338`），而 fold **只认第一条** descriptor（`descriptor.js:174-191`）⇒ 事后 append 改不了路由。
- 冷唤醒：`deliverToChild` 仅当 `resident` 不存在才 `coldResume`，后者调 `ownerCtx.agents.resume(...)`（`manager.js:788`，方法调用，不解构）⇒ 包 `ctx.agents.resume` 有效。
- roster 只读 `live?.options.model ?? root.options.model`（`agent-team/lib/index.js:922`），所以 `list_agents` 的 model 切换后不刷新，成员被回收时甚至会回落显示 Lead 的 model。
- 本 build 内 `grep switch_agent_model` = 0 命中 ⇒ 官方没有任何「切换 teammate 模型」协议。

### 1.3 参考插件 dsh-subagents-model 1.2.1

- **纯客户端展示插件**：Host 半侧只是让 `dsh-client-modules` 扫描到本包的空锚点（`src/index.js`），浏览器半侧读 `modelSelection` 投影渲染 header chip / composer dock chip / sidebar hover。
- 不写任何路由、不注册工具或服务、明确不接管官方 subagent 下拉（`cordis.patch.yml` 注释记录了「强占 subagent-catalog 席位导致整个下拉消失」的踩坑）。
- 结论：与本插件**无写冲突**，可共存；它的 chip 展示的是投影里的 `next`，本插件写入 `model/selection` 后它会自动跟随。

### 1.4 客户端可用的扩展面与硬约束

- 可用 slot（会话作用域）：`conversation.session.header.actions`（list）、`conversation.composer.dock`（list，**child chat 也渲染**）、`conversation.input.left|right` 等；subagent 下拉的每一行**没有** slot（`ui-subagent/lib/client.js:164-338` 零 renderSlot）；Agent Teams 队友卡片同样没有 slot（整文件 renderSlot = 0）。
- 客户端 → Host 只有两条正式通道：build 期挂载的 `ctx.remote.<namespace>.<method>`（其中 **`commands/execute` 已挂载**，`dsh-api-remotes/lib/types/client/index.js` 的贡献清单含 `commandsRemote`）与白名单 `ctx.remote.$on(...)`。第三方**不能**在浏览器侧新增 RPC namespace。
- 一个包只能有一条 Loader 行，否则 `ClientPackageCompositionError` 会让整个 web shell 失去 `__ModuleLoader__`。

---

## 2. 设计方案

### 2.1 允许列表存放位置：会话事件（复用官方事件类型）

- 存放：父会话（发起委派的那个会话）日志里的 `subagent/model-selection-policy` 事件，**最后一条生效**。
  - 选它的理由：是 `KNOWN_SESSION_EVENT_TYPES` 里的正式类型（`dsh-session/lib/types/known-event-types.js:48`），`append` 有 schema 校验、日志可被官方读取；不需要 `plugin:` 自定义记录（那需要 `appendPluginRecord`，零依赖插件拿不到），也不写 settings（settings 没有会话维度）。
- 读取顺序（新实现 `allowedRoutes`）：
  1. 本会话最后一条策略；
  2. 没有时取**最近的活着的祖先会话**的策略（子会话继承被委派时的列表）；
  3. 再没有取部署默认值（`subagent-model-selection-settings` 的 enabled/allowedModels）；
  4. 都没有 ⇒ 不限制（边界条件要求的默认行为）。
- 「恢复全局」：把当前部署默认值**快照**写进本会话（面板「导入全局」/ `/subagent-models inherit`）。官方事件 schema 要求至少一条路由，空列表无法表达「取消覆盖」，所以语义上写成「快照」而不是「删除」，README 与面板都有说明。

### 2.2 强门禁放在哪个接缝

放在 `ctx.subagents.startActivation` 的包装里（所有委派路径的唯一收口：Team roster、官方 subagent 工具、未来插件都走它）：

1. 先按 ticket 合并出**这个子会话真正会跑**的 `agentOptions`；
2. 用「显式路由 → provider `agentRouteDefaults` → 父会话当前路由」求有效路由；
3. 有效路由不在列表内就抛错，错误里列出可用路由并提示改用 `spawn_teammate_with_model` / `switch_agent_model`。

关键实现细节：**ticket 必须先合并再判断**，否则「显式选了允许的模型」会因为「继承路由不在列表」被误杀（自测里专门覆盖了这一点）。

### 2.3 为什么同时提供工具和命令

按官方 user-actions 的「一个操作两个调用方」原则：两个操作各实现一次，工具（模型侧）与命令（UI 侧）共用同一份 helper：

| 操作 | 工具 | 命令（UI 调用） |
| --- | --- | --- |
| 读/写会话允许列表 | `configure_subagent_models` | `/subagent-models [routes... | inherit | show | json]` |
| 切换某个子智能体模型 | `switch_agent_model` | `/subagent-model-switch <teammate|session-id|self> <provider/model>` |

---

## 3. 问题定位与修复：「只能切换一次」

### 3.1 定位

- 真实运行时 Agent **没有** `model` 门面（`dsh-agent-loop/lib/index.js:747-770` 字段表无 model；全仓 grep `agent.model` 无命中）。旧实现 `recordSelection` 因此永远退化成 `session.append('model/selection')`。
- 该事件在运行期唯一的消费者是 api-session-controller 给**普通会话**装的选择闭包，而它对 subagent 会话直接拒绝（`:128-134`、`:225`）。所以**热态切换是空操作**。
- teammate 每回合结束都会被 settle 释放，下一次唤醒走 `coldResume → agents.resume`，旧的 resume shim 生效 ⇒ **第一次切换（冷态）成功**。之后再切时它已经重新 resident（运行中或尚未 settle），走 live 分支 ⇒ 静默失效。这就是「只能切一次」。
- 旧实现还有两个放大器：(a) live 分支的 `selected` 用 `liveSelection()` 读 `request/header`，返回的是**旧路由**，看起来像成功；(b) 自测里的假 Agent 自造了 `model:{current,select}` 门面，所以单测一直是绿的。

### 3.2 修复

1. **热态**：给每个 Agent 在它自己的 `ctx` 上装 `agent/request` 瀑布（与 GUI 模型选择器同一条接缝），把 `routeOverrides` 里的路由盖到每一步的请求上。可反复生效。
2. **冷态**：保留 `agents.resume` 包装；并在 resume 时先查**子会话日志里最新的 `model/selection`**（`durableRoute`），于是切换能跨进程重启；resume 后在新段里再记一次选择。
3. **返回值**：live 分支直接返回本次写入的 `selected`，不再回读旧 header。
4. **可观测**：新增 `diagnostics()`，暴露四个接缝（`startActivation` 包装 / `agents.resume` 包装 / `agent/request` 热态 hook / `commands` 注册）是否装成功。

触发条件与影响范围：只影响「子 Agent（origin=subagent / 有 parentSession）的模型路由」；不改 Lead 自己的路由，不改 session 事件语义，不改官方插件代码。

---

## 4. UI 改动

> 0.4.0 现状：cell 已扩为三个（composer dock 面板 / session header chip / sidebar hover row，见 §13）。本节保留 0.2.0 首版只有单个 dock cell 时的记录。

- 新增 `client.js`（浏览器半侧，classic bundle，`package.json` 增加 `dsh.client` + `./client` 导出）。
- 新增**一个** cell：`conversation.composer.dock`，`id: subagent-model-panel`，`order: 45`（官方 todo=0 / queue=20，不挤位）。选它是因为官方 subagent 下拉/队友卡片没有行级 slot，而 composer.dock 在**子会话 chat 里也渲染**。
- 面板内容：
  1. 本会话允许列表（读 `/subagent-models json`），逐条「移除」、按 provider/model 下拉「添加」、「导入全局」；
  2. 「把当前子智能体切到」下拉 + 「切换」→ `/subagent-model-switch self <route>`。
- 与主 agent 侧切换的关系：**同一条执行路径**（命令与 `switch_agent_model` 共用 `applyRoute`），所以 UI 切换与工具切换结果一致；区别只在权限：工具限制「只有 Lead 能改别人、teammate 只能改自己」，而 UI 是用户操作，允许改当前子会话自身（`self` 只对 child 会话成立，主对话会被拒绝并提示用顶部模型选择器）。

---

## 5. 与参考插件的兼容性

| 插件 | 关系 | 说明 / 取舍 |
| --- | --- | --- |
| 官方 `dsh-tool-subagent` | 复用 + 补强 | 复用 `subagent/model-selection-policy` 事件语义；补上「纯继承也校验」与会话内可改。它的 `list_subagent_models` 若存在，展示的仍是组合期快照（可能滞后），门禁以本插件为准。 |
| 官方 `dsh-experimental-agent-team` | 只读挂接 | 只读 roster / `spawnTeammate` / `agents.resume`，不改其代码、不争其 slot。 |
| `dsh-subagents-model` 1.2.1 | 无冲突 | 纯展示；它读 `modelSelection` 投影，本插件写入的 `model/selection` 会让它自动跟随。若需取舍：**本插件是写方**，展示与路由不一致时以本插件返回的 `selected` 为准。 |
| 官方模型选择器 | 分工 | 主对话仍由顶部选择器（`session/selectModel`）负责；子会话被官方刻意关死（`apiSessionSubagentOwnershipError`），所以子会话的切换入口只能由本插件提供。 |

已知取舍：
- 部署默认值生效时，**任何**子激活（包括不带模型的 `spawn_teammate` / `subagent_fork`）只要继承的路由不在列表里就会被拒。这是「强门禁」的必然结果；解决办法是把该路由加进本会话列表（面板）或改部署配置。
- 列表无法表达「取消覆盖」，只能「快照部署默认值」。

---

## 6. 验证步骤（全程未碰运行中的 desktop）

### 6.1 已执行

1. **单元/回归**：`node test/smoke.mjs`（仓库根目录）→ `smoke: all assertions passed`。覆盖：
   - 热态连续两次切换都改变真实请求（旧 bug 的回归测试）；
   - 冷态切换 + `agents.resume` 收到覆盖路由；
   - 清空进程表后按子会话 `model/selection` 恢复（模拟重启）；
   - 允许列表拦「纯继承」、放行允许路由、部署默认值回退；
   - 两个命令的 show/save/switch/越界拒绝；
   - spawn ticket 与 prompt 对象身份不变。
2. **组合树**：隔离 `DSH_HOME=/tmp/dsh-verify` + `--profile verify --dump-config` → 1249 行、含 `# == dsh-subagent-model-router` 行、**零 skipping**。
3. **真 boot**：`--profile verify --port 0 --no-open` → 打印带 token 的 URL，**零 error**；desktop 的 56187 全程在监听、未被触碰。
4. **客户端产物**：跟随 token 取 boot 图，combo 清单里出现 `dsh-subagent-model-router/client.js`（`/plugins/subagent-model-router/client.js&rev=25f516cdf0e3`）⇒ `dsh.client` 清单与 bundle 都被 `dsh-client-modules` 正确发现、组合无冲突。

### 6.2 你需要做的（一次性）

1. 重启 desktop（或让 Cordis 热重载该 profile）：Host 半侧改动会随 HMR 生效，浏览器半侧需要重载页面/重启才能拿到新 client bundle。
2. 在任意会话底部工具栏点「子智能体模型」：应能读到当前列表（继承部署默认时显示 2 条），添加/移除/导入全局后立刻生效。
3. 让 Lead 连续两次 `switch_agent_model` 同一个 teammate，然后 `send_message` 让它继续：子会话日志里应看到两条 `model/selection` 与随后的 `request/header` 变成新路由（`grep '"type":"model/selection"'` 不可直接 grep，日志是 zstd 压缩）。

### 6.3 回滚

本目录现已是 git 仓库（见 §12），代码回滚用 `git checkout -- <file>` 或 `git revert`；profile 侧的回滚是把 `bundles` 里的 `dsh-subagent-model-router` 删掉或把 Loader 行 `disabled: true`。

---

## 7. 待确认点（0.2.0 提出，按 0.4.0 实现核对）

以下三个问题是 0.2.0 设计时「未擅自假设」的点。按 0.4.0 的 `lib/index.js` / `client.js` 逐条核对如下（原问题 1 的缺口已在 0.3.0 的 generic 模式补上，不再成立）：

| # | 原问题 | 0.4.0 现状 |
| --- | --- | --- |
| 1 | 「spawn subagent」指 Team 的 `spawn_teammate` 还是官方 `subagent_fork/subagent`；非 Team profile 是否也要带模型的创建入口？ | 两者都覆盖：门禁放在 `startActivation`，所有委派路径都过。带模型入口 Team 下是 `spawn_teammate_with_model`，非 Team profile 下已有 `spawn_subagent_with_model`（generic 模式，`lib/index.js` 的 `if (team === undefined)` 分支）——不再是缺口。 |
| 2 | 「恢复全局」是否接受「快照部署默认值」而不是「删除会话覆盖」？ | 仍按快照实现（`resolvePolicyWrite` 的 `inherit` 分支 + `/subagent-models inherit`）。官方事件 schema 要求至少一条路由，空列表无法表达「取消覆盖」；README「已知边界」已写明。 |
| 3 | 部署默认值生效时，连 `spawn_teammate` 的继承路由也硬拒吗；还是自动改投列表第一条？ | 默认仍硬拒（fail-closed），不做自动改投。0.4.0 新增 `enforceDeploymentPolicy: false` 可把部署列表降级为提示；`requireExplicitRoute` 只在存在生效列表时才判定（见 README「强门禁」）。 |

---

## 8. 补充（第二轮追问）

### 8.1 「会不会和之前 dsh-tool-subagent 一样，默认继承当前模型而不是从列表里选？」

- **0.1.0 时：会。** 旧版没有任何允许列表；而且即使有，官方语义也只校验「显式选择」，纯继承放行。
- **0.2.0 现在：不会「继承但不比对」。** 门禁算的是子会话**真正会跑**的路由（显式 → provider 默认 → 父会话当前），再与列表比对：

| 情形 | 行为 |
| --- | --- |
| 不写模型，继承路由在列表内 | 放行（等价于选中列表里的一项） |
| 不写模型，继承路由不在列表 | **拒绝**，错误列出可选路由 |
| 显式写模型，在列表内 | 放行 |
| 显式写模型，不在列表 | **拒绝** |
| 部署开 `requireExplicitRoute: true` | 不写模型**一律拒绝**（即使继承路由在列表内） |
| 会话与部署都没有列表 | 不限制 |

- 残留的「看起来像默认继承」只有一种：**Lead 自己的路由就在列表里**，于是不写模型也能通过。这在语义上等价于「选中了列表里的一项」，但若你的目的是「必须显式从几个里挑」，请把 `requireExplicitRoute` 打开（profile 行 config），或在面板里只保留你希望子智能体跑的模型、把 Lead 自己的路由留在部署默认值之外。
- 本轮还补上了一个**真实缺口**：`switch_agent_model` 与 `/subagent-model-switch` 之前没有统一走允许列表（面板只比对会话级、不比对部署级），现在两条路径都走同一个 `assertRouteInPolicy`，所以「先合规创建、再切到表外」也被堵住。
- 另加一道保险：`saveSessionRoutes` 写完后**读回校验**，若未来构建不再记录该事件，保存会当场报错，而不是让你以为列表生效了。

### 8.2 「纯插件还是改了 dsh 源码？兼容性如何？上游升级崩溃概率多大？」

**没有改一行 dsh 源码，也没有 vendor 任何 `@deepseek-ai/*` 包。** 全部通过 Cordis 插件 API 挂在 profile 行上：注册工具、注册两个 slash 命令、包装两个服务方法、在 Agent 自己的 ctx 上注册一个 waterfall、追加一个官方 Session 事件、挂一个客户端 slot。仓库仍是零依赖纯 ESM。

必须诚实说明的依赖面（这是「升级风险」的全部来源）：

| 接缝 | 用途 | 上游若改动 | 失败形态（降级，不是崩溃） |
| --- | --- | --- | --- |
| `ctx.subagents.startActivation` 存在且可赋值 | spawn 票据 + 门禁 | 改名/变只读 | `state.available=false`：工具返回 note，门禁失效；policyText 会明确警告「本构建无法强制允许列表」 |
| manager 读取 `request.agentOptions` | 路由注入 | 改字段名 | 同上（首次请求继承父路由） |
| Agent 作用域派发 `agent/request` 瀑布 | 热态反复切换 | 改事件名 | 热态切换失效；冷态（resume）仍生效，`model/selection` 仍被记录 |
| `ctx.agents.resume({resumeSessionId, agentOptions})` | 冷态覆盖 | 改签名 | 冷态覆盖失效，退化为只在 live 时有效 |
| `session.append('subagent/model-selection-policy', {allowedModels})` | 列表存储 | schema 收紧 | 保存当场报错（读回校验），不会静默 |
| `session.log` / `session.header.parentSession` | 读策略 | 移除同步读 | 读不到 → 退回部署默认；且保存时的读回校验会先报错 |
| `commands.register` + 客户端 `remote.commands.execute` | UI 面板 | 改名/未挂载 | 面板显示错误并保留文字提示；工具侧不受影响 |

崩溃概率（判断，非实测）：我把「导致 profile 起不来」单列为最高风险，并已做防护——`apply()` 内每一步（两个 shim、命令注册、逐 Agent 安装）都是 try/catch，单个 Team 成员安装失败只记 warn、不影响该成员激活。因此：

- **补丁级升级**：几乎不会出问题（以上全是当前公开服务方法与官方事件类型）。
- **次版本升级**：中低概率（我给 10–25%）出现某个接缝改名 → 表现为**功能降级**（某个能力失效并在结果里带 note），不是崩溃。
- **大版本/重构**：50% 以上需要跟进；最坏形态是「允许列表失效」或「面板消失」，仍不应崩溃。
- **真正把 profile 弄挂**：<5%，且前提是 Cordis 改变了 `apply`/`effect` 的契约本身（那就影响所有第三方插件）。

判定语义也做了取舍：**策略判决失败闭（fail-closed）**——路由已知且不在列表就拒；**我们自己的求值异常放行（fail-open）**并记 warn，避免上游改个内部字段就让所有委派瘫痪。

升级后 60 秒自检（不需要重启 desktop 也能做的部分见 6.x）：

1. `node test/smoke.mjs`（逻辑层，0 依赖）；
2. 隔离 `DSH_HOME` + `--profile verify --dump-config` 看有没有 skipping；
3. 在会话里问模型「调用 diagnostics，或看 list_agent_models 是否带 Session allowlist 行」；`diagnostics()` 的四个布尔就是四个接缝的体检结果。

### 8.3 客户端面板「点了没反应」的根因与修复（2026-10-31 实测反馈）

现象（dsh web）：面板能打开、能点，但一直「读取中…」、provider 下拉是「无模型目录」，底部红字 @BT@cannot get property "remote.commands" without inject@BT@。

两个独立原因，都在客户端半侧：

1. **Cordis 的注入守卫是按「扁平服务名」计量的**。@BT@ctx.remote.commands@BT@ 不是普通属性，而是名为 @BT@remote.commands@BT@ 的服务；没有在插件 @BT@inject@BT@ 里声明就去读，会抛 @BT@cannot get property "remote.commands" without inject@BT@（cordis 的 @BT@internal/get@BT@ 守卫，见 @BT@cordis/src/reflect.ts@BT@）。官方 @BT@dsh-client-ui-commands@BT@ 的写法就是 @BT@inject = ["sessions","remote","remote.commands"]@BT@，然后 @BT@ctx.remote.commands.execute(...)@BT@。旧版只 @BT@inject: ['slots']@BT@ 并 @BT@ctx.get('remote')@BT@，必然抛错。
2. **Remote 调用返回的是 @BT@{ ok, value }@BT@ / @BT@{ ok, error }@BT@，不是 Host 方法的原始返回**。旧版把返回值当 @BT@{ commandId, result }@BT@ 直接解，即使注入修好也读不到 @BT@result.kind@BT@，面板会一直停在空状态。

修复（@BT@client.js@BT@）：@BT@inject: ['slots','remote','remote.commands','remote.session']@BT@；所有 Host 交互收进 @BT@createController(ctx, sessionId)@BT@，统一 @BT@unwrap(reply)@BT@ 处理 @BT@ok/error@BT@，命令失败把 @BT@error.code@BT@ 和 message 原样显示在面板里；组件只做渲染，避免把 Cordis 注入错误藏进一次渲染。

回归：新增 @BT@test/client.smoke.mjs@BT@，用一个**模拟 Cordis 守卫**的假 ctx（未声明的命名空间访问会抛同样的错误）驱动 controller，断言四件事：订阅名齐全、@BT@/subagent-models json@BT@ 解包正确、@BT@{ok:false}@BT@ 带 code 抛出、@BT@modelCatalog@BT@ 可选解包。这样同类错误在 node 里就能挡住，不必等浏览器。

### 9. 补充（第三轮追问）：teammate / subagent 的关系与插件绑定

**9.1 teammate 与 subagent 互斥吗？——不是，teammate 是 subagent 的一个特化**

- 运行时：Team roster 的 @BT@spawnTeammate@BT@ 最终调 @BT@ctx.subagents.startActivation@BT@（@BT@dsh-experimental-agent-team/lib/index.js:1032-1042@BT@），所以每个 teammate 都是 subagent 子会话（@BT@header.origin = "subagent"@BT@，有 parentSession）。反过来，@BT@subagent_fork@BT@ / @BT@subagent@BT@ 创建的子会话**不是** Team 成员：不进 roster、没有 @BT@send_message@BT@、不共享任务板，结果按 parent delivery 回来。
- 工具面：官方 Team profile 把 @BT@tool-subagent@BT@ / @BT@tool-subagent-fork@BT@ / @BT@tool-subagent-control@BT@ / @BT@tool-subagent-list-agents@BT@ 四个 profile 行 @BT@disabled: true@BT@（@BT@dsh-experimental-agent-team-profile/cordis.patch.yml@BT@），改由 Team 工具接管；但 @BT@dsh-web-app/presets/cordis.patch.yml@BT@ 会在 agent preset 作用域里重新插入 @BT@subagent_fork@BT@，所以本机 Lead 同时拥有 @BT@subagent_fork@BT@ 与 @BT@spawn_teammate@BT@。**「互斥」只是 profile 层的默认取舍，不是运行时限制。**
- 区别只在协作语义：teammate 有身份/roster/邮件/任务板/跨轮存续；subagent 是一次委派，结果回给 parent。

**9.2 插件与 Agent Teams 强绑定吗？——改造前是，现在不是**

- 改造前：@BT@inject@BT@ 含 @BT@agentTeams@BT@，Cordis 的 inject 是硬依赖，非 Team profile 里插件根本不会激活；工具也只装给 @BT@tryMembership@BT@ 命中的成员。
- 现在（本轮改动）：@BT@inject = ['agents','tools','subagents','systemPrompt']@BT@，@BT@agentTeams@BT@ 改为 @BT@ctx.get('agentTeams')@BT@ 可选读取，按 Agent 决定安装模式：
  | 模式 | 条件 | 装的工具 |
  | --- | --- | --- |
  | team | 有 Team 且该 Agent 是成员 | @BT@switch_agent_model@BT@ / @BT@spawn_teammate_with_model@BT@ / @BT@configure_subagent_models@BT@ / @BT@list_agent_models@BT@ |
  | generic | 没有 Team 服务，且该 Agent 是 root 会话（非 subagent 子会话） | @BT@switch_agent_model@BT@（目标用子会话 id，仅直系 parent 可切）/ @BT@spawn_subagent_with_model@BT@ / @BT@configure_subagent_models@BT@ / @BT@list_agent_models@BT@ |
  | none | 有 Team 但不是成员 | 无 |
- Team 服务晚挂载时会自动把已装的 generic 工具升级成 team 工具（@BT@ctx.inject(['agentTeams'], ...)@BT@ 触发 reconcile）。
- 门禁（@BT@startActivation@BT@）、resume 覆盖、两个 slash 命令在三种模式下都在，因为它们是通用 subagent 管道，不依赖 Team 语义。@BT@systemPrompt.getSectionOrder('TEAM_POLICY')@BT@ 在无 Team 时也有兜底（@BT@sectionOrder@BT@ 返回 600）。
- 新增回归：@BT@test/generic.smoke.mjs@BT@（无 @BT@agentTeams@BT@ 的 ctx：工具面、同一门禁、按 id 切换、仅直系 parent、@BT@self@BT@ 面板切换）。三套测试全绿。

### 10. 完整性与风险审计（第四轮追问）

**10.1 需求 → 实现 → 验证 对照**

| 需求 | 实现位置 | 验证 |
| --- | --- | --- |
| spawn 时只能从允许列表选，超范围拒绝 | `assertActivationAllowed`（包装 `startActivation`，先合并 ticket 再判定） | smoke 5/10 节：继承表外被拒、显式表外被拒、允许放行 |
| 会话级覆盖全局，只对当前会话生效 | 会话事件 `subagent/model-selection-policy`（最后一条生效）+ `allowedRoutes` 向上继承 + 部署兜底 | smoke 10/11 节、generic 4/8 节 |
| 会话内 UI 入口 | composer dock 面板 + `/subagent-models`（show/json/routes/inherit） | client.smoke 全链路 |
| 反复切换模型 | `installRouteHook`（agent/request 瀑布）+ `applyRoute` | smoke 1/2 节（同一 child 连切两次） |
| subagent 界面 UI 切换 | 面板「把当前子智能体切到」+ `/subagent-model-switch self` | client.smoke、generic 7 节 |
| 边界：列表未配置 → 全局 | `allowedRoutes` 三级回退 | smoke 11、generic 8 |
| 边界：非法/不可用模型 | 工具侧 `llm.resolveModelInfo` 校验；UI 只给目录内选项 | smoke 命令错误路径、client 5 节 |

**10.2 可能"某次运行突然异常"的地方（逐条 + 现在的兜底）**

| 场景 | 触发条件 | 现在的行为 / 兜底 |
| --- | --- | --- |
| 部署列表把既有工作流拦住 | 部署 `enabled` 且 Lead 用了表外模型 → `spawn_teammate` / `subagent_fork` 被拒 | **本轮新增** `enforceDeploymentPolicy: false` 可把它降级为提示；错误信息始终列出可选路由 |
| 面板「切换」在没列表时不可用 | 会话与部署都没列表 | **本轮修复**：切换下拉回退到模型目录 |
| 普通 subagent 无法用工具改模型 | Team profile 里 `subagent_fork` 子会话不是成员 | **本轮修复**：`switch_agent_model` 接收子会话 id（仅直系 parent） |
| 官方 `list_subagent_models` 显示滞后 | 官方策略是组合期快照，会话内改列表后它不变 | 门禁以本插件为准；官方投影只影响展示；文档已注明 |
| Cordis 服务/事件改名 | 上游大版本 | 降级而非崩溃：`state.available=false` → 工具带 note、系统提示显式警告；求值异常 fail-open 并 warn |
| 热态 hook 与 GUI 选择器并存 | Lead 也装了 hook | Lead 的 override 永远为空 → 完全透传，无副作用 |
| 切换发生在运行中 | 正跑一轮 | 下一步生效（不是当前步）；返回 note 说明 |
| 冷态覆盖依赖 resume shim | 宿主没有 `sessionQuery` | 退化为进程内表；重启后需重切一次（note 已说明） |
| 写入非法/空列表 | 手误或模型传错 | `llm.resolveModelInfo` 校验 + 写入后**读回校验**；失败当场报错 |
| Host 未重启、面板命令不存在 | 只重载了浏览器 | 面板显示「未识别的命令」；文档要求重启 profile |
| 重复挂载同一个包 | bundle + patch 各写一次 | 工具/命令重复注册被 try/catch 兜住（warn），但会出现 `ClientPackageCompositionError` 让整个 web shell 失去 `__ModuleLoader__` → README 明确「只能一条 Loader 行」 |
| generic 模式加深委派链 | 无 Team 且子会话也装工具 | 已限制：generic 只装 root 会话（generic 测试断言 child 无工具） |
| 第二种插件也包装 startActivation | 例如别的路由插件 | 链式包装仍生效；我们的门禁在自己的 wrapper 里先判定 |
| 成员探测抛错 | `tryMembership` 内部异常 | **本轮修复**：root 会话回退 generic，不再静默失去工具 |

**10.3 已知的、无法在本机证明的部分**

- 浏览器面板的**真实点击路径**只做了 controller 级测试 + 隔离 host 的 bundle 发现；渲染/样式/焦点行为需要你在 dsh web 里看一眼。
- 桌面实例上的 HMR 行为：本轮只保证**重启后**正确；热重载时序不保证。
- 上游尚未发布的版本：接缝表见 §8.2，判断已给概率区间，非实测。

### 11. 关掉官方 Agent Teams 之后（第五轮追问）

**结论：能生效。** 三种关法对应的行为与证据：

| 关法 | @BT@agentTeams@BT@ | 工具面 | 备注 |
| --- | --- | --- | --- |
| 从 @BT@bundles@BT@ 移除 @BT@...agent-team-profile@BT@ | 无 | 本插件 generic（4 个工具）+ base 的官方 @BT@subagent@BT@ / @BT@subagent_fork@BT@ 恢复 | 推荐；委派能力最完整 |
| 保留 bundle，disable @BT@agent-team@BT@ / @BT@tool-agent-team@BT@ / @BT@ui-agent-team@BT@ 三行 | 无 | 本插件 generic；但 bundle 对 @BT@tool-subagent*@BT@ 的禁用仍生效 → 没有官方 fork 工具 | 仍可用，统一走 @BT@spawn_subagent_with_model@BT@ |
| 只关 @BT@tool-agent-team@BT@ | 有 | team 模式 → @BT@spawn_teammate_with_model@BT@ 可用，但 @BT@send_message@BT@ 缺失 | 本轮新增：spawn 返回 @BT@note@BT@ 明确警告"联系不上"，不再是静默坑 |
| 只关 @BT@ui-agent-team@BT@ | 有 | 不变（只是队友面板没了） | 无影响 |

为什么在无 Team 时仍然成立：门禁、resume 覆盖、两个面板命令都挂在 @BT@ctx.subagents@BT@ / Session 日志上；只有 @BT@spawn_teammate_with_model@BT@ 依赖 @BT@agentTeams.spawnTeammate@BT@，它在 generic 模式下本就不注册（改为 @BT@spawn_subagent_with_model@BT@）。

验证：@BT@verifyplain@BT@（base + web-app + 本插件，**没有任何 Team bundle**）用隔离 @BT@DSH_HOME@BT@ 组合 + boot：1249 行组合无 skipping、boot 零 error、客户端 bundle 进入 boot 图。工具面由 @BT@test/generic.smoke.mjs@BT@（无 @BT@agentTeams@BT@ 的 ctx）逐条断言。

### 12. 改名、版本锁与仓库（第六轮）

- **改名**：包 `dsh-agent-team-model` → `dsh-subagent-model-router`；Cordis 插件名 / Loader 行 id `agent-team-model` → `subagent-model-router`；浏览器模块 id 同步（必须等于包名，否则 `dsh-client-modules` 找不到 bundle）。仓库目录名未动（会话 cwd 在其中），迁移只改 profile 一侧，步骤见 README「改名与迁移」。
- **版本锁**：`peerDependencies["@deepseek-ai/dsh-app-boot"]` 给 `>=0.2.1-rc.5 <0.3.0`（与实测版本 `0.2.1-rc.5` 对齐）；`dsh.compat` 记录 validated/range；运行时若宿主通过 `DSH_VERSION` / `DSH_HARNESS_VERSION` 声明版本且落在窗口外，`apply` 直接 `return`（只留一条 warn，不注册任何工具）。当前 dsh 不导出可读版本（已核对全部 host service 名，无 version/identity 服务，环境里也没有版本变量），所以「未声明」按「未知但放行」处理，另用 `diagnostics().missingSeams` 做能力探测。
- **git**：仓库已在项目目录初始化为 git 仓库（main），包含 lib/client/test/docs；`.gitignore` 排除 node_modules、日志与本地验证目录。

### 13. 展示能力聚合（第七轮）：不再需要第二个插件

- **背景**：@BT@dsh-subagents-model@BT@ 只做展示（header chip / composer dock 汇总 / 侧栏 hover / 路由历史），我们只做路由与门禁。用户要求一个插件覆盖两者。
- **实现**：@BT@client.js@BT@ 现在注册三个 cell：
  | slot | id | 数据 |
  | --- | --- | --- |
  | @BT@conversation.composer.dock@BT@ | @BT@subagent-model-panel@BT@ | 允许列表 + 子智能体列表 + 逐行切换 |
  | @BT@conversation.session.header.actions@BT@ | @BT@subagent-model-header-chip@BT@ | 当前会话路由（model/effort/继承/待生效），tooltip 带按模型的子树汇总 |
  | @BT@sidebar.session.row.hover@BT@ | @BT@subagent-model-hover-row@BT@ | 该会话路由一行 |
- **不新增 Host RPC**：三个位置都从 shell 已有的投影读（@BT@modelSelection@BT@ / @BT@subagent@BT@ / @BT@subagentCatalog@BT@），只有面板沿用 @BT@commands/execute@BT@ 与 @BT@session/modelCatalog@BT@。路由解析复刻官方语义：@BT@next != lastUsed@BT@ 才算 pending、无 own route 时沿 @BT@parentId@BT@ 走最多 8 跳找祖先、都找不到就报 @BT@inherited@BT@ 空模型（不编造）。
- **隔离性**：三个 cell 各自 try/catch 注册，一个 slot 被拒不影响其余，也绝不替换官方 cell；组件缺 @BT@useSessions@BT@（老 shell）时回退到常量 store 而不是抛错。
- **代价**：与 @BT@dsh-subagents-model@BT@ 同时安装会出现两份 chip；README 已写卸载步骤。路由历史（它另有一个 @BT@client.route-history.js@BT@）本插件暂未提供——官方投影里没有 per-turn @BT@request/header@BT@，客户端拿不到完整历史，只有 @BT@lastUsed@BT@ 与 @BT@pending@BT@ 两态。
