"""Real PTY, production broker/renderer/handoff, unprivileged substitute for sudo. No actual credentials."""
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
scenario = sys.argv[1]
with tempfile.TemporaryDirectory(prefix="sudo-pty-test-") as directory:
    temporary = pathlib.Path(directory)
    helper = temporary / "helper"
    fake = temporary / "fake-sudo"
    fake.write_text('''#!/usr/bin/python3
import os, sys
scenario = ''' + repr(scenario) + '''
if scenario != "nopasswd":
    fd = os.open("/dev/tty", os.O_RDWR)
    os.write(fd, b"FAKE_AUTH_READY:")
    password = bytearray()
    while True:
        ch = os.read(fd, 1)
        if ch in (b"\\n", b"\\r", b""): break
        password.extend(ch)
    # A PAM conversation may write sensitive text on either stream: neither may be captured.
    os.write(1, b"AUTH_STDOUT:" + password + b"\\n")
    os.write(2, b"AUTH_STDERR:" + password + b"\\n")
    os.close(fd)
if scenario == "retry":
    fd = os.open("/dev/tty", os.O_RDWR)
    os.write(fd, b"FAKE_AUTH_RETRY:")
    password = bytearray()
    while True:
        ch = os.read(fd, 1)
        if ch in (b"\\n", b"\\r", b""): break
        password.extend(ch)
    os.write(2, b"RETRY_STDERR:" + password + b"\\n")
    os.close(fd)
if scenario == "failure": sys.exit(1)
args = sys.argv[sys.argv.index("--") + 1:]
os.execv(args[0], args)
''')
    fake.chmod(0o700)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DOPENCODE_SUDO_TEST",
        '-DSUDO_PATH="' + str(fake) + '"',
        str(package / "native/helper.c"), "-o", str(helper),
    ], check=True)
    pid, terminal = pty.fork()
    if pid == 0:
        os.environ["OTUI_STDIN_LOG"] = str(temporary / "stdin.log")
        if scenario == "diagnostics":
            os.environ["OTUI_DEBUG"] = "1"
            os.environ["OTUI_NATIVE_INPUT_SHADOW"] = "1"
        os.execv(shutil.which("bun"), ["bun", str(package / "test/fixture/native.ts"), directory, str(helper), scenario])
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
                os.write(terminal, b"r")
                phase = 1
            if phase == 1 and b"System sudo" in transcript:
                native_group = os.tcgetpgrp(terminal)
                assert native_group != pid, "native helper did not take foreground ownership"
                if scenario == "suspend": os.killpg(native_group, signal.SIGTSTP)
                phase = 2
            if phase == 1 and b"Ctrl+C to close" in transcript:
                native_group = os.tcgetpgrp(terminal)
                phase = 2
            if phase == 2 and scenario == "nopasswd" and b"System sudo" in transcript:
                os.write(terminal, b"DUMMY_NATIVE_AUTH_PASSWORD\r")
                phase = 3
            if phase == 2 and b"FAKE_AUTH_READY:" in transcript:
                if scenario == "resize":
                    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 16, 40, 0, 0))
                    os.killpg(native_group, signal.SIGWINCH)
                if scenario == "replace":
                    helper.rename(temporary / "original")
                    helper.write_text("#!/bin/sh\nexit 99\n")
                    helper.chmod(0o755)
                if scenario == "unlink": helper.unlink()
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
                os.write(terminal, b"DUMMY_NATIVE_AUTH_TAIL\x03")
                command_interrupted = True
            if phase in (2, 3) and b"Ctrl+C to close" in transcript:
                assert b"APP_RESUMED" not in transcript
                assert os.tcgetpgrp(terminal) == native_group
                if scenario in ("interrupt", "command-interrupt"):
                    time.sleep(0.05)
                    assert not (temporary / "release.json").exists(), "authentication Ctrl+C dismissed the guard"
                os.write(terminal, b"DUMMY_NATIVE_AUTH_TAIL")
                if scenario == "crash":
                    os.killpg(native_group, signal.SIGKILL)
                else:
                    if scenario == "suspend": os.killpg(native_group, signal.SIGTSTP)
                    if scenario == "escape-tail":
                        os.write(terminal, b"\x1b[A\x1b[200~DUMMY_NATIVE_AUTH_TAIL\x1b[201~")
                        time.sleep(0.05)
                        assert not (temporary / "release.json").exists(), "escape sequence released terminal"
                    os.write(terminal, b"\x03")
                phase = 4
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = code
                break
        if status is None:
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended: status = code
        assert phase == 4, transcript[-3000:].decode(errors="replace")
        assert (temporary / "release.json").exists(), transcript[-3000:].decode(errors="replace")
        released = json.loads((temporary / "release.json").read_text())["released"]
        assert released == (scenario != "crash")
        if released: assert os.tcgetpgrp(terminal) in (pid, 0)
        output = (temporary / "result.json").read_bytes()
        log = (temporary / "stdin.log").read_bytes()
        assert b"r" in log, "raw-input logging was not exercised"
        for secret in (b"DUMMY_NATIVE_AUTH_PASSWORD", b"DUMMY_NATIVE_AUTH_TAIL"):
            assert secret not in output, "secret leaked into tool result"
            assert secret not in log, "secret leaked into renderer input log"
        assert b"DUMMY_NATIVE_AUTH_TAIL" not in transcript, "guard echoed trailing input"
        result = json.loads(output)
        if scenario in ("success", "nopasswd", "diagnostics", "suspend", "crash", "slow-auth", "replace", "unlink", "resize", "escape-tail", "retry"):
            assert result["output"] == "command-output\n", result
            assert result["exit"] == 0, result
        if scenario == "failure":
            assert result["exit"] == 1 and result["output"] == "", result
        if scenario in ("timeout", "flood"):
            assert result["timedOut"] and result["exit"] != 0, result
        if scenario == "flood": assert result["truncated"], result
        if scenario in ("cancel", "stale", "remote"): assert result is None, result
        if scenario in ("stale", "remote"): assert b"FAKE_AUTH_READY" not in transcript
        if scenario in ("interrupt", "command-interrupt", "handoff-cancel"): assert result["exit"] != 0 and result["output"] == "", result
        if scenario == "success":
            assert b"AUTH_STDOUT:DUMMY_NATIVE_AUTH_PASSWORD" in transcript
            assert b"AUTH_STDERR:DUMMY_NATIVE_AUTH_PASSWORD" in transcript
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
