"""Register finished build outputs in AgentWithU Release Center.

This command is intentionally non-publishing.  Build scripts may call it after
packaging without any risk of changing the stable update manifest.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.backend.release_center import ReleaseCenterManager  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Register build outputs as a release candidate")
    parser.add_argument("--project-root", default=str(ROOT))
    parser.add_argument("--source", default="build-script")
    parser.add_argument("--json", action="store_true", help="print the complete candidate JSON")
    args = parser.parse_args()

    result = ReleaseCenterManager().scan_project(args.project_root, args.source)
    candidate = result["candidate"]
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(
            "[RELEASE CANDIDATE] "
            f"{candidate.get('version')} / {candidate.get('buildId')} / "
            f"{len(candidate.get('artifacts') or [])} artifact(s)"
        )
        print("[RELEASE CANDIDATE] Open AgentWithU → 设置 → 数据与系统 → 发布工作台 to review.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"[RELEASE CANDIDATE WARN] {error}", file=sys.stderr)
        raise SystemExit(1)

