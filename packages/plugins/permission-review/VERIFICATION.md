# Settings cutover and package preparation verification

Verified on Linux x64 with Bun 1.4.4 on 2026-11-06. npm publication remains disabled (`private: true`); no registry credentials, publish job, release tag, or installed-client replacement was used.

## Result and compatibility

The settings cutover uses one server override record, preserved session/connection/history keys, one RPC contract, and one production navigation component. Reviewer instructions, evidence selection, permission precedence and fallback agreement logic are unchanged. The old settings methods/dialogs are removed.

The package is `@cmdcode/opencode-auto-permissions@0.1.0-alpha.0`. The tested host is a separate build from the reconciled `perm` source, based on local `custom` at `347123d45d1a26c65ff804503518b96d7c8a88f9`, with the permission-hook work retained. Host version: `0.0.0-perm-package-check` (Linux x64, web UI omitted for this test). Its embedded plugin SDK supplies the fork APIs and shared Effect/Solid runtime identities.

The public `@opencode/plugin@2.2.5` cannot load the plugin directly: the initial clean-install probe found its missing `ReviewResult` export. The peer version is therefore a dependency constraint, not a claim of compatibility with stock OpenCode. The final compiled-fork installation passed without worktree links. Upstream compatibility and registry ownership/name availability remain future release gates.

## Exact artifact

Local retained artifact: `artifacts/cmdcode-opencode-auto-permissions-0.1.0-alpha.0.tgz`.

- Tarball SHA-256: `c0e01e8ba80576e44dd68a1a6c68a022faa12c0dbb51717d3f688fd816de6622`
- Host SHA-256: `142730582b70651c04a099799e2b05b57a95bf6fda8afcd2f4fe6bf20be67f61`
- Host artifact: `packages/cli/dist/perm-package-final/cli-linux-x64/bin/opencode` from the repository root.
- Payload: `package.json`, `LICENSE`, `README.md`, `index.ts`, `review.ts`, `settings.ts`, `connections.ts`, `contract.ts`, `tui.js`.
- Root/server exports load source TypeScript and resolve `.js` imports to those files. The companion is precompiled with the established OpenTUI Solid transform; runtime JSX transformation excludes `node_modules`.
- Development dependencies/scripts, tests, stories, evaluations, plans and local artifacts are excluded. No runtime dependency or export points at a workspace checkout.

The final tarball was installed at `/tmp/permission-package-check-rSZ4cM/node_modules/@cmdcode/opencode-auto-permissions`. `artifacts/verification.json` retains the machine-readable report; the independent profile also contains the server log and captured TUI frame. All temporary servers/model fixtures/TUIs were stopped after verification.

The installation check exercised server activation, companion discovery and rendering, a threshold saved through RPC and preserved across a process restart, and one local System One model call approving an inert permission request. An earlier permission request without user evidence correctly asked the human; the test explicitly approved and remembered it through Allow Session to seed authorization. No proposed tool executed, and no real provider, user session or credential was used.

## Validation

| Check                                                  | Result                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Complete plugin suite                                  | 38 pass, 250 assertions, 3.31 s                                            |
| Affected Core permission suites                        | 31 pass, 340 assertions, 3.07 s                                            |
| Changed plugin files, ten repetitions                  | 200 pass, 880 assertions, 19.35 s                                          |
| Changed Core files, ten repetitions                    | 310 pass, 3400 assertions, 19.83 s                                         |
| Official Core, TUI and plugin `typecheck:tsc`          | Pass                                                                       |
| Root `bun run check`                                   | Pass, 36/36 tasks                                                          |
| Production story via `dev:live`                        | Inspected at 44×36 and 112×36                                              |
| Final isolated tarball check                           | Pass                                                                       |
| Release version mutation on temporary tracked fixtures | Host advances; plugin manifest and lockfile version remain `0.1.0-alpha.0` |
| Turbo test/dependency closure                          | Renamed package present; Core/TUI fixture dependencies included            |

