# Implementation Plan: Model-aware lazy tool catalog

## Checklist

1. Extend lazy-tool configuration types and defaults with catalog visibility and model overrides.
2. Add deterministic model-pattern matching and effective-policy resolution in `config.ts`.
3. Add unit tests for bare-ID matching, full provider/model matching, wildcard behavior, declaration-order precedence, and unmatched fallback.
4. Extract a shared always-active calculation in `lazy-tools.ts`.
5. Add stable catalog construction that sorts names and omits proxy, disabled, and always-active tools.
6. Split session reset from idempotent reconciliation so `before_agent_start` no longer clears session activations.
7. Add model-policy reconciliation and full-tool restoration when lazy mode is disabled.
8. Track the current model in `index.ts`, apply model overrides on `session_start`, `model_select`, and `before_agent_start`, and append the catalog through the prompt filter.
9. Add regression tests for activation persistence, catalog filtering, effective policy changes, and lazy-disabled restoration.
10. Update `README.md` with catalog behavior, configuration fields, model-pattern semantics, and lifecycle timing.
11. Review the complete diff against Trellis hook, state-management, type-safety, and cache-stability specs.

## Validation

```bash
npm run typecheck
npm test
git diff --check
```

## Review Gates

- Confirm activation changes do not alter catalog content.
- Confirm model switching does not reset still-eligible activations.
- Confirm per-model array replacement remains consistent with documented deep-merge semantics.
- Confirm no new runtime dependency is introduced.
- Confirm inactive schemas and detailed guidelines are still deferred.

## Rollback Points

- If prompt catalog behavior causes regressions, set `showCatalogInPrompt: false` or revert only the catalog injection while retaining model-policy resolution.
- If model override matching is incompatible with user expectations, disable `modelOverrides` usage and fall back to the base policy without changing existing lazy activation behavior.
