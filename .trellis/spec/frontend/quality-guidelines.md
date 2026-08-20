# Quality, Testing & Performance Guidelines

> **Scope**: Test conventions, error handling, and prefix-cache stability standards.

---

## Testing Conventions

Tests use Node.js's native test runner (`node:test`) with `--experimental-strip-types`, eliminating the need for Jest, Vitest, or compilation artifacts.

```bash
npm run test
```

### Writing Tests

Tests are placed in `tests/*.test.ts` and use `node:assert/strict`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { deepMerge, DEFAULT_CONFIG } from "../config.ts";

test("config deepMerge: overrides scalars and replaces arrays wholesale", () => {
  const base = { a: 1, list: ["x", "y"] };
  const override = { a: 2, list: ["z"] };
  assert.deepEqual(deepMerge(base, override), { a: 2, list: ["z"] });
});
```

---

## Mocking Extension APIs in Tests

Mock minimal `ExtensionAPI` surfaces to verify activation lifecycle and tool filtering without launching a full Pi agent runtime:

```typescript
function createMockPi(toolNames: string[]) {
  const tools = toolNames.map((name) => ({ name, description: `${name} tool` }));
  let active: string[] = [];
  return {
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    registerTool: () => {},
    registerCommand: () => {},
    on: () => {},
  };
}
```

---

## Cache Performance & Stability Rules

1. **Keep Always-Active Small**: Default always-active tools must remain compact (`bash`, `read`, `write`, `edit`, `ls`, `find`, `grep`) to keep request body tokens minimal.
2. **Stable Tool Descriptions**: Do not inject dynamic timestamps, session IDs, or volatile text into `lazy` tool descriptions.
3. **Stable Catalog Membership**: Build the system-prompt catalog from the complete configured lazy pool, not the current inactive set. Sort and deduplicate names so activation and registry iteration order do not change prompt bytes.
4. **Deferred Detail**: The stable catalog contains names and activation guidance only. Keep inactive descriptions, schemas, and tool-specific guidelines out of the prompt until activation.
5. **Graceful Degradation**: If user config is corrupted, log to `console.error` and continue with normalized default configuration instead of throwing errors.
6. **Lifecycle Regression Coverage**: Tests must distinguish session reset from per-run/model reconciliation so future hook refactors cannot silently clear session activations.
