/** Type surface for dsh-subagent-model-router. Dependency-free: the plugin imports no workspace package. */

/** Optional mount configuration; both defaults match the shipped Agent Teams layer. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates (default spawn). */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates (default fork). */
  readonly forkProvider?: string
  /**
   * Reject a child activation that names no route while an allowlist is active,
   * even when the inherited route is on the list (default false). Turn it on to
   * force every spawn to pick one allowed route explicitly.
   */
  readonly requireExplicitRoute?: boolean
  /**
   * Treat the deployment preference (subagent-model-selection-settings) as a
   * hard gate (default true). Set false to keep only Session-saved lists
   * enforced, which stops an inherited child route outside the deployment list
   * from being refused.
   */
  readonly enforceDeploymentPolicy?: boolean
}

/** Cordis plugin name. */
export declare const name: 'subagent-model-router'

/** The DeepSeek Harness build every wrapped seam was read from. */
export declare const VALIDATED_DSH: '0.2.1-rc.5'

/** Declared compatibility window; outside it the plugin warns and refuses to install. */
export declare const SUPPORTED_DSH_RANGE: '>=0.2.1-rc.5 <0.3.0'

/**
 * Line check for a declared Harness version (an undeclared version is allowed).
 * @param version - a 0.2.1-rc.5 style version, or undefined.
 */
export declare function isSupportedDshVersion(version: string | undefined): boolean

/**
 * Services the plugin waits for before installing. Agent Teams is NOT required:
 * without it the plugin installs the plain subagent tools in every Agent scope.
 */
export declare const inject: readonly ['agents', 'tools', 'subagents', 'systemPrompt']

/** The shipped Session event that carries a Session-scoped child-model allowlist. */
export declare const POLICY_EVENT: 'subagent/model-selection-policy'

/** Tool names the plugin registers in every Team member scope. */
export type TeamModelToolName =
  | 'switch_agent_model'
  | 'spawn_teammate_with_model'
  | 'spawn_subagent_with_model'
  | 'configure_subagent_models'
  | 'list_agent_models'

/** Host commands the composer-dock panel drives through ctx.remote.commands.execute(). */
export type TeamModelCommandName = 'subagent-models' | 'subagent-model-switch'

/** Which host seams the plugin managed to wrap in this process. */
export interface TeamModelDiagnostics {
  /** Whether ctx.subagents.startActivation is wrapped (spawn ticket + allowlist gate). */
  readonly available: boolean
  readonly reason: string
  /** Whether ctx.agents.resume is wrapped (cold-wake route override). */
  readonly resume: boolean
  readonly resumeReason: string
  /** Whether the two slash commands were registered. */
  readonly commands: boolean
  readonly commandsReason: string
  /** Whether at least one Agent received the agent/request route hook. */
  readonly hook: boolean
  readonly hookReason: string
  /** Whether this deployment rejects purely inherited child routes. */
  readonly requireExplicitRoute: boolean
  /** Whether the deployment preference is enforced or advisory. */
  readonly enforceDeploymentPolicy: boolean
  /** The Harness version the host declared, when it declares one. */
  readonly declaredDsh?: string
  /** False when a declared version is outside SUPPORTED_DSH_RANGE (plugin idle). */
  readonly compatible: boolean
  /** Required host seams this build did not provide. */
  readonly missingSeams: readonly string[]
}

/**
 * Install model routing into every live and future Team member scope, gate every
 * child activation on the Session allowlist, and register the panel commands.
 * @param ctx - host context carrying the Team, Agent, tool, prompt, command, and subagent services.
 * @param config - optional provider overrides.
 */
export declare function apply(ctx: unknown, config?: Config): void

/** Read the seam diagnostics; useful when a host changed its internals. */
export declare function diagnostics(): TeamModelDiagnostics
