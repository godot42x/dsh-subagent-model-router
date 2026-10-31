/**
 * Generic-mode smoke test: the plugin mounted WITHOUT Agent Teams.
 * Run with: node test/generic.smoke.mjs
 *
 * Proves the delegation seams and the allowlist are not welded to the Team
 * service: with no agentTeams, every Agent still receives the plain subagent
 * tools (spawn_subagent_with_model / switch_agent_model by child Session id),
 * the same allowlist gate applies, and nothing Team-specific is registered.
 */

import assert from 'node:assert/strict'
import { apply, inject } from '../lib/index.js'

const disposers = []

function makeAgent({ id, provider = 'opencodex', model = 'command-code/a', origin = 'user', parentSession }) {
  const hooks = []
  const agent = {
    id,
    status: 'idle',
    options: { provider, model },
    session: { log: [], header: { id, origin, parentSession }, append(type, data) { const e = { type, seq: 0, data }; agent.session.log.push(e); return e } },
    hooks,
    ctx: {
      on(event, handler) {
        if (event !== 'agent/request') return () => {}
        hooks.push(handler)
        return () => {}
      },
      tools: {
        register(definition) {
          agent.tools ??= new Map()
          agent.tools.set(definition.name, definition)
          return () => agent.tools.delete(definition.name)
        },
      },
      // No getSectionOrder on purpose: the plugin must fall back, not throw.
      systemPrompt: { section: () => () => {} },
    },
  }
  agent.deliver = async () => {
    let index = 0
    const next = async () => index >= hooks.length
      ? { provider: agent.options.provider, model: agent.options.model }
      : await hooks[index++]({}, next)
    return await next()
  }
  return agent
}

const lead = makeAgent({ id: 'lead-session' })
const child = makeAgent({ id: 'child-session', origin: 'subagent', parentSession: 'lead-session' })
const liveAgents = new Map([[lead.id, lead], [child.id, child]])
// A fork keeps the parent id but no subagent descriptor: it is a conversation
// the user drives, so it must keep the root surface (the bug this pins).
const fork = makeAgent({ id: 'fork-session', origin: 'user', parentSession: 'lead-session' })
liveAgents.set(fork.id, fork)

const activations = []
const subagents = {
  async startActivation(spec) {
    activations.push(spec)
    return { childId: spec.childId ?? 'started-child', messageId: 'msg-1' }
  },
  getProvider: name => ({ name, agentRouteDefaults: undefined }),
}

const agents = {
  list: () => [...liveAgents.values()],
  get: id => liveAgents.get(id),
  on: () => () => {},
  async resume(options) {
    const revived = makeAgent({ id: options.resumeSessionId, origin: 'subagent', parentSession: 'lead-session' })
    liveAgents.set(revived.id, revived)
    return { agent: revived, dispose: async () => {} }
  },
}

const llm = {
  resolveCallConfig: async selection => selection,
  listProviders: () => [{ id: 'opencodex', name: 'OpenCodex' }],
  listModels: async () => [{ id: 'command-code/a', name: 'A' }],
  resolveModelInfo: async (provider, model) => ({ id: model, name: model }),
}

const observed = new Map()
const sessionQuery = {
  async observeSession(id) {
    const known = observed.get(id)
    if (known === undefined) throw new Error('session not found')
    return known
  },
}

