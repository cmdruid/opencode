# Permission review settings and package preparation

Implementation and verification completed on 2026-11-06. See [VERIFICATION.md](VERIFICATION.md) for the artifact, compatibility limits, commands and results. npm publication remains on hold.

Replace the permission plugin's settings flow with persistent navigation and a single configuration model, then prepare an independently versioned npm artifact. Work on `perm`, landing locally on `custom`. Publishing to npm is explicitly deferred.

This is the implementation plan. Writing it does not change the installed plugin, configuration, or server.

## Scope and hard cut

- Keep `/permissions` and its four quick presets: Read only, Ask for approval, Approve for me, and Full access.
- Replace the existing settings dialogs and their settings RPC methods together. Ship one settings implementation, without an old/new toggle or compatibility commands.
- Preserve saved user choices, connection credentials, remembered approvals, and review history. Normalize old stored formats at the storage boundary; do not maintain two runtime configuration models.
- Preserve permission precedence, model evidence rules, the fallback agreement rule, auto-accept checks, and configured denials. No change to which model recommendations can authorize execution.
- Prepare the package manifest, documentation, local packing, and artifact verification. Do not publish, create release tags, dispatch release workflows, configure registry credentials, or switch the installed plugin to an npm package.
- Keep the separate upstream permission-hook PR untouched. The initial supported host is this fork with the required experimental APIs; upstream compatibility must be demonstrated before being advertised.

## 1. Establish the custom baseline

1. Reconcile `perm` with current `custom` before editing runtime code. At planning time the branches have 19 and 222 unique commits respectively; inspect overlapping changes and preserve the permission feature rather than blindly replaying duplicates.
2. Confirm the reconciled host exposes permission evaluation/review hooks, plugin RPC/storage, provider and credential integration, model generation, TUI permission mode/actions, and the dialog/rendering facilities required below.
3. Read package instructions and the matching unit/TUI test skills before changing tests. Identify existing release and package-test conventions on the reconciled baseline.
4. Continue using `.workstream/perm`. Preserve the old-path compatibility symlink until the installed plugin reference is deliberately updated; packaging must not depend on that symlink.
5. Run a small pack/install probe with the existing plugin before redesigning its internals. Establish source TS/TSX loading, companion discovery, peer resolution, and the minimal isolated host setup. Resolve packaging incompatibilities early; retain the probe for the final artifact check.

Exit condition: clean baseline with the existing permission feature intact. No move of the primary `custom` checkout and no live service replacement are needed to implement this plan.

## 2. Introduce one effective settings model

Add `settings.ts` beside the plugin implementation for configuration schemas, resolution, persistence, and storage normalization. Keep `review.ts` focused on evaluating a request and `connections.ts` focused on provider/credential integration. Keep shared wire schemas in `contract.ts`.

The effective server settings contain:

| Area             | Fields                                                                            |
| ---------------- | --------------------------------------------------------------------------------- |
| Primary reviewer | Chat/classifier backend, provider/model/variant, classifier threshold, connection |
| Second opinion   | Optional provider/model/variant, default mode, timeout, connection                |
| Review policy    | Default primary reviewer mode, reviewed actions, additional policy text           |

Retain the existing plugin-options format as the configuration-file baseline. Server overrides are a versioned, sparse record: an absent override inherits configuration; reset deletes the override. Define explicit representations for clearing policy, disabling second opinion, and selecting all actions so these operations cannot be confused with inheritance. An empty action list means review no actions and must be labeled accordingly.

Session state contains scope and reviewer mode separately, plus an optional second-opinion mode. The four quick presets write known scope/mode combinations. Changing reviewer mode alone preserves scope. If a combination does not match a quick preset exactly, show its actual scope and reviewer without falsely marking another preset active.

Resolution is deterministic:

1. Resolve existing plugin configuration and its current default behavior.
2. Apply saved server overrides field by field.
3. Resolve the nearest explicit session/ancestor scope and reviewer selection.
4. Apply the current session's second-opinion override; this override is not inherited by children.

Expose each effective value with its source and scope. Distinguish a configured value from a built-in default and an inherited session selection. Resetting a session selection reveals its ancestor or server default. Resetting only second-opinion mode leaves the scope/reviewer selection intact.

Preserve existing storage keys and record layouts wherever they already express the required behavior. Decode `selection/<session>`, `mode/<session>`, and `fallback/<session>` into the canonical effective representation at one boundary. Translate historical configured/shadow presets by their actual scope and reviewer behavior. Add the new server-override record without rewriting all session data. Only migrate a record if its current format cannot express the new behavior; do not introduce a migration registry, startup scan, or eager history rewrite. Any necessary migration must be safe to repeat and write a valid replacement before removing a superseded record. Keep the plugin identity `opencode.permission-review` stable across the npm package rename.

