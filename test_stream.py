import subprocess, sys, os

cli = r"C:\Users\Administrator\AppData\Roaming\npm\claude.cmd"

print("=== 测试 stream-json (Popen) ===")
proc = subprocess.Popen(
    [cli, "-p", "say hi", "--output-format", "stream-json"],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    encoding="utf-8",
    errors="replace",
    bufsize=1,
)
count = 0
for line in proc.stdout:
    line = line.rstrip()
    if line:
        count += 1
        print(f"  [{count}] {line[:200]}")
proc.wait()
stderr = proc.stderr.read()
if stderr:
    print(f"  stderr: {stderr[:300]}")
print(f"  共 {count} 行, returncode={proc.returncode}")

if count == 0:
    print("\n=== stream-json 无输出，测试 jsonl ===")
    proc2 = subprocess.Popen(
        [cli, "-p", "say hi", "--output-format", "jsonl"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
    )
    for line in proc2.stdout:
        line = line.rstrip()
        if line:
            print(f"  {line[:200]}")
    proc2.wait()
    print(f"  returncode={proc2.returncode}")