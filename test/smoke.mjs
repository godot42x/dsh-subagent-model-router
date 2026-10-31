/**
 * Dependency-free smoke test for the Agent Teams model-routing plugin.
 * Run with: node test/smoke.mjs
 *
 * The fake Agent deliberately mirrors the SHIPPED runtime: an Agent has NO
 * model facade (dsh-agent-loop/lib/index.js:747-770 has no model field), each
 * request is seeded from the immutable creation-time options, and the only
 * per-step seam is the agent/request waterfall. That is what makes this test
 * catch the "a live switch silently does nothing" regression.
 */

import assert from 'node:assert/strict'
import { apply, name as pluginName, inject, POLICY_EVENT, isSupportedDshVersion, VALIDATED_DSH, SUPPORTED_DSH_RANGE } from '../lib/index.js'

const disposers = []
const ROUTES = Symbol.for('dsh.subagent-model-router.routeOverrides')

let headerSeq = 0

function makeAgent({ id, provider = 'opencodex', model = 'command-code/a', origin = 'subagent', parentSession }) {
  const hooks = []
  let header
  const session = {
    log: [],
    header: { id, origin, parentSession },
    append(type, data) {
      const event = { type, seq: session.log.length, data }
      session.log.push(event)
      return event
    },
    requestHeader() {
      return header
    },
  }
  const agent = {
    id,
    status: 'idle',
    options: { provider, model },
    session,
    hooks,
    ctx: {
      on(event, handler) {
        if (event !== 'agent/request') return () => {}
        hooks.push(handler)
        return () => {
          const index = hooks.indexOf(handler)
          if (index !== -1) hooks.splice(index, 1)
        }
      },
      tools: {
        register(definition) {
          agent.tools ??= new Map()
          agent.tools.set(definition.name, definition)
          return () => agent.tools.delete(definition.name)
        },
      },
      systemPrompt: {
        getSectionOrder: () => 600,
        section: spec => { agent.sections ??= []; agent.sections.push(spec); return () => {} },
      },
    },
  }
  agent.deliver = async () => {
    // Mirror dsh-agent-loop prepareRequest: seed from options, then run the
    // agent/request waterfall and record the produced header.
    let index = 0
    const next = async () => {
      if (index >= hooks.length) {
        return {
          provider: agent.options.provider,
          model: agent.options.model,
          ...(agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort }),
        }
      }
      const hook = hooks[index]
      index += 1
      return await hook({ agent }, next)
    }
    const config = await next()
    headerSeq += 1
    header = { config, seq: headerSeq }
    return config
  }
  return agent
}

const agentList = []

const lead = makeAgent({ id: 'lead-session', origin: 'user' })
const teammate = makeAgent({ id: 'teammate-session' })
agentList.push(lead, teammate)

const spawnCalls = []
const activations = []
const resumeCalls = []
const observed = new Map()

const subagents = {
  async startActivation(spec) {
    activations.push(spec)
    return { childId: spec.childId ?? 'new-child', messageId: 'msg-1' }
  },
  getProvider(name) {
    return { name, agentRouteDefaults: undefined }
  },
}

const roster = [
  { id: lead.id, name: 'lead', role: 'lead', status: 'idle', model: 'opencodex/command-code/a', diagnostics: [] },
  { id: teammate.id, name: 'builder', role: 'teammate', status: 'idle', provider: 'spawn', context: 'fresh', model: 'opencodex/command-code/a', diagnostics: [] },
]

const agentTeams = {
  tryMembership: agent => ({ role: agent === lead ? 'lead' : 'teammate', name: agent === lead ? 'lead' : 'builder', root: lead, id: 'team' }),
  membership: agent => ({ role: agent === lead ? 'lead' : 'teammate', name: agent === lead ? 'lead' : 'builder', root: lead, id: 'team' }),
  listMembers: () => roster,
  async spawnTeammate(caller, request) {
    spawnCalls.push({ caller, request })
    // Mirror the roster: forward the exact prompt array into startActivation.
    await subagents.startActivation({
      delivery: 'parent',
      childId: 'new-child',
      provider: request.provider,
      label: request.description,
      request: { prompt: request.prompt, parent: caller },
      signal: request.signal,
    })
    return {
      member: {
        id: 'new-child', name: request.name, role: 'teammate', status: 'provisioning',
        description: request.description, provider: request.provider, context: request.context, diagnostics: [],
      },
    }
  },
}