Read effective settings once at the start of a review and pass that snapshot through primary and fallback evaluation. Later saves affect subsequent reviews, not the assessment in progress. Refresh settings across connected readers through the plugin's existing event/reload facilities.

Keep synchronous resolution and schema validation separate from Effect-backed storage and provider work. Reuse the existing permission evaluator and connection machinery instead of rewriting them for the new UI. Reload provider/credential integrations only when their inputs change; policy or threshold edits must not cause provider rebuilds. Use existing refresh behavior before considering another cache or invalidation system.

Exit condition: configuration, storage, and RPC share one typed model; existing selections resolve to the same behavior before and after normalization.

## 3. Replace settings RPCs and navigation

Replace the fragmented settings read/write methods with typed operations for reading effective settings, saving/resetting server sections, and saving/resetting session selections. Keep approval/history operations focused on their existing responsibilities. Remove superseded experimental settings methods after updating the companion and tests; do not add deprecated aliases for these internal experimental methods.

Server settings operations require location context but no Session ID. Session operations require the actual Session ID. Return refreshed effective state after each save/reset, and notify connected clients about the appropriate server-wide or session change.

Replace the chained dialogs in `tui.tsx` with a persistent navigation state and production settings component. Use the host's existing rendering and dialog facilities. Split reusable editors/components where they have clear responsibilities; avoid a new general-purpose UI framework.

Keep screen identity, selection/scroll restoration, and an editor draft in a small navigation state owned by the settings component. Reuse concrete controls for model selection, connection editing, and simple values. Avoid a schema-generated form engine, generic routing layer, or per-field RPC. Read the effective settings once on entry and refresh after saves or relevant change events; load model catalogs, history, and approvals only when their screen needs them. Share production components between the UI, story, and renderer tests rather than implementing a second visual copy.

| Screen           | Contents                                                                | Scope                       |
| ---------------- | ----------------------------------------------------------------------- | --------------------------- |
| This session     | Reviewer mode, second-opinion mode, restore inherited/default selection | Current session             |
| Primary reviewer | Backend, provider, model, variant, connection, threshold                | All sessions on this server |
| Second opinion   | Model setup/removal, connection, default mode, timeout                  | All sessions on this server |
| Review policy    | Default reviewer mode, reviewed actions, additional instructions        | All sessions on this server |
| Activity         | History, remembered approvals, effective permissions                    | Current session             |

Navigation contract:

- `/permissions` keeps the four quick presets and Settings; add current scope/reviewer information to the entry screen.
- Settings rows show current values and scope. The selected row and scroll position survive returning from a child screen.
- Escape returns one level. At the Settings root it returns to the permissions selector; at the selector it closes the flow.
- Save returns to the containing screen and refreshes values. Cancel discards the editor draft and returns without writing.
- Validation errors remain in the editor with entered values preserved.
- History details return to history; approval details/revocation return to the approvals list.
- Home-screen server configuration creates no session. Session and activity screens explain that no session is selected. Selecting a quick preset retains the existing create-session behavior.
- Retain auto-accept checks for session approval controls. Do not silently switch the host client's permission mode.

Use “Primary reviewer” instead of “Classifier connection.” Display Shadow as “Shadow — suggest only; you decide.” Threshold appears only for classifier backends. Explain that the threshold routes decisions and is not a calibrated probability of safety.

## 4. Implement configuration editors

Provider/model/variant choices come from the host's available model catalog. Validate references at the owning boundary and report unavailable models without silently substituting another model. Preserve model variant generation settings, including token limits.

Second opinion can be configured entirely through settings, including when no fallback exists in the configuration file. A chat primary disables use of second opinion while retaining its saved setup. Switching back to a classifier restores that setup. Preserve the existing fallback rules: only agreement with a below-threshold primary approve can grant approval; primary escalation remains human-reviewed.

Keep the existing bounds: threshold 0–1, fallback timeout 100–15,000 ms, and the host's overall review deadline. Expose the existing default values; do not change live threshold, mode, or fallback preferences as part of the refactor. Generation-token controls continue to belong to model variants.

Connection editing is one draft with endpoint and authentication choices: use configured provider, retain existing key for an unchanged endpoint, replace key, or no key. Save validates the complete draft before changing effective settings. Cancel performs no credential or provider writes. A changed endpoint never inherits the old key. Credentials remain in the host credential store and never enter settings responses or plugin KV. Preserve current connection identities when carrying existing overrides forward.

