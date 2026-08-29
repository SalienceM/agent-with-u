"""Build and optionally upload an AgentWithU update manifest.

The upload path intentionally uses qshell rather than embedding Qiniu account
secrets in AgentWithU.  Configure qshell once on the release machine, then this
script uploads immutable artifacts first and the channel manifest last.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import runpy
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def canonical_payload(document: dict) -> bytes:
    unsigned = dict(document)
    unsigned.pop("signature", None)
    return json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def public_url(base_url: str, key: str) -> str:
    return f"{base_url.rstrip('/')}/{quote(key.strip('/'), safe='/._+-')}"


def qshell_upload(qshell: str, bucket: str, key: str, path: Path, dry_run: bool) -> None:
    command = [qshell, "fput", bucket, key, str(path), "--overwrite"]
    print("[qiniu]", " ".join(command[:-1]), path)
    if not dry_run:
        subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create/upload AgentWithU release manifest")
    parser.add_argument("plan", help="release plan JSON; see deploy/update-release.example.json")
    parser.add_argument("--output", default="dist/update/manifest.json")
    parser.add_argument("--base-url", default="", help="Qiniu/CDN public HTTPS base URL")
    parser.add_argument("--qiniu-bucket", default="")
    parser.add_argument("--qshell", default="qshell")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    plan_path = Path(args.plan).expanduser().resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    if not isinstance(plan, dict) or not isinstance(plan.get("artifacts"), list):
        raise ValueError("release plan must contain an artifacts array")
    base_url = str(args.base_url or plan.get("baseUrl") or "").strip()
    if not base_url.startswith(("https://", "http://")):
        raise ValueError("baseUrl must be an HTTP(S) CDN/domain URL")

    version_data = runpy.run_path(str(ROOT / "src" / "_version.py"))
    display_version = str(version_data.get("__display_version__") or version_data.get("__version__") or "0.0.0-dev")
    build_id = str(version_data.get("__build_id__") or display_version)
    sequence = int(version_data.get("__build_sequence__") or "".join(c for c in build_id if c.isdigit())[:14] or 0)
    channel = str(plan.get("channel") or "stable")
    prefix = str(plan.get("prefix") or "agentwithu/releases").strip("/")
    immutable_prefix = f"{prefix}/{build_id}"
    manifest_artifacts: list[dict] = []
    upload_jobs: list[tuple[str, Path]] = []

    for index, raw in enumerate(plan["artifacts"]):
        if not isinstance(raw, dict):
            raise ValueError(f"artifact #{index + 1} must be an object")
        local_path = Path(str(raw.get("path") or ""))
        if not local_path.is_absolute():
            local_path = (plan_path.parent / local_path).resolve()
        if not local_path.is_file():
            raise FileNotFoundError(local_path)
        key = str(raw.get("key") or f"{immutable_prefix}/{local_path.name}").strip("/")
        item = {
            "id": str(raw.get("id") or f"{raw.get('platform', 'any')}-{raw.get('arch', 'any')}-{index + 1}"),
            "platform": str(raw.get("platform") or raw.get("os") or "any"),
            "arch": str(raw.get("arch") or "any"),
            "target": str(raw.get("target") or "desktop"),
            "kind": str(raw.get("kind") or "custom"),
            "fileName": str(raw.get("fileName") or local_path.name),
            "url": public_url(base_url, key),
            "size": local_path.stat().st_size,
            "sha256": sha256(local_path),
        }
        if isinstance(raw.get("install"), dict):
            item["install"] = raw["install"]
        manifest_artifacts.append(item)
        upload_jobs.append((key, local_path))

    manifest = {
        "schemaVersion": 1,
        "channel": channel,
        "release": {
            "version": display_version,
            "packageVersion": str(version_data.get("__package_version__") or display_version),
            "buildId": build_id,
            "sequence": sequence,
            "commit": str(version_data.get("__commit__") or ""),
            "publishedAt": str(plan.get("publishedAt") or build_id[:14]),
            "notes": str(plan.get("notes") or ""),
        },
        "artifacts": manifest_artifacts,
    }
    signing_key = os.environ.get("AGENT_WITH_U_UPDATE_SIGNING_KEY", "")
    if signing_key:
        manifest["signature"] = {
            "algorithm": "hmac-sha256",
            "value": hmac.new(signing_key.encode("utf-8"), canonical_payload(manifest), hashlib.sha256).hexdigest(),
        }
    else:
        print("[WARN] AGENT_WITH_U_UPDATE_SIGNING_KEY is empty; manifest will be unsigned", file=sys.stderr)

    output = (ROOT / args.output).resolve() if not Path(args.output).is_absolute() else Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[OK] manifest: {output}")

    bucket = str(args.qiniu_bucket or plan.get("qiniuBucket") or "").strip()
    if bucket:
        qshell = shutil.which(args.qshell) or args.qshell
        for key, artifact_path in upload_jobs:
            qshell_upload(qshell, bucket, key, artifact_path, args.dry_run)
        versioned_manifest_key = f"{immutable_prefix}/manifest.json"
        channel_manifest_key = str(plan.get("manifestKey") or f"{prefix}/{channel}/manifest.json").strip("/")
        qshell_upload(qshell, bucket, versioned_manifest_key, output, args.dry_run)
        # Channel pointer is deliberately last: clients never observe a
        # manifest before all immutable artifacts are available.
        qshell_upload(qshell, bucket, channel_manifest_key, output, args.dry_run)
        print(f"[OK] feed URL: {public_url(base_url, channel_manifest_key)}")
    else:
        print("[INFO] qiniuBucket not set; upload skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
