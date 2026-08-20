# Lifecycle Hooks & Event Handling Guidelines

> **Scope**: Handling Pi Agent lifecycle hooks, model changes, prompt-filter interceptors, and tool events.

---

## Pi Lifecycle Pipeline

The extension coordinates state through these events:

```text
session_start            ──> Reload cache-stack.json, resolve ctx.model, reset session activations, apply policy
model_select             ──> Resolve selected model policy and reconcile without resetting eligible activations
before_agent_start       ──> Refresh ctx.model and idempotently reconcile without resetting activations
tool_execution_end       ──> Refresh registered-tool snapshot and reconcile dynamic additions/removals
session_shutdown         ──> Drop extension-local runtime state
```

`session_start` is the only normal lifecycle hook that resets `activated`. Do not reuse its reset path from `before_agent_start`.

## System Prompt Interception

The prompt filter must remain synchronous and activation-independent. It exposes:

1. snippets and guidelines for the `lazy` proxy and effective always-active tools;
2. a compact, stable catalog of the complete lazy-loadable tool-name pool;
3. a `selectedTools` set consistent with the visible always-active prompt content.

```typescript
api.registerSystemPromptFilter((event) => {
  if (!effectiveLazyTools.enabled) return undefined;

  const disabled = new Set(effectiveLazyTools.disabled);
  const keep = new Set([PROXY_TOOL_NAME, ...getAlwaysActiveTools(effectiveLazyTools)]);
  const toolSnippets = Object.fromEntries(
    Object.entries(event.toolSnippets)
      .filter(([name]) => keep.has(name) && !disabled.has(name)),
  );
  const toolGuidelines = Object.entries(event.toolGuidelines)
    .filter(([name]) => keep.has(name) && !disabled.has(name))
    .flatMap(([, guidelines]) => guidelines);

  const catalog = buildLazyToolCatalog(pi, effectiveLazyTools);
  if (catalog) toolGuidelines.push(catalog);

  return {
    toolSnippets,
    toolGuidelines,
    selectedTools: [...keep]
      .filter((name) => event.toolNames.includes(name) && !disabled.has(name)),
  };
});
```

The catalog must not be the real-time inactive set. It intentionally still lists lazy-pool tools after activation so `setActiveTools()` does not change system-prompt bytes.

## Key Hook Rules

1. **Reset vs Reconcile**: `session_start` may reset session activations; `model_select`, `before_agent_start`, and `tool_execution_end` must preserve still-eligible activations.
2. **Current Model Ownership**: Resolve the effective policy in `index.ts`, where lifecycle contexts expose `ctx.model` and `model_select` exposes `event.model`. Pass the effective policy into `lazy-tools.ts` through a getter.
3. **Idempotent Handlers**: Repeated reconcile calls with unchanged model, config, registry, and activation state must produce the same active tool set.
4. **Synchronous Interceptors**: Prompt filter callbacks must remain synchronous, deterministic, and free of I/O.
5. **No Volatile Prompt Data**: Never inject timestamps, session IDs, current activation status, or unsorted registry iteration into the stable prompt.
6. **Optional Fork APIs**: Feature-detect `registerSystemPromptFilter`. If absent, warn and continue; do not block agent startup.
7. **No Unhandled Rejections**: Any future asynchronous lifecycle work must catch failures internally and preserve fail-open startup behavior.
