/**
 * Subagent model routing.
 *
 * Extends the shipped Agent Teams + subagent tools with three capabilities they
 * do not have:
 *
 * 1. spawn_teammate_with_model - create a durable teammate directly on a chosen
 *    provider/model instead of inheriting the Lead route.
 * 2. switch_agent_model - re-route a live teammate in place, any number of
 *    times, without restarting it or losing its history.
 * 3. A Session-scoped allowlist of child models, enforced at the one seam every
 *    child activation crosses, editable from the UI (slash command) for the
 *    current conversation only and overriding the deployment-wide preference.
 *
 * Why each seam exists (line numbers refer to the shipped build):
 *
 * - Delegation: the Team roster calls ctx.subagents.startActivation() WITHOUT
 *   agentOptions (dsh-experimental-agent-team/lib/index.js:1032-1042) and the
 *   subagent manager only reads request.agentOptions (dsh-subagent/lib/types/
 *   manager.js:327). The roster forwards the prompt array by reference, so a
 *   ticket keyed by that exact array object is consumed by our wrapper and
 *   merged into request.agentOptions: the first step already runs on the route.
 *
 * - Allowlist: the shipped subagent tool only rejects an EXPLICIT route outside
 *   its policy ("Pure inheritance remains outside this policy because no
 *   model-facing choice occurred", dsh-tool-subagent/lib/index.js:88-97), and a
 *   Session that already has history never receives the deployment preference
 *   (dsh-tool-subagent/lib/index.js:542-554). Our gate runs on every activation
 *   and validates the route the child will actually use, inherited or explicit.
 *
 * - Live switching: a child Agent is driven per step from its creation-time
 *   AgentOptions (dsh-agent-loop/lib/index.js:1179-1184) and exposes no
 *   agent.model facade, so appending model/selection alone cannot re-route it
 *   (that projection is consumed only for ordinary Sessions, dsh-api-session-
 *   controller/lib/index.js:534-536, and refuses subagent Sessions). We install
 *   an agent/request waterfall on the child own context - the same seam the GUI
 *   model picker uses - and apply the recorded route to every later step.
 *
 * - Cold resume: the durable subagent/descriptor snapshots the route once and
 *   the fold keeps the FIRST descriptor (dsh-subagent/lib/types/descriptor.js:
 *   174-191), so a released child is rebuilt through agents.resume()
 *   (manager.js:788). Our resume wrapper rewrites agentOptions for the recorded
 *   child and re-records the selection inside the fresh segment; the newest
 *   model/selection event in the child own log is the authority, so the choice
 *   also survives a Harness restart.
 */

/** Survive HMR: the installed shims and their tickets must outlive one module instance. */
const PENDING = Symbol.for('dsh.subagent-model-router.pendingChildOptions')
const SHIM = Symbol.for('dsh.subagent-model-router.startActivationShim')
const RESUME_SHIM = Symbol.for('dsh.subagent-model-router.resumeShim')
const OVERRIDES = Symbol.for('dsh.subagent-model-router.routeOverrides')
const STATE = Symbol.for('dsh.subagent-model-router.state')
const ROUTE_HOOK = Symbol.for('dsh.subagent-model-router.routeHook')

/** The shipped Session event that carries a Session-scoped child-model allowlist. */
export const POLICY_EVENT = 'subagent/model-selection-policy'

const pendingChildOptions = globalThis[PENDING] ??= new WeakMap()
/** child session id -> route that every later step/resume of that child must use. */
const routeOverrides = globalThis[OVERRIDES] ??= new Map()
/** The DeepSeek Harness build every seam in this file was read from. */
export const VALIDATED_DSH = '0.2.1-rc.5'
/** Declared compatibility window: the 0.2 line, from the validated prerelease on. */
export const SUPPORTED_DSH_RANGE = '>=0.2.1-rc.5 <0.3.0'

const state = globalThis[STATE] ??= {
  available: false,
  reason: 'the startActivation seam was not wrapped',
  resume: false,
  resumeReason: 'the resume seam was not wrapped',
  commands: false,
  commandsReason: 'the commands service was not mounted',
  hook: false,
  hookReason: 'no child Agent has been observed yet',
  requireExplicitRoute: false,
  enforceDeploymentPolicy: true,
  /** Declared Harness version, when the host exports one. */
  declaredDsh: undefined,
  /** Whether the declared version is inside the supported window. */
  compatible: true,
  /** Required host seams this build did not provide. */
  missingSeams: [],
}

export const name = 'subagent-model-router'

// agentTeams is deliberately NOT injected: the delegation seams and the
// allowlist are generic subagent plumbing, so this plugin also mounts in a
// profile without Agent Teams (see the install mode in apply). Team-only tools
// are registered only when the service is present.
export const inject = ['agents', 'tools', 'subagents', 'systemPrompt']

/** Model-facing guidance installed into every Team member scope. */
function policyText(role) {
  const lines = [
    '## Subagent model routing',
    '',
    'list_agent_models lists provider and model ids (no arguments: providers; provider: its models; provider + model: that model and its reasoning efforts).',
    '',
    'switch_agent_model re-routes one child in place, and it may be repeated. When a child reports that its endpoint is exhausted (quota, revoked or missing API key, dead proxy, persistent 4xx/5xx), do NOT abandon it and do NOT respawn its work elsewhere: call switch_agent_model with another model, then send_message telling it to continue where it stopped. A running child picks the new route up at its next step; a released child is rebuilt on it at the next wake and every later resume. A teammate may call this tool on itself; only the Team Lead may re-route another member. The Lead own route is not switchable through this tool.',
  ]
  if (role !== 'teammate') {
    lines.push(
      '',
      'spawn_teammate_with_model creates a teammate on an explicit provider/model. Use it instead of spawn_teammate whenever the Lead route is not the right one for the delegated work, or when you want work spread across several models. Only the Team Lead may create teammates: a teammate never gets this tool, because a teammate that delegates would recurse.',
      '',
      'This Session may restrict which provider/model routes any child may use. configure_subagent_models shows that allowlist; when one is active, every provider/model you pass to a spawn or switch tool must be on it, and a spawn that would inherit a route outside it is rejected. When this deployment turns requireExplicitRoute on, a spawn MUST name provider and model even if the inherited route happens to be allowed. The user edits the same list for this conversation from the subagent model panel.',
    )
  } else {
    lines.push(
      '',
      'You are a teammate: you may re-route YOURSELF with switch_agent_model, and you must not delegate further. Route rules for children are enforced by the host, not by you.',
    )
  }
  return lines.join('\n') + '\n' + (state.available
    ? ''
    : '\nWarning: this host build did not accept the delegation seam (' + state.reason
      + '), so the child-model allowlist cannot be enforced for delegation here.\n')
}