The two repeated suites ran concurrently, with no more than two heavy test processes. JUnit reports are `/tmp/perm-plugin-repeat.xml` and `/tmp/perm-core-repeat.xml`. The slowest repeated plugin case was the first whole-app home-settings test (1.386 s); subsequent native-prompt cases were about 0.7 s. The slowest Core case was 0.271 s. Expensive setup is the first full TUI app import and real Core storage/provider initialization, not a host boot per settings field.

The first complete plugin run took 37.31 s because separate RPC event subscriptions held fixture connections open during teardown. Reusing the TUI's existing event stream reduced the subsequent complete run to 3.01 s; the settled suite with another activity test took 3.31 s. These are local observations, not CI performance guarantees. No runner parallelism or frame budget was increased.

The live story renders the production settings component and exercises session/inheritance state, server overrides, long policy text, preserved failed drafts, back navigation and reset. Captures: `/tmp/perm-story-narrow.txt`, `/tmp/perm-story-error-narrow.txt`, `/tmp/perm-story-wide.txt`. Tests separately cover connection drafts/key isolation, model variants, numeric bounds, all versus no actions, settings events, home-screen session creation, auto accept, native Allow Session, and history/revocation navigation.

Only the affected Core suites were run; this is not a claim that every Core test passes. No real-model quality evaluation was repeated because reviewer instructions/evidence/decision rules did not change. No public Protocol or Server HttpApi changed, so client generation was unnecessary.

## Reproduce

From `packages/plugins/permission-review`:

```sh
bun run test
bun test --timeout 30000 --preload @opentui/solid/preload --only-failures --rerun-each 10 permissions.test.tsx settings.test.ts tui.test.tsx
bun run typecheck:tsc
bun run pack /tmp/permission-package
bun run check:package /tmp/permission-package/cmdcode-opencode-auto-permissions-0.1.0-alpha.0.tgz /absolute/path/to/compatible/opencode
```

The artifact checker requires Bun, tar and tmux, plus network access to install peer packages. It creates a temporary isolated profile, checks the manifest/file list, uses a local model fixture and cleans up its processes. It does not publish.

From `packages/core`:

```sh
bun run script/test.ts test/plugin/permission-settings.test.ts test/plugin/permission-review.test.ts test/plugin/permission-presets.test.ts test/plugin/permission-fallback.test.ts test/plugin/permission-connections.test.ts test/plugin/session-approvals.test.ts
bun run typecheck:tsc
```

From `packages/tui`, run `bun run typecheck:tsc`. From the repository root, run `bun run check` and `OPENCODE_STORY=permission-settings bun run dev:live /tmp`. The story's F2–F6 controls are listed in its footer.

## Live installation and release hold

Before editing runtime files, the existing installed source plugin was copied to `.workstream/permission-review-installed`, and only its configured package path was redirected there. Its options were preserved. The config backup is `~/.config/opencode/opencode.jsonc.before-perm-implementation`. Read-only final inventory confirmed that snapshot active on the same elected endpoint, `http://127.0.0.1:49374`. The normal service and installed client were not replaced or restarted.

The old `.workstream/permission-review` compatibility symlink remains, but the npm artifact does not depend on it. The helper's hardcoded `stream/` branch prefix conflicts with this repository's branch naming instructions, so the workstream checkpoint is saved directly under the bounded workstream lock. The separate upstream hook PR remains untouched.

Future release work must explicitly authorize publishing, verify registry ownership/name availability, review host compatibility and then remove `private: true`. Host release version rewriting excludes both the package manifest and its lockfile record; the host's package collection does not include this plugin.

## Compact menu revision — 2026-11-06

Version `0.1.0-alpha.1` replaces the large, filtered settings view with compact native selection rows, a medium dialog, right-aligned values and selected-row help. The host's selection row is shared with the bundled companion; existing host dialogs retain their behavior. Classifier selection offers only decision models and writes `mode: "decision"`; Reviewer selection offers only chat models. Single-provider and variant-free selections skip unnecessary screens. Existing configuration-file chat mode remains readable for compatibility; no permission evaluation or saved-setting migration changed.