let liveAgents = new Map([[lead.id, lead], [teammate.id, teammate]])

const agents = {
  list: () => [...liveAgents.values()],
  get: id => liveAgents.get(id),
  on: () => () => {},
  async resume(options) {
    resumeCalls.push(options)
    const revived = makeAgent({
      id: options.resumeSessionId,
      provider: options.agentOptions?.provider ?? 'opencodex',
      model: options.agentOptions?.model ?? 'command-code/a',
      origin: 'subagent',
      parentSession: 'lead-session',
    })
    liveAgents.set(revived.id, revived)
    return { agent: revived, dispose: async () => {} }
  },
}

const llm = {
  resolveCallConfig: async selection => selection,
  listProviders: () => [{ id: 'opencodex', name: 'OpenCodex' }],
  listModels: async () => [{ id: 'command-code/a', name: 'model A' }, { id: 'command-code/b', name: 'model B' }],
  resolveModelInfo: async (provider, model) => ({ id: model, name: model }),
}

const commands = new Map()
const commandService = {
  register(definition) {
    commands.set(definition.name, definition)
    return () => commands.delete(definition.name)
  },
}

const sessionQuery = {
  async observeSession(id) {
    const known = observed.get(id)
    if (known === undefined) throw new Error('session not found')
    return known
  },
}

const services = {
  llm,
  subagents,
  commands: commandService,
  sessionQuery,
  agentTeams,
}

const ctx = {
  agents,
  agentTeams,
  get: service => services[service],
  on: () => () => {},
  effect: fn => disposers.push(fn()),
}

apply(ctx, {})
assert.equal(pluginName, 'subagent-model-router')
assert.equal(VALIDATED_DSH, '0.2.1-rc.5')
assert.equal(SUPPORTED_DSH_RANGE, '>=0.2.1-rc.5 <0.3.0')
// The version window is a line check, not a string compare: rc suffixes sort
// below the release, so parse the core and accept the whole 0.2.1+ line.
assert.equal(isSupportedDshVersion(undefined), true, 'an undeclared version must not disable the plugin')
assert.equal(isSupportedDshVersion('0.2.1-rc.5'), true)
assert.equal(isSupportedDshVersion('0.2.1'), true)
assert.equal(isSupportedDshVersion('0.2.2-rc.1'), true)
assert.equal(isSupportedDshVersion('0.2.0'), false)
assert.equal(isSupportedDshVersion('0.3.0'), false)
assert.equal(isSupportedDshVersion('1.0.0'), false)
assert.deepEqual(inject, ['agents', 'tools', 'subagents', 'systemPrompt'])

const expectedTools = ['configure_subagent_models', 'list_agent_models', 'spawn_teammate_with_model', 'switch_agent_model']
assert.deepEqual([...lead.tools.keys()].sort(), expectedTools)
// A teammate may re-route itself and nothing else: giving it a spawn tool would
// let delegation recurse, which the harness budget does not allow.
assert.deepEqual([...teammate.tools.keys()].sort(), ['list_agent_models', 'switch_agent_model'])
assert.equal(teammate.tools.has('spawn_teammate_with_model'), false, 'a teammate must never be able to spawn')
assert.equal(teammate.tools.has('configure_subagent_models'), false, 'route rules for children belong to the Lead')
assert.match(teammate.sections[0].text, /must not delegate further/)
assert.equal(lead.sections.length, 1)
assert.deepEqual([...commands.keys()].sort(), ['subagent-model-switch', 'subagent-models'])

const exec = signal => ({ agent: lead, signal })
const teammateExec = signal => ({ agent: teammate, signal })

// 1. A live switch must move the ACTUAL next request of a live child.
assert.deepEqual(await teammate.deliver(), { provider: 'opencodex', model: 'command-code/a' })
const first = await lead.tools.get('switch_agent_model').execute(
  { target: 'builder', provider: 'opencodex', model: 'command-code/b' },
  exec(new AbortController().signal),
)
assert.equal(first.previous, 'opencodex/command-code/a')
assert.equal(first.selected, 'opencodex/command-code/b')
assert.deepEqual(await teammate.deliver(), { provider: 'opencodex', model: 'command-code/b' })

