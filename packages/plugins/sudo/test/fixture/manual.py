"""Exercise the actual human runner with fake sudo; never uses credentials or real sudo."""
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

package = pathlib.Path(__file__).resolve().parents[2]
scenario = sys.argv[1] if len(sys.argv) > 1 else "success"
runner = sys.argv[2] if len(sys.argv) > 2 else "script/manual.ts"
assert scenario in ("success", "slow", "cancel", "review-cancel")
with tempfile.TemporaryDirectory(prefix="sudo-manual-test-") as directory:
    root = pathlib.Path(directory)
    bundle = root / "plugin"
    bundle.mkdir()
    for name in ("package.json", "index.ts", "rpc.ts", "requests.ts", "tui.js"):
        shutil.copyfile(package / name, bundle / name)
    (bundle / "node_modules").symlink_to(package / "node_modules")
    binary = bundle / f"native/bin/{'darwin-arm64' if sys.platform == 'darwin' else 'linux-x64'}/opencode-sudo-tty"
    binary.parent.mkdir(parents=True)
    fake = root / "fake-sudo"
    fake.write_text(f'''#!{sys.executable}
import os, sys, termios
fd = os.open("/dev/tty", os.O_RDWR)
original = termios.tcgetattr(fd)
if sys.platform == "darwin":
    assert original[3] & termios.ECHO, "Touch ID must start with inherited echo enabled"
password_mode = termios.tcgetattr(fd)
password_mode[3] &= ~(termios.ECHO | termios.ECHONL)
termios.tcsetattr(fd, termios.TCSAFLUSH, password_mode)
os.write(fd, b"FAKE_AUTH_READY:")
password = bytearray()
while True:
    ch = os.read(fd, 1)
    if ch in (b"\\n", b"\\r", b""): break
    password.extend(ch)
os.write(1, b"AUTH_STDOUT:" + password + b"\\n")
os.write(2, b"AUTH_STDERR:" + password + b"\\n")
termios.tcsetattr(fd, termios.TCSAFLUSH, original)
os.close(fd)
args = sys.argv[sys.argv.index("--") + 1:]
os.execv(args[0], args)
''')
    fake.chmod(0o700)
    flags = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DOPENCODE_SUDO_TEST",
             f'-DSUDO_PATH="{fake}"', f'-DTEST_CLEANUP_PATH="{root}/cleanup"', '-DTEST_FAILURE="manual"']
    wrappers = ("tcsetattr", "tcgetattr", "tcsetpgrp", "tcgetpgrp")
    subprocess.run([*flags, *[f"-D{name}=__wrap_{name}" for name in wrappers], "-c",
                    str(package / "native/helper.c"), "-o", str(root / "helper.o")], check=True)
    subprocess.run([*flags, *[f"-D__real_{name}={name}" for name in wrappers],
                    str(root / "helper.o"), str(package / "test/fixture/cleanup.c"), "-o", str(binary)], check=True)
    binary.with_suffix(".sha256").write_text(hashlib.sha256(binary.read_bytes()).hexdigest())
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(package)
        os.execv(shutil.which("bun"), ["bun", "--preload", "@opentui/solid/preload", runner, str(bundle)])
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    transcript = bytearray()
    status = None
    group = None
    approved = False
    sent = False
    auth_at = None
    cleanup_at = None
    released = False
    deadline = time.monotonic() + 45
    try:
        while time.monotonic() < deadline:
            if select.select([terminal], [], [], .02)[0]:
                try:
                    data = os.read(terminal, 65536)
                except OSError:
                    break
                if not data:
                    break
                transcript.extend(data)
            if not approved and b"approve" in transcript:
                os.write(terminal, b"\x1b" if scenario == "review-cancel" else b"\r")
                approved = True
            if auth_at is None and b"FAKE_AUTH_READY:" in transcript:
                auth_at = time.monotonic()
                group = os.tcgetpgrp(terminal)
                assert group > 0 and group != pid
            # One real wait crosses Bun's former 10-second server idle timeout.
            if auth_at is not None and not sent and time.monotonic() - auth_at >= (22 if scenario == "slow" else 0):
                os.write(terminal, b"DUMMY_MANUAL_PASSWORD" + (b"\x03" if scenario == "cancel" else b"\r"))
                sent = True
            if cleanup_at is None and (root / "cleanup").exists():
                cleanup_at = time.monotonic()
            # Hold native cleanup while the real runner processes the early broker result.
            # This deliberately simulates slow terminal restoration, not authentication.
            if cleanup_at is not None and not released and time.monotonic() - cleanup_at >= .5:
                assert b'"command":"/usr/bin/id -u"' not in transcript, "runner finished before native cleanup"
                (root / "cleanup.release").touch()
                released = True
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = code
                break
        while status is None and time.monotonic() < deadline:
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = code
            else:
                time.sleep(.001)
        assert status == 0, transcript.decode(errors="replace")
        for error in (b"InvalidPhase", b"ECONNRESET", b"ClientError", b"timed out a request"):
            assert error not in transcript, transcript.decode(errors="replace")
        marker = b'{"command":"/usr/bin/id -u"'
        assert transcript.count(marker) == 1, transcript[-4000:].decode(errors="replace")
        record, _ = json.JSONDecoder().raw_decode(transcript[transcript.index(marker):].decode())
        assert "DUMMY_MANUAL_PASSWORD" not in json.dumps(record)
        result = record["result"]
        if scenario == "review-cancel":
            assert result == "cancelled"
            assert auth_at is None
        elif scenario == "cancel":
            assert result["exit"] != 0 and result["output"] == ""
        else:
            assert result["exit"] == 0 and result["output"] == str(os.getuid()) + "\n"
        print(json.dumps({"scenario": scenario, "runner_exit": 0, "transport_errors": False, "credential_leaks": False}))
    finally:
        if status is None:
            for target in (group, pid):
                if target:
                    try:
                        os.killpg(target, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            os.waitpid(pid, 0)
        os.close(terminal)
