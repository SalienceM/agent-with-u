"""PTY 原生探针子程序，只接受探针创建的临时 HOME；不执行任意命令。"""
import os
from pathlib import Path
import subprocess
import sys
import time

home = Path.home().resolve()
if not home.parent.name.startswith('awu-engine-pty-') or home.name != 'home':
    raise RuntimeError('Not an isolated terminal fixture')
if Path(os.environ['AGENT_WITH_U_DATA_ROOT']).resolve() != home / 'awu':
    raise RuntimeError('Wrong fixture data root')

if sys.argv[-1] == '--worker':
    time.sleep(300)
elif sys.argv[-1] == '--daemon' and sys.platform.startswith('linux'):
    if os.fork():
        os._exit(0)
    os.setsid()
    if os.fork():
        os._exit(0)
    print(f'FIXTURE_DAEMON_{os.getpid()}', flush=True)
    time.sleep(300)
else:
    print('FIXTURE_READY', flush=True)
    for line in sys.stdin:
        command = line.strip()
        if command == 'hello':
            print('FIXTURE_ECHO_OK', flush=True)
        elif command == 'size':
            size = os.get_terminal_size(sys.stdout.fileno())
            print(f'FIXTURE_SIZE_{size.columns}_{size.lines}', flush=True)
        elif command == 'child':
            child = subprocess.Popen([sys.executable, '-I', __file__, '--worker'],
                                     env=dict(os.environ))
            print(f'FIXTURE_CHILD_{child.pid}', flush=True)
        elif command == 'daemon' and sys.platform.startswith('linux'):
            subprocess.Popen([sys.executable, '-I', __file__, '--daemon'], env=dict(os.environ))
        elif command == 'exit':
            break
        else:
            print('FIXTURE_REJECTED', flush=True)