/**
 * Whether one declared Harness version is inside the supported window.
 * An absent version is treated as unknown-but-allowed: the harness does not
 * export one today, so a hard must-match rule would disable the plugin
 * everywhere. A version that IS declared and clearly outside the line is
 * refused, which is the case this guard exists for.
 * @param version - a 0.2.1-rc.5 style version string, or undefined.
 * @returns false only when a version is declared and clearly outside the line.
 */
export function isSupportedDshVersion(version) {
  if (typeof version !== 'string' || version.length === 0) return true
  const core = version.split(/[-+]/u)[0]
  const parts = core.split('.').map(part => Number.parseInt(part, 10))
  const major = parts[0]
  const minor = parts[1]
  const patch = parts[2]
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return true
  if (major !== 0 || minor !== 2) return false
  return !Number.isInteger(patch) || patch >= 1
}

/** Read a Harness version the host may export through the environment. */
function declaredDshVersion() {
  try {
    const env = globalThis.process?.env
    if (env === undefined || env === null) return undefined
    const value = env.DSH_VERSION ?? env.DSH_HARNESS_VERSION
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Probe the host seams this plugin wraps, so a renamed internal shows up as an
 * explicit diagnostic instead of a half-working install.
 * @param ctx - host context.
 * @returns the names of seams this build does not provide.
 */
function missingSeams(ctx) {
  const missing = []
  const subagents = ctx.get('subagents')
  if (subagents === undefined || typeof subagents.startActivation !== 'function') missing.push('subagents.startActivation')
  if (typeof ctx.agents?.get !== 'function') missing.push('agents.get')
  if (typeof ctx.agents?.resume !== 'function') missing.push('agents.resume')
  return missing
}

/** Throw a model-correctable error. */
function fail(message) {
  throw new Error(message)
}

/** Report a contained host-compatibility failure without breaking the caller. */
function warn(ctx, message) {
  try {
    if (ctx !== undefined && ctx !== null && ctx.logger !== undefined) {
      if (typeof ctx.logger.warn === 'function') ctx.logger.warn('[subagent-model-router] ' + message)
    }
  } catch {
    // Logging is best effort; never let it decide an outcome.
  }
}

/** Read one system-prompt section order, tolerating a host without that key. */
function sectionOrder(prompt, key) {
  try {
    if (prompt !== undefined && typeof prompt.getSectionOrder === 'function') {
      const value = prompt.getSectionOrder(key)
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  } catch {
    // A host without that section key is not a failure: use a neutral order.
  }
  return 600
}

/** Require one non-empty trimmed string argument. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) fail('"' + field + '" must be a non-empty string')
  return value.trim()
}

/** Render one selection as provider/model (reasoning_effort: x). */
function formatSelection(selection) {
  if (selection === undefined || selection === null) return ''
  const effort = selection.reasoningEffort === undefined ? '' : ' (reasoning_effort: ' + selection.reasoningEffort + ')'
  return selection.provider + '/' + selection.model + effort
}

/** Render one route as provider/model. */
function formatRoute(route) {
  return route.provider + '/' + route.model
}

/** Render a route list for a model-facing message. */
function formatRoutes(routes) {
  return routes.map(formatRoute).join(', ')
}

/** Whether two routes name the same provider/model pair. */
function sameRoute(left, right) {
  return left !== undefined && right !== undefined && left.provider === right.provider && left.model === right.model
}

/**
 * Detach an untrusted route list, dropping entries that are not exact routes.
 * @param value - candidate array of { provider, model } records.
 * @returns the detached routes, or undefined when the value is not a list.
 */
function normalizeRoutes(value) {
  if (!Array.isArray(value)) return undefined
  const routes = []
  for (const entry of value) {
    if (typeof entry?.provider !== 'string' || typeof entry?.model !== 'string') continue
    if (entry.provider.length === 0 || entry.model.length === 0) continue
    routes.push({ provider: entry.provider, model: entry.model })
  }
  return routes
}

/**
 * Read the newest Session-scoped allowlist from one Session log.
 * The event is a shipped type (subagent/model-selection-policy), so official
 * subagent tooling reads the same record; the newest one wins because that is
 * the list the user last saved in this conversation.
 * @param session - Session whose log is scanned, if one is available.
 * @returns the saved routes, or undefined when this Session saved none.
 */
function sessionRoutes(session) {
  const log = session?.log
  if (!Array.isArray(log)) return undefined
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event?.type !== POLICY_EVENT) continue
    const routes = normalizeRoutes(event.data?.allowedModels)
    if (routes !== undefined && routes.length > 0) return routes
  }
  return undefined
}

/**
 * Read the deployment-wide preference owned by subagent-model-selection-settings.
 * @param ctx - host context.
 * @returns the enabled routes, or undefined when the preference is off or empty.
 */
function deploymentRoutes(ctx) {
  if (state.enforceDeploymentPolicy === false) return undefined
  const settings = ctx.get('subagentModelSelection')
  if (settings === undefined || typeof settings.current !== 'function') return undefined
  try {
    const current = settings.current()
    if (current?.enabled !== true) return undefined
    const routes = normalizeRoutes(current.allowedModels)
    return routes === undefined || routes.length === 0 ? undefined : routes
  } catch {
    // A mis-configured deployment preference must not make every child spawn
    // fail with a configuration error the model cannot fix.
    return undefined
  }
}

/**
 * Resolve the allowlist that governs children of one Session.
 * Order: the Session own saved list, then the nearest live ancestor saved list
 * (a child conversation inherits the list it was spawned under), then the
 * deployment preference, then no restriction.
 * @param ctx - host context.
 * @param agent - the delegating Agent, when one is live.
 * @param seen - visited Session ids, guarding against a cyclic parent chain.
 * @returns the enforced routes, or undefined when nothing restricts children.
 */
function allowedRoutes(ctx, agent, seen = new Set()) {
  if (agent === undefined) return deploymentRoutes(ctx)
  const own = sessionRoutes(agent.session)
  if (own !== undefined) return own
  const parentId = agent.session?.header?.parentSession
  if (typeof parentId !== 'string' || seen.has(parentId)) return deploymentRoutes(ctx)
  seen.add(parentId)
  const parent = ctx.agents?.get?.(parentId)
  return parent === undefined ? deploymentRoutes(ctx) : allowedRoutes(ctx, parent, seen)
}

/**
 * Read the route one child activation will actually run on.
 * An explicit request wins, then the provider own route defaults, then the
 * delegating Agent current route (pure inheritance).
 * @param ctx - host context.
 * @param spec - the startActivation spec about to be forwarded.
 * @returns the effective route, or undefined when it cannot be determined.
 */
function activationRoute(ctx, spec) {
  const request = spec?.request
  const explicit = request?.agentOptions
  let defaults
  try {
    defaults = ctx.subagents?.getProvider?.(spec?.provider)?.agentRouteDefaults
  } catch {
    defaults = undefined
  }
  const parent = request?.parent
  const inherited = parent === undefined ? undefined : (liveSelection(parent) ?? parent?.options)
  const provider = explicit?.provider ?? defaults?.provider ?? inherited?.provider
  const model = explicit?.model ?? defaults?.model ?? inherited?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Enforce the Session allowlist at the seam every child activation crosses.
 * @param ctx - host context.
 * @param spec - the startActivation spec about to be forwarded.
 */
function assertActivationAllowed(ctx, spec) {
  const parent = spec?.request?.parent
  let routes
  try {
    routes = allowedRoutes(ctx, parent)
  } catch (error) {
    // Fail open on OUR evaluation failure: a host upgrade that renames an
    // internal field must not make every delegation impossible. A policy
    // verdict on a known route still fails closed below.
    warn(ctx, 'allowlist lookup failed, delegation continues: ' + String(error))
    return
  }
  if (routes === undefined) return
  const allowed = formatRoutes(routes)
  if (state.requireExplicitRoute === true && explicitRoute(spec) === undefined) {
    fail('this Session requires an explicit child route (requireExplicitRoute is on for this deployment): '
      + 'pass provider and model chosen from ' + allowed + ', for example with spawn_teammate_with_model')
  }
  const route = activationRoute(ctx, spec)
  if (route === undefined) {
    fail('this Session restricts child models to ' + allowed + ', but the child route could not be determined; name provider and model explicitly')
  }
  if (!routes.some(candidate => sameRoute(candidate, route))) {
    fail('child LLM route "' + formatRoute(route) + '" is not allowed for this Session; allowed routes: ' + allowed
      + '. Pick one of them (spawn_teammate_with_model / switch_agent_model) or ask the user to change the Session allowlist.')
  }
}

/**
 * Read the route a caller named explicitly, ignoring inherited values.
 * @param spec - the startActivation spec about to be forwarded.
 * @returns the explicit route, or undefined when the caller named none.
 */
function explicitRoute(spec) {
  const agentOptions = spec?.request?.agentOptions
  const provider = agentOptions?.provider
  const model = agentOptions?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Enforce the same allowlist for one live re-route.
 * @param ctx - host context.
 * @param agent - the Agent whose Session policy governs the target.
 * @param selection - the route the caller wants to apply.
 */
function assertRouteInPolicy(ctx, agent, selection) {
  let routes
  try {
    routes = allowedRoutes(ctx, agent)
  } catch (error) {
    warn(ctx, 'allowlist lookup failed, re-route continues: ' + String(error))
    return
  }
  if (routes === undefined) return
  if (routes.some(candidate => sameRoute(candidate, selection))) return
  fail('route "' + formatRoute(selection) + '" is outside this Session allowlist ('
    + formatRoutes(routes) + '); pick one of those routes or ask the user to change the session list')
}

/**
 * Validate one requested route against the live LLM runtime.
 * @param ctx - host context carrying the llm service.
 * @param args - model-facing provider/model/reasoning_effort fields.
 * @param signal - tool-call cancellation.
 * @returns the detached selection to record.
 */
async function resolveSelection(ctx, args, signal) {
  const provider = requireText(args.provider, 'provider')
  const model = requireText(args.model, 'model')
  const effort = args.reasoning_effort === undefined
    ? undefined
    : requireText(args.reasoning_effort, 'reasoning_effort')
  const selection = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  const llm = ctx.get('llm')
  // Without the runtime we cannot preflight; the agent loop still validates the
  // route at the next step and reports an unusable selection there.
  if (llm === undefined) return selection
  await llm.resolveCallConfig(selection, signal)
  return selection
}

/**
 * Wrap ctx.subagents.startActivation once per host process so a ticket created
 * by spawn_teammate_with_model becomes agentOptions on the child, and so every
 * child activation is checked against the Session allowlist.
 * @param ctx - host context carrying the subagent service.
 */
function installActivationShim(ctx) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    state.available = false
    state.reason = 'no subagents service is mounted'
    return
  }
  if (subagents[SHIM] !== undefined) {
    state.available = true
    state.reason = ''
    return
  }
  try {
    const original = subagents.startActivation
    if (typeof original !== 'function') throw new Error('startActivation is not a function')
    const patched = async function patchedStartActivation(spec) {
      const prompt = spec?.request?.prompt
      const ticket = prompt === undefined ? undefined : pendingChildOptions.get(prompt)
      // The allowlist must judge the route the child will ACTUALLY use, so the
      // ticket is merged before the gate runs; otherwise an allowed explicit
      // route would be rejected because the inherited one is outside the list.
      const forwarded = ticket === undefined
        ? spec
        : {
          ...spec,
          request: { ...spec.request, agentOptions: { ...spec.request.agentOptions, ...ticket } },
        }
      if (ticket !== undefined) pendingChildOptions.delete(prompt)
      assertActivationAllowed(ctx, forwarded)
      return await original.call(this, forwarded)
    }
    subagents.startActivation = patched
    Object.defineProperty(subagents, SHIM, { value: patched, configurable: true })
    state.available = true
    state.reason = ''
  } catch (error) {
    state.available = false
    state.reason = 'could not wrap ctx.subagents.startActivation: ' + String(error)
  }
}

/**
 * Read the newest durable route recorded in one child own Session log.
 * model/selection is the shipped durable selection event; our resume wrapper
 * records it inside every fresh segment, which is what makes a switch survive a
 * Harness restart (the descriptor snapshot cannot be rewritten).
 * @param ctx - host context carrying sessionQuery, when mounted.
 * @param sessionId - child Session identity.
 * @returns the recorded route, or undefined when the child never switched.
 */
async function durableRoute(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') return undefined
  try {
    const observation = await query.observeSession(sessionId)
    const events = observation?.events
    if (!Array.isArray(events)) return undefined
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'model/selection') continue
      const data = event.data
      if (typeof data?.provider !== 'string' || typeof data?.model !== 'string') continue
      return {
        provider: data.provider,
        model: data.model,
        ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Wrap ctx.agents.resume once per host process so a route recorded by
 * switch_agent_model survives every later re-materialization.
 * @param ctx - host context.
 * @param agents - the live Agent registry.
 */
function installResumeShim(ctx, agents) {
  if (typeof agents?.resume !== 'function') {
    state.resume = false
    state.resumeReason = 'this host exposes no agents.resume'
    return
  }
  if (agents[RESUME_SHIM] !== undefined) {
    state.resume = true
    state.resumeReason = ''
    return
  }
  try {
    const original = agents.resume
    const patched = async function patchedResume(options) {
      const sessionId = options?.resumeSessionId
      if (sessionId === undefined) return await original.call(this, options)
      let override = routeOverrides.get(sessionId)
      if (override === undefined) {
        override = await durableRoute(ctx, sessionId)
        if (override !== undefined) routeOverrides.set(sessionId, override)
      }
      if (override === undefined) return await original.call(this, options)
      const agentOptions = {
        ...options.agentOptions,
        provider: override.provider,
        model: override.model,
        ...(override.reasoningEffort === undefined ? {} : { reasoningEffort: override.reasoningEffort }),
      }
      const handle = await original.call(this, { ...options, agentOptions })
      const agent = handle?.agent ?? handle
      try {
        installRouteHook(agent)
        recordSelection(agent, override)
      } catch {
        // The resumed segment still carries the overridden route through
        // agentOptions, so a failed re-record only loses the notice/step pairing.
      }
      return handle
    }
    agents.resume = patched
    Object.defineProperty(agents, RESUME_SHIM, { value: patched, configurable: true })
    state.resume = true
    state.resumeReason = ''
  } catch (error) {
    state.resume = false
    state.resumeReason = 'could not wrap ctx.agents.resume: ' + String(error)
  }
}

/**
 * Give one Agent a route override seam for its remaining lifetime.
 *
 * The shipped loop derives each request from immutable creation-time
 * AgentOptions, so the only way to move a live child is the agent/request
 * waterfall - exactly the seam installModelSelection uses for ordinary
 * Sessions. Installing it once per Agent keeps repeated switches working.
 * @param agent - live child Agent owning an agent-scoped context.
 */
function installRouteHook(agent) {
  if (agent === undefined || agent === null) return
  if (agent[ROUTE_HOOK] !== undefined) return
  const events = agent.ctx
  if (typeof events?.on !== 'function') {
    state.hook = false
    state.hookReason = 'the Agent exposes no agent-scoped context'
    return
  }
  const id = agent.id ?? agent.session?.id
  if (typeof id !== 'string') return
  let dispose
  try {
    dispose = events.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const override = routeOverrides.get(id)
      if (override === undefined) return resolved
      const { reasoningEffort: _inherited, ...rest } = resolved ?? {}
      return {
        ...rest,
        provider: override.provider,
        model: override.model,
        ...(override.reasoningEffort === undefined ? {} : { reasoningEffort: override.reasoningEffort }),
      }
    })
  } catch (error) {
    state.hook = false
    state.hookReason = 'could not install the agent/request hook: ' + String(error)
    return
  }
  Object.defineProperty(agent, ROUTE_HOOK, { value: dispose, configurable: true })
  state.hook = true
  state.hookReason = ''
}

/** One canonical tool output: JSON text the model can read back. */
function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

const ROUTE_PROPERTIES = {
  provider: { type: 'string', description: 'Registered LLM provider id.' },
  model: { type: 'string', description: 'Exact model id within that provider.' },
  reasoning_effort: {
    type: 'string',
    description: 'Model-specific reasoning effort id; omit to use the model default (recommended when the route changes).',
  },
}

const SWITCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string' },
    previous: { type: 'string', description: 'Route before the switch, or an empty string when unknown.' },
    selected: { type: 'string', description: 'Route now in effect for the next step.' },
    note: { type: 'string', description: 'Present when the teammate was idle and the route applies on its next wake.' },
  },
  required: ['target', 'previous', 'selected'],
}

