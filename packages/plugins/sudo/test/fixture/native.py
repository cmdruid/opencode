"""Real PTY, production broker/renderer/handoff, unprivileged substitute for sudo. No actual credentials."""
import hashlib
import fcntl
import struct
import termios
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

package = pathlib.Path(__file__).resolve().parents[2]
release = pathlib.Path(os.environ.get("SUDO_PACKAGE_ROOT", str(package)))
scenario = sys.argv[1]
with tempfile.TemporaryDirectory(prefix="sudo-pty-test-") as directory:
    temporary = pathlib.Path(directory)
    helper = temporary / "helper"
    fake = temporary / "fake-sudo"
    fake.write_text('#!' + sys.executable + '''
import os, sys, termios
scenario = ''' + repr(scenario) + '''
fd = os.open("/dev/tty", os.O_RDWR)
original = termios.tcgetattr(fd)
if sys.platform == "darwin":
    assert original[3] & termios.ECHO, "Touch ID must start with inherited echo enabled"
if scenario != "nopasswd":
    password_mode = termios.tcgetattr(fd)
    password_mode[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(fd, termios.TCSAFLUSH, password_mode)
    os.write(fd, b"FAKE_AUTH_READY:")
    password = bytearray()
    while True:
        ch = os.read(fd, 1)
        if ch in (b"\\n", b"\\r", b""): break
        password.extend(ch)
    # A PAM conversation may write sensitive text on either stream: neither may be captured.
    os.write(1, b"AUTH_STDOUT:" + password + b"\\n")
    os.write(2, b"AUTH_STDERR:" + password + b"\\n")
if scenario == "retry":
    os.write(fd, b"FAKE_AUTH_RETRY:")
    password = bytearray()
    while True:
        ch = os.read(fd, 1)
        if ch in (b"\\n", b"\\r", b""): break
        password.extend(ch)
    os.write(2, b"RETRY_STDERR:" + password + b"\\n")
termios.tcsetattr(fd, termios.TCSAFLUSH, original)
os.close(fd)
if scenario == "failure": sys.exit(1)
args = sys.argv[sys.argv.index("--") + 1:]
os.execv(args[0], args)
''')
    fake.chmod(0o700)
    flags = [
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DOPENCODE_SUDO_TEST",
        f'-DSUDO_PATH="{fake}"', f'-DTEST_CLEANUP_PATH="{temporary}/cleanup"',
        f'-DTEST_FAILURE="{scenario}"',
        *([f'-DTEST_CLOCK_PATH="{temporary}/clock"'] if scenario == "long-auth" else []),
    ]
    wrappers = ["tcsetattr", "tcgetattr", "tcsetpgrp", "tcgetpgrp"]
    if scenario == "long-auth": wrappers += ["clock_gettime", "poll"]
    source = pathlib.Path(os.environ.get("SUDO_NATIVE_SOURCE", str(package / "native"))) / "helper.c"
    # Rename only the helper's references; wrapper definitions call the real libc symbols.
    # This also works with Apple's linker, which has no GNU --wrap option.
    subprocess.run([*flags, *[f"-D{name}=__wrap_{name}" for name in wrappers], "-c",
                    str(source), "-o", str(temporary / "helper.o")], check=True)
    subprocess.run([*flags, *[f"-D__real_{name}={name}" for name in wrappers],
                    str(temporary / "helper.o"), str(package / "test/fixture/cleanup.c"),
                    *([str(package / "test/fixture/clock.c")] if scenario == "long-auth" else []),
                    "-o", str(helper)], check=True)
    pathlib.Path(str(helper) + ".sha256").write_text(hashlib.sha256(helper.read_bytes()).hexdigest())
    if scenario == "loaded":
        bundle = temporary / "plugin"
        bundle.mkdir()
        for name in ("package.json", "index.ts", "rpc.ts", "requests.ts", "tui.js"):
            shutil.copy2(release / name, bundle / name)
        (bundle / "node_modules").symlink_to(package / "node_modules")
        binary = bundle / ("native/bin/darwin-arm64" if sys.platform == "darwin" else "native/bin/linux-x64")
        binary.mkdir(parents=True)
        shutil.copy2(helper, binary / "opencode-sudo-tty")
        (binary / "opencode-sudo-tty.sha256").write_text(hashlib.sha256(helper.read_bytes()).hexdigest())
    pid, terminal = pty.fork()
    if pid == 0:
        if scenario == "loaded": os.environ["TEST_UI_WIDTH"] = sys.argv[2] if len(sys.argv) > 2 else "100"
        os.environ["OTUI_STDIN_LOG"] = str(temporary / "stdin.log")
        if scenario == "diagnostics":
            os.environ["OTUI_DEBUG"] = "1"
            os.environ["OTUI_NATIVE_INPUT_SHADOW"] = "1"
        os.execv(shutil.which("bun"), ["bun", "--preload", "@opentui/solid/preload", str(package / ("test/fixture/loaded.ts" if scenario == "loaded" else "test/fixture/native.ts")), directory, str(helper), scenario])
    slave_path = f"/proc/{pid}/fd/0"
    if sys.platform == "darwin":
        slave_path = fcntl.ioctl(terminal, 0x40807453, bytes(128)).split(b"\0", 1)[0].decode()
    transcript = bytearray()
    phase = 0
    status = None
    native_group = None
    retried = False
    command_interrupted = False
    deadline = time.monotonic() + 15
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([terminal], [], [], 0.02)
            if readable:
                try:
                    data = os.read(terminal, 65536)
                except OSError:
                    break
                if not data: break
                transcript.extend(data)
            if phase == 0 and b"FIXTURE_READY" in transcript:
                os.write(terminal, b"\r" if scenario == "loaded" else b"r")
                phase = 1
            if phase == 1 and b"System sudo" in transcript:
                native_group = os.tcgetpgrp(terminal)
                assert native_group > 0 and native_group != pid, "native helper did not take foreground ownership"
                if scenario == "suspend": os.killpg(native_group, signal.SIGTSTP)
                phase = 2
            if phase == 2 and b"FAKE_AUTH_READY:" in transcript:
                if scenario == "crash":
                    os.killpg(native_group, signal.SIGKILL)
                    phase = 4
                    continue
                if scenario == "long-auth":
                    (temporary / "clock").touch()
                    if not (temporary / "clock.observed").exists(): continue
                if scenario == "resize":
                    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 16, 40, 0, 0))
                    os.killpg(native_group, signal.SIGWINCH)
                if scenario == "replace":
                    helper.rename(temporary / "original")
                    helper.write_text("#!/bin/sh\nexit 99\n")
                    helper.chmod(0o755)
                if scenario == "unlink": helper.unlink()
                if scenario == "overwrite":
                    try:
                        helper.write_text("#!/bin/sh\nexit 99\n")
                        helper.chmod(0o755)
                    except OSError as error:
                        # Linux pins the running file and rejects writes with ETXTBSY.
                        if sys.platform != "linux" or error.errno != 26: raise
                if scenario == "slow-auth": time.sleep(0.25)
                if scenario in ("cancel", "handoff-cancel"):
                    os.write(terminal, b"DUMMY_NATIVE_AUTH_PASSWORD")
                    (temporary / "cancel").touch()
                elif scenario == "interrupt":
                    os.write(terminal, b"DUMMY_NATIVE_AUTH_PASSWORD\x03")
                else:
                    os.write(terminal, b"DUMMY_NATIVE_AUTH_PASSWORD\r")
                phase = 3
            if scenario == "retry" and not retried and b"FAKE_AUTH_RETRY:" in transcript:
                os.write(terminal, b"DUMMY_NATIVE_AUTH_PASSWORD\r")
                retried = True
            if scenario == "command-interrupt" and not command_interrupted and (temporary / "command-started").exists():
                os.write(terminal, b"DUMMY_COMMAND_INPUT\x03")
                command_interrupted = True
            if phase < 4 and (temporary / "cleanup").exists():
                assert b"APP_RESUMED" not in transcript
                assert not (temporary / "release.json").exists()
                if scenario == "loaded" and not (temporary / "closed-observed").exists(): continue
                tail = b"DUMMY_NATIVE_AUTH_TAIL\n\x1b[A\x1b[200~DUMMY_NATIVE_AUTH_TAIL\nsecond-line\x1b[201~\n"
                os.write(terminal, tail)
                # A PTY master write can still be in transit. Test flushing queued
                # input, not input that arrives after the native cleanup barrier.
                slave = os.open(slave_path, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
                try:
                    while struct.unpack("I", fcntl.ioctl(slave, termios.FIONREAD, struct.pack("I", 0)))[0] < len(tail):
                        assert time.monotonic() < deadline, "trailing input did not reach the terminal"
                        time.sleep(.001)
                finally:
                    os.close(slave)
                if scenario == "success": os.kill(native_group, signal.SIGTERM)
                (temporary / "cleanup.release").touch()
                phase = 4
            if phase == 4 and b"APP_RESUMED" in transcript:
                os.write(terminal, b"z")
                phase = 5
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = code
                break
        if status is None:
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended: status = code
        assert phase in (4, 5), transcript[-3000:].decode(errors="replace")
        assert (temporary / "release.json").exists(), transcript[-3000:].decode(errors="replace")
        released = json.loads((temporary / "release.json").read_text())["released"]
        assert released == (scenario not in ("crash", "attributes", "readback", "ownership", "foreground-readback"))
        if released:
            assert os.tcgetpgrp(terminal) in (pid, 0)
            assert (temporary / "fresh-key").read_text() == "z"
        output = (temporary / "result.json").read_bytes()
        log = (temporary / "stdin.log").read_bytes()
        assert (b"\r" if scenario == "loaded" else b"r") in log, "raw-input logging was not exercised"
        for secret in (b"DUMMY_NATIVE_AUTH_PASSWORD", b"DUMMY_NATIVE_AUTH_TAIL", b"DUMMY_NATIVE_AUTH_BUFFER", b"DUMMY_COMMAND_INPUT", b"second-line"):
            assert secret not in output, "secret leaked into tool result"
            assert secret not in log, f"{secret!r} leaked into renderer input log: {log!r}"
        if released: assert b"z" in log, "fresh input was not delivered after resume"
        assert b"DUMMY_NATIVE_AUTH_TAIL" not in transcript, "cleanup echoed trailing input"
        # The fake deliberately writes PAM text containing the password; the tty
        # must contain only those writes, never a third copy from input echo.
        expected_password_writes = 3 if scenario == "retry" else 2 if b"AUTH_STDOUT:" in transcript else 0
        assert transcript.count(b"DUMMY_NATIVE_AUTH_PASSWORD") == expected_password_writes, "password input echoed"
        result = json.loads(output)
        if scenario in ("success", "loaded", "nopasswd", "diagnostics", "suspend", "attributes", "readback", "ownership", "foreground-readback", "slow-auth", "long-auth", "replace", "unlink", "overwrite", "resize", "escape-tail", "retry"):
            assert result["output"] == "command-output\n", result
            assert result["exit"] == 0, result
            assert not result["timedOut"], result
        if scenario == "command-failure":
            assert result["exit"] == 7 and result["output"] == "", result
        if scenario == "failure":
            assert result["exit"] == 1 and result["output"] == "", result
        if scenario in ("timeout", "flood"):
            assert result["timedOut"] and result["exit"] != 0, result
        if scenario == "flood": assert result["truncated"], result
        if scenario in ("cancel", "stale", "remote", "crash"): assert result is None, result
        if scenario in ("stale", "remote"): assert b"FAKE_AUTH_READY" not in transcript
        if scenario in ("interrupt", "command-interrupt", "handoff-cancel"): assert result["exit"] != 0 and result["output"] == "", result
        if scenario == "success":
            assert b"AUTH_STDOUT:DUMMY_NATIVE_AUTH_PASSWORD" in transcript
            assert b"AUTH_STDERR:DUMMY_NATIVE_AUTH_PASSWORD" in transcript
        # Darwin can report PTY EOF before the fixture process is waitable.
        while status is None and time.monotonic() < deadline:
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended: status = code
            else: time.sleep(.001)
        assert status == 0, f"fixture exit: {status}"
        print(json.dumps({"scenario": scenario, "released": released, "credential_leaks": False}))
    finally:
        if status is None:
            for target in (native_group, pid):
                if target:
                    try: os.killpg(target, signal.SIGKILL)
                    except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass
        os.close(terminal)
