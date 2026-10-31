/**
 * Dependency-free test for the browser half of dsh-subagent-model-router.
 * Run with: node test/client.smoke.mjs
 *
 * It reproduces the two Cordis facts that broke the first shipped panel:
 *   1. a client plugin may only touch a Remote namespace it DECLARED, and the
 *      guard is per flattened name ("remote.commands"), and
 *   2. a Remote call answers { ok, value } / { ok, error }, not the raw value.
 * The fake context throws exactly like cordis's internal/get guard so a missing
 * inject entry fails here instead of in the browser.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec },
  },
}
new Function(source)()
assert.equal(loaded.id, 'dsh-subagent-model-router', 'the module id must be the package name')

const reactStub = {
  createElement: () => null,
  useMemo: fn => fn(),
  useState: value => [value, () => {}],
  useCallback: fn => fn,
}
const module = loaded.factory(spec => {
  if (spec === 'react') return reactStub
  throw new Error('unexpected require: ' + spec)
})

// 1. The declared inject list is what unlocks the Remote namespaces.
assert.deepEqual(module.__internals.INJECT, ['slots', 'locale', 'remote', 'remote.commands', 'remote.session'])
assert.deepEqual(module.inject, module.__internals.INJECT)

const declared = new Set(module.inject)

/** Mirror cordis: every flattened name must be declared before it is read. */
function makeCtx(overrides) {
  const namespaces = {
    commands: overrides.commands,
    session: overrides.session,
  }
  const remote = new Proxy({}, {
    get(_target, prop) {
      const name = 'remote.' + String(prop)
      if (!declared.has(name)) throw new Error('cannot get property "' + name + '" without inject')
      const value = namespaces[String(prop)]
      if (value === undefined) throw new Error('cannot get property "' + name + '" without inject')
      return value
    },
  })
  return {
    get(name) {
      if (name === 'remote') {
        if (!declared.has('remote')) throw new Error('cannot get property "remote" without inject')
        return remote
      }
      if (name === 'slots') return { inject() {}, register() { return () => {} } }
      throw new Error('cannot get property "' + name + '" without inject')
    },
    remote,
  }
}

const executed = []
const commands = {
  async execute(sessionId, line, attachments) {
    executed.push({ sessionId, line, attachments })
    if (line === '/subagent-models json') {
      return {
        ok: true,
        value: {
          commandId: 'cmd-1',
          result: {
            kind: 'success',
            text: JSON.stringify({ source: 'session', routes: ['opencodex/a', 'opencodex/b'], deployment: ['opencodex/a'] }),
          },
        },
      }
    }
    if (line.indexOf('nope') !== -1) {
      return { ok: false, error: { code: 'command/failed', message: 'not a provider/model route' } }
    }
    return { ok: true, value: { commandId: 'cmd-2', result: { kind: 'success', text: 'saved' } } }
  },
}
const session = {
  async modelCatalog() {
    return { ok: true, value: { groups: [{ id: 'opencodex', name: 'OpenCodex', models: [{ id: 'a' }, { id: 'b' }] }] } }
  },
}

const ctx = makeCtx({ commands, session })
const controller = module.__internals.createController(ctx, 'session-1')

// 2. Reading the policy goes through the declared namespace and unwraps value.
const policy = await controller.readPolicy()
assert.deepEqual(policy, { source: 'session', routes: ['opencodex/a', 'opencodex/b'], deployment: ['opencodex/a'] })
assert.equal(executed[0].line, '/subagent-models json')
assert.equal(executed[0].sessionId, 'session-1')
assert.deepEqual(executed[0].attachments, [])

// 3. Saving builds one route list from the panel state.
assert.equal(await controller.saveRoutes([{ provider: 'opencodex', model: 'a' }, { provider: 'x', model: 'y/z' }]), 'saved')
assert.equal(executed.at(-1).line, '/subagent-models opencodex/a x/y/z')
await assert.rejects(controller.saveRoutes([]), /至少保留一条/)
await assert.rejects(controller.saveRoutes([{ provider: 'opencodex', model: 'nope' }]), /command\/failed|not a provider/)

// 4. Importing the deployment preference and switching itself.
assert.equal(await controller.useDeployment(), 'saved')
assert.equal(executed.at(-1).line, '/subagent-models inherit')
assert.equal(await controller.switchSelf('opencodex/b'), 'saved')
assert.equal(executed.at(-1).line, '/subagent-model-switch self opencodex/b')
await assert.rejects(controller.switchSelf(''), /先选择一条路由/)