Validation on the final source:

- Full plugin suite: 39 pass, 272 assertions, 3.88 s.
- Changed component and whole-app suites repeated ten times: 100 pass, 850 assertions, 15.10 s. After the final alignment and mouse/long-list test addition, component suite repeated ten times: 80 pass, 700 assertions, 2.30 s.
- Native selection suite repeated ten times concurrently: 350 pass, 490 assertions, 25.34 s, covering both native design modes.
- Official plugin and TUI TypeScript checks pass. Root `bun run check`: 36/36 tasks pass.
- Production story inspected through `dev:live` at 44×36 and 112×36: `/tmp/perm-compact-preview-bCUuuV`. Service discovery used the normal profile while terminal state stayed isolated.
- Exact final tarball passed the complete isolated package check against the already installed binary, `2.2.5-cmdruid.c72416a6ad`. Report: `/tmp/permission-package-check-ly3b7m/verification.json`. Includes settings persistence across restart, local fixture classifier review after explicit Allow Session evidence, and the bundled companion rendering.

Artifact: `artifacts/cmdcode-opencode-auto-permissions-0.1.0-alpha.1.tgz`.
SHA256: `8528586e158d2f0b1e146e2e6051db9087e7e9eec8c3bbc049d5fdfbc41c872e`.

Installed the exact artifact under `~/.local/share/opencode/local-plugins/auto-permissions-0.1.0-alpha.1` and changed only the package path in the existing global configuration. Verified all eight existing session permission selections and the complete effective server settings were preserved. Backup: `~/.opencode/backups/before-auto-permissions-2026-11-06T23-01-50-996Z`. The previous preview remains available. No binary replacement, background-server restart, remote push or npm publication.

## Custom connection and queued approval fixes — 2026-11-06

Alpha.2 resolves custom connection models from the finished model catalog when needed. This includes providers and model overrides contributed after external plugins by the configuration plugin. Generated connections retain their saved identity and isolated credentials; provider reloads reuse the resolved definition, and removing the source model removes the executable alias on the next lookup. Missing classifier models now produce a specific settings-oriented error.

Allow Session now asks the host to re-evaluate queued requests for the same session and action after storing the explicit approval. The new experimental plugin API preserves the original requesting agent and runs current rules and review hooks. Only approvals settle requests with a one-time reply. Other decisions remain pending; manual/Shadow modes, configured denials, other actions and other sessions do not inherit blanket approval. Requests answered during a model call are not replied to again. The method is exposed through both Effect and Promise SDKs; no HTTP API changed or client generation was required. Older hosts keep handling future remembered approvals and log that a host update is needed for queued rechecks.

Validation:

- The regression fails on the original connection implementation (`allow` expected, `ask` received), then passes with the fix.
- Core permission engine plus connection/session-approval suites: 139 pass, 735 assertions. Ten repetitions: 1,390 pass, 7,350 assertions, 7.78 s.
- All seven affected plugin/Core permission suites: 37 pass, 395 assertions, 6.40 s.
- Complete plugin suite: 39 pass, 272 assertions, 2.87 s. One earlier run during concurrent checks hit an unchanged TUI startup wait; subsequent TUI ten-repeat run passed all 30 cases/190 assertions in 13.80 s.
- Official Core, plugin SDK and permission-plugin TypeScript checks pass. Root `bun run check`: 36/36 tasks pass.
- Exact alpha.2 tarball and rebuilt host passed isolated cold-start/restart and queued-approval checks: `/tmp/permission-package-check-YkVuwi/verification.json`. The classifier call used the saved custom URL; Allow Session caused the queued fixture request to be reviewed and approved. No tool executed or real provider was contacted.
- Alpha.2 connection/persistence/companion checks also pass against the old installed host: `/tmp/permission-package-check-b6pUor/verification.json`. That host lacks queued rechecks.

