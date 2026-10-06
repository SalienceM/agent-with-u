"""隔离目录协议夹具：只读 stdin，绝不访问用户配置或认证。"""
import json
import sys
import time

mode = sys.argv[1]
for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    if mode == "startup-hang":
        time.sleep(60)
    if message["method"] == "initialize":
        result = {"userAgent": "isolated-fixture"}
    elif message["method"] == "model/list":
        if mode == "hang":
            time.sleep(60)
        if mode == "oversize":
            print('x' * (2 * 1024 * 1024), flush=True)
            continue
        result = {"data": [{"id": "display-id", "model": "runtime-id", "displayName": "Fixture"}]}
    else:
        raise RuntimeError("Unexpected method")
    print("secret stderr fixture", file=sys.stderr, flush=True)
    print(json.dumps({"id": message["id"], "result": result}), flush=True)