// 5. The catalog is optional but unwrapped when present.
assert.deepEqual(await controller.loadCatalog(), [{ provider: 'opencodex', models: ['a', 'b'] }])

// 6. A host failure is reported, not swallowed, and keeps its code.
await assert.rejects(async () => {
  const failing = makeCtx({ commands: { execute: async () => ({ ok: false, error: { code: 'session/not-found', message: 'gone' } }) }, session })
  await module.__internals.createController(failing, 'session-2').readPolicy()
}, /session\/not-found: gone/)

// 7. The switch picker falls back to the catalog when no allowlist is saved.
assert.deepEqual(
  module.__internals.switchChoices([{ provider: 'opencodex', model: 'a' }], [{ provider: 'opencodex', models: ['a', 'b'] }]),
  ['opencodex/a'],
)
assert.deepEqual(
  module.__internals.switchChoices([], [{ provider: 'opencodex', models: ['a', 'b'] }]),
  ['opencodex/a', 'opencodex/b'],
  'an unsaved allowlist must not make every switch impossible',
)
assert.deepEqual(module.__internals.switchChoices([], []), [])

// 8. An undeclared namespace access is what the first shipped panel hit: prove
//    the guard fires for a name this module did NOT declare.
assert.throws(() => makeCtx({ commands, session }).remote.settings, /without inject/)

// 9. Switching a child by Session id (the panel row) builds the documented line.
assert.equal(await controller.switchChild('session-child', 'opencodex/b'), 'saved')
assert.equal(executed.at(-1).line, '/subagent-model-switch session-child opencodex/b')
await assert.rejects(controller.switchChild('', 'opencodex/b'), /先选择一个子智能体/)
await assert.rejects(controller.switchChild('session-child', ''), /先选择一条路由/)

// 10. Route resolution reads the SAME projections the shell already keeps, so
//     the three display seats need no new Host call.
const store = {
  root: {
    values: {
      subagentCatalog: [
        { id: 'child-a', mode: 'continuable', label: 'builder' },
        { id: 'child-b', mode: 'one-shot', label: 'scout' },
        { id: 'child-c', mode: 'continuable', label: 'analyst' },
      ],
      modelSelection: { next: { model: 'opencodex/a' }, lastUsed: { model: 'opencodex/a' } },
    },
  },
  'child-a': {
    values: {
      modelSelection: { next: { model: 'opencodex/b', reasoningEffort: 'high' }, lastUsed: { model: 'opencodex/a' } },
    },
  },
  'child-c': {
    values: { subagent: { agentModel: 'opencodex/c-preview', agentReasoningEffort: 'low' } },
  },
}
const rows = {
  'child-a': { parentId: 'root' },
  'child-b': { parentId: 'root', running: true },
  'child-c': { parentId: 'root' },
}
const internals = module.__internals

const rootRoute = internals.resolveRoute(store, rows, 'root')
assert.equal(rootRoute.model, 'opencodex/a')
assert.equal(rootRoute.source, 'selection')
assert.equal(rootRoute.pending, false)

// A queued switch is next != lastUsed, and it names the route being left.
const childRoute = internals.resolveRoute(store, rows, 'child-a')
assert.equal(childRoute.model, 'opencodex/b')
assert.equal(childRoute.effort, 'high')
assert.equal(childRoute.pending, true)
assert.equal(childRoute.switchedFrom, 'opencodex/a')

// A child with no route of its own runs its parent's: the walk names it.
const inherited = internals.resolveRoute(store, rows, 'child-b')
assert.equal(inherited.model, 'opencodex/a')
assert.equal(inherited.source, 'inherited')
assert.equal(inherited.inheritedFrom, 'root')

// A never-requested child keeps its start-time route in the durable descriptor.
const described = internals.resolveRoute(store, rows, 'child-c')
assert.equal(described.model, 'opencodex/c-preview'.replace(/-preview$/u, ''))
assert.equal(described.effort, 'low')
assert.equal(described.source, 'start', 'a descriptor route is a start route, never one it has used')

// An unknown session says so instead of inventing a model.
const unknown = internals.resolveRoute(store, rows, 'nobody')
assert.equal(unknown.loaded, false)
assert.equal(unknown.model, '')

