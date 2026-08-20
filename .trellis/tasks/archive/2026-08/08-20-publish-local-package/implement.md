# Implementation Plan: Publish and replace local package

## Checklist

1. Use the explicitly approved release version `0.4.0`.
2. Inject the user-provided npm token ephemerally and verify with `npm whoami`, without writing it to `.npmrc`, task files, or the repository.
3. Bump repository metadata with `npm version 0.4.0 --no-git-tag-version`.
4. Run `npm run typecheck` and `npm test`.
5. Inspect `npm pack --dry-run` for unintended files.
6. Publish with `npm publish --access public`.
7. Verify `npm view pi-cache-stack version` reports `0.4.0`.
8. Run `pi update npm:pi-cache-stack`.
9. Verify the local installed package version is `0.4.0`.
10. Report whether the current Pi process needs `/reload` or restart.
11. Quality-check the final diff and request commit approval under Phase 3.4; do not tag or push.

## Validation Commands

```bash
npm whoami
npm run typecheck
npm test
npm pack --dry-run
npm view pi-cache-stack version
pi update npm:pi-cache-stack
node -p "require('C:/Users/Administrator/.pi/agent/npm/node_modules/pi-cache-stack/package.json').version"
git diff --check
```

## Stop Conditions

- Stop before publication if `npm whoami` fails.
- Stop before local replacement if registry verification does not show the new version.
- Stop before committing if unrelated files would be included.
