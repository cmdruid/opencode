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
        str(pathlib.Path(os.environ.get("SUDO_NATIVE_SOURCE", str(package / "native"))) / "helper.c"), "-o", str(helper),
        str(package / "test/fixture/cleanup.c"),
        '-DTEST_CLEANUP_PATH="' + str(temporary / "cleanup") + '"',
        '-DTEST_FAILURE="' + scenario + '"',
        "-Wl,--wrap=tcsetattr", "-Wl,--wrap=tcgetattr", "-Wl,--wrap=tcsetpgrp", "-Wl,--wrap=tcgetpgrp",
        *([
            str(package / "test/fixture/clock.c"),
            '-DTEST_CLOCK_PATH="' + str(temporary / "clock") + '"',
            "-Wl,--wrap=clock_gettime", "-Wl,--wrap=poll",
        ] if scenario == "long-auth" else []),
    ], check=True)
    if scenario == "loaded":
        bundle = temporary / "plugin"
        bundle.mkdir()
        for name in ("package.json", "index.ts", "rpc.ts", "requests.ts", "tui.js"):
            shutil.copy2(package / name, bundle / name)
        (bundle / "node_modules").symlink_to(package / "node_modules")
        binary = bundle / "native/bin/linux-x64"
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
                assert native_group != pid, "native helper did not take foreground ownership"
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
            if phase < 4 and (temporary / "cleanup").exists():
                assert b"APP_RESUMED" not in transcript
                assert not (temporary / "release.json").exists()
                os.write(terminal, b"DUMMY_NATIVE_AUTH_TAIL\n\x1b[A\x1b[200~DUMMY_NATIVE_AUTH_TAIL\nsecond-line\x1b[201~")
                if scenario == "loaded" and not (temporary / "closed-observed").exists(): continue
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
        for secret in (b"DUMMY_NATIVE_AUTH_PASSWORD", b"DUMMY_NATIVE_AUTH_TAIL", b"DUMMY_NATIVE_AUTH_BUFFER", b"second-line"):
            assert secret not in output, "secret leaked into tool result"
            assert secret not in log, "secret leaked into renderer input log"
        if released: assert b"z" in log, "fresh input was not delivered after resume"
        assert b"DUMMY_NATIVE_AUTH_TAIL" not in transcript, "cleanup echoed trailing input"
        result = json.loads(output)
        if scenario in ("success", "loaded", "nopasswd", "diagnostics", "suspend", "attributes", "readback", "ownership", "foreground-readback", "slow-auth", "long-auth", "replace", "unlink", "resize", "escape-tail", "retry"):
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
