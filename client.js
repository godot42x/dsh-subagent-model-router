/**
 * dsh-subagent-model-router - the browser half.
 *
 * Three seats, all ADDED (never replacing a shipped one):
 *   1. conversation.composer.dock  - the panel (allow-set + subagents + switch)
 *   2. conversation.session.header.actions - the route this conversation runs on
 *   3. sidebar.session.row.hover - the same route as one sidebar line
 *
 * Rules this file follows, each learned from review:
 *   - An action never sits away from its target: switching a child happens
 *     inside that child own row.
 *   - Reads are cached per conversation per page load, so opening the panel
 *     does not append command events; only a real edit writes.
 *   - Only direct children are listed (that is all the host lets this session
 *     re-route); deeper descendants are a count, never a dead row.
 *   - A teammate never gets a spawn tool: delegation does not recurse.
 *   - Internals (depth, session ids) render only with ?dev=1.
 *   - Every user-visible string comes from the locale dictionaries below, so
 *     the panel follows the harness language (zh / en).
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-model-router',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const DOCK_SLOT = 'conversation.composer.dock'
    const DOCK_ID = 'subagent-model-panel'
    const DOCK_ORDER = 45
    const ACTIONS_SLOT = 'conversation.session.header.actions'
    const ACTIONS_ID = 'subagent-model-header-chip'
    const ACTIONS_ORDER = 45
    const HOVER_SLOT = 'sidebar.session.row.hover'
    const HOVER_ID = 'subagent-model-hover-row'
    const HOVER_ORDER = 45

    /** Flattened services this module touches; Cordis refuses undeclared ones. */
    const INJECT = ['slots', 'locale', 'remote', 'remote.commands', 'remote.session']

    const MODEL_KEY = 'modelSelection'
    const IDENTITY_KEY = 'subagent'
    const CATALOG_KEY = 'subagentCatalog'
    const MAX_PARENT_HOPS = 8
    /** Locale namespace for this plugin dictionaries. */
    const NS = 'dsh-subagent-model-router'

    /** Every user-visible string, in the two languages the harness ships. */
    const MESSAGES = {
      zh: {
        'chip.root': '子智能体',
        'chip.rootCount': '子智能体 · {count}',
        'chip.rootRunning': ' · {count} 运行中',
        'panel.rootTitle': '子智能体模型',
        'panel.childTitle': '本子智能体模型',
        'panel.allowSet': '允许集合',
        'panel.edit': '编辑列表',
        'panel.done': '完成',
        'panel.emptyList': '还没有列表：默认允许任意路由，子会话跟随你的路由。添加一条即启用白名单。',
        'panel.provider': 'provider',
        'panel.model': 'model',
        'panel.noCatalog': '没有模型目录',
        'panel.add': '添加',
        'panel.import': '导入部署默认（{count} 条，导入后可在本会话继续改）',
        'panel.children': '子智能体',
        'panel.noChildren': '还没有',
        'panel.childrenMeta': '{count} 个{running}{deeper}',
        'panel.running': ' · {count} 运行中',
        'panel.deeper': ' · 另有 {count} 个深层',
        'panel.directOnly': '这里只列直接子智能体；更深的在各自会话里切换。',
        'panel.switchTo': '切到',
        'panel.pickRoute': '选择路由…',
        'panel.noRoute': '没有可选路由',
        'panel.confirm': '确认',
        'panel.cancel': '取消',
        'panel.impact': '它下面还有 {count} 个子智能体继承这条路由，会一起变。',
        'panel.hint': '⇄ 只改这一行；你自己切换模型请用顶部的模型选择器。',
        'panel.current': '当前路由',
        'panel.inheritFromParent': '继承父会话',
        'panel.pendingLine': '待生效 · 上一轮 {model}',
        'panel.switch': '切换',
        'panel.childAllow': '可选路由来自父会话的允许集合（{count}）。',
        'panel.childAllowOpen': '可选路由来自父会话的允许集合（未限制）。',
        'panel.devSession': 'session {id} · 来源 {source}',
        'mode.session': '本会话白名单 · {count} 条',
        'mode.deployment': '跟随部署默认 · {count} 条',
        'mode.open': '不限制（子会话默认跟随父会话路由）',
        'mode.unknown': '读取失败',
        'badge.inherited': '继承',
        'badge.start': '启动路由',
        'badge.pending': '待生效 →',
        'badge.unknown': '未知',
        'route.unknown': '未知',
        'summary.empty': '还没有子智能体',
        'summary.head': '子智能体 {count} 个',
        'summary.unrouted': '  {count} 个路由未知',
        'summary.inherited': '  {count} 个跟随父会话',
        'summary.running': '  {count} 个正在运行',
        'hint.inherited': '没有自己的路由，跟随父会话',
        'hint.start': '启动时指定的路由，还没跑过一轮',
        'hint.unknown': '父链上没有记录，无法判断实际路由',
        'hint.pending': '已排队切到新路由，下一轮起生效（上一轮 {model}）',
        'hint.running': '正在运行',
        'header.model': '模型',
        'header.pending': '→ 待生效',
        'header.titleInherited': '（继承父会话）',
        'header.titlePending': '（已排队，下一轮起生效；上一轮 {model}）',
        'hover.model': '模型',
        'hover.inherited': '（继承）',
        'hover.pending': ' → 待生效',
        'error.noCommands': 'commands Remote 不可用',
        'error.unknownCommand': '未识别的命令：{line}',
        'error.emptyResult': '命令没有返回结果：{line}',
        'error.keepOne': '列表至少保留一条；要放开限制请清空部署设置并新开会话',
        'error.pickRoute': '先选择一条路由',
        'error.pickChild': '先选择一个子智能体',
        'title.panelChild': '切这个子智能体自己的模型',
      },
      en: {
        'chip.root': 'Subagents',
        'chip.rootCount': 'Subagents · {count}',
        'chip.rootRunning': ' · {count} running',
        'panel.rootTitle': 'Subagent models',
        'panel.childTitle': 'This subagent model',
        'panel.allowSet': 'Allowed set',
        'panel.edit': 'Edit list',
        'panel.done': 'Done',
        'panel.emptyList': 'No list yet: any route is allowed and children follow your route. Adding one route turns the allowlist on.',
        'panel.provider': 'provider',
        'panel.model': 'model',
        'panel.noCatalog': 'no model catalog',
        'panel.add': 'Add',
        'panel.import': 'Import deployment default ({count} routes, then keep editing here)',
        'panel.children': 'Subagents',
        'panel.noChildren': 'none yet',
        'panel.childrenMeta': '{count}{running}{deeper}',
        'panel.running': ' · {count} running',
        'panel.deeper': ' · {count} deeper',
        'panel.directOnly': 'Only direct subagents are listed; deeper ones switch inside their own conversation.',
        'panel.switchTo': 'Switch to',
        'panel.pickRoute': 'Pick a route…',
        'panel.noRoute': 'no selectable route',
        'panel.confirm': 'Apply',
        'panel.cancel': 'Cancel',
        'panel.impact': '{count} subagent(s) below inherit this route and will change too.',
        'panel.hint': 'The switch control changes only that row; use the model picker at the top for your own route.',
        'panel.current': 'Current route',
        'panel.inheritFromParent': 'inherited from the parent',
        'panel.pendingLine': 'Queued · previous {model}',
        'panel.switch': 'Switch',
        'panel.childAllow': 'Selectable routes come from the parent allow-set ({count}).',
        'panel.childAllowOpen': 'Selectable routes come from the parent allow-set (unrestricted).',
        'panel.devSession': 'session {id} · source {source}',
        'mode.session': 'Session allowlist · {count} routes',
        'mode.deployment': 'Following deployment default · {count} routes',
        'mode.open': 'Unrestricted (children follow the parent route)',
        'mode.unknown': 'read failed',
        'badge.inherited': 'inherited',
        'badge.start': 'start route',
        'badge.pending': 'queued →',
        'badge.unknown': 'unknown',
        'route.unknown': 'unknown',
        'summary.empty': 'no subagents yet',
        'summary.head': '{count} subagent(s)',
        'summary.unrouted': '  {count} with unknown route',
        'summary.inherited': '  {count} following the parent',
        'summary.running': '  {count} running',
        'hint.inherited': 'no route of its own, follows the parent',
        'hint.start': 'route it was created with, no turn has run yet',
        'hint.unknown': 'nothing on the parent chain records a route',
        'hint.pending': 'a new route is queued and starts on the next turn (previous {model})',
        'hint.running': 'running',
        'header.model': 'model',
        'header.pending': '→ queued',
        'header.titleInherited': ' (inherited from the parent)',
        'header.titlePending': ' (queued, applies next turn; previous {model})',
        'hover.model': 'model',
        'hover.inherited': ' (inherited)',
        'hover.pending': ' → queued',
        'error.noCommands': 'commands Remote is unavailable',
        'error.unknownCommand': 'unknown command: {line}',
        'error.emptyResult': 'command returned nothing: {line}',
        'error.keepOne': 'keep at least one route; to lift the gate, clear the deployment setting and open a new conversation',
        'error.pickRoute': 'pick a route first',
        'error.pickChild': 'pick a subagent first',
        'title.panelChild': 'switch this subagent model',
      },
    }

    /** Fill {placeholders} from one vars object. */
    function format(text, vars) {
      if (vars === undefined || vars === null) return text
      return String(text).replace(/\{\s*([a-zA-Z]+)\s*\}/gu, (whole, name) => {
        const value = vars[name]
        return value === undefined || value === null ? whole : String(value)
      })
    }

    /** A translator bound to one language code. */
    function makeT(language) {
      const dictionary = MESSAGES[language] ?? MESSAGES.zh
      return (key, vars) => format(dictionary[key] ?? MESSAGES.en[key] ?? key, vars)
    }

    /** Guess the language when the harness exposes no locale service. */
    function detectLanguage() {
      try {
        const lang = navigator === undefined ? '' : navigator.language
        if (typeof lang === 'string' && lang.length > 0) return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        // A shell without navigator keeps Chinese, the project default.
      }
      return 'zh'
    }

    /**
     * Register both dictionaries with the harness locale service.
     * register() throws on a duplicate namespace+locale pair, which is exactly
     * what a hot reload does, so every call is guarded and the existing
     * dictionary stays in place.
     */
    function registerDictionaries(ctx) {
      let locale
      try {
        locale = ctx.get('locale')
      } catch {
        return
      }
      if (locale === undefined || locale === null || typeof locale.register !== 'function') return
      for (const language of ['zh', 'en']) {
        try {
          locale.register(NS, language, MESSAGES[language])
        } catch {
          // Already registered by an earlier apply.
        }
      }
    }

    /** Bind the harness translator, falling back to a local dictionary. */
    function bindTranslator(ctx) {
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') return bound
        }
      } catch {
        // Fall through to the local dictionary.
      }
      return makeT(detectLanguage())
    }

    /** Internals render only when explicitly asked for. */
    const DEBUG = (() => {
      try {
        const search = window === undefined ? undefined : window.location?.search
        if (typeof search === 'string' && /(?:^|[?&])dev=1(?:&|$)/u.test(search)) return true
        const stored = window === undefined ? undefined : window.localStorage?.getItem('dsh.debug')
        return stored === '1'
      } catch {
        return false
      }
    })()

    const S = {
      root: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'transparent', color: 'inherit', borderRadius: '999px',
        padding: '2px 10px', fontSize: '12px', lineHeight: '18px', cursor: 'pointer',
      },
      headerChip: {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        borderRadius: '999px', padding: '1px 8px', fontSize: '12px',
        lineHeight: '18px', whiteSpace: 'nowrap',
      },
      panel: {
        position: 'absolute', bottom: '28px', left: '0', zIndex: 40,
        width: '400px', maxHeight: '66vh', overflow: 'auto',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        borderRadius: '12px', padding: '14px 16px',
        background: 'var(--dsh-surface, #1b1b1b)', color: 'inherit',
        boxShadow: '0 8px 28px rgba(0,0,0,0.35)', fontSize: '12px',
      },
      titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      title: { fontWeight: 600, fontSize: '13px' },
      section: { marginTop: '10px' },
      line: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' },
      routeRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
      childRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 4px', borderRadius: '6px' },
      childRowOpen: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 4px', borderRadius: '6px', background: 'var(--dsh-hover, rgba(127,127,127,0.14))' },
      name: { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      model: { fontFamily: "'SF Mono', ui-monospace, Menlo, monospace", fontSize: '10.5px', opacity: 0.62, whiteSpace: 'nowrap' },
      badge: { fontSize: '9.5px', borderRadius: '999px', padding: '1px 7px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', whiteSpace: 'nowrap' },
      badgeWarn: { fontSize: '9.5px', borderRadius: '999px', padding: '1px 7px', border: '1px solid rgba(229,181,103,0.55)', color: '#e5b567', whiteSpace: 'nowrap' },
      dot: { width: '7px', height: '7px', borderRadius: '999px', background: 'currentColor', opacity: 0.35, flex: '0 0 auto' },
      iconButton: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent',
        color: 'inherit', borderRadius: '6px', padding: '1px 7px', fontSize: '11px', lineHeight: '16px', cursor: 'pointer',
      },
      button: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent',
        color: 'inherit', borderRadius: '6px', padding: '2px 10px', fontSize: '12px', cursor: 'pointer',
      },
      primary: {
        border: '1px solid #41598c', background: '#2b3a5e', color: 'inherit',
        borderRadius: '6px', padding: '2px 10px', fontSize: '12px', cursor: 'pointer',
      },
      select: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent',
        color: 'inherit', borderRadius: '6px', padding: '2px 6px', fontSize: '12px', flex: '1 1 auto', minWidth: '0',
      },
      inline: {
        marginLeft: '12px', marginTop: '4px', marginBottom: '6px', padding: '6px 8px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.28))', borderRadius: '8px',
        background: 'var(--dsh-surface-2, rgba(127,127,127,0.06))',
      },
      muted: { opacity: 0.66 },
      dim: { opacity: 0.5, fontSize: '10.5px' },
      divider: { height: '1px', background: 'var(--dsh-border, rgba(127,127,127,0.25))', margin: '12px 0 10px' },
      error: { marginTop: '8px', color: '#e08a8a', fontSize: '11px' },
      hoverRow: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden' },
    }

    /* ------------------------------------------------------------------ *
     * Pure helpers (tested in test/client.smoke.mjs).
     * ------------------------------------------------------------------ */

    /** Split a provider/model route string on its first separator. */
    function splitRoute(text) {
      const value = String(text)
      const slash = value.indexOf('/')
      if (slash <= 0 || slash === value.length - 1) return undefined
      return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
    }

    /**
     * Normalize one allow-set list into { provider, model } records.
     *
     * The Host reports routes as "provider/model" strings; the panel needs the
     * two fields separately, and older builds may already send records. Anything
     * else is dropped rather than rendered as undefined/undefined.
     * @param list - routes from the Host JSON, in either shape.
     */
    function normalizeRoutes(list) {
      if (!Array.isArray(list)) return []
      const routes = []
      for (const entry of list) {
        if (typeof entry === 'string') {
          const route = splitRoute(entry)
          if (route !== undefined) routes.push(route)
          continue
        }
        if (entry !== null && typeof entry === 'object'
          && typeof entry.provider === 'string' && typeof entry.model === 'string') {
          routes.push({ provider: entry.provider, model: entry.model })
        }
      }
      return routes
    }

    /** Routes offered by a picker: the allow-set, else the whole catalog. */
    function switchChoices(routes, catalog) {
      if (routes.length > 0) return routes.map(route => route.provider + '/' + route.model)
      const choices = []
      for (const entry of catalog) for (const id of entry.models) choices.push(entry.provider + '/' + id)
      return choices
    }

    /** Drop a -preview / -latest tail so a chip stays on one line. */
    function shortenModel(model) {
      if (typeof model !== 'string') return ''
      const trimmed = model.trim()
      if (trimmed === '') return ''
      return trimmed.replace(/-(preview|latest)$/iu, '')
    }

    /** Read one { model, reasoningEffort } pair out of a selection record. */
    function readRoute(selection) {
      if (selection === null || selection === undefined || typeof selection !== 'object') {
        return { model: '', effort: '' }
      }
      const effort = typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort.trim() : ''
      return { model: shortenModel(selection.model), effort }
    }

    /** Read one route out of a projection snapshot, whichever shape it has. */
    function readSelection(source) {
      const values = source === null || source === undefined ? undefined : (source.values ?? source)
      if (values === null || values === undefined) {
        return { model: '', effort: '', pending: false, switchedFrom: '', source: 'none' }
      }
      const selection = values[MODEL_KEY]
      if (selection !== null && selection !== undefined) {
        const next = readRoute(selection.next)
        const lastUsed = readRoute(selection.lastUsed)
        const pending = next.model !== '' && lastUsed.model !== '' && next.model !== lastUsed.model
        return {
          model: next.model,
          effort: next.effort !== '' ? next.effort : lastUsed.effort,
          pending,
          switchedFrom: pending ? lastUsed.model : '',
          source: 'selection',
        }
      }
      const identity = values[IDENTITY_KEY]
      if (identity === null || identity === undefined || typeof identity !== 'object') {
        return { model: '', effort: '', pending: false, switchedFrom: '', source: 'none' }
      }
      const effort = typeof identity.agentReasoningEffort === 'string' ? identity.agentReasoningEffort.trim() : ''
      const model = shortenModel(identity.agentModel)
      if (model === '') return { model: '', effort, pending: false, switchedFrom: '', source: 'inherited' }
      return { model, effort, pending: false, switchedFrom: '', source: 'start' }
    }

    /** Whether one session has its own resident snapshot in the store. */
    function hasSnapshot(projectionsBySession, sessionId) {
      if (projectionsBySession === null || typeof projectionsBySession !== 'object') return false
      if (typeof sessionId !== 'string' || sessionId === '') return false
      return Object.prototype.hasOwnProperty.call(projectionsBySession, sessionId)
    }

    /** Resolve one session route from the resident store, then the list row. */
    function resolveModel(projectionsBySession, byId, sessionId) {
      if (hasSnapshot(projectionsBySession, sessionId)) {
        return Object.assign({ loaded: true }, readSelection(projectionsBySession[sessionId]))
      }
      const row = byId === null || byId === undefined ? undefined : byId[sessionId]
      const attached = row === null || row === undefined ? undefined : row.projectionValues
      if (attached === null || attached === undefined) {
        return { loaded: false, model: '', effort: '', pending: false, switchedFrom: '', source: 'none' }
      }
      return Object.assign({ loaded: true }, readSelection(attached))
    }

    /** Resolve the route a session EFFECTIVELY runs on, walking its lineage. */
    function resolveRoute(projectionsBySession, byId, sessionId) {
      const own = resolveModel(projectionsBySession, byId, sessionId)
      if (own.source !== 'inherited' && own.source !== 'none') return own
      if (own.model !== '') return own
      const visited = new Set([sessionId])
      let cursor = byId === null || byId === undefined ? undefined : byId[sessionId]
      for (let hops = 0; hops < MAX_PARENT_HOPS; hops += 1) {
        const parentId = cursor === null || cursor === undefined ? undefined : cursor.parentId
        if (typeof parentId !== 'string' || parentId === '' || visited.has(parentId)) break
        visited.add(parentId)
        const parent = resolveModel(projectionsBySession, byId, parentId)
        if (parent.source !== 'inherited' && parent.model !== '') {
          return Object.assign({}, parent, { source: 'inherited', inheritedFrom: parentId })
        }
        cursor = byId === null || byId === undefined ? undefined : byId[parentId]
      }
      return Object.assign({}, own, { model: '', effort: '' })
    }

    /** Read one session direct-child catalog, from either store. */
    function catalogOf(projectionsBySession, byId, sessionId) {
      const snapshot = hasSnapshot(projectionsBySession, sessionId) ? projectionsBySession[sessionId] : undefined
      const values = snapshot === undefined ? undefined : (snapshot.values ?? snapshot)
      const fromStore = values === undefined ? undefined : values[CATALOG_KEY]
      const row = byId === null || byId === undefined ? undefined : byId[sessionId]
      const attached = row === null || row === undefined ? undefined : row.projectionValues
      const fromRow = attached === undefined ? undefined : attached[CATALOG_KEY]
      const value = fromStore ?? fromRow
      return Array.isArray(value) ? value : []
    }

    /**
     * Whether one conversation is a DELEGATED subagent, as opposed to any other
     * session that happens to have a parent.
     *
     * A forked conversation also carries a parent id, so parentage alone cannot
     * decide this: a fork the user opened as a main conversation must keep the
     * root panel. Three signals are checked, strongest first:
     *   1. the durable subagent identity projection, which only a delegation writes,
     *   2. the shell's own origin label,
     *   3. membership in the parent's subagent catalog.
     * @param projectionsBySession - store map.
     * @param byId - list rows.
     * @param sessionId - conversation to classify.
     * @returns true only for a delegated child.
     */
    function isSubagentConversation(projectionsBySession, byId, sessionId) {
      const snapshot = hasSnapshot(projectionsBySession, sessionId) ? projectionsBySession[sessionId] : undefined
      const values = snapshot === undefined ? undefined : (snapshot.values ?? snapshot)
      const row = byId === null || byId === undefined ? undefined : byId[sessionId]
      const attached = row === null || row === undefined ? undefined : row.projectionValues
      const identity = values?.[IDENTITY_KEY] ?? attached?.[IDENTITY_KEY]
      if (identity !== null && identity !== undefined && typeof identity === 'object') return true
      if (row?.origin === 'subagent') return true
      const parentId = row?.parentId ?? row?.parentSessionId
      if (typeof parentId !== 'string' || parentId === '') return false
      // A fork keeps its parent id but never appears in that parent catalog.
      return catalogOf(projectionsBySession, byId, parentId).some(entry => entry?.id === sessionId)
    }

    /** Walk the delegation tree below one session and resolve every descendant. */
    function summarizeSubagents(projectionsBySession, byId, rootId) {
      const rows = []
      const seen = new Set([rootId])
      const queue = [{ id: rootId, depth: 0 }]
      while (queue.length > 0) {
        const current = queue.shift()
        for (const entry of catalogOf(projectionsBySession, byId, current.id)) {
          if (entry === null || typeof entry !== 'object') continue
          if (typeof entry.id !== 'string' || seen.has(entry.id)) continue
          seen.add(entry.id)
          const route = resolveRoute(projectionsBySession, byId, entry.id)
          const running = byId?.[entry.id]?.running === true
          rows.push({
            id: entry.id,
            label: typeof entry.label === 'string' ? entry.label : '',
            mode: typeof entry.mode === 'string' ? entry.mode : '',
            depth: current.depth + 1,
            running,
            route,
          })
          queue.push({ id: entry.id, depth: current.depth + 1 })
        }
      }
      const counts = new Map()
      for (const row of rows) {
        if (row.route.model === '') continue
        const key = row.route.model + '|' + row.route.effort
        const bucket = counts.get(key) ?? { model: row.route.model, effort: row.route.effort, count: 0 }
        bucket.count += 1
        counts.set(key, bucket)
      }
      const groups = [...counts.values()].sort((left, right) => right.count - left.count)
      return {
        rows,
        groups,
        total: rows.length,
        running: rows.reduce((sum, row) => sum + (row.running ? 1 : 0), 0),
        inherited: rows.reduce((sum, row) => sum + (row.route.source === 'inherited' ? 1 : 0), 0),
        unrouted: rows.reduce((sum, row) => sum + (row.route.model === '' ? 1 : 0), 0),
      }
    }

    /** One-line route text: model plus effort. */
    function routeText(route, t) {
      const translate = t ?? makeT('zh')
      if (route === undefined || route === null || route.model === '') return translate('route.unknown')
      return route.effort === '' ? route.model : route.model + ' (' + route.effort + ')'
    }

    /** Tooltip text for one row: what the badge means, in words. */
    function rowHint(row, t) {
      const translate = t ?? makeT('zh')
      const parts = []
      if (row.route.source === 'inherited') parts.push(translate('hint.inherited'))
      if (row.route.source === 'start') parts.push(translate('hint.start'))
      if (row.route.source === 'none' || row.route.model === '') parts.push(translate('hint.unknown'))
      if (row.route.pending === true) parts.push(translate('hint.pending', { model: row.route.switchedFrom || translate('route.unknown') }))
      if (row.running) parts.push(translate('hint.running'))
      return parts.join('\n')
    }

    /** One-line summary of the whole delegation tree. */
    function summaryText(summary, t) {
      const translate = t ?? makeT('zh')
      if (summary.total === 0) return translate('summary.empty')
      const lines = [translate('summary.head', { count: summary.total })]
      for (const group of summary.groups) {
        lines.push('  ' + group.count + ' x ' + group.model + (group.effort === '' ? '' : ' (' + group.effort + ')'))
      }
      if (summary.unrouted > 0) lines.push(translate('summary.unrouted', { count: summary.unrouted }))
      if (summary.inherited > 0) lines.push(translate('summary.inherited', { count: summary.inherited }))
      if (summary.running > 0) lines.push(translate('summary.running', { count: summary.running }))
      return lines.join('\n')
    }

    /**
     * Turn one allow-set reading into the words the panel shows.
     * Three states exist, but only two transitions: the shipped policy event is
     * append-only and requires at least one route, so a saved list can never be
     * withdrawn again.
     * @param policy - { source, routes, deployment } from the Host.
     * @param t - translator.
     */
    function describeMode(policy, t) {
      const translate = t ?? makeT('zh')
      if (policy === undefined || policy === null || policy.source === 'unknown') {
        return { key: 'unknown', label: translate('mode.unknown'), routes: [], deployment: [], editable: false, canImport: false }
      }
      const routes = normalizeRoutes(policy.routes)
      const deployment = normalizeRoutes(policy.deployment)
      if (policy.source === 'session') {
        return {
          key: 'session',
          label: translate('mode.session', { count: routes.length }),
          routes,
          deployment,
          editable: true,
          canImport: deployment.length > 0,
        }
      }
      if (policy.source === 'deployment') {
        return {
          key: 'deployment',
          label: translate('mode.deployment', { count: deployment.length }),
          routes: deployment,
          deployment,
          editable: true,
          canImport: false,
        }
      }
      return {
        key: 'open',
        label: translate('mode.open'),
        routes: [],
        deployment,
        editable: true,
        canImport: deployment.length > 0,
      }
    }

    /** The shell supplies useSessions as a hook; degrade to a constant store. */
    function asHook(candidate) {
      if (typeof candidate === 'function') return candidate
      const empty = { projectionsBySession: {}, byId: {} }
      return selector => selector(empty)
    }

    /* ------------------------------------------------------------------ *
     * Controller: every host interaction this UI performs.
     * ------------------------------------------------------------------ */

    /** Read one successful Remote value or throw its reported error. */
    function unwrap(reply, what) {
      if (reply === null || reply === undefined) throw new Error(what + ': empty reply')
      if (reply.ok === false) {
        const error = reply.error === undefined ? undefined : reply.error
        const code = error !== undefined && error.code !== undefined ? error.code : 'error'
        const message = error !== undefined && error.message !== undefined ? error.message : 'no message'
        throw new Error(what + ' failed: ' + code + ': ' + message)
      }
      if (reply.ok === true) return reply.value
      return reply
    }

    /** One reading of the allow-set per conversation per page load. */
    const policyCache = new Map()

    /**
     * Build the panel controller: every host interaction this UI performs.
     * @param ctx - plugin context carrying the declared Remote namespaces.
     * @param sessionId - the conversation whose allow-set is edited.
     * @param t - translator for the messages a failure carries.
     */
    function createController(ctx, sessionId, t) {
      const translate = t ?? makeT('zh')
      const commands = () => {
        const remote = ctx.remote
        return remote === undefined || remote === null ? undefined : remote.commands
      }
      const session = () => {
        const remote = ctx.remote
        return remote === undefined || remote === null ? undefined : remote.session
      }
      const execute = async line => {
        const service = commands()
        if (service === undefined || typeof service.execute !== 'function') {
          throw new Error(translate('error.noCommands'))
        }
        const settled = unwrap(await service.execute(sessionId, line, []), 'commands/execute')
        if (settled === undefined) throw new Error(translate('error.unknownCommand', { line }))
        const result = settled.result
        if (result === undefined) throw new Error(translate('error.emptyResult', { line }))
        if (result.kind === 'error') throw new Error(result.text)
        return result.text === undefined ? '' : result.text
      }
      return {
        /** Read the allow-set (cached unless fresh). */
        async readPolicy(fresh) {
          const cached = policyCache.get(sessionId)
          if (fresh !== true && cached !== undefined) return cached
          const text = await execute('/subagent-models json')
          const start = String(text).indexOf('{')
          const value = start === -1
            ? { source: 'unknown', routes: [], deployment: null }
            : JSON.parse(String(text).slice(start))
          policyCache.set(sessionId, value)
          return value
        },
        /** Replace the Session allowlist with an exact route list. */
        async saveRoutes(routes) {
          if (routes.length === 0) throw new Error(translate('error.keepOne'))
          const line = '/subagent-models ' + routes.map(route => route.provider + '/' + route.model).join(' ')
          const text = await execute(line)
          policyCache.delete(sessionId)
          return text
        },
        /** Copy the deployment preference into this conversation (a snapshot). */
        async useDeployment() {
          const text = await execute('/subagent-models inherit')
          policyCache.delete(sessionId)
          return text
        },
        /** Ask the host for the model catalog shown in the pickers. */
        async loadCatalog() {
          const service = session()
          if (service === undefined || typeof service.modelCatalog !== 'function') return []
          const value = unwrap(await service.modelCatalog(), 'session/modelCatalog')
          const groups = value !== null && value !== undefined && Array.isArray(value.groups) ? value.groups : []
          return groups.map(group => ({
            provider: group.id,
            models: (group.models === undefined || group.models === null ? [] : group.models).map(entry => entry.id),
          }))
        },
        /** Re-route the conversation that is currently open. */
        async switchSelf(route) {
          if (route === undefined || route === null || route === '') throw new Error(translate('error.pickRoute'))
          return await execute('/subagent-model-switch self ' + route)
        },
        /** Re-route one direct child of the open conversation. */
        async switchChild(childId, route) {
          if (typeof childId !== 'string' || childId === '') throw new Error(translate('error.pickChild'))
          if (route === undefined || route === null || route === '') throw new Error(translate('error.pickRoute'))
          const text = await execute('/subagent-model-switch ' + childId + ' ' + route)
          policyCache.delete(sessionId)
          return text
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * The panel.
     * ------------------------------------------------------------------ */

    function ModelPanel(props) {
      const t = props.t ?? makeT('zh')
      const sessionId = props.sessionId
      const controller = React.useMemo(() => createController(props.ctx, sessionId, t), [props.ctx, sessionId, t])
      const readSessions = asHook(props.useSessions)
      const projections = readSessions(state => state.projectionsBySession)
      const byId = readSessions(state => state.byId)
      const summary = React.useMemo(
        () => summarizeSubagents(projections, byId, sessionId),
        [projections, byId, sessionId],
      )
      const isChild = isSubagentConversation(projections, byId, sessionId)

      const [open, setOpen] = React.useState(false)
      const [policy, setPolicy] = React.useState(undefined)
      const [editing, setEditing] = React.useState(false)
      const [catalog, setCatalog] = React.useState([])
      const [provider, setProvider] = React.useState('')
      const [model, setModel] = React.useState('')
      const [expanded, setExpanded] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [selfRoute, setSelfRoute] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const run = React.useCallback(async work => {
        setBusy(true)
        setError('')
        try {
          return await work()
        } catch (failure) {
          setError(failure !== null && failure !== undefined && failure.message !== undefined
            ? failure.message
            : String(failure))
          return undefined
        } finally {
          setBusy(false)
        }
      }, [])

      const reload = React.useCallback(async fresh => {
        try {
          setPolicy(await controller.readPolicy(fresh))
        } catch (failure) {
          setPolicy({ source: 'unknown', routes: [], deployment: null })
          setError(failure.message === undefined ? String(failure) : failure.message)
        }
      }, [controller])

      const onOpen = () => {
        const next = !open
        setOpen(next)
        setExpanded('')
        if (!next) {
          setEditing(false)
          return
        }
        void reload(false)
        try {
          Promise.resolve(controller.loadCatalog()).then(entries => setCatalog(entries)).catch(() => setCatalog([]))
        } catch {
          setCatalog([])
        }
      }

      const mode = describeMode(policy, t)
      const choices = switchChoices(mode.routes, catalog)
      const direct = summary.rows.filter(row => row.depth === 1)
      const deeper = summary.total - direct.length
      const current = catalog.find(entry => entry.provider === provider)
      const modelChoices = current === undefined ? [] : current.models

      const children = []
      children.push(h('div', { key: 'title', style: S.titleRow },
        h('span', { style: S.title }, isChild ? t('panel.childTitle') : t('panel.rootTitle'))))

      if (isChild) {
        /* ---------------- subagent conversation: only switch myself -------- */
        const own = resolveRoute(projections, byId, sessionId)
        children.push(h('div', { key: 'own', style: S.section },
          h('div', { key: 'label', style: Object.assign({}, S.muted, { fontSize: '11px' }) }, t('panel.current')),
          h('div', { key: 'route', style: Object.assign({}, S.line, { marginBottom: '2px' }) },
            h('span', { key: 'dot', style: Object.assign({}, S.dot, { color: own.model === '' ? '#8a8a8a' : '#6cc46c', opacity: 0.9 }) }),
            h('span', { key: 'name', style: { fontWeight: 600, fontSize: '13px' } }, routeText(own, t)),
            own.source === 'inherited'
              ? h('span', { key: 'inh', style: Object.assign({}, S.muted, { fontSize: '10.5px' }) }, '(' + t('panel.inheritFromParent') + ')')
              : null),
          own.pending === true
            ? h('div', { key: 'pending', style: Object.assign({}, S.muted, { fontSize: '10.5px', color: '#e5b567' }) },
                t('panel.pendingLine', { model: own.switchedFrom || t('route.unknown') }))
            : null))
        children.push(h('div', { key: 'divider', style: S.divider }))
        children.push(h('div', { key: 'switchLabel', style: Object.assign({}, S.muted, { fontSize: '11px', marginBottom: '6px' }) }, t('panel.switchTo')))
        children.push(h('div', { key: 'switchRow', style: S.line },
          h('select', {
            key: 'sel',
            style: S.select,
            value: selfRoute,
            disabled: busy || choices.length === 0,
            onChange: event => setSelfRoute(event.target.value),
          }, [h('option', { key: 'none', value: '' }, choices.length === 0 ? t('panel.noRoute') : t('panel.pickRoute'))].concat(
            choices.map(choice => h('option', { key: choice, value: choice }, choice)))),
          h('button', {
            key: 'go',
            type: 'button',
            style: S.primary,
            disabled: busy || selfRoute === '',
            onClick: async () => {
              const done = await run(() => controller.switchSelf(selfRoute))
              if (done !== undefined) {
                setSelfRoute('')
                void reload(true)
              }
            },
          }, t('panel.switch'))))
        children.push(h('div', { key: 'allow', style: Object.assign({}, S.dim, { marginTop: '8px' }) },
          mode.routes.length === 0
            ? t('panel.childAllowOpen')
            : t('panel.childAllow', { count: mode.routes.length })))
        if (DEBUG) {
          children.push(h('div', { key: 'dbg', style: S.dim }, t('panel.devSession', { id: String(sessionId), source: own.source })))
        }
      } else {
        /* ---------------- root conversation: allow-set + children --------- */
        children.push(h('div', { key: 'mode', style: Object.assign({}, S.line, { marginTop: '6px' }) },
          h('span', { key: 'k', style: Object.assign({}, S.muted, { fontSize: '11px' }) }, t('panel.allowSet')),
          h('span', { key: 'v', style: S.name }, mode.label),
          h('button', {
            key: 'edit',
            type: 'button',
            style: S.button,
            disabled: busy,
            onClick: () => setEditing(!editing),
          }, editing ? t('panel.done') : t('panel.edit'))))
        if (editing) {
          if (mode.routes.length === 0) {
            children.push(h('div', { key: 'empty', style: Object.assign({}, S.muted, { fontSize: '11px', marginBottom: '6px' }) },
              t('panel.emptyList')))
          }
          for (const route of mode.routes) {
            children.push(h('div', { key: 'r-' + route.provider + '/' + route.model, style: S.routeRow },
              h('span', { key: 'n', style: S.name }, route.provider + '/' + route.model),
              h('button', {
                key: 'x',
                type: 'button',
                style: S.iconButton,
                disabled: busy,
                onClick: async () => {
                  const next = mode.routes.filter(candidate => candidate.provider !== route.provider || candidate.model !== route.model)
                  const done = await run(() => controller.saveRoutes(next))
                  if (done !== undefined) await reload(true)
                },
              }, 'x')))
          }
          children.push(h('div', { key: 'add', style: S.line },
            h('select', {
              key: 'p',
              style: S.select,
              value: provider,
              disabled: busy || catalog.length === 0,
              onChange: event => { setProvider(event.target.value); setModel('') },
            }, [h('option', { key: 'none', value: '' }, catalog.length === 0 ? t('panel.noCatalog') : t('panel.provider'))].concat(
              catalog.map(entry => h('option', { key: entry.provider, value: entry.provider }, entry.provider)))),
            h('select', {
              key: 'm',
              style: S.select,
              value: model,
              disabled: busy || modelChoices.length === 0,
              onChange: event => setModel(event.target.value),
            }, [h('option', { key: 'none', value: '' }, t('panel.model'))].concat(
              modelChoices.map(id => h('option', { key: id, value: id }, id)))),
            h('button', {
              key: 'add',
              type: 'button',
              style: S.button,
              disabled: busy || provider === '' || model === '',
              onClick: async () => {
                const seen = new Set()
                const next = mode.routes.concat([{ provider, model }]).filter(route => {
                  const keyId = route.provider + '/' + route.model
                  if (seen.has(keyId)) return false
                  seen.add(keyId)
                  return true
                })
                const done = await run(() => controller.saveRoutes(next))
                if (done !== undefined) {
                  setModel('')
                  await reload(true)
                }
              },
            }, t('panel.add'))))
          if (mode.canImport) {
            const deploymentCount = mode.deployment.length
            children.push(h('button', {
              key: 'import',
              type: 'button',
              style: Object.assign({}, S.button, { marginTop: '6px' }),
              disabled: busy,
              onClick: async () => {
                const done = await run(() => controller.useDeployment())
                if (done !== undefined) {
                  await reload(true)
                  // Importing writes a session list, which is then editable here.
                  setEditing(true)
                }
              },
            }, t('panel.import', { count: deploymentCount })))
          }
        }

        children.push(h('div', { key: 'divider', style: S.divider }))
        const meta = summary.total === 0
          ? t('panel.noChildren')
          : t('panel.childrenMeta', {
              count: direct.length,
              running: summary.running > 0 ? t('panel.running', { count: summary.running }) : '',
              deeper: deeper > 0 ? t('panel.deeper', { count: deeper }) : '',
            })
        children.push(h('div', { key: 'childrenHead', style: Object.assign({}, S.line, { marginBottom: '4px' }) },
          h('span', { key: 'k', style: Object.assign({}, S.muted, { fontSize: '11px' }) }, t('panel.children')),
          h('span', { key: 'n', style: S.name }, meta)))

        if (direct.length === 0) {
          children.push(h('div', { key: 'none', style: S.dim }, t('panel.directOnly')))
        }
        for (const row of direct) {
          const isOpen = expanded === row.id
          const badge = row.route.pending === true
            ? { text: t('badge.pending'), style: S.badgeWarn }
            : row.route.source === 'inherited' ? { text: t('badge.inherited'), style: S.badge }
              : row.route.source === 'start' ? { text: t('badge.start'), style: S.badge }
                : row.route.model === '' ? { text: t('badge.unknown'), style: S.badge } : undefined
          children.push(h('div', {
            key: 'c-' + row.id,
            style: isOpen ? S.childRowOpen : S.childRow,
            title: rowHint(row, t) + (DEBUG ? '\n' + row.id : ''),
          },
            h('span', { key: 'dot', style: Object.assign({}, S.dot, { color: row.running ? '#6cc46c' : '#8a8a8a', opacity: row.running ? 0.95 : 0.4 }) }),
            h('span', { key: 'name', style: S.name }, row.label === '' ? (DEBUG ? row.id : '\u2014') : row.label),
            badge === undefined ? null : h('span', { key: 'b', style: badge.style }, badge.text),
            h('span', { key: 'm', style: S.model }, routeText(row.route, t)),
            h('button', {
              key: 'sw',
              type: 'button',
              style: S.iconButton,
              disabled: busy,
              onClick: () => {
                setExpanded(isOpen ? '' : row.id)
                setDraft('')
                setError('')
              },
            }, '\u21c4')))
          if (!isOpen) continue
          const downstream = summary.rows.filter(other => other.depth > 1 && other.route.inheritedFrom === row.id).length
          children.push(h('div', { key: 'inline-' + row.id, style: S.inline },
            h('div', { key: 'line', style: S.line },
              h('span', { key: 'k', style: Object.assign({}, S.muted, { fontSize: '11px' }) }, t('panel.switchTo')),
              h('select', {
                key: 'sel',
                style: S.select,
                value: draft,
                disabled: busy || choices.length === 0,
                onChange: event => setDraft(event.target.value),
              }, [h('option', { key: 'none', value: '' }, choices.length === 0 ? t('panel.noRoute') : t('panel.pickRoute'))].concat(
                choices.map(choice => h('option', { key: choice, value: choice }, choice)))),
              h('button', {
                key: 'go',
                type: 'button',
                style: S.primary,
                disabled: busy || draft === '',
                onClick: async () => {
                  const done = await run(() => controller.switchChild(row.id, draft))
                  if (done !== undefined) {
                    setExpanded('')
                    setDraft('')
                  }
                },
              }, t('panel.confirm')),
              h('button', {
                key: 'cancel',
                type: 'button',
                style: S.button,
                disabled: busy,
                onClick: () => { setExpanded(''); setDraft('') },
              }, t('panel.cancel'))),
            downstream > 0
              ? h('div', { key: 'impact', style: Object.assign({}, S.dim, { marginTop: '4px' }) },
                  t('panel.impact', { count: downstream }))
              : null,
            DEBUG ? h('div', { key: 'dbg', style: S.dim }, row.id + ' / depth ' + row.depth) : null))
        }
        children.push(h('div', { key: 'hint', style: Object.assign({}, S.dim, { marginTop: '8px' }) }, t('panel.hint')))
      }

      if (error !== '') children.push(h('div', { key: 'error', style: S.error }, error))

      const chipText = isChild
        ? t('panel.childTitle')
        : summary.total === 0
          ? t('chip.root')
          : t('chip.rootCount', { count: summary.total })
            + (summary.running > 0 ? t('chip.rootRunning', { count: summary.running }) : '')

      return h('div', { style: S.root },
        h('button', {
          type: 'button',
          style: S.chip,
          title: isChild ? t('title.panelChild') : summaryText(summary, t),
          onClick: onOpen,
        }, chipText),
        open ? h('div', { style: S.panel, role: 'dialog' }, children) : null)
    }

    /* ------------------------------------------------------------------ *
     * Header chip and sidebar hover row.
     * ------------------------------------------------------------------ */

    function HeaderModelChip(props) {
      const t = props.t ?? makeT('zh')
      const readSessions = asHook(props.useSessions)
      const projections = readSessions(state => state.projectionsBySession)
      const byId = readSessions(state => state.byId)
      const route = resolveRoute(projections, byId, props.sessionId)
      const summary = React.useMemo(
        () => summarizeSubagents(projections, byId, props.sessionId),
        [projections, byId, props.sessionId],
      )
      if (!route.loaded || route.model === '') return null
      const parts = [
        h('span', { key: 'label', style: S.muted }, t('header.model')),
        h('span', { key: 'model', style: { fontWeight: 500 } }, route.model),
      ]
      if (route.effort !== '') parts.push(h('span', { key: 'effort', style: S.muted }, '(' + route.effort + ')'))
      if (route.pending === true) {
        parts.push(h('span', { key: 'pending', style: Object.assign({}, S.muted, { color: '#e5b567' }) }, t('header.pending')))
      }
      return h('span', {
        style: S.headerChip,
        role: 'status',
        title: routeText(route, t)
          + (route.source === 'inherited' ? t('header.titleInherited') : '')
          + (route.pending === true ? t('header.titlePending', { model: route.switchedFrom || t('route.unknown') }) : '')
          + '\n' + summaryText(summary, t),
      }, parts)
    }

    function HoverModelRow(props) {
      const t = props.t ?? makeT('zh')
      const readSessions = asHook(props.useSessions)
      const projections = readSessions(state => state.projectionsBySession)
      const byId = readSessions(state => state.byId)
      const sessionId = props.sessionId !== undefined ? props.sessionId : props.session?.id
      const route = resolveRoute(projections, byId, sessionId)
      if (!route.loaded || route.model === '') return null
      return h('div', { style: S.hoverRow },
        h('span', { style: S.muted }, t('hover.model')),
        h('span', { style: { opacity: 1 } }, routeText(route, t)
          + (route.source === 'inherited' ? t('hover.inherited') : '')
          + (route.pending === true ? t('hover.pending') : '')))
    }

    return {
      inject: INJECT,
      apply(ctx) {
        registerDictionaries(ctx)
        const t = bindTranslator(ctx)
        const slots = ctx.get('slots')
        if (slots === undefined || typeof slots.inject !== 'function') return
        // Each seat registers independently: a shell that refuses one slot must
        // still get the others, and must never lose the shipped cells around it.
        try {
          slots.inject(DOCK_SLOT, () => slots.register({
            name: DOCK_SLOT,
            id: DOCK_ID,
            order: DOCK_ORDER,
          }, props => h(ModelPanel, Object.assign({}, props, { ctx, t }))))
        } catch {
          // The dock refused the cell; the header and hover seats stand alone.
        }
        try {
          slots.inject(ACTIONS_SLOT, () => slots.register({
            name: ACTIONS_SLOT,
            id: ACTIONS_ID,
            order: ACTIONS_ORDER,
          }, props => h(HeaderModelChip, Object.assign({}, props, { t }))))
        } catch {
          // No header slot in this shell.
        }
        try {
          slots.inject(HOVER_SLOT, () => slots.register({
            name: HOVER_SLOT,
            id: HOVER_ID,
            order: HOVER_ORDER,
          }, props => h(HoverModelRow, Object.assign({}, props, { t }))))
        } catch {
          // No sidebar hover slot in this shell.
        }
      },
      /** Test seam for test/client.smoke.mjs; the Host loader ignores it. */
      __internals: {
        createController,
        switchChoices,
        resolveRoute,
        summarizeSubagents,
        describeMode,
        normalizeRoutes,
        isSubagentConversation,
        rowHint,
        routeText,
        summaryText,
        shortenModel,
        makeT,
        MESSAGES,
        INJECT,
        DEBUG,
      },
    }
  },
})
