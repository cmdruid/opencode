# Sudo command review and automatic prompt closing

Make requested commands easier to audit with concise context, syntax highlighting, expandable inspection, and a reason supplied in the tool call. Capture a fresh background for each native prompt. Replace the native “Ctrl+C to close” stage with automatic return to OpenCode after sudo exits and the native helper successfully restores the terminal. Password input and authentication output remain entirely outside OpenCode's JavaScript, RPC, tool results, and model context.

Status: implemented and verified, 2026-11-07. This document authorizes no deployment or publication. Continue in the existing `sudo-wait` worktree, landing on `custom` when requested. The stronger tool description is already edited separately in `index.ts`; preserve it. The timeout fix is committed as `c526689987`.

## Scope and hard cut

- Ship one automatic cleanup path. Remove the final key-reading loop, dismissal instructions, and tests that require a second Ctrl+C. Provide no legacy mode, compatibility toggle, or configurable delay.
- Close after the sudo process has exited and been reaped, including command errors, exhausted authentication attempts, and completed cancellation. Pressing Enter or receiving a server result does not establish that the terminal is ready.
- Keep the command approval dialog before authentication. Escape or Ctrl+C still cancels approval; Ctrl+C during native execution still cancels sudo. No additional dismissal follows completed native cleanup.
- Keep the terminal under native control for the entire sudo invocation, including command execution. Returning the UI while the command continues is outside this change.
- Preserve unbounded plugin waits for approval/authentication, the command timeout after authentication, single-use local requests, output limits, Linux x64 support, and the existing permission checks.
- Preserve refusal to resume after a helper crash or failed terminal cleanup. This is an error path, not a fallback dismissal mode.
- Capture a fresh completed TUI frame for each native prompt so its frozen background reflects the current conversation at handoff.
- Keep the approval UI minimal: useful host/directory context, a short reason, the command, and actions. Omit explanations of sudo, repeated root/shell labels, generic warnings, and instructional decorations. Users already understand the tool.
- Add a required `reason` to the sudo tool input. Keep it ordinary tool-call data, available to any existing consumer of that input. Do not modify, import, depend on, or add an integration with the auto-review plugin.
- Improve command presentation using existing rendering and highlighting facilities. Do not build a shell parser, command simulator, or risk-scoring system.

## Terminal return contract

