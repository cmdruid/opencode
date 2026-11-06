# Safe sudo for OpenCode

A dedicated `sudo` tool for OpenCode v2. **OpenCode never asks for or transports the sudo password.** Its TUI hands the terminal to a small native supervisor; system sudo reads authentication directly from `/dev/tty`. OpenCode receives only the command's output, after authentication.

## Installation

The release package installs like an ordinary OpenCode plugin. It includes its native helper: **no separate helper installation, compiler, shell commands, sudoers edits, or setup password prompt.** Install/enable the package through OpenCode's normal plugin configuration or plugin manager.

The package is configured for its first release, **0.1.0**, and is not yet published. After publication, enable it with:

```json
{
  "plugins": ["@cmdcode/opencode-safe-sudo"]
}
```

The TUI discovers the package's TUI entry normally. The initial release supports **Linux x64**, including SSH/tmux with the TUI running on the same host as the server. The helper is statically linked and included in the release archive. There are no installation lifecycle hooks and no downloads or compilation at first use. Desktop/web, other operating systems/architectures, remote-machine TUIs, and interactive root commands are unsupported.

For a source checkout only, maintainers run `bun run build` before loading its directory as a local plugin. End users receive the already built helper in the published package. `bun pm pack` builds the helper at packaging time through `prepack`; publishing is a separate action. Keep release compilation on Linux x64 with a static C toolchain.

## Usage

The agent calls the tool with `command`, optional `workdir`, and optional `timeout` in milliseconds. Omit a leading `sudo`:

```json
{ "command": "id -u", "timeout": 120000 }
```

OpenCode checks the `sudo` permission action first. Then, in the requesting session:

1. Review the server, directory, and command in OpenCode. PageUp/PageDown/Home/End scroll long commands. Invisible characters and backslashes are escaped. **Do not type a password in this dialog.** Enter approves; Escape cancels.
2. System sudo prompts directly in a native panel over a frozen OpenCode view, without a second confirmation. Only type your password when sudo prompts. `sudo -k` requires fresh authentication unless sudoers specifies passwordless access.
3. After completion, authentication failure, interruption, or cancellation, press **Ctrl+C** to return. Until then, native code discards input with echo disabled. Ctrl-Z is disabled during native ownership. If the helper crashes or cannot restore the terminal, OpenCode remains suspended; close that terminal and restart.

The review is 60 columns wide (or fits the terminal), with a content-sized command area capped at six rows. Scroll hints appear only for overflowing commands. The native panel occupies the bottom eight rows on normal-sized terminals and uses the current theme's dialog colors. A bounded, sanitized snapshot preserves the upper part of OpenCode; unavailable snapshots use a branded native screen. The snapshot is ASCII-only, so non-ASCII background characters appear as spaces; command review in OpenCode retains Unicode with invisible controls escaped. Long sudo/PAM messages scroll below the heading. Resizing during authentication releases the panel's scroll region for ordinary terminal output, without reading or reconstructing the password prompt. Very small terminals use full-screen output. These are presentation fallbacks; input remains exclusively native.

There is no password RPC, password form, or password state in JavaScript. Authentication stdout/stderr stay on the terminal as well, since PAM messages can contain sensitive text. Commands run in `/bin/sh` with `/dev/null` stdin, a new session, and no controlling terminal. Only their stdout/stderr enter the tool result; output is limited to the last 65536 characters.

The command timeout defaults to two minutes and starts after authentication. Pending requests and authentication have bounded lifetimes; the server allows five minutes plus the command timeout for a handoff. Cancellation and timeout terminate the command through sudo; neither rolls back completed operations. The native guard remains until dismissed even when the server has closed the request.

## Security boundary

The confidentiality property is deliberately narrow: **credentials entered at the native sudo prompt do not pass through OpenCode's input parser, JavaScript state, RPC, session storage, tool results, or model context.** There is no filtering or redaction step on which this depends.

The supervisor takes the terminal foreground process group while OpenCode's renderer is suspended. It disables echo before authentication, preserves no-echo mode afterward, and flushes terminal input before returning ownership. It connects to a private per-request Unix socket and can claim each request only once. A hostname comparison or shared filesystem is insufficient to authorize a handoff. The helper is launched from the installed plugin with a minimal environment, executable-mode checks, and a checksum check for damaged or mixed package assets. After authentication, sudo executes `/proc/<supervisor-pid>/exe`, keeping execution bound to the running native image through package replacement or removal. There is no fallback to a changed package pathname. The supervisor stays alive until sudo exits.

The installed package (including its native binary and checksum) is trusted code, just like OpenCode and its other plugins. The checksum is an integrity check, not protection against an attacker who can change the package and its checksum together. This release does not require root-owned package files or a system installation.

This is not an absolute guarantee against a compromised OS, terminal/SSH/tmux, sudo/PAM, native helper, OpenCode installation, or other same-user code. Those remain trusted. A user-approved arbitrary root command can also compromise the machine. Terminal/session recorders and configured sudo/PAM audit behavior are outside the plugin's control. Passwords entered in chat, tool arguments, the approval dialog, or before the system sudo prompt are outside this protected flow. Never send a password to the agent.