// The regression: a SECOND switch on the same live child must also apply.
const second = await lead.tools.get('switch_agent_model').execute(
  { target: 'builder', provider: 'opencodex', model: 'command-code/a' },
  exec(new AbortController().signal),
)
assert.equal(second.previous, 'opencodex/command-code/b')
assert.equal(second.selected, 'opencodex/command-code/a')
assert.deepEqual(await teammate.deliver(), { provider: 'opencodex', model: 'command-code/a' })

// 2. reasoning_effort is carried and cleared by a later route change.
await lead.tools.get('switch_agent_model').execute(
  { target: 'builder', provider: 'opencodex', model: 'command-code/b', reasoning_effort: 'high' },
  exec(new AbortController().signal),
)
assert.deepEqual(await teammate.deliver(), { provider: 'opencodex', model: 'command-code/b', reasoningEffort: 'high' })

// 3. Every switch is also recorded durably in the child Session log.
const selections = teammate.session.log.filter(event => event.type === 'model/selection')
assert.equal(selections.length, 3)
assert.deepEqual(selections.at(-1).data, { provider: 'opencodex', model: 'command-code/b', reasoningEffort: 'high' })

// 4. Teammates may re-route themselves but not a peer.
const selfSwitch = await teammate.tools.get('switch_agent_model').execute(
  { target: 'builder', provider: 'opencodex', model: 'command-code/a' },
  teammateExec(new AbortController().signal),
)
assert.equal(selfSwitch.selected, 'opencodex/command-code/a')
await assert.rejects(
  teammate.tools.get('switch_agent_model').execute(
    { target: 'lead', provider: 'opencodex', model: 'command-code/a' },
    teammateExec(new AbortController().signal),
  ),
  /model picker/,
)

// 5. Unknown targets and failed members fail with guidance.
await assert.rejects(
  lead.tools.get('switch_agent_model').execute({ target: 'ghost', provider: 'p', model: 'm' }, exec(new AbortController().signal)),
  /no teammate or subagent matches "ghost"/,
)

// 6. A released teammate records the route on the resume seam instead.
liveAgents = new Map([[lead.id, lead]])
const coldSwitch = await lead.tools.get('switch_agent_model').execute(
  { target: 'builder', provider: 'opencodex', model: 'command-code/b' },
  exec(new AbortController().signal),
)
assert.equal(coldSwitch.selected, 'opencodex/command-code/b')
assert.match(coldSwitch.note, /next wake/)
assert.equal(resumeCalls.length, 0, 'a cold switch must not materialize the teammate')

const revivedHandle = await agents.resume({
  resumeSessionId: teammate.id,
  parentAgent: lead,
  agentOptions: { provider: 'opencodex', model: 'command-code/a' },
})
assert.deepEqual(resumeCalls[0].agentOptions, { provider: 'opencodex', model: 'command-code/b' },
  'resume must receive the overriding route')
assert.deepEqual(await revivedHandle.agent.deliver(), { provider: 'opencodex', model: 'command-code/b' },
  'the resumed segment must also apply the route at its next request')
assert.ok(revivedHandle.agent.session.log.some(event => event.type === 'model/selection'),
  'the resumed segment must re-record the durable selection')

// 7. A restart forgets the process map; the durable event in the child log wins.
globalThis[ROUTES].clear()
observed.set(teammate.id, {
  header: { id: teammate.id, origin: 'subagent', parentSession: 'lead-session' },
  events: [
    { type: 'subagent/descriptor', data: { mode: 'continuable', provider: 'spawn' } },
    { type: 'model/selection', data: { provider: 'opencodex', model: 'command-code/b' } },
  ],
})
const afterRestart = await agents.resume({
  resumeSessionId: teammate.id,
  parentAgent: lead,
  agentOptions: { provider: 'opencodex', model: 'command-code/a' },
})
assert.deepEqual(resumeCalls.at(-1).agentOptions, { provider: 'opencodex', model: 'command-code/b' },
  'a recorded model/selection must survive a process restart')
assert.deepEqual(await afterRestart.agent.deliver(), { provider: 'opencodex', model: 'command-code/b' })

