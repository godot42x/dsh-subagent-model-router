# DSH 客户端插件 UI 扩展机制 recon（模型选择 UI）

> 目的：为 `dsh-agent-team-model` 增加两个 UI 能力找可行落点
> (a) **会话级**「本会话允许的 subagent 模型列表」（覆盖全局设置）
> (b) 在 subagent 界面里 **UI 切换某个 subagent 的模型**
>
> 证据全部来自编译产物；版本 = `@deepseek-ai/*` 0.2.1-rc.5（app.asar 内）。
> 路径前缀约定：
> - `PKG/` = `/tmp/dsh-recon/dsh/node_modules/@deepseek-ai/`（已解包）
> - `X/` = `/tmp/dsh-x/dsh/node_modules/@deepseek-ai/`（本次从 app.asar 按需解包，方法见附录 A）
> - `REF/` = `/Users/mark/.dsh/profiles/desktop/node_modules/dsh-subagents-model/`
> - `PROFILE/` = `/Users/mark/.dsh/profiles/desktop/`

---

## 0. 结论速览

| 问题 | 结论 | 关键证据 |
|---|---|---|
| 官方设置页注册在哪 | 插件页 `plugins.item` slot，`id: "subagent"`，一次保存写 **两个** settings namespace | `PKG/dsh-client-ui-settings-subagent/lib/client.js:839-846` |
| allowedModels 存哪 | Host 侧 schemastery volatile Config（profile patch），namespace 名 = **Loader entry id** `subagent-model-selection-settings` | `PKG/dsh-tool-subagent/lib/model-selection-settings.js:41-46,66`；`PROFILE/cordis.patch.yml:207-212` |
| 有没有会话级概念 | 设置本身**没有**会话维度；唯一"会话级"是组合时把策略**快照**成 session 事件，之后改设置不再影响已组合会话 | `PKG/dsh-tool-subagent/README.zh.md:76`；`lib/index.js:290-293,540-558` |
| subagent 面板能拿到什么 | 只能拿 `subagentCatalog` 投影（id/label/mode/createdAt）与 session 摘要；**没有任何模型字段** | `PKG/dsh-client-ui-subagent/lib/client.js:356-377`；`X/dsh-subagent/lib/types/catalog.js:11-50` |
| subagent 面板可插入点 | `conversation.session.header.actions`(list) / `.utilities`(list) / `conversation.composer.dock`(list) / `conversation.input.left|right`(list)；**下拉列表每行没有 slot** | `X/dsh-client-ui-conversation/lib/client.js:20058-20072,20108-20131`；`PKG/dsh-client-ui-subagent/lib/client.js:164-338`（无 renderSlot） |
| 官方能否切 subagent 模型 | **被刻意禁止**：官方模型座位对 child session 直接 `available=false`，`assertAvailable` 抛错，`/model` 也拒绝 | `X/dsh-client-ui-model-selection/lib/client.js:1887,1913,1920,943-944` |
| 但 host 有通用切换 API | `session/selectModel` 对 **live** child 可用，冷 child 被 subagent 归属检查拒绝 | `X/dsh-api-session-controller/lib/typert.remote-client.js:1880`；`lib/index.js:793-808,221-225,1068` |
| Agent Teams 队友卡片 | 无独立 slot：`conversation.session.header.actions` 的 `agent-team`(order -20) 弹出面板内部渲染，**整文件 0 个 renderSlot** | `PKG/dsh-experimental-client-ui-agent-team/lib/client.js:491-497,88-145` |
| 队友模型能否切 | 本 build **没有**任何切换协议：roster 只读 `options.model`，team 工具集无模型参数 | `PKG/dsh-experimental-agent-team/lib/index.js:909-935,1147-1163`；`X/dsh-experimental-tool-agent-team/lib/index.js:250-334` |
| client↔host | 只有 `ctx.remote.<ns>.<method>`（**生成物**、build 期固定）+ `ctx.remote.$on(<allowlist>)`；自定义 namespace 需 `./typert` 产物或 `ctx.typert.register()` | `X/dsh-api-remotes/lib/types/client/index.js:1-48`；`X/dsh-api-remotes/lib/types/remote-events.js:16-45`；`X/dsh-typert-loader/README.zh.md:27-29` |
| 推荐 | **路径 A（客户端 UI + host 侧 session 事件/官方 remote 生效）**；settings 只当"数据存储层" | §6 |

---

## 1. 官方 subagent 设置页机制（Q1）

### 1.1 包形态：宿主半侧是空壳，浏览器半侧是全部
- `PKG/dsh-client-ui-settings-subagent/lib/index.js:1-13` — 注释直说：空 `apply` 只为占一条 Loader 行，浏览器半侧通过 `exports["./client"]` 被发现；**本包不注册任何 namespace**，`subagent` 与 `subagent-model-selection` 由委派插件注册。
- `PKG/dsh-client-ui-settings-subagent/package.json:29-39` — `dsh.client.inject` = `[locale, ui-settings, ui-plugin-manager, api-remotes]`，`platform: "web"`；`:16-28` 是 `main`/`exports`（`./client` → `lib/client.js`）。

