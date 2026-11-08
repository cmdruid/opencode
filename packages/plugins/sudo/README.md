# Safe sudo for OpenCode

A dedicated `sudo` tool for OpenCode v2. **OpenCode never asks for or transports the sudo password.** Its TUI hands the terminal to a small native supervisor; system sudo reads authentication directly from `/dev/tty`. OpenCode receives only the command's output, after authentication.

## Installation

The release package installs like an ordinary OpenCode plugin. It includes its native helper: **no separate helper installation, compiler, shell commands, sudoers edits, or setup password prompt.** Install/enable the package through OpenCode's normal plugin configuration or plugin manager.

Enable the package after its first publication:

```json
{
  "plugins": ["@cmdcode/opencode-safe-sudo"]
}
```

The TUI discovers the package's TUI entry normally. This release supports **Linux x64 and macOS arm64**, with the TUI running on the same host as the server. Linux retains SSH/tmux support; see the macOS environment notes below. The archive includes a static Linux helper and a macOS helper linked against the system library. There are no installation lifecycle hooks and no downloads or compilation at first use. Desktop/web, other operating systems/architectures, remote-machine TUIs, and interactive root commands are unsupported.

For a source checkout only, maintainers run `bun run build` before loading its directory as a local plugin. End users receive the already built helper in the published package. `bun pm pack` requires both platform helpers to be built and assembled first; `prepack` verifies them and compiles the TUI. See [RELEASING.md](RELEASING.md) for native builds and archive verification. Publishing is a separate action.

## Usage

The agent calls the tool with `command`, a required `reason` (one nonblank sentence, up to 500 characters), optional `workdir`, and optional `timeout` in milliseconds. Omit a leading `sudo`:

```json
{
  "command": "systemctl reload example",
  "reason": "Reload the system service to apply the requested configuration.",
  "timeout": 120000
}
```

OpenCode checks the `sudo` permission action first. Then, in the requesting session:

1. Review the host, directory, reason, and highlighted command. Tab expands/collapses the view; PageUp/PageDown/Home/End scroll. Line numbers distinguish actual newlines from visual wraps. Invisible characters and backslashes are escaped. Enter approves; Escape cancels.
2. System sudo prompts directly in a native panel over a fresh frozen OpenCode view. `sudo -k` requires fresh authentication unless sudoers specifies passwordless access.
3. OpenCode returns automatically after sudo exits and native cleanup succeeds, including command errors and cancellation. Ctrl+C cancels an active invocation; Ctrl-Z is disabled during native ownership. If the helper crashes or cannot restore the terminal, OpenCode remains suspended; close that terminal and restart.

Short reviews remain compact; longer content uses the available height and shows a scroll position only when needed. The reason is the agent's explanation and is ordinary tool-call input, with no special reviewer integration. Highlighting does not change the command sent for execution or infer its effects.

The native panel occupies the bottom eight rows on normal-sized terminals and uses the current theme's dialog colors. Each handoff waits for a fresh completed frame before suspension. Its bounded ASCII snapshot preserves the upper part of OpenCode; unavailable snapshots use a branded native screen. Long sudo/PAM messages scroll below the heading. Resizing during authentication releases the panel's scroll region without reading or reconstructing the password prompt. Very small terminals use full-screen output.

There is no password RPC, password form, or password state in JavaScript. Authentication stdout/stderr stay on the terminal as well, since PAM messages can contain sensitive text. Commands run in `/bin/sh` with `/dev/null` stdin, a new session, and no controlling terminal. Only their stdout/stderr enter the tool result; output is limited to the last 65536 characters.

The agent waits for your response: pending approval requests and native authentication have no plugin-imposed deadline. System sudo still enforces its own authentication policy. The command timeout defaults to two minutes and starts only after authentication succeeds. Explicit cancellation, plugin shutdown, or a native helper disconnect ends the pending request. Cancellation and command timeout terminate the command through sudo; neither rolls back completed operations. A server result cannot resume the terminal before native cleanup finishes.

## macOS authentication

The macOS build targets Apple Silicon on macOS 15 or later. The release workflow verifies the same archive on native macOS 15 and 26 runners; those checks must pass before release. Human password and Touch ID success were observed on macOS 26.4.1. Intel Macs and Linux arm64 are unsupported. The TUI and server must run on the same host.

Authentication belongs to system sudo/PAM. Password authentication works without plugin-specific system configuration. If the machine already enables sudo Touch ID, the plugin uses it through the same native handoff. The plugin does not install PAM modules or change sudoers.

For optional Touch ID setup, an administrator can enable Apple's `auth sufficient pam_tid.so` entry in `/etc/pam.d/sudo_local`, preserving existing contents and the system password fallback. This is a system sudo setting affecting every caller, not a plugin preference. Check plain `/usr/bin/sudo -k /usr/bin/id -u` in the same terminal before diagnosing a plugin failure. Never give your password to OpenCode.

In the tested `herdr` 0.9.0 session, both stock sudo and this plugin fell back to a password; both used Touch ID in a direct terminal outside `herdr`. The exact session restriction remains undiagnosed. The plugin follows system authentication policy, including cancellation and fallback; it does not promise that dismissing the biometric dialog aborts the command. Ctrl+C cancels the active native invocation. macOS tmux/SSH behavior still needs environment-specific validation.