// A resume with no recorded override passes through unchanged.
await agents.resume({ resumeSessionId: 'someone-else', agentOptions: { provider: 'x', model: 'y' } })
assert.deepEqual(resumeCalls.at(-1).agentOptions, { provider: 'x', model: 'y' })

// 8. Spawn carries the route through the startActivation seam.
const spawned = await lead.tools.get('spawn_teammate_with_model').execute(
  { name: 'scout', description: 'research', prompt: 'look around', provider: 'opencodex', model: 'command-code/b' },
  exec(new AbortController().signal),
)
assert.equal(spawned.target, 'scout')
assert.equal(spawned.provider, 'opencodex')
assert.equal(spawned.model, 'command-code/b')
assert.equal(spawned.note, undefined, 'the seam must be available so the first step already uses the new route')
assert.equal(spawnCalls.length, 1)
assert.equal(spawnCalls[0].request.provider, 'spawn')
assert.deepEqual(activations.at(-1).request.agentOptions, { provider: 'opencodex', model: 'command-code/b' })
assert.equal(activations.at(-1).request.prompt, spawnCalls[0].request.prompt, 'prompt identity must be preserved')

// 9. A spawn without a ticket passes through untouched.
await subagents.startActivation({ request: { prompt: [{ type: 'text', text: 'plain' }], parent: lead }, provider: 'spawn', signal: new AbortController().signal })
assert.deepEqual(activations.at(-1).request.agentOptions, undefined)

// 10. The Session allowlist is a hard gate, including pure inheritance.
assert.deepEqual(await lead.tools.get('configure_subagent_models').execute({}, exec(new AbortController().signal)), { source: 'open', routes: [] })

const saved = await lead.tools.get('configure_subagent_models').execute(
  { models: [{ provider: 'opencodex', model: 'command-code/b' }] },
  exec(new AbortController().signal),
)
assert.deepEqual(saved, { source: 'session', routes: ['opencodex/command-code/b'] })
assert.ok(lead.session.log.some(event => event.type === POLICY_EVENT), 'the policy must be a durable Session event')

// An inherited route outside the list is rejected at the seam.
await assert.rejects(
  lead.tools.get('spawn_teammate_with_model').execute(
    { name: 'nope', description: 'x', prompt: 'y', provider: 'opencodex', model: 'command-code/a' },
    exec(new AbortController().signal),
  ),
  /is not allowed for this Session/,
)

// A plain spawn_teammate (inheriting the Lead route) is rejected too.
await assert.rejects(
  subagents.startActivation({
    provider: 'spawn',
    request: { prompt: [{ type: 'text', text: 'inherit' }], parent: lead },
    signal: new AbortController().signal,
  }),
  /is not allowed for this Session/,
)

// An allowed route passes.
const allowedSpawn = await lead.tools.get('spawn_teammate_with_model').execute(
  { name: 'ok', description: 'x', prompt: 'y', provider: 'opencodex', model: 'command-code/b' },
  exec(new AbortController().signal),
)
assert.equal(allowedSpawn.model, 'command-code/b')

// 11. The deployment preference is the fallback when a Session saved none.
services.subagentModelSelection = {
  current: () => ({ enabled: true, allowedModels: [{ provider: 'opencodex', model: 'command-code/a' }] }),
}
const child = makeAgent({ id: 'child-session', provider: 'opencodex', model: 'command-code/a' })
liveAgents.set(child.id, child)
assert.deepEqual(
  await lead.tools.get('configure_subagent_models').execute({}, { agent: child, signal: new AbortController().signal }),
  { source: 'deployment', routes: ['opencodex/command-code/a'] },
)
await assert.rejects(
  subagents.startActivation({
    provider: 'spawn',
    request: { prompt: [{ type: 'text', text: 'x' }], parent: child, agentOptions: { provider: 'opencodex', model: 'command-code/b' } },
    signal: new AbortController().signal,
  }),
  /is not allowed for this Session/,
)
delete services.subagentModelSelection

