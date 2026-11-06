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