### 1.2 注册到哪个分区/组件
- `client.js:839-846`：
  ```js
  ctx.effect(() => ctx.configForms.whileServed([SUBAGENT_NS, SUBAGENT_MODEL_SELECTION_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
      name: "plugins.item", id: "subagent", order: 10, label: () => t("subagentTitle"), locale: NS,
      inject: () => subagentCardFace(limitsFace, modelsFace)
  }, SubagentCard))), "ui-settings-subagent: page");
  ```
  → 分区 = **插件页**（`plugins.item`），不是独立设置页；`whileServed` 让"Host 服务任一 namespace 才出现"。
- 组件树：`SubagentCard`（`client.js:420-467`，`SettingsForm` + 两个 section）→ `SubagentLimitsFields`（`:126-190`，depth/capacity）/ `SubagentModelSelectionFields`（`:228-...`，开关 + 按 provider 分组的复选框）。
- 语言：`NS = "settings.subagent"`（`:796`）；`inject = ["slots","locale","remote","remote.session","configForms"]`（`:803-809`）。

### 1.3 如何读写全局 allowedModels（三层）
**① 绑定表单**：`ctx.configForms.get(<entryId>)`
- `client.js:820` `const limits = new SubagentLimitsCardController(ctx.configForms.get(SUBAGENT_NS));`（`SUBAGENT_NS = "subagent"`，`:801`）
- `client.js:824` `new SubagentModelSelectionCardController(ctx.configForms.get(SUBAGENT_MODEL_SELECTION_NS), ctx)`
- `client.js:515` `const SUBAGENT_MODEL_SELECTION_NS = "subagent-model-selection-settings"` ← **实际串带 `-settings` 后缀**，README 里的 `subagent-model-selection` 是旧称。

**② 读/写值（客户端只认快照 + 修订栅）**
- 读：`client.js:634` `this.scope.getSnapshot().value?.allowedModels.map(...)`；`:636-638` `enabled`。
- 写：`client.js:711-722` `await this.scope.mutate([{op:"set",path:["enabled"],...},{op:"set",path:["allowedModels"],value: desired.map(({provider,model})=>({provider,model}))}], this.draftRevision)`。
- 并发：`client.js:594-599` 订阅 scope，revision 变了就 `conflicted = true`；`:701-705` 保存前再比 revision。
- 透传实现在 UI 基座：`X/dsh-client-ui-settings/lib/client.js:1170` `this.ctx.remote.settings.mutate(ns, ownedOps, revision)`；`:1447` `remote.settings.describe()`；`:1479` `inject = ["remote","remote.settings"]`。
- 表单工厂：`X/dsh-client-ui-settings/lib/client.js:1294-1301` `get(entryId) { ... new ConfigFormController(this.owner, { namespace: entryId }, ...) }`；`:1315-1334` `whileServed(namespaces, register)`。

**③ Host 侧真实拥有者（schemastery，不走 settings 服务 API）**
- `PKG/dsh-tool-subagent/lib/model-selection-settings.js:41-46`：`SubagentModelSelectionConfig extends Service`，`static Config = z.object({ enabled: z.boolean().default(false).volatile(), allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile() })`，`super(ctx, "subagentModelSelection")`。
- `model-selection-settings.js:66` `const name = "subagent-model-selection-settings";` → **namespace = 这个 entry 的 Loader id**。
- 闭环证据：`PROFILE/cordis.patch.yml:207-212` 正是 `- id: subagent-model-selection-settings / name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings" / config: {enabled: true, allowedModels: [{provider: opencodex, model: ...}]}`。⇒ allowedModels 是 **profile 级持久配置**（写 profile patch 文件）。
- settings 服务如何把它变成 namespace：`X/dsh-settings/lib/index.js:413-465`（`describe()` 遍历 `configEditor.configuration()`，`ns: entry.options.id`，要求 `volatileForm(schema) !== undefined`）；写入 `:502-520`（`entries().find(row => row.options.id === ns)` + `isVolatilePath` 校验）；`X/dsh-settings/README.zh.md:33` "表单只展示活动且可唯一定位的 profile 条目中的 volatile 字段"。

### 1.4 模型候选（目录）来源
- `client.js:754` `const response = await this.ctx.remote.session.modelCatalog();`（`:757-758` 取 `groups` / `failures`）。
- 失效信号：`client.js:827-835` 订阅 `llm/adapters-updated`、`settings/document-updated`、`connection/reset`。

### 1.5 有没有"会话级"概念 —— **没有**
- 设置页 copy 自己写明：`client.js:76`（zh，"…仅影响新会话。"）/ `:38`（en）。
- 机制上：`PKG/dsh-tool-subagent/lib/index.js:540-558` `selectForSession(target)`：先读**该 session 的策略投影**；没有则（子会话）继承父会话，或（全新会话，`firstLiveSeq === 0` 且首事件不是 `session/end-seed`）读**全局设置** `settings.current()`，随后 `recordSubagentModelSelection(...)` 把结果**写成 session 事件**。
- 事件与投影：`lib/index.js:259-274`（`subagent/model-selection-policy` → `key: "subagentModelSelectionPolicy"`；注释 `:258` 明说 **Host-only**，无 `wire` 视图）；写入器 `:290-293`（只写第一条）。
- 组合时捕获 + 记忆化：`:559-561`（直接 session）、`:570-591`（`installScoped` 用 `WeakMap` 记忆化，仅 `agent/created` `:605-607` 与 `tools/change` `:611` 触发；`removeScoped` 只在 agent 销毁 `:592-600`）。
- 结果：**策略在 agent 组合那一刻冻结**；之后改全局设置或补写该 session 的策略事件都不会重装工具（`installScoped` 命中缓存直接 return）。README 同口径：`PKG/dsh-tool-subagent/README.zh.md:76`（"…此模式在每个全新顶层 Session 组合时读取…记录进 Session…后续设置编辑不会改变它"）。