Use the standard foreground-job lifecycle: wait for the job, restore terminal state and ownership, then resume the caller. GNU documents this lifecycle in its [job-control guide](https://sourceware.org/glibc/manual/latest/html_node/Foreground-and-Background.html). Sudo's [password-reading implementation](https://github.com/sudo-project/sudo/blob/main/src/tgetpass.c) restores terminal settings with input flushing.

The native helper must establish all of these conditions before reporting that OpenCode may resume:

1. No authentication or supervised command process remains able to read from the terminal. Reap sudo after natural completion or cancellation before returning ownership. An unexpected wait failure must not be treated as confirmed termination.
2. OpenCode's renderer and input handling remain suspended. Sudo/PAM reads authentication directly from `/dev/tty`; its output is never captured as command output.
3. Native presentation is restored, unread terminal input is discarded, and saved terminal attributes are restored with `tcsetattr(..., TCSAFLUSH, ...)`. Check syscall results and read back the relevant terminal attributes rather than assuming partial success restored everything. [Terminal API semantics](https://man7.org/linux/man-pages/man3/tcsetattr.3.html)
4. The original foreground process group is restored with `tcsetpgrp` and confirmed with `tcgetpgrp`.
5. The helper exits with its existing cleanup-success status, `0`. This status certifies terminal restoration; the command's exit code remains in the existing result frame and may be nonzero.

Restore presentation and attributes while native code still owns the foreground terminal, then restore ownership. Handle interruption during cleanup without repeating completed destructive steps or resending cancellation to an already reaped child. A failed required restoration operation produces a nonzero helper exit and leaves OpenCode suspended.

Flushing discards input already received. Input delivered after OpenCode resumes belongs to the restored terminal session; this design does not claim to identify arbitrarily delayed password bytes. No quiet-period timer is a security condition, and no new password buffer, JavaScript input filter, or authentication transcript is introduced.

## Implementation sequence

### 1 Establish the baseline

Inspect the worktree, current `custom`, and the existing description edit before making changes. Reconcile only committed upstream work without dropping that edit. Read the repository's unit-test and TUI-test skills before changing their respective tests.

Audit the actual renderer suspend/resume implementation for input listeners, pending key/paste parsing, and diagnostics. Confirm that restoration cannot replay pre-handoff buffered events into the composer or the next approval. Address a demonstrated gap at its owning input boundary; do not add a speculative password scanner or an unrelated input framework.

Exit condition: the terminal ownership and input-resumption path is understood, with a focused regression case for any demonstrated buffering issue.

### 2 Add a reason to the tool call

In `index.ts`, add a required nonblank `reason` string to the sudo tool input schema. Describe it as one concise sentence explaining why the requested operation needs root privileges; cap it at 500 characters. Validate at the tool input boundary and use the resulting typed value inward.

Example tool call:

```json
{
  "command": "systemctl reload example",
  "reason": "Reload the system service to apply the configuration change you requested."
}
```

Include the same reason in the sudo plugin's own `Request` schema in `rpc.ts`, its pending request, and its approval dialog. Update the sudo plugin's callers and fixtures together. This is a direct change to its experimental tool/request contract; do not maintain an alternate input shape or invent a reason for old callers.

The reason is already part of the recorded tool-call input. The existing reviewer reads tool-call inputs through its general evidence path; no special forwarding or permission-metadata addition is needed. Do not change reviewer code, prompts, configuration, or dependencies for this feature. The reason remains the calling agent's explanation, not independent user authorization.

Verify through the real sudo tool registry and its RPC that the supplied reason survives unchanged into the request shown to the user, and that missing/blank reasons are rejected before admission. Keep these tests in the sudo plugin and its existing host fixtures; do not create a test dependency on the reviewer plugin.

Exit condition: `reason` is required by the tool and visible in its own request and UI, with no cross-plugin wiring.

### 3 Make the command easier to inspect

Update `prompt.tsx` and its existing fixtures:

- Keep a compact host/directory header. Do not add “entire command runs as root,” a shell-information row, or explanations of the approval process. The title and tool identity already establish the action.
- Show the supplied reason once as a short sentence above the command. Do not wrap it in an explanatory paragraph or repeat it in another panel. Escape invisible/control characters as for other untrusted display text.
- Use the existing shell highlighter and theme syntax roles to distinguish commands, arguments, strings, variables, and operators. Preserve the command's exact ordering and characters; distinguish visual wraps from actual newlines. Preserve existing invisible-character and backslash escaping. Do not rewrite the command into a different script for display.
- Let long commands use more available terminal height while keeping short commands compact. Provide one expand/collapse action for inspection, preserve scroll position, and show a position indicator only when content extends beyond the viewport. Retain keyboard scrolling and prevent inspection keys or pasted text from approving the request.
- Use simple annotations only where they add information beyond highlighting. Reuse existing token information for a small set of reliable facts, such as redirection, pipelines, or command substitution; show compact details in the expanded view. Do not infer filesystem effects, expand variables, inspect referenced scripts, execute substitutions, or label a command safe. If the existing token data cannot support a fact reliably, omit it rather than add a parser or a misleading regex heuristic.
- Use semantic theme roles and verify light, dark, and custom-theme rendering. Keep error/status colors for actual outcomes, not decoration.

Illustrative compact layout, with shell syntax colored in the actual component:

```text
sudo · server-name
/home/user/project

Reload the system service to apply the requested configuration.

systemctl reload example

Enter approve · Esc cancel · Expand
```

Test the real production component at narrow/wide widths and short terminal heights. Cover short commands, long arguments, multiline commands, quotes and literal operators inside strings, invisible characters, long reasons, expand/collapse, scroll position, and approval/cancellation bindings. Use deterministic highlighter completion when needed. Test that the command sent for execution is unchanged by highlighting, wrapping, inspection, or annotations.

Exit condition: the command and reason are fully inspectable with minimal UI, using existing syntax infrastructure and no new semantic-analysis subsystem.

### 4 Capture a fresh background before handoff

`takeTerminal()` currently calls `presentation(renderer, theme)` before `renderer.suspend()`. Each invocation creates a new snapshot, but `presentation()` reads `currentRenderBuffer` without waiting for pending UI changes to render. A real-renderer fixture reproduces this: changing `OLD conversation` to `NEW conversation` still captures the old text until a new frame completes. This is a render-ordering defect, not a snapshot cache shared across requests.

Update the preparation path in `native.ts` and, if needed, its `tui.tsx` caller:

- Apply the final intended pre-authentication UI state, request a render through the supported renderer API, and await a completed frame containing those changes. An already-running frame that predates the changes is insufficient; account for it explicitly.
- Serialize that completed frame, then suspend the renderer and start the native helper. Perform no terminal readback and never capture a background after authentication has begun.
- Use renderer completion and lifecycle signals instead of sleeps or an assumption that `requestRender()` completes synchronously. Remove temporary listeners on completion, abort, destruction, or handoff failure; cancellation while awaiting a frame must prevent helper launch.
- Keep snapshots local to each handoff and preserve current bounds, text sanitization, theme handling, and native fallback when dimensions change or no usable frame can be obtained. Never substitute an earlier request's snapshot.

Extend `test/presentation.test.ts` and the real handoff fixture: render old text, change it immediately before handoff without manually rendering a second frame, and assert the helper receives the updated text. Repeat across two requests with different conversation content and at narrow/wide sizes. Cover an in-flight frame and cancellation during the wait. A test that manually renders before calling the production preparation path would miss this bug.

Exit condition: every successful handoff captures the latest completed frame after its final UI updates, before suspension and password entry, with no credential-containing readback.

### 5 Replace the native dismissal stage

Change `native/helper.c` and, where needed, `native/screen.h`:

- Route normal completion, authentication failure, cancellation, request disconnect, and handled setup failures through one terminal cleanup path. Track whether a child exists and whether it has been reaped so an early failure cannot return while sudo is still active.
- Remove the final `read(tty, ...)` loop, the Ctrl+C-byte dismissal state, and the “Ctrl+C to close” message. Keep the signal handling used to cancel an active child and the existing job-suspension protection.
- Preserve the existing command-result frame, output isolation, FIFO cleanup, and executable binding through `/proc/<supervisor-pid>/exe`.
- Finish native presentation, flush and restore attributes, restore foreground ownership, and verify the return contract. Make restoration failure distinguishable from a completed command that returned a nonzero status.
- Make any terminal write needed for presentation restoration report failure. Do not add a completion sleep or depend on a terminal screen query.

Exit condition: a completed sudo invocation returns without another keypress; failed restoration cannot report helper success.

### 6 Complete the TUI lifecycle

Change `native.ts`, `tui.tsx`, and `prompt.tsx` only where required:

- Retain the meaning of helper exit `0`: cleanup succeeded. Resume the renderer once, after confirmed native completion, and close the matching dialog once.
- Keep command status separate from terminal status. A command exit of `1` or a command timeout still permits automatic closing when native cleanup succeeded. Display the outcome using the existing tool-result/error path, without copying authentication output into the UI.
- A server `closed` event may arrive before native cleanup. It must not directly resume the renderer, open the next approval, or destroy the active terminal handoff. Cancellation stays effective while sudo runs; a late cancellation after child termination must not corrupt cleanup or overwrite the completed result.
- Advance queued approvals only after the renderer is available and the previous dialog has finished closing. Preserve request/session identity checks so an old completion cannot close a newer dialog.
- Handle route changes, disconnects, and plugin disposal through the same cancellation and native cleanup lifecycle. Preserve the current explicit recovery message when the helper cannot certify restoration.
- Keep approval-stage failures that occur before terminal suspension distinct from failures after native ownership begins. Do not present a “Request closed · Esc dismiss” screen after a successfully completed native handoff.

The reason changes only the sudo plugin's own tool input and request schema. No public HTTP API or generated client change is required by this plan. Do not add a second terminal-ready protocol unless the implementation demonstrates that the existing helper lifecycle is insufficient.

Exit condition: the real loaded plugin returns to a usable conversation automatically, with queued requests processed in order and no stale dialog or input replay.

### 7 Replace and extend the regression coverage

Use the existing production broker, native helper, renderer, and loaded-plugin fixtures. All automated authentication uses fake sudo and dummy credentials; no test runs real privileged commands.

| Case                                                                 | Required result                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Successful command and passwordless sudo                             | Prompt closes and the renderer resumes without a dismissal key.                                                   |
| Nonzero command exit                                                 | Prompt closes; the original exit status reaches the tool result.                                                  |
| Incorrect password followed by retry                                 | OpenCode stays suspended until authentication and sudo execution finish.                                          |
| Exhausted authentication attempts                                    | Native cleanup completes and the prompt closes; authentication text never enters tool results.                    |
| Ctrl+C, tool abort, handoff cancellation, or server disconnect       | The child terminates and is reaped before restoration; no second Ctrl+C is required.                              |
| Command timeout and output flooding                                  | Existing timeout and truncation behavior is preserved; return is automatic.                                       |
| Long approval and authentication waits                               | The prior no-expiration regressions continue to pass.                                                             |
| Stale claim, wrong host socket, or handled setup failure             | No unauthorized command runs; acquired terminal state is cleaned up automatically.                                |
| Helper crash or injected terminal-restoration failure                | No renderer resume, composer input, or success acknowledgement.                                                   |
| Queued requests and reordered server closure events                  | No premature resume, duplicate close, or dismissal of the next request.                                           |
| Conversation changes immediately before handoff and between requests | Each native prompt receives its own fresh pre-authentication frame; aborting a frame wait prevents helper launch. |
| Resize, SSH/tmux, package replacement or unlink                      | Existing supported behavior and executable binding remain intact.                                                 |

In `test/fixture/native.py` and `native.ts`, replace the final guard phase with waiting for verified automatic return. Introduce deterministic test-only synchronization around cleanup to enqueue dummy trailing characters, multiline paste, and escape sequences before the final input flush. Assert those bytes never reach the tool result, RPC, renderer input log, composer, or subsequent approval. After return, send a fresh benign key and prove normal input works.

Inject restoration failures with test-only native wrappers, following the existing clock-wrapper approach. Cover `tcsetattr`/readback and foreground-ownership restoration, plus helper death while authentication is active. Do not add production environment switches or weaken the existing credential-isolation assertions.

Update `test/tui.test.tsx` and its fixtures to cover the loaded plugin's completion lifecycle, not just `takeTerminal` in isolation. Update `test/fixture/overlay.py` to wait for automatic return at 40×16, 80×24, and 120×40, without sending the old dismissal key. Keep password retry and authentication-output isolation coverage.

### 8 Verify and document the replacement

Update `README.md`, `native/README.md`, and applicable release instructions to describe the required reason, command inspection, and automatic return after sudo finishes. Update every documented sudo call to include a reason. Remove obsolete dismissal instructions and explain that helper success certifies cleanup independently of command success.

Run from `packages/plugins/sudo`:

```sh
bun run build
bun test --timeout 30000
bun run typecheck:tsc
```

Repeat the changed native and TUI lifecycle tests ten times, including a run alongside the package suite. Use controlled events rather than timing sleeps for security assertions. Run `bun run check` from the worktree root, plus formatting and `git diff --check`.

Pack the plugin and run its artifact verification with `OPENCODE_SUDO_TARBALL` pointing at the exact archive. Confirm that the archive contains the rebuilt native helper, matching checksum, and compiled TUI, and that it loads outside the workspace. Exercise automatic closing through a helper compiled from the packed native source with fake sudo; retain verification of the shipped binary's integrity and entrypoints. Record the distinction between the fake-sudo behavior test and the production artifact checks.

Exit condition: all listed scenarios pass; no final native key-reading loop or old dismissal instruction remains; the package and source implementation agree.

## Landing and activation

Keep the description edit identifiable separately from the automatic-closing change. Land one complete automatic-closing implementation on `custom` with its tests and documentation; do not temporarily ship two runtime paths. Commit and push only when authorized.

Build and verify the native binary/checksum and compiled TUI together before activating the updated plugin. Switch the complete verified artifact while no native sudo handoff is active; do not overwrite a live helper as part of testing. Preserve sessions, plugin settings, credentials, and sudo policy. Roll back by restoring the previous complete artifact rather than introducing a runtime legacy mode.

Publishing to npm, creating a release tag, dispatching a release workflow, and restarting or replacing the live service are separate actions requiring the user's requested scope. Planning this feature performs none of them.

## Implementation notes and verification

The required reason remains ordinary sudo tool input and its own RPC request data; permission metadata and the reviewer plugin are unchanged. Command highlighting uses the host's existing shell parser and syntax roles. Highlight ranges are mapped from the original command to the escaped display, so escaped quotes cannot change the coloring of literal operators. No semantic annotations were added: the highlighter's generic token spans do not provide the structural facts needed without additional shell analysis.

Native cleanup now reaps sudo, restores presentation, restores attributes with input flushing and readback, then restores and verifies foreground ownership. Cleanup blocks late cancellation signals. The renderer also discards its unread JavaScript stream buffer before resuming: a negative-control test demonstrated that omitting this step leaks dummy buffered input into raw-input diagnostics. A second negative-control test detects incorrect quote coloring without the original-command range mapping.

Validation covers fake-sudo PTYs, injected attribute/readback/foreground failures, authentication retries, nonzero command exit, long waits, cancellation, timeout/flood, package replacement/unlink, trailing paste and fresh input after return; loaded-plugin queues at 40×16 and 100×30; fresh successive/in-flight frames and aborted waits; command inspection in light, dark, and custom themes. Isolated tmux checks passed at 40×16, 80×24, and 120×40. Changed suites were repeated ten times, including alongside the full suite. The exact packed artifact was checked and cleanly installed outside the workspace; packed native source was exercised with fake sudo separately from shipped-binary integrity checks. No real sudo credentials or privileged commands were used, and no live plugin was activated.

Final results: 67/67 package tests, 36/36 repository check tasks, official package TypeScript, formatting and diff checks passed. Repeated suites passed (540 initial lifecycle/frame/review cases, 210 final layout cases, 150 final highlighting cases); all 26 packed-native-source cases passed. Logs are under `/tmp/sudo-*.log`; the review archive is `/tmp/sudo-auto-close-artifact-ga70iN/cmdcode-opencode-safe-sudo-0.1.0.tgz`. The user authorized committing and activating this implementation. Landing and live activation are recorded in the workstream checkpoint.
