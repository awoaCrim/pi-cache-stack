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

---

## Scenario: npm release and Pi-local replacement

### 1. Scope / Trigger

Use this flow whenever publishing a new `pi-cache-stack` version and replacing the package installed through Pi's npm package manager.

### 2. Signatures

```bash
npm version <semver> --no-git-tag-version
npm run typecheck
npm test
npm pack --dry-run
npm publish --access public
npm view pi-cache-stack version
pi update npm:pi-cache-stack
```

Installed-version assertion:

```bash
node -p "require('C:/Users/Administrator/.pi/agent/npm/node_modules/pi-cache-stack/package.json').version"
```

### 3. Contracts

- `package.json` and the root entries in `package-lock.json` must carry the same version.
- Use `--no-git-tag-version`; Git commits/tags/pushes require separate approval.
- `prepublishOnly` must run type checking and tests, but run them explicitly before publish as an early failure gate.
- `npm pack --dry-run` must show only the files allowed by `package.json#files` plus npm metadata (`LICENSE`, `README.md`, and `package.json`).
- Publish credentials must be ephemeral. Never write tokens into `.npmrc`, repository files, task artifacts, shell profiles, logs, or commits.
- Do not publish with TLS verification disabled. Unset `NODE_TLS_REJECT_UNAUTHORIZED=0` for auth and publish commands.
- Verify the registry reports the new version before updating the local Pi installation.
- Update only `npm:pi-cache-stack`, then assert the installed package version directly. The running Pi process may still need `/reload` or restart.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `npm whoami` fails | Stop before changing release metadata or publishing |
| Typecheck/test fails | Stop before packing or publishing |
| Dry-run contains unexpected files | Stop and fix `package.json#files` or ignore rules |
| Publish fails | Keep the existing local package installed; report the registry error |
| Registry does not show the new version | Do not update the local installation |
| Targeted Pi update fails | Leave unrelated packages untouched; retry only the exact package |
| Installed version differs from registry | Report failure and do not claim local replacement succeeded |

### 5. Good / Base / Bad Cases

- **Good**: bump both metadata files, validate, publish, verify registry, target-update the local package, and verify the installed version.
- **Base**: validation succeeds but authentication fails; no publication or local update occurs.
- **Bad**: run `pi update --all`, which can change unrelated packages.
- **Bad**: update the local package before registry verification, leaving the installation dependent on propagation timing or stale metadata.
- **Bad**: persist a one-use publish token in `.npmrc` for convenience.

### 6. Tests Required

- `npm run typecheck` succeeds.
- `npm test` succeeds with the complete suite.
- `npm pack --dry-run` file list is manually checked against `package.json#files`.
- `npm view pi-cache-stack version` equals the intended release.
- The installed package metadata equals the registry version after the targeted update.
- `git diff --check` succeeds and the release diff contains only intended metadata/spec/task changes.

### 7. Wrong vs Correct

#### Wrong

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
npm publish
pi update --all
```

#### Correct

```bash
unset NODE_TLS_REJECT_UNAUTHORIZED
npm publish --access public   # with ephemeral auth supplied for this process only
npm view pi-cache-stack version
pi update npm:pi-cache-stack
```