> 对我们的含义：(a) 要做"覆盖全局"的**会话级**列表，官方唯一识别的载体就是 **组合前** 写进 session 的 `subagent/model-selection-policy` 事件；写晚了不生效。

---

## 2. 官方 subagent 面板的挂载点（Q2）

包：`PKG/dsh-client-ui-subagent/lib/client.js`（1003 行）。

### 2.1 它注册了什么（可对照的 slot API 名）
| 行 | slot | 形态 | 用途 |
|---|---|---|---|
| `:978-982` | `conversation.session.header.lineage` | 无 children（single 占位，声明见 `X/.../dsh-client-ui-conversation/lib/client.js:20054-20057`） | 标题旁血缘/切换器 |
| `:983-989` | `conversation.session.header.actions` | `id: "subagent-catalog"`, `order: 10` | 头部 subagent 目录下拉 |
| `:990-995` | `conversation.composer` | `priority: -10` | 只读 composer 接管 |
| `:830-837` | `sidebar.right.pane.tab` | `key: SUBAGENT_CHAT_ID` | 侧栏 chat tab 容器 |
| `:838` | `sidebar.chat.conversation` | — | 侧栏 chat 内容 |
| `:818` | `ctx.resources.register(subagentChatResourceProvider(ctx.sessions))` | — | `dsh-resource://subagentchat/session/<id>?parent=&mode=` 资源协议（`:709-715`） |
| `:819-829` | `ctx.sidebarRightTabs.register({...})` | — | tab 类型/标题 |

依赖注入：`client.js:936-942` `inject = ["sessions","uiWorkspace","slots","locale","sidebarRight"]`。

### 2.2 列表与详情怎么拿（全部走 client session store 投影，零 RPC）
- `client.js:356-377`（`CatalogDropdown`）：`const projections = useSessions((state) => state.projectionsBySession);` / `const summaries = useSessions((state) => state.byId);` / `const projected = snapshot.values.subagentCatalog;` → `{state, error, entries}`。
- `client.js:388-392` 当前项 `projections[rootSessionId]?.values.subagentCatalog?.find(e => e.id === currentSessionId)`；`directChildren = catalog?.entries`。
- 刷新：`client.js:974-976` `ctx.sessions.refreshProjections(parentSessionId)`。
- 打开子会话：`client.js:965-973` `ctx.uiWorkspace.openSession(address)` / `ctx.sidebarRight.openResource(subagentChatAddress(address), {kind:"subagentchat", preferNewPane:true})`。
- 投影载荷（**没有 model**）：`X/dsh-subagent/lib/types/catalog.js:11-50`（`mode/label/childId/childCreatedAt` → view `id/createdAt/...`），折入 `:60-80`。
  子会话自己的描述符里**有**模型：`X/dsh-subagent/lib/types/descriptor.js:38-45`（`agentProvider/agentModel/agentReasoningEffort`，仅 continuable），但注释 `:7-14` 说明它是 model-hidden 的持久组合快照，**没有 wire 视图**（`projection-types.js` 只有 `export {}`）。

### 2.3 面板里如何显示模型 —— **完全不显示**
- `grep "model\|Model\|provider"` 该文件只命中 `:64` 一行注释（"四个不相交的 durable provider-usage buckets"）。
- locale 词典 `:846-932`（zh）无任何模型相关键。

### 2.4 现成的切换控件在哪、为什么用不了
- 座位声明：`X/dsh-client-ui-conversation/lib/client.js:20120-20123` `"conversation.input.model": { kind: "single", scope: "session" }`；渲染 `:19278` `renderSlot("conversation.input.model", { locked: modelSeatLocked })`（`locked` 定义 `:19020`，仅 `removed || inert || !live`）。
- 归属者：`X/dsh-client-ui-model-selection/lib/client.js:1903-1924`：
  ```js
  inject: (sessionId) => {
    const directory = models.directoryFor(sessionId);
    const available = sessions.subagentAddress(sessionId) === void 0;   // ← child session 直接 false
    return { available, directory: directory.store,
             load: () => { if (available) directory.load().catch(() => {}); },
             select: (selection) => available ? directory.select(selection) : Promise.resolve(void 0) };
  }
  ```
- 硬闸：`X/dsh-client-ui-model-selection/lib/client.js:943-944` `assertAvailable() { if (!this.available()) throw new Error("model selection is unavailable for addressed subagent sessions"); }`；`/model` 命令同拒 `:1887`。
- 内联扩展点：`conversation.input.model.label`（`:1905-1910` 声明，`kind:"single", scope:"session", inline:true`），语义见 `X/dsh-client-ui-model-selection/README.zh.md:50-54`：**只能渲染非交互内联内容**（名称/徽标），选择、搜索、焦点、勾选全归选择器。⇒ 不能拿它做切换器。

