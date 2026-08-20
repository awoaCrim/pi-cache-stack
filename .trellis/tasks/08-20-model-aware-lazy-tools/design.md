# Design: Model-aware lazy tool catalog

## Boundaries

- `config.ts` owns configuration types, defaults, glob matching, and resolution of a model-specific effective lazy policy.
- `lazy-tools.ts` owns always-active calculation, stable catalog construction, activation state, and reconciliation.
- `index.ts` owns Pi lifecycle integration, current-model tracking, and system-prompt filtering.
- `README.md` documents the public configuration contract.

## Configuration Contract

Add these fields under `lazyTools`:

- `showCatalogInPrompt?: boolean`, default `true`.
- `modelOverrides?: Record<string, LazyToolsModelOverride>`, default `{}`.

A model override may set `enabled`, `alwaysActive`, `disabled`, and `showCatalogInPrompt`.

Patterns containing `/` match the full `provider/model-id`; patterns without `/` match only `model-id`. `*` matches any sequence and `?` matches one character. Matching is case-insensitive. Matching entries are deep-merged in JSON declaration order. Arrays replace the prior array at the override layer, while the final configured `alwaysActive` array is still unioned with `DEFAULT_ALWAYS_ACTIVE` by runtime policy construction.

## Stable Prompt Catalog

The system-prompt filter continues to expose snippets and guidelines only for the proxy and always-active tools. It additionally appends one compact guideline containing alphabetically sorted lazy-loadable tool names.

The catalog is derived from the complete registered lazy pool rather than the current inactive set. Therefore activating a tool changes `tools[]` but not the system prompt. Disabled and always-active names are filtered out.

## Lifecycle and State

Maintain a resolved effective policy in `index.ts`:

1. `session_start`: reload file configuration, resolve against `ctx.model`, reset session activations, and apply policy.
2. `model_select`: resolve against the selected model and reconcile without clearing still-eligible activations.
3. `before_agent_start`: refresh the current model and reconcile idempotently without resetting activations.
4. `tool_execution_end`: refresh registered tools and reconcile.
5. `session_shutdown`: discard extension-local state.

Reconciliation behavior:

- Effective lazy disabled: activate all registered tools.
- Effective lazy enabled: compute defaults plus configured always-active tools, remove disabled tools, prune missing/disabled/newly-always-active entries from the session activation set, then apply proxy + always-active + remaining activated tools.

## Compatibility and Degradation

- Keep feature detection for `registerSystemPromptFilter`; unsupported Pi builds continue with a warning and normal prompt behavior.
- Do not add runtime dependencies; implement small glob matching locally.
- Preserve existing TypeScript and Pi 0.84.x extension API compatibility.
- Configuration read failures continue to fall back to defaults.

## Trade-offs

Listing names increases the stable system prompt slightly, but remains much smaller than exposing full tool descriptions and schemas. The catalog intentionally includes already activated lazy tools; an exact real-time inactive list would invalidate the prompt prefix after every activation.

## Rollback

The feature can be disabled without code rollback using `showCatalogInPrompt: false`. Per-model lazy behavior can be disabled with an override setting `enabled: false`. A source rollback is isolated to `config.ts`, `lazy-tools.ts`, and `index.ts` plus associated tests and documentation.
