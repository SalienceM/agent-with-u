"""Stamp a build with a same-day-distinguishable display and package version.

Display:  YY.M.D.HHMMSS          (for humans and update manifests)
Package:  YY.M.<D*2000+minute>   (three numeric fields, MSI-safe and monotonic)
Build ID: YYYYMMDDHHMMSS-<git>   (cross-node ordering)

Set AGENT_WITH_U_RELEASE_TIMESTAMP=YYYYMMDDHHMMSS on every build machine to
produce Windows/Linux artifacts for one identical release.  Re-running with the
same timestamp reuses the existing package version.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAURI_CONFIG = ROOT / "src-tauri" / "tauri.conf.json"
VERSION_FILE = ROOT / "src" / "_version.py"


def _git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short=12", "HEAD"], cwd=ROOT,
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        ).strip()
    except Exception:
        return "nogit"


def _parse_timestamp(value: str) -> dt.datetime:
    raw = re.sub(r"\D", "", value or "")
    if not raw:
        return dt.datetime.now().astimezone()
    if len(raw) != 14:
        raise ValueError("release timestamp must contain YYYYMMDDHHMMSS")
    parsed = dt.datetime.strptime(raw, "%Y%m%d%H%M%S")
    return parsed.replace(tzinfo=dt.datetime.now().astimezone().tzinfo)


def _existing_metadata() -> dict[str, str]:
    try:
        text = VERSION_FILE.read_text(encoding="utf-8")
    except OSError:
        return {}
    result: dict[str, str] = {}
    for name in ("__package_version__", "__display_version__", "__build_id__"):
        match = re.search(rf"^{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", text, re.MULTILINE)
        if match:
            result[name] = match.group(1)
    return result


def stamp(timestamp: str = "") -> dict[str, str | int]:
    instant = _parse_timestamp(timestamp or os.environ.get("AGENT_WITH_U_RELEASE_TIMESTAMP", ""))
    commit = _git_commit()
    timestamp_digits = instant.strftime("%Y%m%d%H%M%S")
    build_id = f"{timestamp_digits}-{commit}"
    display_version = f"{instant:%y}.{instant.month}.{instant.day}.{instant:%H%M%S}"
    computed_patch = instant.day * 2000 + instant.hour * 60 + instant.minute

    config = json.loads(TAURI_CONFIG.read_text(encoding="utf-8-sig"))
    existing_version = str(config.get("version") or "0.0.0")
    existing_parts = [int(value) for value in re.findall(r"\d+", existing_version)[:3]]
    existing = _existing_metadata()
    if str(existing.get("__build_id__", "")).startswith(timestamp_digits):
        package_version = existing.get("__package_version__") or existing_version
    else:
        patch = computed_patch
        if len(existing_parts) == 3 and existing_parts[:2] == [instant.year % 100, instant.month]:
            patch = max(patch, existing_parts[2] + 1)
        if patch > 65535:
            raise ValueError(f"computed MSI patch version exceeds 65535: {patch}")
        package_version = f"{instant:%y}.{instant.month}.{patch}"

    config["version"] = package_version
    TAURI_CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    VERSION_FILE.write_text(
        "# auto-written by scripts/stamp_version.py\n"
        f"__version__ = {display_version!r}\n"
        f"__display_version__ = {display_version!r}\n"
        f"__package_version__ = {package_version!r}\n"
        f"__build_id__ = {build_id!r}\n"
        f"__build_sequence__ = {int(timestamp_digits)!r}\n"
        f"__commit__ = {commit!r}\n",
        encoding="utf-8",
    )
    return {
        "displayVersion": display_version,
        "packageVersion": package_version,
        "buildId": build_id,
        "sequence": int(timestamp_digits),
        "commit": commit,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timestamp", default="")
    parser.add_argument("--field", choices=("displayVersion", "packageVersion", "buildId", "sequence", "commit"))
    args = parser.parse_args()
    result = stamp(args.timestamp)
    print(result[args.field] if args.field else json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