### 2.5 可插入 UI 的挂载点清单（会话作用域，行号来自本 build）
| slot | kind / scope | 声明行 |
|---|---|---|
| `conversation.session.header.lineage` | single / session | `X/dsh-client-ui-conversation/lib/client.js:20054-20057` |
| `conversation.session.header.actions` | **list** / session | `:20058-20061` |
| `conversation.session.header.utilities` | **list** / session | `:20062-20065` |
| `conversation.session.header.corner` | single / session | `:20066-20069` |
| `conversation.session.header.views.actions` | list / root | `:20070-20073` |
| `conversation.input.left` / `.right` | **list** / session | `:20108-20111` / `:20116-20119` |
| `conversation.input.model` | single / session（官方占用） | `:20120-20123` |
| `conversation.composer.dock` | **list** / session | `:20128-20131` |
| `conversation.input.dock` | list / session | `:19953-19956` |
| `conversation.input.overlay` | list / session | `:20100-20103` |
| `conversation.hero.options` | list / session | `:19966-19969` |
| `sidebar.chat.conversation` | — | 由 `dsh-client-ui-subagent:838` 注册 |
| `conversation.session` | single / session | `X/.../conversation:20000`（`ui-subagent:783` 以 `{view:"chat"}` 渲染） |

**关键负面结论**：subagent 目录下拉的每一行**没有** slot —— `PKG/dsh-client-ui-subagent/lib/client.js` 全文只有 2 处 `renderSlot`（`:783`、`:808`），都在外层容器；`CatalogRows`（`:164-338`）内部零 slot。参考插件踩过这个坑并留下记录：`REF/cordis.patch.yml:17-22` + `REF/src/client.js:34-42`（曾强占 `subagent-catalog` 席位加"每行模型标记"，导致整个下拉消失，现已回退并写明"不要再来一次"）。

**层级差异（重要）**：`conversation.header`（含 `session.header.actions`）只在 `main.conversation` 根上渲染（`X/dsh-client-ui-conversation/lib/client.js:17615` `renderSlot("conversation.header", {})`）。侧栏子会话 chat 走的是 `conversation.session`（`PKG/dsh-client-ui-subagent/lib/client.js:783`），**不含 header**；但 `conversation.composer.dock` 属于 `conversation.composer.bar`（渲染点 `X/.../conversation:19262` 附近），child chat 有 composer 即可见 ⇒ 想在 child chat 里放"本子智能体模型"控件，`composer.dock` 比 `header.actions` 更稳。

---

## 3. Agent Teams 面板的挂载点（Q3）

### 3.1 客户端
- `PKG/dsh-experimental-client-ui-agent-team/lib/client.js:457-462` `inject = ["sessions","uiWorkspace","slots","locale"]`。
- `:469-497` 只注册**一个**席位：
  ```js
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
    { name: "conversation.session.header.actions", id: "agent-team", order: -20, locale: NS, inject: () => actions },
    TeamAction));
  ```
- 导航回调 `:478-490` `openTeammate(sessionId, childSessionId)` → `ctx.uiWorkspace.openSession({ parentSessionId, childSessionId, mode: "continuable" })`。
- **整个文件 `renderSlot` 出现次数 = 0**（本次 grep 实测）⇒ 面板内部无扩展点。队友卡片 `TeamMemberRow`（`:88-145`）是面板私有组件，一个 `<button>`，点击只做 `openTeammate`（`:96-112`）。
- 卡片上唯一的模型展示：`:89` `const model = useSessions((state) => state.projectionsBySession[member.id]?.values.modelSelection?.next?.model);`；渲染 `:132-134`（小字 "· 模型: <id>"；CSS 默认隐藏、hover 才显示：`:12` 的 inline CSS `.XdyUwa_memberModel{display:none}` + `:hover` 规则）。
- README 口径一致：`README.zh.md:34`（roster 行、模型来自共享 `modelSelection` 投影）、`:50`（"不挂载任何 Remote namespace"）、`:52`（数据来自 `useSessions / useSessionStatus / useSession` 三个座位）、`:90`（模型仅在 store 有时显示）。

### 3.2 宿主侧：是否已支持切换 teammate 模型 —— **没有**
- roster 冻结 spawn 时的路由，只读：`PKG/dsh-experimental-agent-team/lib/index.js:909-935`（`list()`：lead 用 `root.options.model`，teammate 用 `live?.options.model ?? root.options.model`）、`:1147-1163`（`memberView`）。
- 工具集（本 build 真实清单）：`X/dsh-experimental-tool-agent-team/lib/index.js:250-334` = `spawn_teammate` / `send_message` / `list_agents` / `wait_agent`；`:351-363` `interrupt_agent`（配置门控）；`:364+` `team_task_*`。**没有任何 provider/model 参数，也没有 switch 工具**。
- 交叉验证：整个 app.asar 里 `grep -abo "switch_agent_model"` = **0 命中**；`"spawn_teammate"` 只命中 `dsh-client-ui-tool/lib/client.js`（那是工具渲染文案，不是实现）。⇒ "切换 teammate 模型"在本 build **不存在协议层**，只能由第三方插件自建（正是本仓 `lib/index.js:1-26` 在做的事：wrap `startActivation` seam + 追加 `model/selection`）。