Plugin artifact SHA256: `305f0d6b3dfdaa906385a1223d196db77239f2ca17333a240c5d277576cf7665`.
Host: `packages/cli/dist/perm-fixes/cli-linux-x64/bin/opencode`, version `2.2.5-cmdruid.permfix.20261106`, including web UI; SHA256 `d73836575253380c551872d2c1d3c270a24ef92dea09f179ad2fa82a4213cfb9`.

Alpha.2 is installed on the live server. Verified the previously missing custom classifier is now available, the full effective settings and ten session permission selections are preserved, and the same five pending requests remain intact. Backup: `~/.opencode/backups/before-auto-permissions-2026-11-06T23-41-06-079Z`. The host update is prepared but not activated because one session is running with those pending approvals; activation requires a server reload. No npm publication.

## Policy, model selection and reset shortcut — 2026-11-06

Version `0.1.0-alpha.3` uses Session Policy and Global Policy, separate Provider and Model controls, and a footer Ctrl+R shortcut instead of repeated reset rows. Reset confirmation names the section and restores configuration/built-in defaults; Escape cancels. From the settings overview the shortcut offers section selection. A provider change commits only after choosing its model/variant; Model directly lists the current provider's models.

Global Policy's Review With selects classifier-only, reviewer-only or combined review. Omitted selection preserves the prior configuration's workflow. Reviewer-only bypasses classifier resolution and generation, retains reviewer Off/Shadow/Automatic and timeout, and records chat assessments. Classifier-only skips chat. Existing combined agreement rules, manual/Shadow policy and configured denials remain intact.

Validation:

- Full plugin suite: 43 pass, 304 assertions. Initial sandboxed execution could not bind the fixture server; the permitted isolated-fixture run passed.
- Six affected Core plugin suites: 35 pass, 396 assertions. The first run caught an internal provider alias leaking into missing-model diagnostics; corrected to retain the configured model name.
- UI/settings suites repeated ten times: 220 pass, 1,230 assertions. Core workflow/settings repeated ten times: 40 pass, 520 assertions. Added missing-model-choice validation assertions: settings suite ten repeats, 30 pass, 280 assertions.
- Official plugin/Core TypeScript checks pass. Root `bun run check`: 36/36 tasks pass.
- Production story inspected at 44×36 and 112×36 through `dev:live`: `/tmp/perm-compact-preview-keWYB5`. Shortened the reset explanation after inspecting its narrow layout.
- Exact package passed isolated activation, settings persistence through restart, saved custom connection, queued Allow Session and packaged companion checks against installed host `2.2.5-cmdruid.permfix.20261106`: `/tmp/permission-package-check-G6uCIY/verification.json`.
- Installed client inspection at both widths includes opening and cancelling the reset confirmation: `/tmp/perm-compact-preview-M5ID5Q`. No live review or approval was generated.

Artifact SHA256: `6bf543958adb4328a068fde874694239b214ace1c2a18f2d0c6e23139b18ddd6`.
Installed at `~/.local/share/opencode/local-plugins/auto-permissions-0.1.0-alpha.3/node_modules/@cmdcode/opencode-auto-permissions`. Backup: `~/.opencode/backups/before-auto-permissions-2026-11-07T00-15-54-219Z`. Full existing effective settings (plus the new derived workflow field), all ten session selections and the server endpoint were verified unchanged. No host replacement/restart, remote push or npm publication.

## Matching session/global policy controls — 2026-11-06

Alpha.4 gives both policy pages exactly three controls, in the same order: Automation Mode (Classifier, Reviewer, Both), Classifier Mode (Manual, Shadow, Approve), and Reviewer Mode (Off, Shadow, Approve). Both is the default; explicit saved choices remain. Review Rules contains action filtering and additional instructions. Session automation overrides are local and reset with the other session choices. Reviewer Mode is configurable separately from its model/connection. Reviewer-only operation uses reviewer mode without an inactive classifier gating it; manual quick presets and combined agreement rules remain. Legacy chat-only preset/mode storage is preserved.

