# Native authentication boundary

OpenCode must not collect, forward, buffer, or serialize the sudo password. The JavaScript plugin handles command metadata and command results only. This is a structural boundary, not a claim that a compromised operating system or terminal cannot steal a password.

The server creates a private, per-request Unix socket. The native supervisor takes the terminal, then connects locally and claims the request before permitting authentication. Failed claims enter the native dismissal guard. A hostname match or shared filesystem is not sufficient: an actual local Unix socket connection is required. A TUI running on a different machine must be run on the server through SSH instead.

After the TUI suspends input, the supervisor takes the terminal foreground process group, disables echo, and claims the same immutable request that the user approved in OpenCode. The duplicate native command confirmation is removed. Only `/usr/bin/sudo` reads the authentication input, directly from `/dev/tty`. Its stdout and stderr also go directly to the terminal; PAM conversation output is never a tool result.

After authentication, a second mode of the installed helper redirects command output into a private FIFO, starts the command in a new session without a controlling terminal, and supplies `/dev/null` as stdin. The supervisor forwards only that FIFO's bytes to the server. Completion, cancellation, and authentication failure leave an echo-disabled native guard on screen until the user presses Ctrl+C. The supervisor flushes terminal input before restoring foreground ownership. OpenCode resumes only after the supervisor exits normally.

The release package includes a static Linux x64 native executable. No root installation, setuid bit, install hook, or end-user compiler is required. The package is trusted code, as are OpenCode's JavaScript plugin files. A checksum catches damaged/mixed assets; it is not an independent trust anchor against someone who can replace the whole package.

The native supervisor builds `/proc/<its-own-pid>/exe` before forking sudo and keeps running through sudo completion. Sudo executes that running image after authentication; replacing or deleting the package pathname cannot substitute another executable for that handoff. Linux documents this executable reference in [proc_pid_exe(5)](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html). Proc access failures fail closed. The post-authentication entry still requires root and refuses setuid/setgid invocation. A test-only build substitutes unprivileged fake sudo and is never released.

Trusted components remain the operating system, terminal/SSH/tmux, sudo/PAM, installed plugin and bundled native helper, OpenCode code, and the user-approved root command. Killing or compromising these components is outside the confidentiality guarantee. Passwords typed into the chat composer or before the native sudo prompt are outside the flow.

The native panel receives only a bounded sanitized pre-authentication snapshot and numeric theme colors on a one-way descriptor, which is closed before forking sudo. It never reads the terminal screen. Resize uses ioctl, resets scrolling margins, and leaves all password input to sudo. The snapshot can be absent without weakening terminal custody. Escape sequences and bracketed paste do not dismiss the final guard.

Ctrl+C cancels while sudo is active. Only after sudo has exited does the final guard disable ISIG and accept the Ctrl+C byte as dismissal. An earlier SIGINT cannot satisfy that read. Terminal input is flushed at the transition and again before restoring OpenCode.