> 对 (b) 的启示：**不要指望官方面板留了按钮位**。可在 `conversation.session.header.actions` 再插一个自己的 cell（`id` 唯一、`order` 避开 `-20`/`10`），或把"当前 session（含 teammate/subagent child）的模型"切换入口做进自己的 chip。

---

## 4. client ↔ host 通信（Q4）

### 4.1 唯一正式通道：`ctx.remote.<namespace>.<method>`（生成物，build 期固定）
- 装配点：`X/dsh-api-remotes/lib/types/client/index.js:1-48` —— 逐个 `import ...Remote from '<host pkg>/remote'`，然后 `ctx.remote.$mount(contribution)`（`:47`），失败逆序回滚（`:50-60`）；注释 `:1` 明确为 "generated Host Remote contributions"。
- 与本任务相关的 namespace：
  - `subagents` ← `@deepseek-ai/dsh-subagent/remote`（`:22`）→ **只有 2 个方法**：`subagents/prompt`、`subagents/interruptByParent`（`X/dsh-subagent/lib/typert.remote-client.js:66,132`）。**没有 list / detail / model**。
  - `session` ← `dsh-api-session-controller/remote`：`session/list|page|follow|projections|prompt|create|fork|rename|search|cancel|control|selectModel|modelCatalog|updateQueue|...`（`X/dsh-api-session-controller/lib/typert.remote-client.js:1426-1977`）。
  - `settings` ← `dsh-api-settings-controller/remote`：`settings/describe|mutate|update|replace|openSettingsDocument`（`X/dsh-api-settings-controller/lib/typert.remote-client.js:265-430`）。
- 产出方式有据：`X/dsh-subagent/lib/typert.remote-client.js:1` "Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit."；server 侧带 `sourceLocation`（如 `session/selectModel` 的 `packages/api/session-controller/src/index.ts:311`）。

### 4.2 事件：`ctx.remote.$on(<allowlist key>)`
- 白名单唯一真源：`X/dsh-api-remotes/lib/types/remote-events.js:16-45`（27 项），含 `settings/document-updated`、`llm/adapters-updated`、`api-session/status|activity|added|removed|error`、`approval/request`、`user-questions/request`、`cordis/*`、`plugin-manager/*` 等。
- 语义：`emit` = 单向通知；`waterfall` = agent 作用域往返（`README.zh.md:43-51`）。**没有自定义事件**：`README.zh.md:43` "该名单同时就是 `ctx.remote.$on` 的合法键集…多转发一个事件只需在该数组里加一项"（= 改官方装配包）。

### 4.3 第三方能不能加自己的 RPC？
- **Host 侧可以**：`X/dsh-typert-loader/README.zh.md:27-29` 原文 "Manual `ctx.typert.register()` remains available for contributions that do not use a `./typert` artifact (hand-written wire schemas…)"；实现见 `X/dsh-typert-loader/lib/index.js:39-44`（`TYPERT_HOST_EXPORT = "./typert"`）与 `:69-88`（manifest 必须本包、`face:"host"`、schema 带 `create()`）。亦可直接 `ctx.typert.remotes.register(contribution)`（`X/dsh-typert-registry/lib/index.js:135-155`）。
- **Browser 侧是瓶颈**：客户端只能调 `$mount` 过的 namespace，装配清单是源码常量（`X/dsh-api-remotes/lib/types/client/index.js:38-46`）。本 build 没有"客户端自己 mount 手写 contribution"的公开路径/文档。
- **备选通道（有坑）**：host 可 `ctx.webServer.register({ kind:'exact'|'prefix', path, handler })`（`X/dsh-host-webserver/lib/index.js:326-333`；`registerUpgrade` `:340-345`；`registerFallback` `:355-357`）。但 `X/dsh-host-webserver/README.zh.md:12` 明确"它只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch"；`:130` "不提供服务器级认证或来源策略" ⇒ **desktop（正在跑的形态）上不建议**当作业务 RPC。

### 4.4 参考插件 `dsh-subagents-model` 的做法（最贴近我们的形态）
- 形态：纯 ESM，**手写 classic bundle**：`REF/src/client.js:84` `window.__ModuleLoader__.load({ id, factory })`；`:1468-1481` 返回 `{ inject: ['slots','locale'], apply }`。分块：`:1270-1275` `require.async('./client.model.js')`（可行性依据 `:1261-1265` 注释指向 `dsh-client-modules/lib/client.js:707-740`）。
- 三处席位（全部**新增** id，绝不替换官方 cell）：`:1389-1408`（`conversation.session.header.actions`）、`:1416-1432`（`sidebar.session.row.hover`）、`:1445-1461`（`conversation.composer.dock`）；常量与理由见 `REF/cordis.patch.yml:6-22`。防御式注册：`:1356-1359`（`whenService(ctx,'slots')` + 必须 `typeof slots.inject === 'function'`）、`:1375-1377`（`register` 会抛，必须包在 `inject` 回调里）。
- 它**怎么读 session 数据**：不读事件流，读 **projection**，来源是 renderer 传给 slot 组件的标准 props 里的 store hooks：
  `:530-534` `const { sessionId, useSessions, loadCatalog, t, m } = props; const readSessions = asHook(useSessions); const projections = readSessions((state) => state.projectionsBySession)`；`:690-693`、`:915-918` 同款。
  解析：`REF/src/client.model.js:50` `const PROJECTION_KEY = 'modelSelection'`；`:247-260` `resolveModel(projectionsBySession, byId, sessionId)`（先 `projectionsBySession[id].values`，未加载则退回 `byId[id].projectionValues` —— 后者覆盖"父目录里列出但从未打开"的 child）；`:226-229` `isLoaded`。