const commands = new Map()
const services = {
  llm,
  subagents,
  sessionQuery,
  commands: { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
  // Deliberately NO agentTeams.
}

const ctx = {
  agents,
  get: service => services[service],
  on: () => () => {},
  effect: fn => disposers.push(fn()),
}

apply(ctx, {})

// 1. The mount no longer depends on the Team service.
assert.deepEqual(inject, ['agents', 'tools', 'subagents', 'systemPrompt'])

// 2. Every Agent gets the plain subagent tool set; none of it is Team-shaped.
assert.deepEqual([...lead.tools.keys()].sort(), [
  'configure_subagent_models',
  'list_agent_models',
  'spawn_subagent_with_model',
  'switch_agent_model',
])

// ...but a plain subagent child gets no delegation tools, so the plugin never
// deepens a chain the host did not budget for.
assert.equal(child.tools, undefined, 'a subagent child must not receive delegation tools in generic mode')
// A fork has header.parentSession and is still a root conversation.
assert.deepEqual([...fork.tools.keys()].sort(), [
  'configure_subagent_models',
  'list_agent_models',
  'spawn_subagent_with_model',
  'switch_agent_model',
], 'a forked conversation keeps the root tools')

// 3. Spawning a subagent on an explicit route reaches the generic seam.
const spawned = await lead.tools.get('spawn_subagent_with_model').execute(
  { description: 'look around', prompt: 'find the bug', provider: 'opencodex', model: 'command-code/b' },
  { agent: lead, signal: new AbortController().signal },
)
assert.equal(spawned.subagentId, 'started-child')
assert.equal(spawned.model, 'command-code/b')
assert.equal(activations.at(-1).provider, 'spawn')
assert.deepEqual(activations.at(-1).request.agentOptions, { provider: 'opencodex', model: 'command-code/b' })
assert.equal(activations.at(-1).delivery, 'parent')

// 4. The same allowlist gate runs in generic mode.
await lead.tools.get('configure_subagent_models').execute(
  { models: [{ provider: 'opencodex', model: 'command-code/b' }] },
  { agent: lead, signal: new AbortController().signal },
)
await assert.rejects(
  lead.tools.get('spawn_subagent_with_model').execute(
    { description: 'x', prompt: 'y', provider: 'opencodex', model: 'command-code/a' },
    { agent: lead, signal: new AbortController().signal },
  ),
  /is not allowed for this Session/,
)

// 5. Switching addresses the child Session id and is limited to own children.
const switched = await lead.tools.get('switch_agent_model').execute(
  { target: child.id, provider: 'opencodex', model: 'command-code/b' },
  { agent: lead, signal: new AbortController().signal },
)
assert.equal(switched.selected, 'opencodex/command-code/b')
assert.deepEqual(await child.deliver(), { provider: 'opencodex', model: 'command-code/b' })

const stranger = makeAgent({ id: 'stranger-session', origin: 'subagent', parentSession: 'someone-else' })
liveAgents.set(stranger.id, stranger)
await assert.rejects(
  lead.tools.get('switch_agent_model').execute(
    { target: stranger.id, provider: 'opencodex', model: 'command-code/b' },
    { agent: lead, signal: new AbortController().signal },
  ),
  /not a child of this Session/,
)

// 6. A released child resolves through its persisted header.
observed.set('cold-child', {
  header: { id: 'cold-child', origin: 'subagent', parentSession: 'lead-session' },
  events: [{ type: 'model/selection', data: { provider: 'opencodex', model: 'command-code/b' } }],
})
const cold = await lead.tools.get('switch_agent_model').execute(
  { target: 'cold-child', provider: 'opencodex', model: 'command-code/b' },
  { agent: lead, signal: new AbortController().signal },
)
assert.match(cold.note, /next wake/)

// 7. The panel commands exist without a Team, and 'self' works for a child.
assert.deepEqual([...commands.keys()].sort(), ['subagent-model-switch', 'subagent-models'])
const selfSwitch = await commands.get('subagent-model-switch').handler({
  agent: child,
  rawInput: 'self opencodex/command-code/b',
  attachments: [],
  signal: new AbortController().signal,
})
assert.equal(selfSwitch.kind, 'success')
const rootTry = await commands.get('subagent-model-switch').handler({
  agent: lead,
  rawInput: 'self opencodex/command-code/b',
  attachments: [],
  signal: new AbortController().signal,
})
assert.equal(rootTry.kind, 'error', 'the root conversation cannot re-route itself through the panel')

// 8. enforceDeploymentPolicy:false makes the deployment list advisory while a
//    Session list stays a hard gate.
services.subagentModelSelection = {
  current: () => ({ enabled: true, allowedModels: [{ provider: 'opencodex', model: 'command-code/b' }] }),
}
const otherRoot = makeAgent({ id: 'root-two' })
liveAgents.set(otherRoot.id, otherRoot)
await assert.rejects(
  subagents.startActivation({
    provider: 'spawn',
    request: { prompt: [{ type: 'text', text: 'x' }], parent: otherRoot },
    signal: new AbortController().signal,
  }),
  /is not allowed for this Session/,
)
const pluginState = globalThis[Symbol.for('dsh.subagent-model-router.state')]
pluginState.enforceDeploymentPolicy = false
await subagents.startActivation({
  provider: 'spawn',
  request: { prompt: [{ type: 'text', text: 'x' }], parent: otherRoot },
  signal: new AbortController().signal,
})
pluginState.enforceDeploymentPolicy = true
delete services.subagentModelSelection

for (const dispose of disposers) dispose()
console.log('generic-smoke: all assertions passed')
