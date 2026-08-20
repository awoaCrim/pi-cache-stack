# Design: Publish and replace local package

## Release Boundary

The task has three ordered boundaries:

1. Repository release metadata and validation.
2. npm publication and registry verification.
3. Pi-managed local package update and installed-version verification.

Publication must complete and registry verification must pass before modifying the local installation.

## Versioning

Use `npm version <approved-version> --no-git-tag-version` so `package.json` and `package-lock.json` remain synchronized without creating a Git commit or tag. The current feature is backward-compatible and user-visible, so `0.4.0` is the recommended version from `0.3.0`.

## Publication Flow

1. Supply the user-provided npm token only as an ephemeral environment value and confirm authentication with `npm whoami`; never persist the token in `.npmrc` or repository files.
2. Run `npm version 0.4.0 --no-git-tag-version` after approval.
3. Run `npm run typecheck` and `npm test`.
4. Inspect `npm pack --dry-run` output.
5. Run `npm publish --access public`; `prepublishOnly` repeats type checking and tests.
6. Poll or query `npm view pi-cache-stack version` until it reports the released version.

If ephemeral authentication fails, stop before changing release metadata and report the authentication error without printing the token.

## Local Replacement

The package is installed through Pi's package manager as `npm:pi-cache-stack`. After registry verification, run:

```bash
pi update npm:pi-cache-stack
```

Then read the installed package metadata directly from:

```text
C:\Users\Administrator\.pi\agent\npm\node_modules\pi-cache-stack\package.json
```

The currently running Pi process may retain the previously loaded extension instance until `/reload` or restart; replacement on disk is still complete once the installed metadata matches.

## Safety and Rollback

- Do not uninstall before the new registry version is confirmed.
- Do not update all Pi packages; target only `npm:pi-cache-stack`.
- If publish fails, leave the existing local `0.3.0` installation intact.
- If local update fails after publication, retry the targeted update or reinstall the exact published version; do not alter unrelated packages.
- Do not include unrelated Trellis bootstrap files in release commits.