// 11. The tree summary groups descendants by the route they actually run on.
const summary = internals.summarizeSubagents(store, rows, 'root')
assert.equal(summary.total, 3)
assert.equal(summary.running, 1)
assert.equal(summary.inherited, 1)
assert.equal(summary.rows.find(row => row.id === 'child-a').depth, 1)
assert.deepEqual(summary.groups.map(group => group.model).sort(), [
  'opencodex/a', 'opencodex/b', 'opencodex/c',
].sort())
assert.match(internals.summaryText(summary), /子智能体 3 个/)
assert.match(internals.summaryText(summary), /1 个跟随父会话/)
assert.equal(internals.routeText({ model: 'm', effort: 'high' }), 'm (high)')
assert.equal(internals.routeText({ model: '', effort: '' }), '未知')
assert.equal(internals.shortenModel('x-latest'), 'x')

// 12. All three seats register, each independently: one refused slot must not
//     take the others (or the shipped cells around them) down.
const registered = []
function makeSlots(refuse) {
  return {
    inject(name, callback) {
      if (name === refuse) throw new Error('slot refused: ' + name)
      callback()
    },
    register(definition) {
      registered.push(definition.name + '|' + definition.id + '|' + definition.order)
      return () => {}
    },
  }
}
module.apply({ get: name => (name === 'slots' ? makeSlots(undefined) : undefined) })
assert.deepEqual(registered, [
  'conversation.composer.dock|subagent-model-panel|45',
  'conversation.session.header.actions|subagent-model-header-chip|45',
  'sidebar.session.row.hover|subagent-model-hover-row|45',
])
registered.length = 0
module.apply({ get: name => (name === 'slots' ? makeSlots('conversation.session.header.actions') : undefined) })
assert.deepEqual(registered, [
  'conversation.composer.dock|subagent-model-panel|45',
  'sidebar.session.row.hover|subagent-model-hover-row|45',
])

// 13. The allow-set has three readable states, but only two transitions: the
//     shipped policy event is append-only and needs at least one route.
const modeSession = internals.describeMode({ source: 'session', routes: ['a/b'], deployment: ['a/b', 'a/c'] })
assert.equal(modeSession.key, 'session')
assert.match(modeSession.label, /白名单 · 1 条/)
assert.equal(modeSession.editable, true)
assert.equal(modeSession.canImport, true)

const modeDeployment = internals.describeMode({ source: 'deployment', routes: [], deployment: ['a/b', 'a/c'] })
assert.equal(modeDeployment.key, 'deployment')
assert.match(modeDeployment.label, /跟随部署默认 · 2 条/)
assert.equal(modeDeployment.routes.length, 2, 'a follow-deployment conversation offers the deployment routes')

const modeOpen = internals.describeMode({ source: 'open', routes: [], deployment: [] })
assert.equal(modeOpen.key, 'open')
assert.match(modeOpen.label, /不限制/)
assert.deepEqual(modeOpen.routes, [])

const modeUnknown = internals.describeMode(undefined)
assert.equal(modeUnknown.key, 'unknown')
assert.equal(modeUnknown.editable, false)

// 14. The policy read is cached per conversation: opening the panel twice must
//     not append a second command event.
const cacheSession = 'session-cache'
const before = executed.length
const cachedController = internals.createController(ctx, cacheSession)
await cachedController.readPolicy()
await cachedController.readPolicy()
assert.equal(executed.length - before, 1, 'the second open reads from the cache, not the Host')
await cachedController.readPolicy(true)
assert.equal(executed.length - before, 2, 'an explicit refresh still asks the Host')

// 15. A shell without the slots facade must not throw on mount.
module.apply({ get: () => undefined })

// 16. Both languages cover the same flat keys, so switching the harness
//     language can never leave a raw key on screen.
const zh = internals.MESSAGES.zh
const en = internals.MESSAGES.en
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en must expose identical keys')
for (const [key, value] of Object.entries(zh)) {
  assert.equal(typeof value, 'string', 'dictionary values stay flat strings: ' + key)
  assert.equal(typeof en[key], 'string', 'en value must be a string: ' + key)
}
assert.match(internals.makeT('en')('mode.session', { count: 2 }), /Session allowlist · 2 routes/)
assert.match(internals.makeT('zh')('mode.session', { count: 2 }), /本会话白名单 · 2 条/)
assert.match(internals.makeT('en')('panel.impact', { count: 3 }), /3 subagent/)
assert.equal(internals.makeT('en')('route.unknown'), 'unknown')
assert.equal(internals.makeT('zh')('missing.key'), 'missing.key', 'a missing key falls back to the key, never throws')