const SPAWN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string' },
    id: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    status: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['target', 'id', 'provider', 'model', 'context', 'status'],
}

const SUBAGENT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subagentId: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['subagentId', 'provider', 'model'],
}

const POLICY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', description: 'session, deployment, or open.' },
    routes: { type: 'array', items: { type: 'string' } },
  },
  required: ['source', 'routes'],
}

/** Resolve one teammate roster row by model-facing name. */
function findTeammate(team, caller, targetName) {
  const members = team.listMembers(caller)
  const member = members.find(candidate => candidate.role === 'teammate' && candidate.name === targetName)
  if (member === undefined) {
    const known = members
      .filter(candidate => candidate.role === 'teammate')
      .map(candidate => candidate.name)
      .join(', ')
    fail('no teammate named "' + targetName + '"; teammates in this Team: ' + (known || '(none)'))
  }
  return member
}

/** Read the true current route of one live Agent, not its immutable creation options. */
function liveSelection(agent) {
  try {
    const selected = agent?.model?.current?.()
    if (selected !== undefined) return selected
    // Some hosts expose the Session without the model facade; the last recorded
    // request header is then the only evidence of the route actually in use.
    const config = agent?.session?.requestHeader?.()?.config
    if (config === undefined) return undefined
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
  } catch {
    return undefined
  }
}