- 它**怎么给 host 发请求**：只有一个只读调用 —— `:1282-1293`：`const readRemote = ctx.get('remote'); remoteService = typeof readRemote.session?.modelCatalog === 'function' ? readRemote.session : null;` / `:1291-1293` `loadCatalog = () => remoteService.modelCatalog()`。并刻意**不**在 `inject` 里声明 `remote`（`:1277-1281`：声明会把 header chip 卡在整个 Remote 链后面）。
- Host 半侧是纯锚点：`REF/src/index.js`（63 行）+ `cordis.patch.yml:24-29`（`dsh-client-modules` 只扫描 **Host Loader 的 live entry**，没有宿主行浏览器半侧不会被打包/送出）+ `:43-44`（"本包不得声明 tool / service / Config schema"）。
- HMR：`:1282-1330` 大量 `typeof ctx.effect === 'function'` / try-catch，理由 `:1298-1302`（`locale.register` 对同 namespace 重复注册会抛）；`patch.yml:31-41` 警告"一个包只能一条 Loader 行"，否则 `ClientPackageCompositionError` 会让 **整个 web shell 失去 `__ModuleLoader__` bootstrap**（= 整个 GUI 挂掉）。

---

## 5. 会话模型相关 host API 的真实边界（决定方案可行性）

1. **`session/selectModel` 存在，且除路由归属外不区分 subagent**
   - 契约：`X/dsh-api-session-controller/lib/typert.remote-client.js:1880-1911`（`{sessionId, provider, model, reasoningEffort?}` → `{selected}`）。
   - 实现：`lib/index.js:793-808`（`resolveAgent` → `requireModel` → `llm.resolveCallConfig` → `agents.selectForNextRequest(agent, selected)`，并后台 `agentDefaultModel.saveSelection(...)`）。
   - 落盘：`selectForNextRequest` 直接 `agent.session.append("model/selection", selection)`（`lib/index.js:313`）+ 立即更新内存缓存（`:314`）。
   - 是否接受 child：`resolve()`（`lib/index.js:221-225`）= 先 `liveAgent` → **live 直接返回**；不是 live 才走 `hasApiSessionSubagentOwner` 拒绝（`:128-134` → `RemoteError("session/agent-busy", … "use subagent delivery for this child session")`，`:140-142`）。
   ⇒ **live 的 subagent/teammate 子会话可用 `session/selectModel` 切换**；冷子会话被拒，需先经 subagent 导航打开（`ctx.uiWorkspace.openSession(address)`）。
2. **投影可见性差异（客户端能读什么）**
   - `session/projections` 返回 schema（`X/dsh-api-session-controller/lib/typert.remote-client.js:1749-1790+`）枚举的键：`inbox / workingDirectory / agentPreset / title / todos / sessionListMetadata / imageLimits / modelSelection / permissions / …`。
   - `modelSelection` 视图 = `{lastUsed, next}`（`X/dsh-api-session-controller/lib/types/model-selection-projection.js:42-52`，`view: state => ({lastUsed, next: pending ?? lastUsed})`）。
   - `subagentModelSelectionPolicy` **不在**其中（`PKG/dsh-tool-subagent/lib/index.js:258` "Host-only projection…" 且无 `wire`）。
   ⇒ UI 能用官方投影显示"这个 session 当前/下一步用什么模型"，但**读不到**"本会话允许的 subagent 模型列表"——那份数据必须自己存。
3. **session 事件写入对第三方开放**：`session.append(type, data)`（`X/dsh-session/lib/index.js:1517-1537`，JSON-serializable 校验）；插件记录专用 `appendPluginRecord(session, 'plugin:<ns>/...', data)`（`:1295`；语法 `PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9]…/` `:1248`；`ignorable: true`，`:1548-1559`）。⇒ host 侧可以给会话写自己的持久数据（`plugin:*`），但**同样没有 client 可见通道**（除非自建 projection/remote）。

---

## 6. 两条路径对比与推荐（Q5）

### 路径 A（推荐）：客户端只做 UI/展示；生效走官方 host API / session 事件

**A1. 切换某个 subagent 的模型（需求 b）**
- 客户端：在 `conversation.session.header.actions`（主会话）或 `conversation.composer.dock`（child chat 更稳，见 §2.5 层级差异）注册自有 cell（`id` 唯一，`order` 避开官方 `10`/`-20`）；props 里自带 `sessionId`，对 subagent/teammate 子会话就是 child 的 id（`REF/src/client.js:530`；官方面板同样按 `member.id` 读，`PKG/…agent-team/lib/client.js:89`）。
- 数据：`projectionsBySession[childId].values.modelSelection.next`（当前模型）+ `ctx.get('remote').session.modelCatalog()`（候选与 reasoning efforts）。
- 落点：`ctx.get('remote').session.selectModel({ sessionId: childId, provider, model, reasoningEffort })`。
- 需要的 host API：`session/selectModel`、`session/modelCatalog`（都已挂载）。**不需要改任何官方插件**。
- 必须写进 UI/错误处理的限制：① 仅对 **live** 子会话有效（`lib/index.js:221-225`），冷会话先经导航打开或明确提示；② 官方 `/model` 与 composer 模型座位仍拒绝 child（`ui-model-selection:1887,1913`），我们只是**多给一个入口**，不要替换座位；③ 官方语义是"下一次请求生效"（`ui-model-selection/README.zh.md:14`）。