Policy editing changes only the additional trusted policy field. Show the current text, allow an explicit clear, and offer reset to configured policy. Keep the core reviewer instructions internal. Reviewed actions are exact action names; support both catalog choices and custom plugin action names.

Exit condition: all listed fields can be configured and reset from the UI without editing global configuration files or restarting the server.

## 5. Prepare the npm package without releasing

Use the user-selected package name `@cmdcode/opencode-auto-permissions` and preparation version `0.1.0-alpha.0`. Registry scope permissions and name availability must be verified before any future publication. This version is independent of the host's version. Do not rename the plugin ID, RPC identity, storage namespace, or source directory merely to match the npm name. Repository ownership remains `cmdruid/opencode`; the npm scope does not change its URL.

Update `package.json` with:

- The independent name/version, accurate description, keywords, repository URL `git+https://github.com/cmdruid/opencode.git`, and repository directory `packages/plugins/permission-review`.
- `private: true` during the release hold. Prepare `publishConfig` for public access, the npm registry, and the `next` tag; removal of `private` belongs to the later release change.
- Existing root/server/TUI export entrypoints, with an explicit allowlist containing all runtime modules, README, and the package license. Exclude tests, evaluation data, this plan, and local artifacts.
- Peer dependency ranges justified by the supported host and artifact test. Keep host plugin APIs, Effect, and Solid runtime identities shared with the host; do not bundle duplicates or claim support from a version number alone.
- Local pack and artifact-check scripts. They must not invoke publishing or the repository release command.

Keep source TS/TSX packaging as the initial format, consistent with the existing plugin entrypoints. Prove that the host's npm-plugin loader resolves these files and their `.js` import specifiers from the packed installation. If the host requires compiled output, use the established repository packaging tools with the correct Solid transform; a generic JSX build is insufficient.

Inspect the emitted manifest and resolve or omit workspace/catalog-only development metadata as appropriate for the artifact. No published runtime dependency or export may point at a workspace checkout. Keep the lockfile and internal package-name references consistent.

Exclude this package from the host release script's blanket version rewriting in `.github/release/tag-release.sh`, following the existing independently versioned package precedent. Ensure host publication scripts do not accidentally collect this artifact. Do not enable a publish job or add Changesets.

Rewrite README around installation requirements, quick start, settings scopes, all supported options/defaults, provider data sent during review, and limitations. Label npm installation as forthcoming while publication is held. Include MIT license text with the existing attribution. Replace relative links to excluded evaluation documents with repository links. Remove obsolete command/menu instructions.

Exit condition: an independently versioned, locally packable artifact with publication disabled, complete metadata/docs, and a documented compatible host.

## 6. Verify behavior and the packed artifact

Before writing tests, read `.opencode/skills/unit-tests` and `.opencode/skills/tui-tests`. Test production code and real provider/storage boundaries with local fixtures.

Assign each contract one main test owner. Extend existing tests rather than recreating their coverage at every layer:

| Owner                                    | Coverage                                                                                                                                                     | Execution approach                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Plugin settings unit tests               | Field validation, precedence, clear versus reset versus inheritance, source labels, legacy-record normalization, quick-preset matching                       | Table-driven cases calling the actual resolver/decoders; no renderer, server, or filesystem               |
| Core plugin integration tests            | Real storage/RPC persistence, session/ancestor isolation, resets, cross-reader refresh, review configuration snapshot                                        | Existing `makePluginTestLayer` and plugin host; targeted new cases, not a host boot per field             |
| Existing Core connection/fallback suites | Credentials, endpoint isolation, model variants, both HTTP adapters, fallback agreement and failures                                                         | Extend the existing fixtures; local HTTP on port 0 and virtual time for timer-only behavior               |
| Production component renderer tests      | Every editor binding, draft save/cancel, validation display, back/focus/scroll behavior, current values, empty/error states, history/approval navigation     | `testRender` without a running frame loop where possible; await data, then `renderOnce()`                 |
| Full TUI integration tests               | Slash/palette registration, session-free home settings, preset session creation, session/RPC change propagation, auto-accept checks and native Allow Session | Small boundary suite using `createAppFixture`; do not repeat every field's validation or persistence here |
| Packed installation check                | Export and peer resolution, server activation, companion discovery, one saved setting surviving reload, one fixture permission request                       | Reuse the early probe against the exact final tarball in one isolated profile                             |