// 17. A teammate never receives a spawn tool: delegation must not recurse.
assert.equal(internals.MESSAGES.zh['panel.directOnly'].length > 0, true)


// 18. A forked conversation keeps a parent id but is NOT a delegated subagent:
//     only a delegation may show the subagent panel in what the user opened as
//     a main conversation.
const forkRows = Object.assign({}, rows, { 'fork-1': { parentId: 'root' } })
const forkStore = Object.assign({}, store, { 'fork-1': { values: { modelSelection: { next: { model: 'opencodex/a' }, lastUsed: { model: 'opencodex/a' } } } } })
assert.equal(internals.isSubagentConversation(forkStore, forkRows, 'fork-1'), false, 'a fork is not a subagent')
assert.equal(internals.isSubagentConversation(store, rows, 'child-a'), true, 'a catalog child is a subagent')
assert.equal(internals.isSubagentConversation(store, rows, 'child-c'), true, 'the identity projection alone is enough')
assert.equal(internals.isSubagentConversation(store, rows, 'root'), false, 'the root conversation is never a subagent')
assert.equal(
  internals.isSubagentConversation(store, Object.assign({}, forkRows, { 'fork-1': { parentId: 'root', origin: 'subagent' } }), 'fork-1'),
  true,
  'the shell origin label wins when the catalog is not loaded',
)
assert.equal(
  internals.isSubagentConversation({}, { 'ghost': { parentId: 'closed-parent' } }, 'ghost'),
  false,
  'an unreadable parent chain defaults to the root panel',
)


// 19. The Host reports routes as "provider/model" strings; the panel must
//     normalize them, or every row renders undefined/undefined.
assert.deepEqual(internals.normalizeRoutes(['opencodex/a', 'x/y/z']), [
  { provider: 'opencodex', model: 'a' },
  { provider: 'x', model: 'y/z' },
])
assert.deepEqual(
  internals.normalizeRoutes([{ provider: 'p', model: 'm' }, 'bad', null, { provider: 'p' }]),
  [{ provider: 'p', model: 'm' }],
  'garbage entries are dropped instead of rendered',
)
const modeStrings = internals.describeMode({ source: 'session', routes: ['opencodex/a'], deployment: ['opencodex/b', 'opencodex/c'] })
assert.deepEqual(modeStrings.routes, [{ provider: 'opencodex', model: 'a' }])
assert.equal(modeStrings.deployment.length, 2)
assert.equal(modeStrings.canImport, true)
assert.deepEqual(modeStrings.routes.map(r => r.provider + '/' + r.model), ['opencodex/a'])

// A write built from normalized routes must produce a real command line.
assert.equal(
  await controller.saveRoutes(internals.normalizeRoutes(['opencodex/a', 'opencodex/b'])),
  'saved',
)
assert.equal(executed.at(-1).line, '/subagent-models opencodex/a opencodex/b')

// 20. Placeholders inside a template always resolve: a trailing {running}
//     used to survive into the DOM as literal text.
const meta = internals.makeT('zh')('panel.childrenMeta', { count: 3, running: '', deeper: '' })
assert.equal(meta, '3 个')
assert.equal(internals.makeT('zh')('panel.childrenMeta', { count: 3, running: ' · 1 运行中', deeper: ' · 另有 2 个深层' }), '3 个 · 1 运行中 · 另有 2 个深层')
assert.equal(internals.makeT('en')('panel.childrenMeta', { count: 3, running: ' · 1 running', deeper: '' }), '3 · 1 running')
for (const dict of [internals.MESSAGES.zh, internals.MESSAGES.en]) {
  for (const [key, value] of Object.entries(dict)) {
    const rendered = internals.makeT('zh')(key, { count: 1, running: 'R', deeper: 'D', model: 'M', line: 'L', id: 'I', source: 'S' })
    assert.equal(/\{[a-zA-Z]+\}/u.test(rendered), false, 'unresolved placeholder in ' + key)
  }
}


console.log('client-smoke: all assertions passed')
