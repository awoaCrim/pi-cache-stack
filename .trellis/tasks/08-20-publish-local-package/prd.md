# Publish and replace local package

## Goal

Publish the completed model-aware lazy-tools feature as a new `pi-cache-stack` npm release, then replace the locally installed `pi-cache-stack` package with that exact published version.

## Background

- Repository package version: `0.3.0`.
- npm latest version: `0.3.0`; no newer release exists.
- Local Pi installation: `C:\Users\Administrator\.pi\agent\npm\node_modules\pi-cache-stack`, version `0.3.0`.
- The completed feature is a backward-compatible user-facing capability addition, so the recommended SemVer release is `0.4.0`.
- `prepublishOnly` already runs `npm run typecheck && npm run test`.
- Initial npm authentication check failed with `E401 Unauthorized`; the user has now provided a publish token for this release. The token must be used only as an ephemeral environment value and must not be written to task artifacts, repository files, shell profiles, or npm config.

## Requirements

1. Bump the package version consistently in `package.json` and `package-lock.json`.
2. Use a SemVer version appropriate for a backward-compatible feature release.
3. Run type checking and the full test suite before publishing.
4. Inspect the npm package contents before publication so only intended files are shipped.
5. Publish to the public npm registry under `pi-cache-stack`.
6. Verify the registry reports the new version after publication.
7. Update the existing Pi-managed local npm installation to the newly published version without disturbing unrelated packages.
8. Verify the installed local `package.json` reports the same version as npm.
9. Do not push Git commits or tags unless separately requested.
10. Preserve unrelated untracked Trellis initialization files.

## Acceptance Criteria

- [ ] `package.json` and `package-lock.json` contain the approved release version.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm pack --dry-run` contains only the expected extension source, README, LICENSE, and package metadata.
- [ ] `npm publish --access public` succeeds under the authenticated npm account.
- [ ] `npm view pi-cache-stack version` returns the approved release version.
- [ ] Pi's local package manager updates `npm:pi-cache-stack` successfully.
- [ ] `C:\Users\Administrator\.pi\agent\npm\node_modules\pi-cache-stack\package.json` reports the approved release version.
- [ ] Unrelated packages and untracked Trellis files remain unchanged.

## Out of Scope

- Publishing or pushing a Git tag or GitHub release.
- Updating unrelated Pi packages.
- Changing npm account credentials or registry configuration beyond authenticating the existing npm account.
- Automatically restarting the currently running Pi process; a reload or restart may still be needed for the running session to use replaced extension code.

## Confirmed Decisions

- Release version: `0.4.0`.
- Publish target: public npm registry package `pi-cache-stack`.
- Authentication: use the user-provided token ephemerally for publish/auth checks; do not persist it.
