"""核对固定 Harness 源码和配套 wheels；不安装、不下载、不启动模型。"""
from __future__ import annotations

import argparse
import email
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Any


LOCK_PATH = Path(__file__).resolve().parents[1] / "deploy" / "deepseek-harness.lock.json"


def load_lock(path: Path = LOCK_PATH) -> dict[str, Any]:
    """不接受通道别名、dev0 或不成对的 Python 版本。"""
    lock = json.loads(path.read_text(encoding="utf-8"))
    version = lock.get("version", "")
    if lock.get("schemaVersion") != 1 or not re.fullmatch(r"\d+\.\d+\.\d+(?:-rc\.\d+)?", version):
        raise ValueError("Unsupported Harness lock schema/version")
    python_version = version.replace("-rc.", "rc")
    if lock.get("pythonVersion") != python_version or lock.get("tag") != f"dsh-v{version}":
        raise ValueError("Harness tag/SDK/runtime versions must match")
    if not re.fullmatch(r"[a-f0-9]{40}", lock.get("commit", "")):
        raise ValueError("Harness commit must be immutable")
    if not re.fullmatch(r"[a-f0-9]{64}", lock.get("sourceLockSha256", "")):
        raise ValueError("Harness source lock checksum missing")
    if not lock.get("platforms"):
        raise ValueError("Harness platform inventory missing")
    return lock


def _git(source: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(source), *args], stderr=subprocess.PIPE)


def verify_source(source: Path, lock: dict[str, Any]) -> dict[str, str]:
    """按 Git blob 计算摘要，不受 checkout 的 CRLF 设置影响。"""
    commit = _git(source, "rev-parse", "HEAD").decode().strip()
    if commit != lock["commit"]:
        raise ValueError("Harness checkout commit does not match lock")
    if _git(source, "status", "--porcelain", "--untracked-files=no").strip():
        raise ValueError("Harness tracked source has local changes")
    digest = hashlib.sha256(_git(source, "show", "HEAD:pnpm-lock.yaml")).hexdigest()
    if digest != lock["sourceLockSha256"]:
        raise ValueError("Harness pnpm lock checksum mismatch")
    manifest = json.loads((source / "package.json").read_text(encoding="utf-8"))
    if manifest["version"] != lock["version"]:
        raise ValueError("Harness source package version mismatch")
    platforms = json.loads((source / "python/sdk-runtime/platforms.json").read_text(encoding="utf-8"))
    for platform, expected in lock["platforms"].items():
        actual = platforms.get(platform, {})
        if actual.get("tag") != expected["wheelTag"] or actual.get("executable") != expected["executable"]:
            raise ValueError(f"Harness platform manifest mismatch: {platform}")
    return {"commit": commit, "sourceLockSha256": digest, "version": manifest["version"]}