**A2. 会话级 allowedModels 覆盖（需求 a）**
- 数据存放（客户端可读写、无需自定义 RPC）：**自有 settings namespace**（= 我们自己的 Loader entry id），Config 建议
  `{ sessions: Dict(z.object({ allowedModels: array(route), updatedAt: number })) }`，字段全部 `.volatile()`。
  - 依据：namespace 由 **loader entry id** 决定（`X/dsh-settings/lib/index.js:413-465`）且要求 volatile（`:502-507`）；客户端用 `ctx.configForms.get('<our-entry-id>')` 绑定，读 `getSnapshot().value`，写 `mutate([...], revision)`（`X/dsh-client-ui-settings/lib/client.js:1294-1301,1170`）。
  - 好处：全走官方通道、带 revision 栅栏、`settings/document-updated` 自动失效（`remote-events.js:42`）。
- 生效（host 半侧）：在**会话组合之前**把 `subagent/model-selection-policy` 事件写进该 session：`ctx.sessions.get(sessionId).append('subagent/model-selection-policy', { allowedModels })`（官方写入器先例 `PKG/dsh-tool-subagent/lib/index.js:290-293`；投影只接受第一条 `:267-273`）。
- **时序硬约束（最重要）**：`tool-subagent` 在 `selectForSession` 读策略并 `install(...)`，`installScoped` 用 `WeakMap` 记忆化（`:570-591`），仅 `agent/created`（`:605-607`）与 `tools/change`（`:611`）触发，销毁才清缓存（`:592-600`）。⇒ 策略事件必须在该 agent **首次组合前**落地，否则工具面不重装（要等 agent 销毁/重开）。
  工程对策（风险从低到高）：
  1. 只对"**全新会话**"提供该 UI（`sessionListMetadata.blank === true` / `firstLiveSeq === 0` 语义见 `tool-subagent:542`），UI 明示"仅对尚未开始的新会话生效"——与官方"仅影响新会话"对齐（`settings-subagent client.js:76`）。
  2. host 在 `ctx.on('agent/created')` 写事件，接受"监听顺序不确定"的风险（我们的 Loader 行需排在 `tool-subagent` 前，insert 顺序可控但属实现细节）→ **必须实测**。
  3. 兜底：不追求改变官方 `subagent` 工具的 allowed 集合，而把"本会话允许的模型列表"作为**我们自有委派入口**的约束（我们已注册 `spawn_teammate_with_model`/`switch_agent_model` 这类工具，`lib/index.js:1-26`）。100% 可控、零时序风险，但**不能阻止**模型直接用官方 `subagent` 工具选任意路由。

  > 官方那条断言在 `tool-subagent` 内部（`:405-452` 把 model 参数拼进 definition、`:453` `assertAllowedModelSelection(...)`），第三方**无法拦截**；"真正覆盖全局"只能靠 A2 的时序，或改官方包。

**路径 A 改动清单**
| 需要什么 | 必须改官方插件？ | 证据 |
|---|---|---|
| 客户端 bundle（`dsh.client` 声明 + `./client` 导出 + 一条 Host Loader 行） | 否 | `REF/package.json:58-65`、`REF/cordis.patch.yml:45-47`、`REF/src/index.js` |
| `session/selectModel` / `session/modelCatalog` | 否 | 已挂载（`api-remotes/lib/types/client/index.js:22-27`） |
| 自有 settings namespace | 否 | 任意 Loader 条目带 volatile Config 即可（`dsh-settings/lib/index.js:413-465`） |
| 会话级策略事件**生效时机** | 否（但要抢在组合前） | `tool-subagent/lib/index.js:540-558,570-611` |
| 每个 subagent 行加按钮 | **是**（或整段替换下拉，风险高） | `dsh-client-ui-subagent/lib/client.js:164-338` 无 slot；`REF/src/client.js:34-42` 的踩坑记录 |

### 路径 B：只用 settings 服务做 "per-session 覆盖"
- **结构上做不到**，三点证据：
  1. namespace id = **profile entry id**（`X/dsh-settings/lib/index.js:439-441,502-505`），一个 entry 一份 document，**没有 session 维度**；写入落 profile patch（`X/dsh-settings/README.zh.md:12`）。
  2. 客户端快照只有 `{value, base, user, revision, writable}`（`X/dsh-client-ui-settings/README.zh.md:34`），不含任何 session 键。
  3. 官方"会话级"实现是**组合时快照成 session 事件**（`tool-subagent/lib/index.js:540-558` + `README.zh.md:76`），不是运行期按 session 读数。
- 所以 B 实际只能：把 map 存进全局文档 → 仍需要 **A2 的 host 消费者**（写策略事件 / 约束自有工具）。即 **B 是 A 的存储层，不是独立方案**。
- 唯一"纯 B"变体：settings 里只放**全局** allowedModels（覆盖官方全局值），会话级仅做展示——等价 A2 的弱化版。