Cover all fields and meaningful cases at their owning layer. Do not multiply every setting by every reviewer mode, session relationship, and terminal width. Test each independent dimension directly, then add specific interactions: chat primary with saved fallback, fallback mode inheritance, key retention after an endpoint change, configured denial with automatic review, and a save during an in-flight assessment. Preserve existing reviewer, preset, and Allow Session regression coverage.

Use explicit synchronization for asynchronous tests. Await plugin readiness, RPC completion, focus, or the model fixture's request signal before asserting or typing. For the in-flight snapshot case, hold a local fixture response, save settings, then release it; do not guess timing with sleeps. Use Effect TestClock for timeout logic and a live clock for real socket/process events. Preserve per-test state isolation and deterministic teardown; do not share mutable sessions or credentials between tests to save setup time.

Render layout cases at 44 and 112 columns with explicit heights. Run the behavioral sequence at one width; resize or mount representative long-label, validation, connection, and activity states for the other width. Do not duplicate the whole workflow solely to check wrapping. Keep animations disabled, avoid wall-clock performance assertions, and do not raise frame budgets to mask missing readiness/focus waits.

Add a fixture-driven story under `packages/tui/src/feature-plugins/system/storybook` and register it in `index.tsx`. Render the production settings component, keep all effects local, expose session/server/inheritance/error states through documented keybindings, and include reset. Run the story through `dev:live` at narrow and wide sizes.

Pack into a temporary output directory, inspect the file list and emitted manifest, then install that exact tarball in an isolated host profile outside the monorepo. Verify server activation, TUI companion discovery, all entrypoint resolution, settings persistence, and a permission request using local model fixtures. This proves distribution and integration; do not repeat the settings behavioral matrix through the installed package. The verification must not resolve source through worktree links or use real user sessions, credentials, or model calls. If matching host artifacts are not publicly available, supply local packed host dependencies and record that limitation explicitly. Reuse built host artifacts only while their source and dependency inputs remain unchanged; always repack after a package payload change.

Run focused package tests from package directories, the affected official `typecheck:tsc` scripts, and root `bun run check`. Read any additional affected-package test instructions. Public Protocol/Server HttpApi changes are not planned; if required, run client generation rather than hand-editing generated files.

Execution order and stopping rules:

1. During iteration, run only changed test files and affected-package `bun typecheck`. Run Core tests through `bun run script/test.ts`; retain the plugin's OpenTUI preload and package timeout when invoking renderer tests.
2. Once implementation settles, run the full plugin suite and the affected Core permission integration suites once. Run story/layout inspection and the packed installation check against the final implementation.
3. Before pushing, perform the repository test skills' ten-repeat check on changed test files, including a bounded loaded run for relevant asynchronous cases. Do not repeat entire unchanged suites ten times. Use at most two heavy test processes together and keep their state isolated; do not change the repository test runner's parallelism settings for this task.
4. Run official typechecks for affected packages and canonical root `bun run check` once on the final code. After a subsequent change, rerun checks invalidated by that change; investigate failures before broadening the run. A new failure or shared-host change justifies broader coverage; already-passing unrelated suites do not need another run.
5. Capture test results, first-run and repeat durations, and named expensive setup work in the verification notes. Do not promise a speedup percentage before measuring it. Validate that the renamed package still appears in `bun turbo test --dry=json` and that imports of shared test fixtures are covered by its dependency closure.

The story is an interactive review aid, not a replacement for behavior tests. Real-provider evaluation is unnecessary while reviewer instructions/evidence/decision rules remain unchanged; if implementation changes those rules, expand validation explicitly rather than treating existing model-quality results as current evidence.

## Delivery and completion

Use three reviewable stages, each internally consistent:

1. Early package-loader probe, then canonical settings resolution, sparse persistence, boundary normalization, and the new RPC contract.
2. Complete UI cutover, production story, and removal of superseded settings methods/dialogs.
3. Independent package configuration, release-script exclusion, documentation, and isolated artifact verification.

The first stage may temporarily retain the current UI only while wiring the replacement; remove that transitional code before completing the work. No parallel settings implementation remains in the final change. If opening a PR, assess feature-flag requirements under repository rules; a necessary rollout flag must gate the new capability rather than preserve two settings stacks. Include the required animated SVG in the PR's Visual section.

Completion means the consolidated settings work, previous effective user choices are preserved, verification passes, and the npm tarball is ready for review. Record its file list, checksum, exact host compatibility, and verification commands. Update the workstream checkpoint with the result and any concrete limitations.

Stop before npm publication, release tagging, enabling publish automation, or replacing the installed client/service. Registry ownership and removal of the publication hold are later release decisions. No release credentials are needed for this work.