Validation:

- Full plugin suite: 46 pass, 350 assertions. Six Core permission suites: 35 pass, 408 assertions.
- Ten repetitions: UI/settings 240 pass, 1,670 assertions; five Core policy/approval suites 320 pass, 3,550 assertions. Final plugin suite includes the additional legacy chat-baseline regression.
- Official plugin/Core TypeScript checks and root `bun run check` (36/36) pass.
- Exact artifact checked against the installed host using isolated model fixtures, restart persistence, custom connection, queued Allow Session and bundled TUI: `/tmp/permission-package-check-N1Bk9z/verification.json`.
- Production story inspection: `/tmp/perm-compact-preview-S2UACM`, including both three-row policy pages. Live installed-client preview: `/tmp/perm-compact-preview-CsAbvg`. The preview harness was corrected to distinguish the persistent story footer from the current page and to wait for full labels after resizing.

Artifact SHA256: `5b174bcea1ef45c915296874135aecb7eb60477efea7bb20ae356a9abae034b5`. Installed at `~/.local/share/opencode/local-plugins/auto-permissions-0.1.0-alpha.4/node_modules/@cmdcode/opencode-auto-permissions`. Backup: `~/.opencode/backups/before-auto-permissions-2026-11-07T00-51-32-097Z`. All prior effective settings and ten session selections matched after excluding newly exposed policy fields. New fields reflect the prior reviewer mode and default Both. Same host/endpoint; no live review, approval, restart or npm publication.

## Approval scores, percentages and reviewer JSON — 2026-11-06

Alpha.5 compares the classifier's approve probability with the inclusive cutoff. The observed 92.42% score passes 90% despite normalized confidence of 88.63%. A higher confidence cannot rescue a below-threshold approval score. Missing approve scores escalate without chat fallback; deny/escalate routing and agreement rules are unchanged. The legacy `minConfidence` storage field remains 0–1; the menu displays percentages and accepts `90` or `90%`. New history identifies its threshold metric and records provider confidence separately; old history retains its original interpretation.

The selected Maple Gemma reviewer now uses a dedicated `permission-review` model variant with strict JSON Schema output. A fictional public-fetch prompt through the installed host's stateless generate endpoint returned bare JSON accepted by the production ReviewResult schema. No user context was replayed and no live permission request was approved by the verification. Strict rejection of fenced/prose responses remains. The README documents variant configuration for other installations; provider support is required. No host API or binary update.

Validation:

- Full plugin suite: 47 pass, 362 assertions. Focused Core connection/fallback/settings: 7 pass, 117 assertions.
- Ten repetitions of changed plugin routing/component/app suites: 350 pass, 3,340 assertions. Core suites: 70 pass, 1,170 assertions.
- Official plugin/Core TypeScript and root `bun run check` (36/36) pass.
- Exact artifact with installed host: `/tmp/permission-package-check-oDo067/verification.json`; checks isolated installation, restart persistence, custom connection, queued approvals and bundled TUI.
- Production story at 44/112 columns: `/tmp/perm-compact-preview-odtnj1`. The 44-column classifier menu displays the entire setting label and `90%`. Installed-client preview also passed at both widths: `/tmp/perm-compact-preview-56lBGk`.
- Reviewer format verification: `/tmp/perm-json-reviewer-verification.json`. Configuration/settings backup: `~/.opencode/backups/before-json-reviewer-2026-11-07T01-43-50-654Z`.

Artifact SHA256: `77d4059590bec0a7b2a45c61c6eba5d4f328d4d4a0355372f3dfe777e3a50206`. Installed at `~/.local/share/opencode/local-plugins/auto-permissions-0.1.0-alpha.5/node_modules/@cmdcode/opencode-auto-permissions`. Installation backup: `~/.opencode/backups/before-auto-permissions-2026-11-07T01-44-03-954Z`. Full effective settings and all ten session selections preserved during plugin replacement. Reviewer variant is the only deliberate settings change; cutoff stays 90%. Same host/endpoint; no restart or npm publication.

