"""一次 NUL 分隔的 porcelain v2 扫描同时取得分支和文件状态，不读取 diff。"""

from typing import Any, Callable


def parse_worktree_status(output: str, xy_status: Callable[[str, str], str]) -> dict[str, Any]:
    result: dict[str, Any] = {"files": [], "branch": "", "upstream": "", "ahead": 0, "behind": 0}
    records = iter(output.split("\0"))
    for record in records:
        if record.startswith("# branch.head "):
            result["branch"] = record[len("# branch.head "):]
        elif record.startswith("# branch.upstream "):
            result["upstream"] = record[len("# branch.upstream "):]
        elif record.startswith("# branch.ab "):
            ahead, behind = record[len("# branch.ab "):].split()
            result["ahead"], result["behind"] = int(ahead), abs(int(behind))
        elif record.startswith(("1 ", "2 ", "u ", "? ")):
            kind = record[0]
            if kind == "?":
                path, xy = record[2:], "??"
            else:
                fields = record.split(" ", {"1": 8, "2": 9, "u": 10}[kind])
                path, xy = fields[-1], fields[1]
                if kind == "2":
                    next(records, None)  # rename/copy 的第二个 NUL 项是旧路径，不是另一条状态。
            result["files"].append({
                "path": path,
                "status": "conflicted" if kind == "u" else xy_status(xy[0], xy[1]),
                "staged": xy[0] not in (".", " ", "?"),
            })
    result["totalChanges"] = len(result["files"])
    result["stagedCount"] = sum(1 for file in result["files"] if file["staged"])
    return result
