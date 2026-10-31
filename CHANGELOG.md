# Changelog

## 0.0.1 - first release

First published version. Everything below is what this release ships; the
package was called `dsh-agent-team-model` during development and is renamed
here, so there is no earlier public version to migrate from.

**Model routing**

- `spawn_teammate_with_model` (Agent Teams) and `spawn_subagent_with_model`
  (no Team) create a child on an explicit provider/model.
- `switch_agent_model` re-points a live child as often as needed: a running child
  picks the new route up at its next step through the `agent/request` waterfall,
  and a released child is rebuilt on it through the `agents.resume` shim plus the
  durable `model/selection` event, so a switch survives a Harness restart.
- A teammate may re-route itself and nothing else: spawn and allowlist tools are
  Lead-only, which keeps delegation from recursing.

**Conversation-scoped allowlist**

- Enforced at `ctx.subagents.startActivation` on every child activation, including
  pure inheritance, which the shipped `allowedModels` check never sees.
- Resolution: this conversation list, then the nearest live ancestor, then the
  deployment default, then unrestricted. The list is saved as the shipped
  `subagent/model-selection-policy` event.
- `requireExplicitRoute` refuses pure inheritance when turned on;
  `enforceDeploymentPolicy` decides whether the deployment list is a hard gate
  or advisory.
- A saved list cannot be withdrawn (the shipped event is append-only with a
  minimum of one route), so the UI states the mode instead of offering a
  reversible switch.

**User interface**

- Conversation header chip: the route this conversation really runs on, plus a
  queued-switch marker and a per-model subtree summary in the tooltip.
- Composer dock panel: allow-set state and editing, direct children with their
  routes, and a per-row switch that states the impact on inheriting descendants.
- Sidebar hover row: the same route without opening the conversation.
- Chinese and English, following the harness locale; internals such as depth and
  Session ids only render with `?dev=1`.

**Compatibility**

- Works with or without Agent Teams; without one, tools install into root
  conversations only.
- Declared Harness window `>=0.2.1-rc.5 <0.3.0` in `dsh.compat` and
  `peerDependencies`; a declared version outside it makes the plugin refuse to
  install, and `diagnostics().missingSeams` reports a renamed internal.
- Zero runtime dependencies.