/**
 * Record one durable model selection on an Agent whose model facade may be
 * absent. The Session append writes exactly the durable event the GUI writes,
 * so the model chip and the next cold resume both see it.
 * @param agent - live Agent carrying either model or session.
 * @param selection - route to record.
 */
function recordSelection(agent, selection) {
  if (typeof agent?.model?.select === 'function') {
    agent.model.select(selection)
    return
  }
  if (typeof agent?.session?.append === 'function') {
    agent.session.append('model/selection', selection)
    return
  }
  const shape = agent === undefined ? 'undefined' : Object.keys(agent).join(',')
  fail('cannot record a model selection on this teammate Agent (shape: ' + shape + ')')
}

/**
 * Put one live child on a new route from its next step on, and remember it for
 * every later wake.
 * @param ctx - host context.
 * @param targetId - child Session identity.
 * @param selection - validated route to apply.
 * @returns the live Agent when one exists.
 */
function applyRoute(ctx, targetId, selection) {
  routeOverrides.set(targetId, selection)
  const live = ctx.agents.get(targetId)
  if (live === undefined) return undefined
  installRouteHook(live)
  recordSelection(live, selection)
  return live
}

/**
 * Append one Session-scoped allowlist.
 * @param session - Session that will own the new list.
 * @param routes - exact routes to save.
 */
function saveSessionRoutes(session, routes) {
  session.append(POLICY_EVENT, {
    allowedModels: routes.map(route => ({ provider: route.provider, model: route.model })),
  })
  // Read back once: if a future build stops honouring this event, the user must
  // see the failure here instead of believing an unenforced list is in force.
  const saved = sessionRoutes(session)
  if (saved === undefined || saved.length !== routes.length) {
    fail('the allowlist was written but cannot be read back from this Session log; this host build may no longer record '
      + POLICY_EVENT + ', so the list would not be enforced')
  }
}

/**
 * Resolve a command/tool target that may be a teammate name or a child Session id.
 * @param ctx - host context.
 * @param caller - the Agent issuing the request.
 * @param token - teammate name or child Session id.
 * @returns the resolved identity, or undefined when nothing matches.
 */
