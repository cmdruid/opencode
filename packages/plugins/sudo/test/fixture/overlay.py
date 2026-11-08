import pathlib, tempfile, subprocess, shlex, time, os, json, shutil, hashlib, sys
package = pathlib.Path(__file__).resolve().parents[2]
tmux = shutil.which('tmux')
if not tmux: raise SystemExit('tmux is required for the overlay regression')
with tempfile.TemporaryDirectory(prefix='sudo-ui-tmux-') as root:
    directory = pathlib.Path(root)
    fake = directory/'fake-sudo'
    helper = directory/'helper'
    fake.write_text('#!' + sys.executable + '''
import os,sys
fd=os.open('/dev/tty',os.O_RDWR)
os.write(fd,b'FAKE_AUTH_READY:')
while os.read(fd,1) not in (b'\\r',b'\\n',b''): pass
for i in range(40): os.write(2, b'Long authentication message, never a tool result.\\n')
args=sys.argv[sys.argv.index('--')+1:]
os.execv(args[0],args)
''')
    fake.chmod(0o700)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O2','-DOPENCODE_SUDO_TEST',f'-DSUDO_PATH="{fake}"',str(package/'native/helper.c'),'-o',str(helper)],check=True)
    pathlib.Path(str(helper) + ".sha256").write_text(hashlib.sha256(helper.read_bytes()).hexdigest())
    for columns, rows in [(40,16),(80,24),(120,40)]:
        socket=f'sudo-ui-{os.getpid()}-{columns}'
        def command(*args):
            return subprocess.run([tmux,'-L',socket,*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout
        def wait_for(text):
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                screen=command('capture-pane','-p','-t','test:0.0')
                if text in screen: return screen
                time.sleep(.02)
            raise AssertionError(screen)
        try:
            launch=shlex.join(['env',f'OTUI_STDIN_LOG={directory}/stdin.log',shutil.which('bun'),str(package/'test/fixture/native.ts'),root,str(helper),'success'])
            command('-f','/dev/null','new-session','-d','-s','test','-x',str(columns),'-y',str(rows),launch)
            command('set-option','-t','test','remain-on-exit','on')
            wait_for('FIXTURE_READY')
            command('send-keys','-t','test','r')
            screen=wait_for('FAKE_AUTH_READY:')
            assert 'OpenCode conversation UPDATED' in screen, screen
            assert 'OpenCode | Run as root' in screen, screen
            assert screen.splitlines().index('--- OpenCode | Run as root ---') == rows - 8, screen
            command('send-keys','-t','test','DUMMY_NATIVE_AUTH_PASSWORD','Enter')
            deadline=time.monotonic()+5
            while not (directory/'release.json').exists() and time.monotonic()<deadline: time.sleep(.02)
            assert json.loads((directory/'release.json').read_text())['released']
            command('send-keys','-t','test','z')
            assert 'DUMMY_NATIVE_AUTH_PASSWORD' not in (directory/'stdin.log').read_text()
            (directory/'release.json').unlink()
            print(f'PASS {columns}x{rows}')
        finally:
            subprocess.run([tmux,'-L',socket,'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