## Provider-independent fenced responses — 2026-11-06

Alpha.6 replaces the Gemma-specific configuration workaround with one shared response parser for reviewer-only and classifier-fallback reviews. It accepts bare JSON or one whole Markdown code block (backticks/tildes, optional JSON label, whitespace and CRLF). Only the outer fence is removed; the original ReviewResult schema still validates the object. Prose, multiple blocks, broken fences, malformed JSON and invalid decision/reason fields escalate. Denial, escalation, fallback agreement and timeout behavior are unchanged.

- Full plugin: 49 pass, 452 assertions. Review suite repeated ten times: 200 pass, 2,560 assertions. Official plugin TypeScript and root check36/36 pass.
- Exact artifact with installed host: `/tmp/permission-package-check-ZDZZNV/verification.json`; isolated install, restart persistence, custom connection, queued approvals and bundled TUI pass.
- Plain `maple/gemma4-31b` generated a fenced response to fictional evidence through the installed host. The production review function parsed it successfully. No live session prompt, permission request or tool execution was submitted.
- Removed the Gemma `permission-review` configuration variant and restored the plain model selection. Preserved all ten sessions' policy selections, accounting for the intended inherited reviewer-model change. Verification: `/tmp/perm-remove-json-variant-verification.json`. Backup: `~/.opencode/backups/before-remove-json-variant-2026-11-07T02-26-49-128Z`.

Artifact SHA256: `addee9059d436922f8020baacc73dedaa32d8f8d3845dfb05ae77ab79bafc468`. Installed at `~/.local/share/opencode/local-plugins/auto-permissions-0.1.0-alpha.6/node_modules/@cmdcode/opencode-auto-permissions`. Installation backup: `~/.opencode/backups/before-auto-permissions-2026-11-07T02-26-37-814Z`. No host replacement/restart, remote push or npm publication. Per-model variants are no longer required for fenced responses.

## Authorization survives compaction — 2026-11-06

Alpha.7 reads original user-authored text through the new host-only `experimental.session.userMessages` API (Effect and Promise). The host reads existing persisted history in chronological order and excludes queued input, staged/committed reverted messages, synthetic messages and summaries. The plugin uses active context for tool inputs/observations and original text for authorization, supplying the same evidence to both evaluators and instructing them to honor later restrictions. No cache or additional persisted records. Existing evidence-budget escalation remains. Hosts without the API escalate with an update-needed explanation. No public Protocol/HttpApi change or generated-client edits.

Validation:

- Plugin: 51 pass, 471 assertions. Seven Core permission/history suites: 36 pass, 418 assertions.
- Ten repeats: review220/2750, host history/permission120/580. Covers repeated compaction, later restrictions, queued input, parent isolation, reopening plugin context, Promise adaptation, staged/cleared/committed reverts and missing/failed host support.
- Official plugin/Core/SDK TypeScript and root `bun run check`36/36 pass. Corrected an older Core fixture still expecting confidence routing after the prior switch to approval scores.
- Exact host/plugin check: `/tmp/permission-package-check-JlPLaA/verification.json`. An imported fixture with two original user messages and a completed compaction has zero user messages in active context; its request auto-approves without an Allow Session example, proving original authorization reaches the compiled host/plugin. Existing restart persistence, custom connection, queued approval and packaged TUI checks pass. No live provider replay or tool execution.