async function resolveChildTarget(ctx, caller, token) {
  const team = ctx.get('agentTeams')
  if (team !== undefined && caller !== undefined) {
    let membership
    try {
      membership = team.membership(caller)
    } catch {
      membership = undefined
    }
    if (membership !== undefined) {
      const member = team.listMembers(caller)
        .find(candidate => candidate.role === 'teammate' && candidate.name === token)
      if (member !== undefined) return { id: member.id, name: member.name, live: ctx.agents.get(member.id) }
    }
  }
  const live = ctx.agents.get(token)
  if (live !== undefined) return { id: token, name: token, live }
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.observeSession === 'function') {
    try {
      const observation = await query.observeSession(token)
      if (observation?.header !== undefined) return { id: token, name: token, live: undefined }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Resolve the Session that issued a panel command as its own switch target.
 * Only a child conversation may be re-routed this way: the Lead route belongs
 * to the user model picker.
 * @param ctx - host context.
 * @param agent - the Agent that issued the command.
 * @returns the self target, or undefined when this Session is not a child.
 */
async function resolveSelfTarget(ctx, agent) {
  if (agent === undefined) return undefined
  const header = agent.session?.header
  if (!isDelegatedSession(agent.session)) return undefined
  return { id: agent.id, name: 'this subagent', live: agent }
}

/**
 * Resolve one switch target for either mounting mode.
 * With a Team: teammate name plus the Lead/self permission rules.
 * Without one: the child Session id, restricted to this Session own children.
 * @param ctx - host context.
 * @param team - the Agent Teams service, when composed.
 * @param caller - the Agent issuing the switch.
 * @param targetName - teammate name or child Session id.
 * @returns the resolved child identity.
 */
async function resolveSwitchTarget(ctx, team, caller, targetName) {
  if (team !== undefined) {
    let members = []
    try {
      members = team.listMembers(caller)
    } catch {
      members = []
    }
    const member = members.find(candidate => candidate.role === 'teammate' && candidate.name === targetName)
    if (member !== undefined) {
      let membership
      try {
        membership = team.membership(caller)
      } catch {
        membership = { role: 'lead', name: 'lead' }
      }
      if (membership.role !== 'lead' && member.name !== membership.name) {
        fail('only the Team Lead can switch another teammate model; a teammate can only switch itself')
      }
      if (member.status === 'failed') {
        fail('teammate "' + member.name + '" failed provisioning (' + (member.diagnostics.join('; ') || 'no diagnostic')
          + '); a failed member cannot be re-routed')
      }
      return { id: member.id, name: member.name }
    }
    // Not a teammate name: fall through, so a plain subagent child (for example
    // one started by subagent_fork) is still reachable by its Session id.
  }
  const resolved = await resolveChildTarget(ctx, caller, targetName)
  if (resolved === undefined) {
    fail('no teammate or subagent matches "' + targetName + '"; pass a teammate name from list_agents or a child Session id')
  }
  const parentId = await parentOfTarget(ctx, resolved)
  if (parentId !== caller.id) {
    fail('only a direct parent can re-route its subagent; "' + targetName + '" is not a child of this Session')
  }
  return { id: resolved.id, name: resolved.name }
}

/** Read the parent Session id of one resolved child target. */
async function parentOfTarget(ctx, target) {
  if (target.live !== undefined && target.live !== null) return target.live.session?.header?.parentSession
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') return undefined
  try {
    const observation = await query.observeSession(target.id)
    return observation?.header?.parentSession
  } catch {
    return undefined
  }
}

/**
 * Read one Agent role inside the Team, tolerating a host without the service.
 * A missing or unreadable membership counts as the Lead, because that is the
 * scope that owns spawning; only a confirmed teammate loses the spawn tools.
 * @param team - the Agent Teams service, when composed.
 * @param agent - the Agent whose scope is being installed.
 * @returns 'lead' | 'teammate'.
 */
function memberRole(team, agent) {
  if (team === undefined) return 'lead'
  try {
    const membership = team.membership(agent)
    return membership !== undefined && membership !== null && membership.role === 'teammate'
      ? 'teammate'
      : 'lead'
  } catch {
    return 'lead'
  }
}

/**
 * Whether one Session was created by a delegation rather than by the user.
 *
 * A forked conversation also carries header.parentSession, so parentage alone
 * misclassifies it: only a delegation writes a subagent descriptor, and only a
 * delegation sets origin=subagent. A fork keeps the root surface.
 * @param session - live Session.
 * @returns true for a delegated child.
 */
function isDelegatedSession(session) {
  const header = session?.header
  if (header !== undefined && header !== null && header.origin === 'subagent') return true
  const log = session?.log
  if (!Array.isArray(log)) return false
  for (const event of log) {
    if (event?.type === 'subagent/descriptor') return true
  }
  return false
}

/** Build the model-facing tools for one Agent scope. */
function registerTools(agent, ctx, config, register, team, role) {
  // A teammate may re-route itself, never delegate: a child that spawns would
  // recurse, and the harness only budgets one level of delegation.
  const lead = role !== 'teammate'


  register(agent.ctx.tools.register({
    name: 'switch_agent_model',
    description:
      'Switch one live teammate to another provider/model without restarting it or losing its history. '
      + 'Use it after a teammate reports an exhausted endpoint (quota, revoked key, dead proxy, persistent provider error), '
      + 'then send_message so it continues where it stopped. It may be repeated: a running teammate applies the new route '
      + 'from its next step, and a released teammate is rebuilt on it at the next wake and every later resume. '
      + 'The route is also recorded in the child Session log, so it survives a Harness restart. '
      + 'With Agent Teams, a teammate may switch itself and only the Team Lead may switch another member; '
      + 'without a Team, target the child Session id and only its direct parent may switch it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Teammate target from list_agents, or a child Session id when no Team is composed (never "lead").' },
        ...ROUTE_PROPERTIES,
      },
      required: ['target', 'provider', 'model'],
    },
    output: jsonOutput(SWITCH_OUTPUT),
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) fail('switch_agent_model requires a calling Agent')
      const targetName = requireText(args.target, 'target')
      if (targetName === 'lead') {
        fail('the caller own route ("lead") is chosen by the user model picker, not by this tool; pick a child target')
      }
      const target = await resolveSwitchTarget(ctx, team, caller, targetName)
      const selection = await resolveSelection(ctx, args, exec.signal)
      assertRouteInPolicy(ctx, caller, selection)
      const live = ctx.agents.get(target.id)
      if (live !== undefined) {
        const previous = liveSelection(live)
        applyRoute(ctx, target.id, selection)
        return {
          target: target.name,
          previous: formatSelection(previous),
          selected: formatSelection(selection),
          note: live.status === 'running'
            ? 'the running child uses the new route from its next step'
            : 'the idle child uses the new route at its next wake',
        }
      }
      // An idle child is released by the continuation manager, so no Agent
      // exists between turns. Record the route on the resume seam instead: the
      // next wake rebuilds the child on it.
      if (!state.resume) {
        fail('"' + target.name + '" is not live and this host cannot override its resume route ('
          + state.resumeReason + '); wake it (send_message, or its parent prompt) and switch while it runs')
      }
      applyRoute(ctx, target.id, selection)
      return {
        target: target.name,
        previous: '',
        selected: formatSelection(selection),
        note: 'the child was idle; the route applies from its next wake on and every later resume in this process',
      }
    },
  }))

  if (team !== undefined && lead) register(agent.ctx.tools.register({
    name: 'spawn_teammate_with_model',
    description:
      'Create one named, durable teammate on an explicit provider/model instead of the Lead current route. '
      + 'Same contract as spawn_teammate plus the route fields; use list_agent_models to discover ids. Only the Team Lead may call this tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', description: 'Complete initial task for the teammate.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
        ...ROUTE_PROPERTIES,
      },
      required: ['name', 'description', 'prompt', 'provider', 'model'],
    },
    output: jsonOutput(SPAWN_OUTPUT),
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) fail('spawn_teammate_with_model requires a calling Agent')
      const membership = team.membership(caller)
      if (membership.role !== 'lead') fail('only the Team Lead can create teammates')
      const selection = await resolveSelection(ctx, args, exec.signal)
      const text = requireText(args.prompt, 'prompt')
      const context = args.context === 'fork' ? 'fork' : 'fresh'
      const provider = context === 'fork' ? config.forkProvider : config.freshProvider
      // The roster forwards this exact array object to startActivation, which is
      // what the shim keys its ticket by.
      const prompt = [{ type: 'text', text }]
      if (state.available) pendingChildOptions.set(prompt, selection)
      let result
      try {
        result = await team.spawnTeammate(caller, {
          name: requireText(args.name, 'name'),
          description: requireText(args.description, 'description'),
          prompt,
          context,
          provider,
          signal: exec.signal,
        })
      } finally {
        pendingChildOptions.delete(prompt)
      }
      const member = result.member
      let note
      // A profile can keep the Team service while dropping the coordination
      // tools (for example when only tool-agent-team is disabled). The teammate
      // would then exist with no way to message it, so say so in the result.
      try {
        const toolbox = caller.ctx?.tools
        if (toolbox !== undefined && typeof toolbox.get === 'function' && toolbox.get('send_message') === undefined) {
          note = 'this profile registers no send_message tool, so the teammate cannot be steered from here; '
            + 'use its Session id with switch_agent_model, or re-enable the Agent Teams tool bundle'
        }
      } catch {
        // An unreadable tool registry is not a spawn failure.
      }
      if (!state.available) {
        const live = ctx.agents.get(member.id)
        if (live === undefined) {
          note = 'the teammate was created on its inherited route because the child-route seam is unavailable ('
            + state.reason + ')'
        } else {
          applyRoute(ctx, member.id, selection)
          note = 'the child-route seam is unavailable (' + state.reason
            + '); the model was applied right after spawn, so the very first step may have used the inherited route'
        }
      }
      return {
        target: member.name,
        id: String(member.id),
        provider: selection.provider,
        model: selection.model,
        context: member.context ?? context,
        status: member.status,
        ...(note === undefined ? {} : { note }),
      }
    },
  }))

  if (team === undefined && lead) register(agent.ctx.tools.register({
    name: 'spawn_subagent_with_model',
    description:
      'Start one background subagent on an explicit provider/model instead of this Session route. '
      + 'Same contract as the shipped subagent tool plus the route fields; the runtime notifies you when it finishes. '
      + 'Use list_agent_models to discover ids, and switch_agent_model with the returned subagent id to re-route it later.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) description of the delegated task, for display.' },
        prompt: { type: 'string', description: 'Complete initial task for the subagent.' },
        ...ROUTE_PROPERTIES,
      },
      required: ['description', 'prompt', 'provider', 'model'],
    },
    output: jsonOutput(SUBAGENT_OUTPUT),
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) fail('spawn_subagent_with_model requires a calling Agent')
      const subagents = ctx.get('subagents')
      if (subagents === undefined || typeof subagents.startActivation !== 'function') {
        fail('this host mounts no subagent service, so a background subagent cannot be started')
      }
      const selection = await resolveSelection(ctx, args, exec.signal)
      const text = requireText(args.prompt, 'prompt')
      const activation = await subagents.startActivation({
        provider: config.freshProvider,
        label: requireText(args.description, 'description'),
        request: {
          prompt: [{ type: 'text', text }],
          parent: caller,
          agentOptions: selection,
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      return {
        subagentId: String(activation.childId),
        provider: selection.provider,
        model: selection.model,
      }
    },
  }))

  if (lead) register(agent.ctx.tools.register({
    name: 'configure_subagent_models',
    description:
      'Read or replace the model allowlist that governs every child spawned from this conversation. '
      + 'The list is Session-scoped: it overrides the deployment preference for this conversation only and applies to '
      + 'spawn_teammate_with_model, switch_agent_model, and inherited child routes. Omit both fields to read the current list.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        models: {
          type: 'array',
          description: 'Exact routes to allow for this conversation; replaces the current list.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { provider: { type: 'string' }, model: { type: 'string' } },
            required: ['provider', 'model'],
          },
        },
        inherit: {
          type: 'boolean',
          description: 'Save the deployment preference into this conversation instead of a custom list.',
        },
      },
    },
    output: jsonOutput(POLICY_OUTPUT),
    async execute(args, exec) {
      const written = await resolvePolicyWrite(ctx, exec.agent, args, exec.signal)
      return written ?? describePolicy(ctx, exec.agent)
    },
  }))

  register(agent.ctx.tools.register({
    name: 'list_agent_models',
    description:
      'Inspect LLM routes usable for teammates without changing any Agent. No arguments: providers. '
      + 'provider: its models. provider + model: that model and its reasoning efforts. '
      + 'Use the returned ids for spawn_teammate_with_model and switch_agent_model.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string', description: 'Registered LLM provider id.' },
        model: { type: 'string', description: 'Exact model id; requires provider.' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const llm = ctx.get('llm')
      if (llm === undefined) fail('cannot discover LLM routes because the llm service is unavailable')
      if (args.model !== undefined && args.provider === undefined) fail('model requires provider')
      const allowed = allowedRoutes(ctx, exec.agent)
      const banner = allowed === undefined ? '' : 'Session allowlist: ' + formatRoutes(allowed) + '\n\n'
      const listProviders = () => llm.listProviders()
      if (args.provider === undefined) {
        const providers = listProviders()
        const body = providers.length === 0
          ? '(no LLM providers)'
          : providers.map(provider => provider.id + ' — ' + provider.name).join('\n')
        return banner + body
      }
      const providerId = requireText(args.provider, 'provider')
      const provider = listProviders().find(candidate => candidate.id === providerId)
      if (provider === undefined) {
        fail('LLM provider "' + providerId + '" is not registered; available providers: '
          + (listProviders().map(candidate => candidate.id).join(', ') || '(none)'))
      }
      if (args.model === undefined) {
        const models = await llm.listModels(provider.id)
        exec.signal.throwIfAborted()
        const body = models.length === 0
          ? '(no advertised models for ' + provider.id + ')'
          : models.map(model => provider.id + '/' + model.id + ' — ' + model.name
            + (model.description === undefined ? '' : ': ' + model.description)).join('\n')
        return banner + body
      }
      const modelId = requireText(args.model, 'model')
      const model = await llm.resolveModelInfo(provider.id, modelId, exec.signal)
      const efforts = (model.reasoning?.efforts ?? [])
        .map(effort => effort.id + (model.reasoning?.defaultEffort === effort.id ? ' (default)' : '') + ' — ' + effort.name)
        .join('\n') || '(no advertised reasoning efforts)'
      return banner + provider.id + '/' + model.id + ' — ' + model.name + '\nReasoning efforts:\n' + efforts
    },
  }))
}

