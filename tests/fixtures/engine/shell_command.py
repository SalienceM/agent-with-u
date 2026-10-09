"""Fixed isolated terminal probe commands, never a user's project."""
import os
import sys
import time

if sys.argv[1] == 'ready':
    print('AWU_SHELL_READY', flush=True)
elif sys.argv[1] == 'size':
    size = os.get_terminal_size()
    print(f'AWU_SIZE_{size.columns}_{size.lines}', flush=True)
elif sys.argv[1] == 'wait':
    try:
        print('AWU_WAITING', flush=True)
        for _ in range(200):
            time.sleep(.1)
    except KeyboardInterrupt:
        print('AWU_CTRL_C', flush=True)
elif sys.argv[1] == 'flood':
    # 唯一、定长行避免 ConPTY 对同一屏重复字符的合并优化；超过 2 MiB 尾部预算。
    for i in range(7000):
        sys.stdout.write(f'{i:06d}:' + 'x' * 472 + '\n')
    print('\nAWU_FLOOD_DONE', flush=True)
