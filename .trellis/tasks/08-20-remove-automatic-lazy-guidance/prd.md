# Remove automatic lazy guidance

## Goal

Stop the `lazy` proxy tool from automatically adding opinionated usage guidance to the system prompt. The proxy should expose only the information required to discover and activate tools; any broader tool-selection guidance can be configured separately by the user in future work.

## Background

- `lazy-tools.ts` currently registers the `lazy` proxy with a static `promptGuidelines` array.
- Those guidelines are retained by the system-prompt filter because the `lazy` proxy is always kept visible.
- The static guidance includes Web-specific policy even when the effective model policy disables all local Web tools.
- The proxy description also contains a Web-specific instruction, so removing only the `promptGuidelines` field would still leave an automatic Web recommendation in the tool schema.

## Requirements

1. The `lazy` proxy registration must not define `promptGuidelines`.
2. The `lazy` proxy description must remain a concise, neutral explanation of status, search, activation, and reset behavior; it must not prescribe Web tools or shell alternatives.
3. The stable lazy-tool name catalog must remain unchanged so models can still discover eligible lazy-loaded tools.
4. Activating another tool through `lazy` must continue returning that tool's own description and `promptGuidelines` in the activation result. This is tool-owned runtime information, not guidance authored by the `lazy` proxy.
5. Documentation and tests must no longer claim that `lazy` automatically injects Web-specific guidance.
6. This task must not add a custom-guidance configuration API. User-configurable guidance is deferred to separate future work.

## Acceptance Criteria

- [x] The registered `lazy` tool has no `promptGuidelines` property.
- [x] The registered `lazy` tool description contains no Web-, HTTP-, curl-, Python-, Node-, or shell-selection policy.
- [x] Searching for and activating lazy-loaded tools continues to work.
- [x] Activation results continue to include guidance declared by the tool being activated.
- [x] The stable lazy catalog remains present when `showCatalogInPrompt` is enabled.
- [x] README wording reflects that `lazy` provides discovery/activation mechanics without automatic Web guidance.
- [x] Existing type-check and test commands pass.

## Out of Scope

- Adding `webGuidance`, `customGuidelines`, or another user-configurable prompt API.
- Moving guidance ownership into individual Web extensions or a capability registry.
- Changing model override matching or disabled-tool semantics.
- Removing the stable lazy-tool catalog.
- Removing activated tools' own descriptions or guidance from activation results.

## Technical Notes

Likely affected files are `lazy-tools.ts`, `tests/lazy-tools.test.ts`, and `README.md`. This is a lightweight, single-boundary change, so a separate `design.md` and `implement.md` are not required.
