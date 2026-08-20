# Add model-aware lazy tool catalog

## Goal

Improve lazy-tool discoverability without giving up the stable prompt prefix and reduced `tools[]` payload, while allowing different models to use different lazy-loading policies.

## Background

The existing prompt filter removes non-always-active tool snippets and guidelines from the system prompt. This keeps the prompt stable across dynamic activation, but it also means the model cannot see which inactive tools exist until it calls `lazy({ search: "..." })`.

Lazy activation is intended to persist for the whole session. Reapplying session-start reconciliation before every agent run must not clear tools that were activated earlier in the same session.

## Requirements

1. The stable system prompt must include a compact catalog of lazy-loadable tool names by default.
2. The catalog must omit tools that are disabled or already part of the always-active set.
3. The catalog must be independent of current activation state. Activating a tool must not remove it from the catalog or otherwise change the system-prompt prefix.
4. Tool descriptions, parameter schemas, and tool-specific prompt guidelines must remain deferred until activation; the stable catalog only needs tool names and activation guidance.
5. Users must be able to disable the catalog globally or in a model-specific override.
6. Lazy policy must support per-model overrides for `enabled`, `alwaysActive`, `disabled`, and catalog visibility.
7. Model patterns must support `*` and `?`, matching either full `provider/model-id` patterns or bare model IDs.
8. When multiple model patterns match, overrides must apply in declaration order, with later matching fields taking precedence.
9. Switching models in the current session must immediately apply the selected model's resolved lazy policy without requiring reload or a new session.
10. Lazily activated tools must remain active across subsequent user runs in the same session unless a newly applied policy disables them or makes them always active.
11. Disabling lazy mode must restore Pi's full registered tool set.
12. Existing fail-open behavior for missing fork APIs and malformed configuration must remain intact.
13. Public configuration behavior and model-pattern semantics must be documented in `README.md`.

## Acceptance Criteria

- [ ] The system prompt contains a stable lazy-tool catalog when `showCatalogInPrompt` is enabled.
- [ ] Disabled and always-active tools are absent from the catalog.
- [ ] The catalog remains byte-stable when tools are activated during the session.
- [ ] `showCatalogInPrompt: false` removes the catalog without disabling lazy loading.
- [ ] Bare model-ID and `provider/model-id` glob patterns resolve correctly.
- [ ] Later matching model overrides win per field.
- [ ] A `model_select` event immediately reconciles the active tool set with the resolved model policy.
- [ ] Session activations survive later `before_agent_start` events.
- [ ] A model-policy change removes activations only when they become disabled or always active.
- [ ] Setting effective `enabled` to `false` restores all registered tools.
- [ ] Type checking passes with `npm run typecheck`.
- [ ] Unit tests pass with `npm test`, including regression coverage for catalog filtering, model override resolution, model-policy switching, and activation persistence.
- [ ] `git diff --check` reports no whitespace errors.

## Out of Scope

- Sending full inactive tool schemas in the system prompt.
- Treating lazy loading or `disabled` as a security or permission boundary.
- Automatically selecting lazy policy from undocumented model capability heuristics.
- Reloading `cache-stack.json` immediately when the file changes mid-session; file changes continue to load on `session_start`.
- Changing Pi core provider serialization or native deferred-tool protocols.
