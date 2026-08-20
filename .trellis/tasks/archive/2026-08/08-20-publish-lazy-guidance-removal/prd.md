# Publish lazy guidance removal

## Goal

Release the completed automatic-lazy-guidance removal as `pi-cache-stack@0.4.1`, push the local `main` history to `origin/main`, publish the package to the public npm registry, and replace the Pi-managed local installation with the verified release.

## Background

- Repository version: `0.4.0`.
- npm `latest`: `0.4.0`.
- Pi-managed local installation version: `0.4.0`.
- The release removes unintended automatic prompt guidance without changing the public configuration shape, so a patch bump to `0.4.1` is appropriate.
- Local `main` is 11 commits ahead of `origin/main` and 0 commits behind. Publishing will add one release commit, so the push will send 12 commits total.
- Existing npm authentication is absent (`npm whoami` returns `E401`). The user supplied a publish token for this release.
- `NODE_TLS_REJECT_UNAUTHORIZED` is currently set in the environment. Every npm authentication, publish, and registry-verification command must explicitly unset it.

## Requirements

1. Authenticate against the public npm registry with the supplied token before changing release metadata.
2. Use the token only as an ephemeral process environment value. Do not write it to `.npmrc`, repository files, task artifacts, shell profiles, command output, or commits.
3. Bump `package.json` and `package-lock.json` consistently from `0.4.0` to `0.4.1` using `npm version 0.4.1 --no-git-tag-version`.
4. Run `npm run typecheck`, the complete `npm test` suite, `git diff --check`, and `npm pack --dry-run` before committing or publishing.
5. Confirm the dry-run package contains only intended source files and npm metadata.
6. Commit only release metadata and this task's Trellis artifacts; preserve all unrelated untracked files.
7. Push local `main` to `origin/main`. The push is expected to include the existing 11 unpushed commits plus the new release commit.
8. Do not create or push a Git tag or GitHub release.
9. Publish `pi-cache-stack@0.4.1` publicly only after the release commit has been pushed successfully.
10. Verify the public registry reports `0.4.1` before changing the local installation.
11. Update only Pi's `npm:pi-cache-stack` package and verify its installed `package.json` reports `0.4.1`.
12. Do not restart Pi automatically; report that `/reload` or a process restart is required.

## Acceptance Criteria

- [x] Ephemeral npm authentication succeeds with TLS verification enabled.
- [x] `package.json` and `package-lock.json` report `0.4.1`.
- [x] `npm run typecheck` passes.
- [x] `npm test` passes with all tests successful.
- [x] `git diff --check` passes.
- [x] `npm pack --dry-run` contains only the expected package files.
- [x] The release commit is pushed to `origin/main`, with no Git tag created.
- [x] `npm publish --access public` succeeds for `pi-cache-stack@0.4.1`.
- [x] `npm view pi-cache-stack version` returns `0.4.1` with TLS verification enabled.
- [x] `pi update npm:pi-cache-stack` succeeds without updating unrelated packages.
- [x] The installed local package version is exactly `0.4.1`.
- [x] No credential is persisted and unrelated untracked files remain untouched.

## Out of Scope

- Creating a Git tag or GitHub release.
- Updating unrelated Pi packages.
- Publishing any version other than `0.4.1`.
- Changing product source beyond release metadata.
- Restarting the current Pi process automatically.

## Release Order

1. Ephemeral authentication check with TLS verification enabled.
2. Version bump to `0.4.1`.
3. Typecheck, tests, diff check, and package dry-run inspection.
4. Commit release metadata and task artifacts.
5. Push `main` to `origin/main`.
6. Publish to npm and verify registry version.
7. Update and verify the Pi-managed local installation.