/**
 * Describe the allowlist that governs one Agent children.
 * @param ctx - host context.
 * @param agent - the delegating Agent.
 * @returns the machine-readable policy summary.
 */
function describePolicy(ctx, agent) {
  const session = sessionRoutes(agent?.session)
  if (session !== undefined) return { source: 'session', routes: session.map(formatRoute) }
  const deployment = deploymentRoutes(ctx)
  if (deployment !== undefined) return { source: 'deployment', routes: deployment.map(formatRoute) }
  return { source: 'open', routes: [] }
}

/**
 * Apply one allowlist write from the tool or the slash command.
 * @param ctx - host context.
 * @param agent - the Session Agent.
 * @param args - models and/or inherit.
 * @param signal - caller cancellation.
 * @returns the new policy summary, or undefined when the request only reads.
 */
async function resolvePolicyWrite(ctx, agent, args, signal) {
  if (agent === undefined) fail('this operation requires a live Session')
  if (args.models === undefined && args.inherit !== true) return undefined
  const session = agent.session
  if (typeof session?.append !== 'function') fail('this Session cannot store an allowlist')
  if (args.inherit === true) {
    const deployment = deploymentRoutes(ctx)
    if (deployment === undefined) fail('this deployment configures no subagent model allowlist to inherit')
    saveSessionRoutes(session, deployment)
    return { source: 'session', routes: deployment.map(formatRoute) }
  }
  const routes = normalizeRoutes(args.models)
  if (routes === undefined || routes.length === 0) fail('models must list at least one { provider, model } route')
  const llm = ctx.get('llm')
  if (llm !== undefined) {
    for (const route of routes) {
      try {
        await llm.resolveModelInfo(route.provider, route.model, signal)
      } catch (error) {
        fail('route "' + formatRoute(route) + '" is not usable: '
          + (error instanceof Error ? error.message : String(error)))
      }
    }
  }
  saveSessionRoutes(session, routes)
  return { source: 'session', routes: routes.map(formatRoute) }
}