Plugin SHA256: `0b51167d5f24be90020d826a2adad5a8fe787bb25b24208476baff62735a7a30`. Matching host `2.2.5-cmdruid.permhistory.20261107` SHA256: `9d545746689a1ce6a6b72a5dfffafc19127e998ad3b3c396ac1c045c5c9c2db2`, including bundled web UI. Staged at `~/.local/share/opencode/previews/perm-history-20261107/opencode`; plugin active at `~/.local/share/opencode/local-plugins/auto-permissions-0.1.0-alpha.7/node_modules/@cmdcode/opencode-auto-permissions`. Old binary backed up under `~/.opencode/backups/before-host-perm-history-20261107`. Activated with explicit user permission on 2026-11-07 using the managed-service version replacement and terminal handoff. Verified host version/hash, active alpha.7, unchanged complete effective settings and all ten session selections. The CVE session is running and its three original user messages remain available. Threshold remains 90%; reviewer remains plain maple/gemma4-31b. Configuration backup: `~/.opencode/backups/before-auto-permissions-2026-11-07T03-13-46-757Z`. Activation report: `/tmp/perm-history-activation-verification.json`. No model replay or manual permission replies were performed. npm publication remains deferred.

## Question answers and reviewer delegation — 2026-11-07

Alpha.8 supplies both evaluators with original user messages and completed native question-dialog replies through the additive `experimental.session.authorization` host API (Effect and Promise). The host reads only user text and question parts from both supported storage layouts, without hydrating historical tool output/media. It validates question/answer structure, preserves selections and free-text answers with their question/option context, and orders evidence by user-message/answer timestamps. Compaction does not erase this evidence. Queued input, reverted exchanges, incomplete/cancelled/malformed questions and provider-executed results do not authorize requests. Arbitrary tool-output prose remains observation only. Existing `userMessages` consumers remain supported; no database migration or additional cache was introduced.

In Both mode, classifier `escalate` now delegates to the reviewer. Reviewer Approve can resolve it, as it already resolves a below-threshold classifier approval. Explicit classifier denials never reach this path. Reviewer Off/Shadow, classifier Manual/Shadow, configured permission restrictions, invalid output, errors and timeouts retain their existing behavior. Neither the 90% threshold nor provider/model configuration was changed.

Validation:

- Full plugin suite: 52 pass, 492 assertions. Nine affected Core suites: 44 pass, 451 assertions.
- Ten repetitions: changed Core history/routing tests 50 pass, 950 assertions; review tests 230 pass, 2,960 assertions. History tests exercise both inline and separate part storage, answer chronology, later restrictions, compaction, reverts, cancelled questions and the Promise adapter. Routing integration tests cover explicit host denials and all workflow modes for both low-score approvals and classifier escalation.
- Official Core, plugin SDK and auto-permissions TypeScript checks pass. Root `bun run check`: 36/36 tasks pass.
- Exact package and matching compiled host passed isolated verification: `/tmp/permission-package-check-cFzQQt/verification.json`. A compacted question-only fixture supplies authorization to both local model fixtures; classifier escalation followed by reviewer approval produces `allow` and an applied audit record. Existing original-user-history, queued Allow Session, settings restart persistence, custom connection and packaged TUI checks also pass. No real-provider replay or live tool execution was used.

Plugin SHA256: `7e8e5af3a7f86265e4996a7782b46bee1372af59a2841c873e357507f84cfb12`. Host `2.2.5-cmdruid.permanswers.20261107` SHA256: `667f94fbdbb93739fb14b90b9ee0e6070eff4d42ae55c1788796440696437bca`, including web UI. Activated on the existing client after verifying no active sessions or pending requests, using managed-service replacement and terminal handoff. Alpha.8 is active under `~/.local/share/opencode/local-plugins/auto-permissions-0.1.0-alpha.8/node_modules/@cmdcode/opencode-auto-permissions`. Complete settings and all ten session choices match their pre-update snapshots. Threshold remains 90%; reviewer remains plain `maple/gemma4-31b`. Endpoint remains `http://127.0.0.1:49374`.

Host backup: `~/.opencode/backups/before-host-perm-answers-20261107/opencode`. Configuration backup: `~/.opencode/backups/before-auto-permissions-2026-11-07T06-37-40-774Z`. Final activation verification: `/tmp/perm-answers-activation-verification.json`. Existing requests were not replayed; this verifies evidence delivery and routing, not general model accuracy. npm publication remains deferred.
