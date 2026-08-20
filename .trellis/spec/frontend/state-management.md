# State Management & Configuration Guidelines

> **Scope**: Managing runtime extension state, configuration loading, model-specific policy resolution, and activation reconciliation.

---

## State Structure

Runtime state is encapsulated inside the `setupLazyTools()` closure and reset on `session_shutdown`:

```typescript
interface LazyToolsState {
  pi: ExtensionAPI;
  alwaysActive: Set<string>;
  disabled: Set<string>;
  /** Tools the LLM has activated this session (beyond alwaysActive). */
  activated: Set<string>;
  /** Current registered-tool snapshot. */
  knownTools: Map<string, ToolInfo>;
}
```

`refreshKnownTools()` must clear the snapshot before repopulating it. Otherwise unregistered dynamic tools remain stale in status, activation, and reconciliation paths.

## Configuration Merging

`deepMerge()` has these public semantics:

- Objects are recursively merged key by key.
- Arrays replace the prior array as a whole.
- `null` and `undefined` are treated as unset and retain the prior value.
- Parsed user configuration is normalized after merging. Invalid scalar/array types fall back to defaults, and invalid model override entries are ignored.
- Configuration parse/read failures log an error and return normalized defaults instead of blocking extension startup.

## Scenario: Model-specific lazy policy and stable catalog

### 1. Scope / Trigger

Use this contract whenever adding or changing fields under `lazyTools`, resolving policy from the selected model, or changing activation reconciliation. These paths jointly control request-body size, system-prompt cache stability, and which registered tools the model may call.

### 2. Signatures

```typescript
interface LazyToolsModelOverride {
  enabled?: boolean;
  alwaysActive?: string[];
  disabled?: string[];
  showCatalogInPrompt?: boolean;
}

interface LazyToolsConfig extends LazyToolsModelOverride {
  enabled: boolean;
  alwaysActive: string[];
  modelOverrides?: Record<string, LazyToolsModelOverride>;
}

interface EffectiveLazyToolsConfig {
  enabled: boolean;
  alwaysActive: string[];
  disabled: string[];
  showCatalogInPrompt: boolean;
}

interface ModelIdentity {
  provider: string;
  id: string;
}

resolveLazyToolsConfig(
  config: LazyToolsConfig,
  model?: ModelIdentity,
): EffectiveLazyToolsConfig;

buildLazyToolCatalog(
  pi: Pick<ExtensionAPI, "getAllTools">,
  cfg: EffectiveLazyToolsConfig,
): string | undefined;
```

### 3. Contracts

- `showCatalogInPrompt` defaults to `true`.
- A model pattern containing `/` matches `provider/model-id`; a pattern without `/` matches only `model-id`.
- Pattern matching is case-insensitive. `*` matches zero or more characters and `?` matches exactly one character. All other regex metacharacters are literal.
- Matching model overrides are applied in JSON declaration order. Later matching fields replace earlier fields; arrays follow normal whole-array replacement semantics.
- Runtime always-active tools are `DEFAULT_ALWAYS_ACTIVE ∪ effective.alwaysActive - effective.disabled`.
- The prompt catalog is alphabetically sorted, deduplicated, and omits the `lazy` proxy, disabled tools, and always-active tools.
- The catalog represents the complete lazy pool, including tools already activated this session. Activation state must not change catalog bytes.
- `session_start` resets session activations. `before_agent_start`, `model_select`, and `tool_execution_end` reconcile without resetting still-eligible activations.
- Reconciliation removes activated entries only when the tool is no longer registered, becomes disabled, or becomes always active.
- Effective `enabled: false` restores all currently registered tools. In that mode, `disabled` is not a permission boundary.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Config file missing | Use normalized defaults without logging an error |
| Invalid JSON/read failure | Log once through `console.error`; use normalized defaults |
| `enabled` or `showCatalogInPrompt` has wrong type | Ignore value and use default |
| `alwaysActive` / `disabled` is not `string[]` | Ignore value and use default/empty array |
| `modelOverrides` is not an object | Ignore all model overrides |
| Individual model override is not an object | Ignore that rule |
| Override field has wrong type | Ignore only that field |
| No model or no matching rule | Return normalized base policy |
| Lazy mode disabled | Activate the full current registered-tool snapshot |
| Prompt-filter fork API unavailable | Warn and continue without stable prompt filtering |

### 5. Good / Base / Bad Cases

- **Good**: `openai/gpt-5.6-*` applies only to that provider/model family; a later `gpt-5.6-luna` rule overrides one field; session activations survive the switch unless forbidden by the new policy.
- **Base**: no model matches, so the normalized global policy is used and the catalog remains stable across activation.
- **Bad**: compute the catalog from “currently inactive tools.” Every activation then changes the system prompt and invalidates the provider prefix cache.
- **Bad**: call session-reset reconciliation from every `before_agent_start`; this silently drops tools activated earlier in the same session.

### 6. Tests Required

- Config tests must assert bare-ID and full provider/model matching, `*` / `?`, case-insensitivity, regex-metacharacter escaping, declaration-order precedence, and unmatched fallback.
- Malformed config tests must assert fail-open normalization for invalid scalar, array, and model-override shapes.
- Catalog tests must assert sorting, deduplication, disabled/always-active filtering, visibility toggle, and identical output before and after activation.
- Lifecycle tests must assert activations survive `onBeforeAgentStart()` and eligible model-policy changes, while disabled/newly-always-active/missing tools are pruned.
- Disabled-mode tests must assert the complete registered set is restored.

### 7. Wrong vs Correct

#### Wrong

```typescript
pi.on("before_agent_start", () => {
  lazyTools.onSessionStart(); // clears activated every user run
});

const names = pi.getAllTools()
  .filter((tool) => !pi.getActiveTools().includes(tool.name)); // volatile prompt
```

#### Correct

```typescript
pi.on("before_agent_start", (_event, ctx) => {
  setCurrentModel(ctx.model);
  lazyTools.onBeforeAgentStart(); // reconcile without reset
});

const names = pi.getAllTools()
  .map((tool) => tool.name)
  .filter((name) => isInStableLazyPool(name))
  .sort();
```
