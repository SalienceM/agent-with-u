"""Portable AWU command declarations. Parsing metadata never runs package code."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import PurePosixPath
from typing import Any

FILENAME = "awu.commands.json"
MAX_BYTES = 128_000
SKILL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
COMMAND = re.compile(r"^/[a-z][a-z0-9-]{0,63}$")
# 与应用命令保持一致；声明不能抢占应用或保留通道。
RESERVED = frozenset({"/help", "/clear", "/new", "/compact", "/continue", "/model",
    "/backend", "/autocontinue", "/export", "/status", "/config", "/skill", "/native",
    "/cost", "/init", "/migrate", "/commit", "/git"})


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def _object(value: Any, allowed: set[str], required: set[str]) -> dict:
    if not isinstance(value, dict) or set(value) - allowed or required - set(value):
        raise ValueError("命令配置存在未知字段或缺少必填字段")
    return value


def _text(value: Any, maximum: int = 240) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\0" in value:
        raise ValueError("命令配置的文本为空、过长或含有 NUL")
    return value


def _list(value: Any, maximum: int = 128) -> list:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("命令配置的列表格式或数量不正确")
    return value


def safe_path(value: Any) -> str:
    value = _text(value, 256)
    path = PurePosixPath(value)
    if path.is_absolute() or "\\" in value or ":" in value or any(p in {"", ".", ".."} for p in value.split("/")):
        raise ValueError("预检路径必须是项目内的相对路径")
    return value


def validate_checks(value: Any) -> None:
    obj = _object(value, {"requiredPaths", "absentPaths", "noAncestorPaths", "yamlGuards"}, set())
    for key in ("requiredPaths", "absentPaths", "noAncestorPaths"):
        for path in _list(obj.get(key, []), 16):
            safe_path(path)
    for guard in _list(obj.get("yamlGuards", []), 8):
        _object(guard, {"path", "forbidKeys"}, {"path", "forbidKeys"})
        safe_path(guard["path"])
        for key in _list(guard["forbidKeys"], 16):
            _text(key, 80)


def validate_cli(value: Any) -> None:
    obj = _object(value, {"executable", "windowsExecutable", "localBin"}, {"executable"})
    for key in ("executable", "windowsExecutable"):
        if key in obj and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}", _text(obj[key])):
            raise ValueError("CLI 必须是可执行文件名，不能包含路径或 shell 表达式")
    if "localBin" in obj:
        safe_path(obj["localBin"])


def parse_manifest(raw: str | bytes) -> dict:
    if len(raw.encode("utf-8") if isinstance(raw, str) else raw) > MAX_BYTES:
        raise ValueError(f"{FILENAME} 超过 128 KB")
    def unique_pairs(pairs: list) -> dict:
        result: dict = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("命令配置存在重复 JSON 字段")
            result[key] = value
        return result
    try:
        data = json.loads(raw, object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError(f"{FILENAME} 不是有效 JSON：{exc}") from None
    _object(data, {"schemaVersion", "id", "skillIds", "commands"}, {"schemaVersion", "id", "skillIds", "commands"})
    if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1:
        raise ValueError("不支持的命令配置版本（当前为 1）")
    if not SKILL_ID.fullmatch(_text(data["id"], 128)):
        raise ValueError("配置 id 格式无效")
    owners = _list(data["skillIds"])
    if not owners or any(not isinstance(name, str) or not SKILL_ID.fullmatch(name) for name in owners) or len(set(owners)) != len(owners):
        raise ValueError("skillIds 必须是不重复的 Skill ID 列表")
    names: set[str] = set()
    for command in _list(data["commands"]):
        _object(command, {"name", "description", "kind", "skillId", "cli", "argv", "parameters", "checks", "instructions"},
                {"name", "description", "kind"})
        name = _text(command["name"], 65)
        if not COMMAND.fullmatch(name) or name in RESERVED or name in names:
            raise ValueError(f"命令名非法、重复或为应用保留命令：{name}")
        names.add(name)
        _text(command["description"])
        kind = command["kind"]
        if kind not in ("skill", "project"):
            raise ValueError("kind 必须是 skill 或 project")
        if "checks" in command:
            validate_checks(command["checks"])
        if "cli" in command:
            validate_cli(command["cli"])
        if "instructions" in command:
            _text(command["instructions"], 8000)
        if kind == "skill":
            if command.get("skillId") not in owners or any(k in command for k in ("argv", "parameters")):
                raise ValueError("Skill 命令必须指向 skillIds 内的 Skill，参数为用户任务原文")
            continue
        if "skillId" in command or "cli" not in command or "argv" not in command:
            raise ValueError("项目命令必须声明 cli 和 argv，不能声明 skillId")
        parameters = _list(command.get("parameters", []), 8)
        parameter_names: set[str] = set()
        optional = False
        for parameter in parameters:
            _object(parameter, {"name", "type", "choices", "required", "default"}, {"name", "type"})
            key = parameter["name"]
            if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", key) or key in parameter_names:
                raise ValueError("参数名不合法或重复")
            parameter_names.add(key)
            if type(parameter.get("required", False)) is not bool or (optional and parameter.get("required")):
                raise ValueError("必填参数必须位于可选参数之前")
            optional = not parameter.get("required", False)
            if parameter["type"] not in ("id", "enum", "idOrEnum"):
                raise ValueError("CLI 参数类型只能是 id、enum 或 idOrEnum")
            choices = _list(parameter.get("choices", []), 32)
            if any(not isinstance(c, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", c) for c in choices):
                raise ValueError("枚举参数必须是简单标识符或选项")
            if parameter["type"] != "id" and not choices:
                raise ValueError("枚举参数缺少 choices")
            if "default" in parameter:
                validate_parameter(parameter, parameter["default"])
        for arg in _list(command["argv"], 64):
            _text(arg, 512)
            if "{" in arg or "}" in arg:
                if arg not in {"{" + key + "}" for key in parameter_names}:
                    raise ValueError("argv 只允许完整参数占位符，不允许字符串插值")
    return data


def validate_parameter(parameter: dict, value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("CLI 参数必须是文本")
    valid_id = bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value))
    kind = parameter["type"]
    if (kind in {"id", "idOrEnum"} and valid_id) or (kind in {"enum", "idOrEnum"} and value in parameter.get("choices", [])):
        return value
    raise ValueError(f"参数 {parameter['name']} 不符合声明的类型；不接受路径或 shell 表达式")


def compile_arguments(command: dict, text: str) -> list[str]:
    values = text.split()
    parameters = command.get("parameters", [])
    if len(values) > len(parameters):
        raise ValueError("参数数量超过命令声明")
    bound: dict[str, str | None] = {}
    for index, parameter in enumerate(parameters):
        value = values[index] if index < len(values) else parameter.get("default")
        if value is None and parameter.get("required"):
            raise ValueError(f"缺少必填参数：{parameter['name']}")
        bound[parameter["name"]] = validate_parameter(parameter, value) if value is not None else None
    result: list[str] = []
    for arg in command["argv"]:
        value = bound[arg[1:-1]] if arg.startswith("{") else arg
        if value is not None:
            result.append(value)
    return result