### 推荐
1. **先做 A1**（切换 subagent/teammate 模型）：零官方改动、零时序风险，正好填上"官方拒绝 child 切换"的空白。UI 落 `conversation.session.header.actions`（主会话头）+ `conversation.composer.dock`（child chat 更可靠），id 用 `agent-team-model`。
2. **A2 分两步**：第一步只做"**新会话**的 allowedModels 覆盖"（host 在组合前写 `subagent/model-selection-policy`）；第二步评估"运行中会话"（需 agent 重组合，收益/风险都要实测）。若第二步不可行，就把会话级允许集当作**我们自有委派工具**的约束（A2 兜底 3），并在文档里如实说明官方 `subagent` 工具不受我们限制。
3. **不要走**：替换 `conversation.input.model`（会顶掉官方选择器）、替换 `subagent-catalog`（参考插件已证明整段下拉消失）、自定义 HTTP 路由（desktop 走 IPC 桥，`host-webserver README:12`）、给客户端手写 remote 装配（`api-remotes` 装配是 build 期常量，`client/index.js:35-48`）。

### 热重载冲突风险（desktop 正在跑，务必谨慎）
- **一个包只能有一条 Loader 行**：`REF/cordis.patch.yml:31-41`（重复包名解析 → `ClientPackageCompositionError` → **整个 web shell 没有 `__ModuleLoader__`**，全 GUI 挂）。我们已有 `cordis.patch.yml` 的 `id: agent-team-model`，新增客户端能力应**复用同一条 entry**，不要 insert 第二行。
- **settings namespace 与 entry id 绑定**：HMR 换 id = 换 namespace，旧值变孤儿；改 id 需迁移。
- **`locale.register` 重复注册会抛**：`REF/src/client.js:1298-1302`（HMR 二次 apply 必须 try-catch，实测坑）。
- **revision 栅栏与 HMR**：草稿跨重载失效 → 保存时 `SettingsConflictError`（`X/dsh-settings/lib/index.js:168-176`）；UI 按官方做法"冲突就要求丢弃草稿"（`settings-subagent client.js:595-598`）。
- **客户端 bundle 更新**：`dsh-client-modules/README.zh.md:38-42`（HMR 用带 revision 的单资源 URL 替换变化的 row；"设置 → 插件 → 插件列表"显示同步失败并可重试）；`:47`（release 不同的 Host 不应用图）。

---

## 附录

### A. 解包方法（app.asar，本次实际使用）
- asar 无压缩。头：`offset4 = payloadSize (uint32LE)`、`offset12 = jsonLen (uint32LE)`，header JSON 从 offset 16 开始；数据基址 `base = 8 + payloadSize`；条目 `offset/size` 是十进制**字符串**。
- 脚本：`/tmp/asar.mjs`（`index()` 走树、`readFile(path)` 读单文件）、`/tmp/x.mjs <substr...>` 按子串批量导出到 `/tmp/dsh-x/`（保留 asar 内相对路径 `dsh/node_modules/@deepseek-ai/...`）。
- 已解包到 `/tmp/dsh-x/`：`dsh-client-ui-settings` / `dsh-api-remotes` / `dsh-client-modules` / `dsh-client-ui-model-selection` / `dsh-client-ui-renderer` / `dsh-api-session-controller` / `dsh-api-settings-controller` / `dsh-subagent` / `dsh-settings` / `dsh-session` / `dsh-typert-registry` / `dsh-typert-loader` / `dsh-host-webserver` / `dsh-client-ui-conversation` / `dsh-experimental-tool-agent-team`。

### B. 不存在 / 容易误引的东西
- **没有**独立的 `@deepseek-ai/dsh-client-ui-slots` 包：asar 条目名里含 "slot" 的只有 `@js-temporal/polyfill/lib/slots.ts`。`ctx.slots` 由渲染/外壳提供，slot **声明数据**在 owner 包（如 `dsh-client-ui-conversation`）。参考插件也只依赖 `slots.inject` / `slots.register` 两个方法（`REF/src/client.js:1356-1461`）。
- 本 build 的 asar 内**不存在** `switch_agent_model` / `spawn_teammate_with_model` / `list_agent_models`（唯一命中在 `dsh-client-ui-tool` 的渲染文案）⇒ 这三项是本仓 `lib/index.js` 自实现，不是官方 API。

### C. 本次未验证、需跑一次才能下结论
1. `session/selectModel` 打到 **live** subagent child 是否真被接受（代码路径支持：`lib/index.js:221-225` 先 `liveAgent` 直接返回；但官方 UI 刻意不调，属"无官方用例"）。
2. host 插件在 `agent/created` 里 append `subagent/model-selection-policy` 能否抢在 `tool-subagent` 的 `installScoped` 之前（监听顺序未文档化）。
3. 在 `conversation.composer.dock` 注册的 cell 是否真的出现在**侧栏 child chat**（由 `conversation.composer.bar` 的渲染点推断，未实机验证）。
4. 插件 `apply` 早于 Remote 链就绪时 `ctx.get('remote')` 可能为空（参考插件用 `ctx.get` + 不声明 inject 规避，`REF/src/client.js:1277-1290`）；实现需同样兜底。