def verify_wheel(path: Path, lock: dict[str, Any], platform: str | None = None) -> dict[str, Any]:
    """检查 wheel 声明、精确依赖、许可证与必要伴随文件，不提取执行内容。"""
    version = lock["pythonVersion"]
    distribution = "deepseek-harness-sdk" if platform is None else "deepseek-harness-runtime-bin"
    if platform is not None and platform not in lock["platforms"]:
        raise ValueError("Unsupported Harness target platform")
    wheel_tag = "any" if platform is None else lock["platforms"][platform]["wheelTag"]
    expected_name = f"{distribution.replace('-', '_')}-{version}-py3-none-{wheel_tag}.whl"
    if path.name != expected_name:
        raise ValueError(f"Expected paired Harness wheel: {expected_name}")
    dist_info = f"{distribution.replace('-', '_')}-{version}.dist-info/"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate Harness wheel members")
        if any(name.startswith(("/", "\\")) or ".." in name.replace("\\", "/").split("/") for name in names):
            raise ValueError("Unsafe Harness wheel member")
        metadata = email.message_from_bytes(archive.read(dist_info + "METADATA"))
        wheel = email.message_from_bytes(archive.read(dist_info + "WHEEL"))
        if metadata["Name"] != distribution or metadata["Version"] != version:
            raise ValueError("Harness wheel metadata does not match lock")
        if wheel.get_all("Tag") != [f"py3-none-{wheel_tag}"]:
            raise ValueError("Harness wheel platform tag mismatch")
        licenses = {Path(name).name for name in metadata.get_all("License-File", [])}
        required = {"LICENSE"} if platform is None else {"LICENSE", "THIRD_PARTY_NOTICES.md"}
        if metadata["License-Expression"] != "MIT" or licenses != required:
            raise ValueError("Harness license declaration missing")
        for name in metadata.get_all("License-File", []):
            if not archive.read(dist_info + "licenses/" + name):
                raise ValueError("Empty Harness license file")
        if platform is None:
            requirements = metadata.get_all("Requires-Dist", [])
            pins = [item for item in requirements if item.startswith("deepseek-harness-runtime-bin")]
            if pins != [f"deepseek-harness-runtime-bin=={version}"]:
                raise ValueError("Harness SDK must pin the same runtime version")
        else:
            executable = lock["platforms"][platform]["executable"]
            companion = executable[:-4] + "-rg.exe" if executable.endswith(".exe") else executable + "-rg"
            root = "deepseek_harness_runtime/runtime/"
            resource_dir = executable.removeprefix("deepseek-harness-sdk-runtime-").removesuffix(".exe")
            for name in (executable, companion):
                info = archive.getinfo(root + name)
                if not info.file_size or (platform.startswith("linux-") and not (info.external_attr >> 16) & 0o100):
                    raise ValueError("Missing or non-executable Harness runtime payload")
            if not any(name.startswith(root + resource_dir + "/") for name in names):
                raise ValueError("Harness runtime resource directory missing")
        if archive.testzip() is not None:
            raise ValueError("Harness wheel CRC mismatch")
    return {"filename": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "size": path.stat().st_size, "version": version, "distribution": distribution}


def verify_staged_wheels(directory: Path, platform: str) -> list[Path]:
    """安装之前核对审计回执；不执行待安装 wheel 中的任何 Python。"""
    lock = load_lock()
    suffix = {"win-x64": "windows", "linux-x64": "linux"}.get(platform)
    if not suffix:
        raise ValueError("Unsupported Harness target platform")
    receipt = json.loads(LOCK_PATH.with_name(f"deepseek-harness.build-{suffix}.json").read_text(encoding="utf-8"))
    if receipt.get("commit") != lock["commit"] or receipt.get("pythonVersion") != lock["pythonVersion"]:
        raise ValueError("Harness build receipt does not match source lock")
    paths, distributions = [], set()
    for wheel in receipt["wheels"]:
        name = wheel["filename"]
        if Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError("Invalid Harness wheel receipt path")
        path = directory / name
        actual = verify_wheel(path, lock, platform if "runtime_bin" in name else None)
        if actual["sha256"] != wheel["sha256"]:
            raise ValueError("Harness wheel digest differs from audited build")
        distributions.add(actual["distribution"])
        paths.append(path)
    if len(paths) != 2 or distributions != {"deepseek-harness-sdk", "deepseek-harness-runtime-bin"}:
        raise ValueError("Harness receipt must contain exactly the paired wheels")
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="固定 commit 的干净源码 checkout")
    parser.add_argument("--sdk-wheel", type=Path)
    parser.add_argument("--runtime-wheel", type=Path)
    parser.add_argument("--platform", choices=tuple(load_lock()["platforms"]))
    parser.add_argument("--verify-staged", type=Path, help="安装前核对暂存 wheel 的固定构建摘要")
    args = parser.parse_args()
    if bool(args.runtime_wheel or args.verify_staged) != bool(args.platform):
        parser.error("--runtime-wheel and --platform must be supplied together")
    lock = load_lock()
    receipt: dict[str, Any] = {"version": lock["version"], "origin": lock["distribution"]}
    if args.source:
        receipt["source"] = verify_source(args.source.resolve(), lock)
    if args.sdk_wheel:
        receipt["sdk"] = verify_wheel(args.sdk_wheel, lock)
    if args.runtime_wheel:
        receipt["runtime"] = verify_wheel(args.runtime_wheel, lock, args.platform)
    if args.verify_staged:
        receipt["verifiedStaged"] = [str(path) for path in verify_staged_wheels(args.verify_staged, args.platform)]
    receipt["pairedWheelsVerified"] = bool(args.verify_staged or (args.sdk_wheel and args.runtime_wheel))
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
