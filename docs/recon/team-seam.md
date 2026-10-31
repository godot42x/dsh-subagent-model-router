# Agent Teams / subagent 运行时接缝分析（model 路由为何只能切一次）

分析对象：dsh-agent-team-model 在 Agent Teams 上做 model 路由的两个接缝——
ctx.subagents.startActivation 的 request.agentOptions，以及 ctx.agents.resume 的 agentOptions。

路径简写（全部只读证据源）：

| 简写 | 绝对路径 |
| --- | --- |
| **AT** | /tmp/dsh-recon/dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js |
| **SA/** | /tmp/dsh-recon/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/types/ （manager.js / descriptor.js / child-agent.js / index.js / internal.js） |
| **AL** | /tmp/dsh-recon/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js |
| **AG** | /tmp/dsh-recon/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js |
| **AS** | /tmp/dsh-recon/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js |
| **SS** | /tmp/dsh-recon/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js （同名逻辑也在 lib/types/index.js） |
| **CO/** | /tmp/asar-out/dsh/node_modules/@deepseek-ai/cordis/src/ （reflect.ts / utils.ts，本轮从 app.asar 解出） |
| **TT** | /tmp/asar-out/dsh/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js （从 app.asar 解出） |
| **PL** | /Users/mark/1/craft/dsh-agent-team-model/lib/index.js （本插件） |

---

## 0. 结论速览

1. **Team 插件从不给 startActivation 传 agentOptions**（AT:1032-1042）。它只传 delivery / childId / provider / label / request{prompt,parent} / signal，prompt 是同一个数组对象原样透传（AT:1038 → SA/manager.js:396）。因此 spawn_teammate_with_model 的「按 prompt 数组对象做 ticket」是成立的接缝。
2. **child descriptor 是路由的耐久权威**，只快照 provider/model/reasoningEffort 成 agentProvider / agentModel / agentReasoningEffort（SA/manager.js:331-338、SA/descriptor.js:38-45），且 fold 取**第一个** subagent/descriptor（SA/descriptor.js:174-191）——事后 append 新 descriptor 不可能改路由。
3. **cold resume 的 agentOptions 只从 descriptor 重建**（SA/manager.js:1188-1211），然后调用 this.ownerCtx.agents.resume(...)（SA/manager.js:788）——是**服务对象上的方法调用**（每次运行时取属性），不是解构引用。cordis 的 traceable Proxy 对 get/set 都转发到同一个原始实例（CO/reflect.ts:136-171、173-197，CO/utils.ts:117-125、165-217），所以 PL:147-187 的 resume shim 在这条路上确实会被调用。
4. **teammate 的活体（live）无法改路由**：本运行时 Agent 上没有 model 门面（AL:747-770 的 ReactLoopAgent 字段表只有 loopCtx/id/options/session/inbox/phase/scope/ctx/...；options 在 :750；全仓 grep agent.model 无命中），而 model/selection 事件的唯一运行期消费者是 api-session-controller 给普通会话装的 selection 闭包（AG:166-210、AS:274-315）；teammate 子会话 header.origin 就是 subagent，被明文拒绝接管（AS:128-134、AS:225）。每一轮请求的 provider/model 只来自本次激活的 agentOptions（AL:1179-1184）。
   → 所以 switch_agent_model 的 live 分支（PL:324-331 → PL:273-284）只是一次无害的 append，对当前激活的路由**完全无效**。
5. 由此得出「只能切一次」的结构性解释：**第一次切在冷态（无 live Agent）→ 走 resume shim → 真的生效；之后每次切在热态（running 或尚未 settle）→ 走 live 分支 → 只有旁路事件、没有路由变更**。排序与判据见 §4。

---

## 1. 调用链

### 1.1 spawn_teammate → subagents.startActivation

    TT:279-289  spawn_teammate.execute：prompt: [{type:'text', text}]      // TT:282-285 每次新建数组
      → AT:1507-1509  TeamService.spawnTeammate(caller, request)
      → AT:943-946    TeamRoster.spawn → lifecycle.track(spawnAdmitted)
      → AT:1004-1074  spawnAdmitted
          AT:1012  childId = brandString(randomUUID())          // brandString 是恒等函数（dsh-brand/lib/index.js:20-22），普通字符串
          AT:1021-1030 journal.appendAndFlush('team/member', ...) // 先落 durable member(provisioning)
          AT:1032-1042 ctx.subagents.startActivation({
                         delivery:'parent', childId, provider: request.provider,
                         label: description,
                         request: { prompt: request.prompt, parent: root },   // AT:1038 原样引用，无 agentOptions
                         signal })
          AT:1043 checkpointInitialPrompt(childId, started.messageId, signal)  // 等首条 user/message 落盘

**传不传 agentOptions**：不传。startActivation 的 spec 里没有 agentOptions 字段；官方唯一入口是 request.agentOptions（SA/manager.js:327 读的就是 request.agentOptions，不是 spec.agentOptions）。本插件的 shim（PL:115-124）把 ticket 合进 spec.request.agentOptions，位置正确。

**prompt 数组是否原样透传**：是。TT:282 → AT:1038 → SA/manager.js:396（submitMaterialized(activation, request.prompt, ...)）全程同一引用；插件用数组对象做 WeakMap key 成立（smoke 断言 test/smoke.mjs:201）。

### 1.2 teammate 的 Session 如何创建 / 落盘

    SA/index.js:136-152   SubagentRuntime.startActivation → manager.startLocal(spec)
    SA/manager.js:316-406 startLocal
      :327  agentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth)
      :331-338 descriptor = snapshotSubagentDescriptor({mode:'continuable', provider, label,
                 agentProvider?, agentModel?, agentReasoningEffort?})
      :356-357 inheritedEventCount / seed ← host.prepareContinuable(...) 给出的 fork 前缀
      :372-390 materialize({kind:'local', childId, provider, parent,
                 create:{cwd, seed, meta, inheritedEventCount, delegatedPolicies, descriptor},
                 agentOptions, composition, ...})
    SA/manager.js:733-845 materializeTracked
      :762-786 setup(childCtx, child)：只在 create 分支 append descriptor / 委派策略 / cwd
              :772 child.session.append('subagent/descriptor', create.descriptor)
      :787-804 create === undefined ? ownerCtx.agents.resume({... agentOptions})
                                 : ownerCtx.agents.create({... agentOptions})
      :823 resident.set(childId, activation)

落盘：ctx.agents.create({sessionId, meta, seed, inheritedEventCount, agentOptions, setup})（SA/manager.js:795-804）→ AgentLoop.createAgent（AL:1893-1913）→ createStoredSession（AL:1861-1871，persistence.create(header,{inheritedEventCount})）+ appendUnstoredSuffix（AL:1881-1886）把构造期 append 的 descriptor / 策略 / marker 写盘。

**child descriptor 存什么**：version(=3)、mode='continuable'、provider（spawn/fork provider）、label，以及可选的 agentProvider / agentModel / agentReasoningEffort / persona / toolFilter（SA/descriptor.js:30-45、131-148、156-173）；**不存** subagentDepth、maxTokens、outputSchema（SA/descriptor.js:8-19 注释）。

### 1.3 空闲回收与唤醒：走哪个入口

回收（每个回合结束就发生，这是关键）：

    SA/manager.js:851-862 announce → watchLocalSettlement
    SA/manager.js:902-955 watchLocalSettlement：等 whenIdle → settlementState
    SA/manager.js:961-972 settlementState：无 ownedChildren 且 inbox 空 → 'ready'
    SA/manager.js:921-947 → this.close(activation, () => this.finishDisposal(activation,false))
    SA/manager.js:974-1059 finishDisposal → handle.dispose(); :1047 this.resident.delete(childId)

即 teammate 一轮跑完且 inbox 为空后，Activation 与 Agent 都被释放，ctx.agents.get(childId) 变 undefined。这就是「冷态 resume 是常态」的原因。

唤醒（send_message）：

    AT:1516-1522 sendMessage → sendAdmitted
    AT:1611  steerHostSubagentPrompt(this.ctx.subagents, root, target.id, content, source, signal)
    SA/internal.js:31   deliverSubagentPrompt = Symbol.for('dsh.subagent.deliverPrompt')
    SA/internal.js:55-57 runtime[deliverSubagentPrompt](...)     // 运行时按 symbol 取服务方法
    SA/index.js:191-195 [deliverSubagentPrompt](...) → this.requireManager().steerPrompt / queuePrompt
    SA/manager.js:503-517 queuePrompt / steerPrompt → deliverToChild
    SA/manager.js:1099-1142 deliverToChild → deliverFollowup
    SA/manager.js:1113-1116 activation = this.resident.get(childId);
                           若 undefined → this.coldResume(...)；否则 submitAdmitted(...)
    SA/manager.js:1171-1231 coldResume → materialize({agentOptions: 由 descriptor 重建})
                           → materializeTracked → SA/manager.js:788 this.ownerCtx.agents.resume(...)

**是服务对象上的方法，还是解构引用**：两层都是**调用点上的运行时属性访问**——唤醒入口是 runtime[Symbol.for('dsh.subagent.deliverPrompt')]（SA/internal.js:56，symbol 键，可被包装），真正的 resume 是 this.ownerCtx.agents.resume(...)（SA/manager.js:788）。cordis 的 ctx.<service> 每次返回新的 traceable Proxy，但 get 转发到原始实例（CO/utils.ts:173-200），set 走 Reflect.set(target, prop, value, shadow) 也落在原始实例（CO/utils.ts:201-212）；因此 agents.resume = patched 对所有 ctx 访问可见，「别处持有旧引用」不成立（除非用 ctx.isolate 隔出另一份 agents 槽，本仓库未见用于 agents）。

唯一确定绕过 shim 的 resume 是 agent-loop 自己的声明式启动路径：AL:1611-1620 与 restoreOrCreateConfigured（AL:1641-1655）直接调内部的 this.resumeWith(...)，不经服务方法——那只用于「配置里声明的 agent 身份」（主会话），不用于 teammate。

---

## 2. 关键代码位置（对应第 2 组问题）

### 2.1 startActivation 里 agentOptions 的合并点与最终去向

| 阶段 | 位置 | 事实 |
| --- | --- | --- |
| 合并 | SA/manager.js:327 + SA/child-agent.js:74-92 | resolveChildAgentOptions(parent, request.agentOptions, childDepth)：先取父的**最后一次请求头**（SA/child-agent.js:49-62 用 parent.session.requestHeader()?.config），再 ...requested 覆盖（:85），最后盖 subagentDepth（:86）；换了 provider/model 而没给 effort 时删掉继承的 effort（:88-90）。**读的是 request.agentOptions**。 |
| 去 1：descriptor | SA/manager.js:328-338 → :772 | 只快照三个路由字段成 agentProvider/agentModel/agentReasoningEffort，随 create 落盘。 |
| 去 2：create 参数 | SA/manager.js:795-804 → AL:1909 | agents.create({... agentOptions}) → setupAndPublish(..., options.agentOptions ?? {})。 |
| 去 3：Agent.options | AL:1915-1925、1681-1682、1750 | new ReactLoopAgent(loopCtx, id, options, session)，options 即 agentOptions；assertAgentOptions 校验。 |
| 生效点 | AL:1174-1196 prepareRequest | route = {provider: this.options.provider ?? '', model: this.options.model ?? ''}（:1179-1182）；seedConfig 首次请求用 route，之后用 requestProposal(persistedHeader)（:1186-1190）；随后过 agent/request waterfall（:1191-1195）。 |

### 2.2 resume 的实现

| 关注点 | 位置 | 事实 |
| --- | --- | --- |
| 何时 cold resume | SA/manager.js:1113-1116 | 只有 resident.get(childId) === undefined 才 resume；否则消息直接塞进活着的 Agent（:1131 submitAdmitted → :1257-1272 → :519-530 agent.steer/followup）。 |
| agentOptions 从哪来 | SA/manager.js:1188-1211 | ownEvents = source.events.slice(source.inheritedEventCount) → foldSubagentDescriptor(ownEvents)（取**第一个** descriptor）→ agentOptions 仅由 descriptor 的 provider/model/reasoningEffort 组成。**不看日志里更晚的 model/selection。** |
| 最终调用 | SA/manager.js:1200-1214 → 787-794 | materialize(...) → ownerCtx.agents.resume({resumeSessionId, parentAgent, agentOptions, signal, setup})。 |
| 真正的 resume | AL:1963-2020 resumeWith | persistence.open(id,'write') → 冷读全量 → interruptedTurnClosers 补齐未闭合 turn（:1992-1993）→ sessions.prepare(id,{seed:[...persisted, ...closers], meta:header, inheritedEventCount: handle.inheritedEventCount, eventState})（:1994-1999）→ setupAndPublish(..., options.agentOptions ?? {}, ...)（:2012）→ 新 ReactLoopAgent，requestHeaderLogged=false（AL:761），因此本次激活的**第一条**请求直接用 agentOptions 的 route。 |
| 是否重新 append end-seed | SS:1414、1427-1428（types:515、544-547） | 恢复（mode !== 'snapshot'）时构造期会在 firstLiveSeq 处 append 一条**非 inherited** 的 session/end-seed（{}）；守卫是 log.at(-1)?.type !== 'session/end-seed'，而该 marker 会被 appendUnstoredSuffix 写盘（AL:2004），所以**只有第一次 resume 会加**，之后不再加。fork 子会话的 inherited marker 由 buildForkSeed 放在 boundary+1（dsh-session/lib/types/fork.js:18-27）。 |
| 继承前缀怎么划分 | SS:1414-1428、AL:1994-2004 | inheritedEventCount 来自持久化句柄（durable fork 切点，fresh 子会话为 0）；firstLiveSeq = log.length（= 种子长度）；firstLifecycleSeq 视 seeded 而定；resume 的种子是**整份存量日志**，所以 slice(inheritedEventCount) 对 fresh 子会话仍含全部历史 → descriptor 永远能被 fold 到。firstLiveSeq / eventAt 的用法见 dsh-tool-subagent/lib/index.js:542。 |

### 2.3 model/selection 在 resume 后会不会被 fold 进后续请求的 config

**对 teammate 不会。** 证据链：

1. 唯一运行期消费者是 api-session-controller 的 ApiSessionAgentController：selectionFor 用 sessionProjections.stateOf(session,'modelSelection').pending 初始化闭包变量 picked（AS:274-306），并给该 Agent 的 ctx 装 installModelSelection（AS:303）。我把整个 app.asar 的 @deepseek-ai 包全量扫过：model/selection 只出现在 api-session-controller、session-format 迁移包和 typert 声明里；dsh-agent-loop、dsh-subagent、agent-team **都没有**消费者。
2. installModelSelection 只在 system-prompt/assemble 把 selection.current 快照进 selection.assembled（AG:166-180），在 agent/request 用它覆盖 config（AG:181-192）；而 selection.current 的 getter 只读闭包 picked，否则回落 agent.session.requestHeader()（AS:291-309）——**不读日志里新 append 的 model/selection**。只有 selectForNextRequest 同时写事件与 picked（AS:312-315）。
3. teammate 子会话拿不到这套机制，而且是被明文拒绝：hasApiSessionSubagentOwner 第一行就是 if (session.header.origin === 'subagent') return true（AS:128-134），resolve 直接抛 session/agent-busy（AS:225）；子会话 meta.origin 就是 'subagent'（SA/child-agent.js:107-121）。子会话创建走 manager 自己的 setup（SA/manager.js:762-786），从不经过 composeAgent 的 installSelection（AS:351-364）。
4. 所以 pending 即使被 append 出来，也只是**投影状态**（AS:2156-2171 的 fold），对下一轮 config 无影响；profile 里的参考插件也把权威值定义为投影 {lastUsed, next}，与 loop 的 options 无关（dsh-subagents-model/src/model.js:50-76）。
5. 「被 end-seed 封进前缀而失效」不是主因：shim 的 recordSelection 发生在 resume 之后（PL:170-177），落在 live 段；下一轮 resume 只重放 descriptor、不重放这条事件，所以它的价值本来就只有投影/UI 维度。

---

## 3. 为什么 list_agents / roster 的 model 切换后不刷新

| 位置 | 事实 |
| --- | --- |
| AT:909-936 TeamRoster.list（list_agents 用它：AT:1498-1500 → TT:326） | const model = live?.options.model ?? root.options.model（:922）——优先活体 Agent 的创建 options，未 live 时**回落到 Lead 的 options**。 |
| AT:1148-1161 memberView（spawn/switch 的返回值） | live?.options.model 有才给 model 字段（:1158），无回落，未 live 时字段直接缺失。 |
| AL:747-751（options 在 :750） | options 是构造时对象，整份生命周期不变；所有改路由机制都不改写它。 |
| AT:1188-1190 availability | status === 'running' ? 'running' : 'inactive'——**已释放**与**活着但空闲**都是 inactive，成员 status 无法区分二者；唯一判据是 ctx.agents.get(member.id)。 |

结论：roster 展示的是「创建时的 options.model」，既不是 modelSelection 投影也不是 descriptor；teammate 被释放时甚至展示 **Lead 的 model**（AT:922）。所谓「切换后不刷新」乃至「显示一个它从没用过的 model」都由这条表达式决定。要刷新必须改读投影 modelSelection（{lastUsed, next}）或 descriptor 的 agentModel。

---

## 4. 根因排序（第二次起不再生效）

### R1（最可能，约 85%）：live 分支是空操作，第二次及以后都打在活体上

链路：PL:324-331（live !== undefined）→ PL:327 recordSelection(live, selection) → PL:273-284：typeof agent?.model?.select === 'function' 为 **false**（本运行时 Agent 没有 model 门面：AL:747-770 的字段清单里没有 model；全仓 grep agent.model 无命中）→ 退化成 agent.session.append('model/selection', selection) → 由 §2.3，**没有任何消费者把它变成下一轮 config**。

同时 PL:329 的 liveSelection(live) 也拿不到新路由：agent.model.current 不存在，回落 session.requestHeader()?.config = 上一次请求头 = **旧路由**。于是：

- 该 teammate 已发过请求时：工具如实报 selected == previous == 旧路由（PL:326-330）。
- 它还没发过请求时：liveSelection 返回 undefined，?? selection 让输出**看起来**是新路由，实际无效（更隐蔽）。

为什么第一次成功：teammate 回合结束后会被自然 settle 释放（SA/manager.js:902-955、961-972、1047），此时 ctx.agents.get(member.id) === undefined → 走冷态分支 PL:335-345 → routeOverrides → 下次 wake 的 ownerCtx.agents.resume（SA/manager.js:788）被 PL:147-187 的 shim 覆盖 → **只有这条路真的改路由**。而「用完发现端点炸了」这种典型场景，切换发生在 teammate **正在跑**的时候（活体），于是从第二次起每次都无效。

**可判定判据**

1. 切换瞬间 ctx.agents.get(member.id) 是否为 undefined；只有 undefined 才会用 resume。
2. 切完让 teammate 再跑一轮，读它自己的 Session 日志：
   - 有 model/selection{NEW} 但其后没有 request/header{config:{NEW}}，下一条 request/header 仍是 {OLD} → 命中 R1。
   - 日志里连新的 model/selection 都没有 → 不是 R1（append 都没跑到）。
3. 工具输出里 selected 与 previous 相同且等于旧路由 → 强证据（PL:326-330）。

### R2（次可能，约 10%）：目标不 running，但 resident 仍在（没有真正 settle），因此没有 resume

SA/manager.js:1113-1116：只要 resident.get(childId) 还在，send_message 就 agent.steer(...) 到**同一个**激活，不会 resume，routeOverrides 也就没机会生效。收不掉的几种情形：该 child 有 ownedChildren（:967-968 返回 'wait'）；inbox 仍有 pending（:969-970）；watchLocalSettlement 与另一段 activity 抢 runMaintenance 失败后反复 retry（:930-938）。

与 R1 的区别：R1 是「Agent 活着」；R2 是「Agent 也许已不在，但 resident 条目还在关闭事务里」这类时序。

**判据**：在 resume shim 里打点（PL:160-166 加计数器/日志）。命中 R2 时 shim **一次都没被调用**，而 member.status 仍是 inactive。

### R3（可排除；按点名逐条评估）

**(a) agents.resume 被别处持有旧引用 / 对象不可写**

- 调用点 this.ownerCtx.agents.resume(...)（SA/manager.js:788）每次读属性、不解构；cordis traceable Proxy 的 set 落到原始实例（CO/utils.ts:201-212），get 也转发原始实例（CO/utils.ts:173-200），PL:179-180 的赋值对所有 ctx 可见。类方法在 prototype 上且可写，赋值只是建一个自有属性。→ 不会失效。
- 真正的失效面是「**没走 agents.resume**」：AL:1611-1620 与 restoreOrCreateConfigured（AL:1641-1655）直接调内部 resumeWith，绕过服务方法；只影响配置声明的主会话，不影响 teammate。

**(b) live path 的 agent.model.select(selection) 是否让后续每一步都用新路由**

- 该门面在本运行时**不存在**，问题不成立（PL:274 的 typeof 判断每次都 fallback）。
- 即便存在（api-session 的等价物 selectForNextRequest，AS:312-315）：它设置闭包 picked，而 installModelSelection 每次重新快照 current（AG:167-170），**不是「只对下一步生效」**；picked 只在与新 request/header 匹配时被 consume 清掉（AS:313-320 + AS:2997-3001），此后 current 从 requestHeader() 取到的是**新**路由，依旧正确。所以对主会话是持久的、不是被缓存成旧 header；对 teammate 则完全不适用（AS:128-134 拒绝接管）。

**(c) 第二次切换时目标是 live 还是已释放（成员 status 与 agents.get 的关系）**

- AT:1188-1190 的 availability 只有 running / inactive，inactive 同时覆盖「活着但空闲」与「已释放」。**不能**用 member.status 判断；唯一判据是 ctx.agents.get(member.id)，插件这点做对了（PL:324-325）。
- 注意：team 的成员释放是**每回合**发生的（§1.3），所以「切在空闲时」通常确实走 resume；出问题的是「切在跑着/尚未 settle 时」。

### 附带发现（explains 为什么一直没被拦住）

test/smoke.mjs:11-38 的假 Agent **自带 model: {current, select} 门面**（注释写 Mirror AgentModel），真实运行时没有这个门面。于是单测里第 1、2 条 live 切换断言（test/smoke.mjs:126-140）在真实环境永不成立——**测试通过与被测行为无关**。

---

## 5. 修的方向（一行，超出本报告范围）

live 时唯一能改路由的接缝是 child agent ctx 上的 **agent/request waterfall**（AL:1191-1195 会跑它；子会话没有别的监听者，等于独占）；或者在 live 时先 ctx.subagents.drainChildren(root,[childId]) 强制释放，让下一次 wake 走 resume。agent.session.append('model/selection') 与 agent.model.* 在本运行时都不是可用接缝。