// 12. The slash commands are the UI entry point and share the same helpers.
const modelsCommand = commands.get('subagent-models')
const shown = await modelsCommand.handler({ agent: lead, rawInput: 'show', attachments: [], signal: new AbortController().signal })
assert.equal(shown.kind, 'success')
assert.match(shown.text, /Session allowlist: opencodex\/command-code\/b/)
const replaced = await modelsCommand.handler({
  agent: lead,
  rawInput: 'opencodex/command-code/a opencodex/command-code/b',
  attachments: [],
  signal: new AbortController().signal,
})
assert.equal(replaced.kind, 'success')
assert.match(replaced.text, /command-code\/a/)
assert.deepEqual(
  await lead.tools.get('configure_subagent_models').execute({}, exec(new AbortController().signal)),
  { source: 'session', routes: ['opencodex/command-code/a', 'opencodex/command-code/b'] },
)
const rejectedWrite = await modelsCommand.handler({ agent: lead, rawInput: 'not-a-route', attachments: [], signal: new AbortController().signal })
assert.equal(rejectedWrite.kind, 'error')

const switchCommand = commands.get('subagent-model-switch')
const switched = await switchCommand.handler({
  agent: lead,
  rawInput: 'builder opencodex/command-code/a',
  attachments: [],
  signal: new AbortController().signal,
})
assert.equal(switched.kind, 'success')
assert.match(switched.text, /builder/)
assert.equal((await lead.tools.get('configure_subagent_models').execute({}, exec(new AbortController().signal))).source, 'session')
const outside = await switchCommand.handler({
  agent: lead,
  rawInput: 'builder elsewhere/model',
  attachments: [],
  signal: new AbortController().signal,
})
assert.equal(outside.kind, 'error', 'a route outside the Session allowlist must be refused by the panel')

// 13. Model discovery renders providers, models, and the Session banner.
assert.match(await lead.tools.get('list_agent_models').execute({}, exec(new AbortController().signal)), /opencodex — OpenCodex/)
assert.match(
  await lead.tools.get('list_agent_models').execute({ provider: 'opencodex' }, exec(new AbortController().signal)),
  /Session allowlist:[\s\S]*opencodex\/command-code\/b/,
)
await assert.rejects(
  lead.tools.get('list_agent_models').execute({ model: 'x' }, exec(new AbortController().signal)),
  /requires provider|model requires provider/,
)

// 14. The allowlist also governs live re-routes, not just spawns.
await assert.rejects(
  lead.tools.get('switch_agent_model').execute(
    { target: 'builder', provider: 'elsewhere', model: 'model' },
    exec(new AbortController().signal),
  ),
  /is outside this Session allowlist/,
)
const rerouted = await lead.tools.get('switch_agent_model').execute(
  { target: 'builder', provider: 'opencodex', model: 'command-code/a' },
  exec(new AbortController().signal),
)
assert.equal(rerouted.selected, 'opencodex/command-code/a')

// 15. requireExplicitRoute rejects pure inheritance even when it is allowed.
const pluginState = globalThis[Symbol.for('dsh.subagent-model-router.state')]
pluginState.requireExplicitRoute = true
await assert.rejects(
  subagents.startActivation({
    provider: 'spawn',
    request: { prompt: [{ type: 'text', text: 'inherit' }], parent: lead },
    signal: new AbortController().signal,
  }),
  /requires an explicit child route/,
)
const strictSpawn = await lead.tools.get('spawn_teammate_with_model').execute(
  { name: 'strict', description: 'x', prompt: 'y', provider: 'opencodex', model: 'command-code/a' },
  exec(new AbortController().signal),
)
assert.equal(strictSpawn.model, 'command-code/a', 'an explicit allowed route must still pass')
pluginState.requireExplicitRoute = false

// 16. A Team service without the coordination tools is reported, not hidden:
//     a teammate you cannot message must not look like a normal spawn.
lead.ctx.tools.get = () => undefined
const noCoordination = await lead.tools.get('spawn_teammate_with_model').execute(
  { name: 'orphan', description: 'x', prompt: 'y', provider: 'opencodex', model: 'command-code/a' },
  exec(new AbortController().signal),
)
assert.match(noCoordination.note, /no send_message tool/)
lead.ctx.tools.get = name => (name === 'send_message' ? { name } : undefined)
const coordinated = await lead.tools.get('spawn_teammate_with_model').execute(
  { name: 'reachable', description: 'x', prompt: 'y', provider: 'opencodex', model: 'command-code/a' },
  exec(new AbortController().signal),
)
assert.equal(coordinated.note, undefined)

for (const dispose of disposers) dispose()
console.log('smoke: all assertions passed')