## Security boundary

The confidentiality property is deliberately narrow: **credentials entered at the native sudo prompt do not pass through OpenCode's input parser, JavaScript state, RPC, session storage, tool results, or model context.** There is no filtering or redaction step on which this depends.

The supervisor takes the terminal foreground process group while OpenCode's renderer is suspended. Linux disables echo before authentication and preserves no-echo mode afterward. macOS lets system sudo/PAM manage password echo so the Touch ID dialog can receive focus, then disables echo for cleanup after sudo exits. Both platforms flush terminal input before returning ownership. The supervisor connects to a private per-request Unix socket and can claim each request only once. A hostname comparison or shared filesystem is insufficient to authorize a handoff. The helper is launched from the installed plugin with a minimal environment, executable-mode checks, and a checksum check for damaged or mixed package assets. On Linux, sudo executes `/proc/<supervisor-pid>/exe` after authentication. On macOS, before suspending the renderer, the plugin copies checksum-verified helper bytes into a private temporary directory with executable mode 0500. The supervisor and post-authentication invocation use this independent copy, which is retained through native completion and removed afterward. Both paths preserve the approved helper through package replacement or removal; they do not fall back to a changed package pathname.

The installed package (including its native binary and checksum) is trusted code, just like OpenCode and its other plugins. The checksum is an integrity check, not protection against an attacker who can change the package and its checksum together. This release does not require root-owned package files or a system installation.

This is not an absolute guarantee against a compromised OS, terminal/SSH/tmux, sudo/PAM, native helper, OpenCode installation, or other same-user code. Those remain trusted. A user-approved arbitrary root command can also compromise the machine. Terminal/session recorders and configured sudo/PAM audit behavior are outside the plugin's control. Passwords entered in chat, tool arguments, the approval dialog, or before the system sudo prompt are outside this protected flow. Never send a password to the agent.

See [native/README.md](native/README.md) for the process boundary. Installing the plugin makes no system-wide privileged changes.

## Verification

From this package: `bun run build`, `bun typecheck`, `bun run typecheck:tsc`, and `bun test --timeout 30000`. The archive test requires both platform helpers to be assembled first; see [RELEASING.md](RELEASING.md). From the repository root: `bun run check`.

Tests exercise the real tool/RPC registry, loaded TUI plugin, approval scrolling at narrow/wide sizes, private socket permissions, single-use claims, malformed frames, and cancellation. Native tests require Python 3, a C compiler, and real Unix pseudo-terminals. They run the production broker, renderer, handoff code, and native helper with an unprivileged fake sudo. Dummy credentials are deliberately printed on both authentication streams to prove they do not reach tool output; raw-input diagnostics are enabled to check the renderer boundary. They also cover passwordless execution, authentication failure, interrupted input, delayed authentication, timeouts, continuous output, stale/remote claims, Ctrl-Z, leftover input, helper crashes, and package replacement/removal during authentication. A packaging test extracts the actual release archive and verifies both plugin entrypoints, executable availability, and rejection of a damaged checksum. They never use real credentials or execute real sudo. Human checks confirmed password authentication, direct-terminal Touch ID with automatic dialog focus, and successful password fallback after cancelling Touch ID on macOS 26.4.1. Additional sudo/PAM policies and SSH setups should be checked on the systems being supported.

## Terminal return

The flow is **OpenCode review → native sudo authentication and execution → automatic return**. After reaping sudo, the helper restores presentation, discards unread terminal input while restoring attributes with `TCSAFLUSH`, reads back those attributes, and restores and verifies foreground ownership. Exit zero certifies terminal cleanup independently of the command's exit status. JavaScript discards any unread stream buffer before resuming the renderer; no password inspection or completion delay is involved.

Requests wait behind other dialogs and suspended editor handoffs. Queued requests retain separate reviews. A server `closed` event may precede terminal restoration; the next review opens only after the helper finishes, the renderer resumes, and the previous dialog closes. Route changes and plugin disposal cancel active native work through the same cleanup path.

Regression coverage includes injected terminal-restoration failures, a deterministic cleanup barrier with trailing dummy input and paste sequences, and a loaded-plugin PTY test with early server closure and queued approvals. Fresh-frame tests cover successive requests, an in-flight frame, and cancellation. For an isolated real-authentication check, run `bun --preload @opentui/solid/preload script/manual.ts` in your own terminal without input diagnostics or recording. This requests only `/usr/bin/id -u` and exits after returning the result. Use `python3 test/fixture/manual.py success` (also `slow`, `cancel`, and `review-cancel`) for the same runner with fake sudo and dummy input.

Run `python3 test/fixture/overlay.py` for the isolated fake-sudo tmux regression at 40×16, 80×24, and 120×40.

## Releasing

See [RELEASING.md](RELEASING.md) for archive verification, the first npm publish, trusted publishing setup, and release tags. The npm name is `@cmdcode/opencode-safe-sudo`; the internal plugin ID remains `experimental.sudo`.