OpenCode's `!` shell mode is useful precedent for command execution, but not authentication: it sends a command through `session.shell`, closes stdin, and captures output. The editor integration provides the renderer suspend/resume API. Neither alone establishes the native foreground ownership and input flushing required here.

See [native/README.md](native/README.md) for the process boundary. Installing the plugin makes no system-wide privileged changes.

## Verification

From this package: `bun run build`, `bun typecheck`, `bun run typecheck:tsc`, and `bun test --timeout 30000`. From the repository root: `bun run check`.

Tests exercise the real tool/RPC registry, loaded TUI plugin, approval scrolling at narrow/wide sizes, private socket permissions, single-use claims, malformed frames, and cancellation. Native tests require Python 3, a C compiler, and real Unix pseudo-terminals. They run the production broker, renderer, handoff code, and native helper with an unprivileged fake sudo. Dummy credentials are deliberately printed on both authentication streams to prove they do not reach tool output; raw-input diagnostics are enabled to check the renderer boundary. They also cover passwordless execution, authentication failure, interrupted input, delayed authentication, timeouts, continuous output, stale/remote claims, Ctrl-Z, leftover input, helper crashes, and package replacement/removal during authentication. A packaging test extracts the actual release archive and verifies both plugin entrypoints, executable availability, and rejection of a damaged checksum. They never use real credentials or execute real sudo. Real sudo/PAM policy variants and live SSH/tmux sessions still need manual verification before release.

## Existing implementations reviewed

- [opencode-sudo-popup](https://github.com/uvindusl/opencode-sudo-popup): a Linux GJS/GTK4/libadwaita askpass popup requiring a graphical display. Its inspected implementation watches `bash`, while this checkout uses `shell`, and shares `/tmp/opencode-sudo-reason` between requests.
- [OpenCode PR #38640](https://github.com/anomalyco/opencode/pull/38640): a broader PTY/SecureInput proposal, closed without merging at the time of review. It is not an installable sudo plugin.

The local Pi extension informed the dedicated-tool interaction. This implementation uses native sudo authentication instead of collecting a password in the harness.

## UI implementation and spike results

The approved flow is **OpenCode review → native sudo authentication → Ctrl+C to return**. Permission policy is unchanged. The user selected retaining OpenCode's review and removing the native duplicate, avoiding an automatic terminal takeover and retaining accessible long-command review. Ctrl+C avoids the Escape-prefix ambiguity of arrow keys. During authentication or execution it cancels; after sudo exits, a new Ctrl+C closes the native window. The final guard reads this key directly with terminal signal generation disabled, so an earlier cancellation signal cannot close it.

The screen-preservation spike uses the public renderer buffer API before suspension. A bounded one-way pipe sends sanitized display text and numeric semantic theme colors to native code; it closes before sudo is forked. It contains no command authority or authentication data. Only the private request socket supplies the command to execute. No terminal readback, password widget, JavaScript PTY relay, or authentication-output capture is involved.

The native panel uses a terminal scroll region, with direct sudo/PAM stdout and stderr. This region is presentation, not a security sandbox for trusted PAM output. No cursor queries are sent during authentication. Resize uses the terminal size ioctl and falls back to full-screen output. The final no-echo guard, input flush, foreground restoration, and normal-exit-only resume remain mandatory.

Requests wait behind other OpenCode dialogs and suspended editor handoffs. Only the requesting session opens its review. A route change, request closure, or dismissal aborts pending helper preflight before terminal acquisition; the broker cancels an already claimed request. Queued requests retain separate explicit reviews, and stale or competing claims cannot authenticate twice.

Automated evidence:

- Real-renderer/PTY tests exercise native ownership, direct authentication streams, dummy credential isolation, success/NOPASSWD/failure, cancellation, Ctrl-C/Ctrl-Z, timeouts, output flooding, stale/remote claims, delayed authentication, package replacement/unlink, resize, crash, and escape/paste tails. Authentication Ctrl+C must leave the guard open until another Ctrl+C; the removed native-decline scenario is covered by OpenCode review cancellation tests.
- An isolated tmux demonstration at 40×16, 80×24, and 120×40 preserves the frozen conversation and heading through long authentication messages. Reproduce with `python3 test/fixture/overlay.py` when tmux is installed. It compiles fake sudo and uses dummy input only.
- Loaded TUI tests cover queued reviews and deferral behind dialogs/editor suspension. Presentation tests cover light/dark colors, ASCII sanitization, and the monochrome/no-frame fallback. Packaging tests verify the actual bundled helper and entrypoints.

Manual acceptance remains owner-driven: try harmless `id -u`, a wrong password, Ctrl-C, Ctrl+C return, and resize in the actual TUI, including an SSH session. Automated fixtures never execute real sudo. Run development clients with `bun run dev:live` so they do not replace the elected server.

## Releasing

See [RELEASING.md](RELEASING.md) for archive verification, the first npm publish, trusted publishing setup, and release tags. The npm name is `@cmdcode/opencode-safe-sudo`; the internal plugin ID remains `experimental.sudo`.