/**
 * Register the human/UI entry points for the Session allowlist and for
 * switching one child. A slash command is the documented channel the browser
 * half calls through ctx.remote.commands.execute(); the same helpers back the
 * model-facing tools, so both callers cannot drift.
 * @param ctx - host context.
 * @returns the disposers for every registration.
 */
function registerCommands(ctx) {
  const commands = ctx.get('commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    state.commands = false
    state.commandsReason = 'no commands service is mounted'
    return []
  }
  const disposers = []
  try {
    disposers.push(commands.register({
      name: 'subagent-models',
      description: 'Show or replace the model allowlist for subagents spawned from this conversation.',
      input: { hint: '[provider/model ... | inherit | show]' },
      async handler(invocation) {
        try {
          const raw = invocation.rawInput.trim()
          const agent = invocation.agent
          if (raw === 'json') {
            const policy = describePolicy(ctx, agent)
            const deployment = deploymentRoutes(ctx)
            return {
              kind: 'success',
              text: JSON.stringify({
                source: policy.source,
                routes: policy.routes,
                deployment: deployment === undefined ? null : deployment.map(formatRoute),
              }),
            }
          }
          if (raw === '' || raw === 'show') {
            const policy = describePolicy(ctx, agent)
            const deployment = deploymentRoutes(ctx)
            const lines = ['Session allowlist: '
              + (policy.source === 'session' ? policy.routes.join(', ') : '(inherits deployment)')]
            lines.push('Deployment allowlist: '
              + (deployment === undefined ? '(off)' : deployment.map(formatRoute).join(', ')))
            if (policy.source === 'open') lines.push('Children are currently unrestricted.')
            return { kind: 'success', text: lines.join('\n') }
          }
          if (raw === 'inherit') {
            const policy = await resolvePolicyWrite(ctx, agent, { inherit: true }, invocation.signal)
            return { kind: 'success', text: 'Session allowlist saved: ' + policy.routes.join(', ') }
          }
          const entries = raw.split(/[\s,]+/).filter(entry => entry.length > 0)
          const routes = entries.map(entry => {
            const slash = entry.indexOf('/')
            if (slash <= 0 || slash === entry.length - 1) {
              fail('"' + entry + '" is not a provider/model route')
            }
            return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) }
          })
          const policy = await resolvePolicyWrite(ctx, agent, { models: routes }, invocation.signal)
          return { kind: 'success', text: 'Session allowlist saved: ' + policy.routes.join(', ') }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
    disposers.push(commands.register({
      name: 'subagent-model-switch',
      description: 'Switch one teammate or subagent to another provider/model from the subagent panel.',
      input: { hint: '<teammate-or-session-id> <provider/model>' },
      async handler(invocation) {
        try {
          const raw = invocation.rawInput.trim()
          const parts = raw.split(/\s+/).filter(part => part.length > 0)
          if (parts.length < 2) fail('usage: /subagent-model-switch <teammate-or-session-id> <provider/model>')
          const token = parts[0]
          const routeText = parts[1]
          const slash = routeText.indexOf('/')
          if (slash <= 0 || slash === routeText.length - 1) fail('"' + routeText + '" is not a provider/model route')
          const selection = await resolveSelection(ctx, {
            provider: routeText.slice(0, slash),
            model: routeText.slice(slash + 1),
          }, invocation.signal)
          assertRouteInPolicy(ctx, invocation.agent, selection)
          const target = token === 'self'
            ? await resolveSelfTarget(ctx, invocation.agent)
            : await resolveChildTarget(ctx, invocation.agent, token)
          if (target === undefined) fail('no teammate or subagent matches "' + token + '"')
          const live = applyRoute(ctx, target.id, selection)
          return {
            kind: 'success',
            text: target.name + ' → ' + formatSelection(selection)
              + (live === undefined ? ' (applies at its next wake)' : ' (applies from its next step)'),
          }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
    state.commands = true
    state.commandsReason = ''
  } catch (error) {
    state.commands = false
    state.commandsReason = 'could not register the model panels: ' + String(error)
  }
  return disposers
}

/** Install the model-routing tools in one Agent scope (Team member or plain child-capable Agent). */
function install(agent, ctx, config, team) {
  const role = memberRole(team, agent)
  const disposers = []
  const register = dispose => disposers.push(dispose)
  try {
    register(agent.ctx.systemPrompt.section({
      name: 'team:model-routing',
      order: sectionOrder(agent.ctx.systemPrompt, 'TEAM_POLICY') + 1,
      text: policyText(role),
    }))
    registerTools(agent, ctx, config, register, team, role)
  } catch (error) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/**
 * Mount model routing for every live and future Team member, the Session
 * allowlist gate, and the two model panels.
 * @param ctx - host context carrying the Team, Agent, tool, prompt, and subagent services.
 * @param config - optional freshProvider/forkProvider override.
 */
export function apply(ctx, config = {}) {
  const resolved = {
    freshProvider: typeof config.freshProvider === 'string' ? config.freshProvider : 'spawn',
    forkProvider: typeof config.forkProvider === 'string' ? config.forkProvider : 'fork',
    requireExplicitRoute: config.requireExplicitRoute === true,
    enforceDeploymentPolicy: config.enforceDeploymentPolicy !== false,
  }
  state.requireExplicitRoute = resolved.requireExplicitRoute
  state.enforceDeploymentPolicy = resolved.enforceDeploymentPolicy
  const declared = declaredDshVersion()
  state.declaredDsh = declared
  state.compatible = isSupportedDshVersion(declared)
  if (!state.compatible) {
    warn(ctx, 'this Harness declares version ' + String(declared) + ', outside the supported window '
      + SUPPORTED_DSH_RANGE + ' (validated against ' + VALIDATED_DSH + '); the plugin refuses to install')
    return
  }
  state.missingSeams = missingSeams(ctx)
  if (state.missingSeams.length > 0) {
    warn(ctx, 'this Harness build does not provide ' + state.missingSeams.join(', ')
      + '; delegation routing and the allowlist cannot be enforced here (validated against ' + VALIDATED_DSH + ')')
  }
  installActivationShim(ctx)
  installResumeShim(ctx, ctx.agents)
  ctx.effect(() => {
    const disposers = registerCommands(ctx)
    return () => {
      for (const dispose of disposers.reverse()) void dispose()
    }
  }, 'subagent-model-router.commands()')

  const installed = new Map()
  const hooks = new Map()
  const installHook = agent => {
    if (agent === undefined || agent === null) return
    installRouteHook(agent)
    const dispose = agent[ROUTE_HOOK]
    if (dispose !== undefined) hooks.set(agent, dispose)
  }
  /**
   * Whether one Agent is a root conversation (not a delegated child).
   * @param agent - live Agent.
   * @returns true for a root Session, false for a subagent child.
   */
  const isRootAgent = agent => !isDelegatedSession(agent.session)
  /**
   * Tool surface for one Agent.
   * team    - Agent Teams is composed and this Agent is one of its members.
   * generic - no Agent Teams at all, so every Agent hosts the plain subagent
   *           tools (the plugin is usable outside a Team profile).
   * none    - a Team is composed and this Agent is not a member: nothing.
   */
  const installMode = agent => {
    let team
    try {
      team = ctx.get('agentTeams')
    } catch {
      team = undefined
    }
    if (team === undefined) {
      // Without a Team, only root conversations delegate. A subagent child gets
      // no tools here, so this plugin cannot deepen a delegation chain the host
      // did not budget for; the child is still reachable from its parent.
      return { mode: isRootAgent(agent) ? 'generic' : 'none', team: undefined }
    }
    try {
      return team.tryMembership(agent) === undefined
        ? { mode: 'none', team }
        : { mode: 'team', team }
    } catch {
      // A membership probe that throws must not silently strip the tools from a
      // root conversation; fall back to the generic surface there.
      return { mode: isRootAgent(agent) ? 'generic' : 'none', team }
    }
  }
  const reconcile = agent => {
    try {
      installHook(agent)
      const decision = installMode(agent)
      const existing = installed.get(agent)
      if (existing !== undefined && existing.mode === decision.mode) return
      if (existing !== undefined) {
        existing.dispose()
        installed.delete(agent)
      }
      if (decision.mode === 'none') return
      installed.set(agent, {
        mode: decision.mode,
        dispose: install(agent, ctx, resolved, decision.team),
      })
    } catch (error) {
      // An Agent that cannot receive the tools must not fail its own
      // activation; the rest of the plugin keeps working.
      warn(ctx, 'could not install the model tools into one Agent: ' + String(error))
    }
  }
  // A Team service that mounts AFTER this plugin upgrades the already
  // installed Agents: without this, Agents created during boot would keep the
  // generic surface for the rest of the process.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['agentTeams'], () => {
        let agentsNow = []
        try {
          agentsNow = ctx.agents.list()
        } catch {
          agentsNow = []
        }
        for (const agent of agentsNow) reconcile(agent)
        return () => {}
      })
    }
  } catch (error) {
    warn(ctx, 'could not watch for the Agent Teams service: ' + String(error))
  }
  let existing = []
  try {
    existing = ctx.agents.list()
  } catch (error) {
    warn(ctx, 'could not enumerate live Agents: ' + String(error))
  }
  for (const agent of existing) reconcile(agent)
  ctx.on('agent/created', ({ agent }) => { reconcile(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = installed.get(agent)
    if (entry !== undefined) {
      entry.dispose()
      installed.delete(agent)
    }
    const hook = hooks.get(agent)
    if (hook !== undefined) {
      try {
        hook()
      } catch {
        // A disposed Agent tears its own scope down; a failing disposer must not
        // block the rest of the registry teardown.
      }
      hooks.delete(agent)
    }
  })
  ctx.effect(() => () => {
    for (const entry of installed.values()) entry.dispose()
    installed.clear()
    for (const dispose of hooks.values()) {
      try {
        dispose()
      } catch {
        // See above: teardown continues regardless.
      }
    }
    hooks.clear()
  }, 'subagent-model-router.scopedTools()')
}

/** Internal diagnostics for tests and for troubleshooting an unsupported host. */
export function diagnostics() {
  return { ...state }
}
