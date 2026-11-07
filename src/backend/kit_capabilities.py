"""Workspace Kit 到 AgentWithU 内建服务的受控能力协议。

Kit 只能按这里注册的稳定 capability id 调用产品能力，不能把任意 Bridge RPC
名称当作步骤执行。高风险能力先生成不可变计划，再等待人类或有效的单次委托确认。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Callable, Awaitable

from .release_center import ReleaseCenterManager

UPDATE_CAPABILITY = "node.update_local_published"
CHECK_UPDATE_CAPABILITY = "node.check_update_local"
BUILD_UPDATE_CAPABILITY = "node.update_local_build"
LOCAL_UPDATE_CAPABILITIES = frozenset({UPDATE_CAPABILITY, CHECK_UPDATE_CAPABILITY, BUILD_UPDATE_CAPABILITY})


class KitCapabilityError(RuntimeError):
    """能力不存在、参数无效或能力执行失败。"""


@dataclass(frozen=True)
class KitLocalUpdateServices:
    """运行器注入的窄接口；闭包固定 Session/run/step，不能接受 RPC/目标/安装命令。"""
    prepare: Callable[[], Awaitable[dict[str, Any]]]
    reconcile: Callable[[], dict[str, Any]]
    cancel: Callable[[], None]


@dataclass(frozen=True)
class KitCapabilityContext:
    release_center: ReleaseCenterManager
    working_dir: Path
    source: str
    run_id: str = ""
    step_id: str = ""
    build_receipt: dict[str, Any] | None = None
    local_update: KitLocalUpdateServices | None = None


class KitCapabilityHandler(Protocol):
    id: str
    title: str
    description: str
    risk_level: str
    permission: str
    approval: str
    requires_explicit_intent: bool
    intent_hints: tuple[str, ...]
    argument_schema: dict[str, Any]
    example: dict[str, Any]

    async def prepare(
        self, arguments: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]: ...

    async def start(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]: ...

    async def poll(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]: ...

    async def cancel(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> None: ...


def _filter_values(arguments: dict[str, Any], singular: str) -> set[str]:
    raw = arguments.get(f"{singular}s", arguments.get(singular))
    if raw in (None, ""):
        return set()
    values = raw if isinstance(raw, list) else [raw]
    return {str(item).strip().lower() for item in values if str(item).strip()}


def _public_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """保存和展示足以审计的冻结快照，不把上传器的内部字段耦合给 KIT。"""
    manifest = dict(plan.get("manifest") or {})
    return {
        "id": str(plan.get("id") or ""),
        "status": str(plan.get("status") or ""),
        "candidateId": str(plan.get("candidateId") or ""),
        "candidate": dict(plan.get("candidate") or {}),
        "channel": str(plan.get("channel") or ""),
        "manifestUrl": str(plan.get("manifestUrl") or ""),
        "manifestKey": str(plan.get("manifestKey") or ""),
        "qiniuBucket": str(plan.get("qiniuBucket") or ""),
        "retentionCount": int(plan.get("retentionCount") or 0),
        "artifacts": [
            dict(item) for item in (manifest.get("artifacts") or [])
            if isinstance(item, dict)
        ],
        "release": dict(manifest.get("release") or {}),
        "blockers": [str(item) for item in (plan.get("blockers") or [])],
        "warnings": [str(item) for item in (plan.get("warnings") or [])],
        "comparison": dict(plan.get("comparison") or {}),
        "fingerprint": str(plan.get("fingerprint") or ""),
        "signatureConfigured": bool(plan.get("signatureConfigured")),
        "createdAt": plan.get("createdAt"),
    }


class ReleasePublishLatestCapability:
    id = "release.publish_latest"
    title = "发布最新包"
    description = "扫描当前工作区的最新制品，冻结发布计划，并在人工或有效的本次委托确认后正式发布。"
    risk_level = "high"
    permission = "node.release.manage"
    approval = "required"
    requires_explicit_intent = True
    intent_hints = ("发布", "publish", "release", "上线最新包", "更新发布清单", "打包上传", "上传制品")
    argument_schema = {
        "projectRoot": {
            "type": "string", "default": ".",
            "description": "Session 工作空间内的项目目录",
        },
        "channel": {
            "type": "string", "default": "stable",
            "description": "发布通道",
        },
        "notes": {"type": "string", "description": "本次更新说明"},
        "bindBuild": {"type": "boolean", "optional": True,
                      "description": "仅发布当前运行的已验证构建输出"},
        "platforms": {
            "type": "string[]", "optional": True,
            "description": "只选择指定平台，如 windows/linux/macos",
        },
        "archs": {
            "type": "string[]", "optional": True,
            "description": "只选择指定架构",
        },
        "targets": {
            "type": "string[]", "optional": True,
            "description": "只选择指定安装目标，如 desktop/docker/executor",
        },
        "kinds": {
            "type": "string[]", "optional": True,
            "description": "只选择指定制品类型，如 msi/nsis/docker-bundle",
        },
        "artifactIds": {
            "type": "string[]", "optional": True,
            "description": "精确选择发布中心制品 ID",
        },
    }
    example = {
        "type": "awu_capability",
        "target": "executor",
        "title": "发布最新包",
        "config": {
            "capability": "release.publish_latest",
            "arguments": {
                "projectRoot": ".", "channel": "stable", "notes": "本次更新说明",
            },
        },
    }

    @staticmethod
    def _project_root(arguments: dict[str, Any], working_dir: Path) -> Path:
        raw = str(arguments.get("projectRoot") or ".").strip() or "."
        requested = Path(raw).expanduser()
        root = requested.resolve() if requested.is_absolute() else (working_dir / requested).resolve()
        if root != working_dir and working_dir not in root.parents:
            raise KitCapabilityError("发布项目目录不能超出当前 Session 工作空间")
        if not root.is_dir():
            raise KitCapabilityError(f"发布项目目录不存在：{root}")
        return root

    @staticmethod
    def _select_artifacts(
        candidate: dict[str, Any], arguments: dict[str, Any],
    ) -> list[dict[str, Any]]:
        artifacts = [
            dict(item) for item in (candidate.get("artifacts") or [])
            if isinstance(item, dict)
        ]
        raw_ids = arguments.get("artifactIds") or []
        explicit = {
            str(item) for item in (raw_ids if isinstance(raw_ids, list) else [raw_ids])
            if str(item).strip()
        }
        if explicit:
            artifacts = [item for item in artifacts if str(item.get("id") or "") in explicit]
        else:
            for field in ("platform", "arch", "target", "kind"):
                wanted = _filter_values(arguments, field)
                if wanted:
                    artifacts = [
                        item for item in artifacts
                        if str(item.get(field) or "").lower() in wanted
                    ]
            if not bool(arguments.get("includeStale", False)):
                artifacts = [item for item in artifacts if item.get("fresh") is not False]
        return artifacts

    async def prepare(
        self, arguments: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        root = self._project_root(arguments, context.working_dir)
        if arguments.get("bindBuild") is True:
            receipt = context.build_receipt or {}
            if receipt.get("runId") != context.run_id or not context.run_id:
                raise KitCapabilityError("发布缺少本次运行的构建回执")
            candidate = await asyncio.to_thread(
                context.release_center.verify_build_snapshot, receipt, root,
            )
        else:
            scanned = await asyncio.to_thread(
                context.release_center.scan_project, str(root), context.source,
            )
            candidate = dict(scanned.get("candidate") or {})
        selected = self._select_artifacts(candidate, arguments)
        if not selected:
            raise KitCapabilityError(
                "没有找到符合条件的本次新制品；请先完成打包，或调整平台/类型筛选"
            )
        options = {
            key: arguments[key] for key in (
                "channel", "notes", "baseUrl", "qiniuBucket", "prefix",
                "manifestKey", "stableManifestUrl", "requireSignature",
            ) if key in arguments
        }
        binding = {"kit_binding": {"runId": context.run_id, "stepId": context.step_id}} if arguments.get("bindBuild") is True else {}
        preview = await context.release_center.preview(
            str(candidate.get("id") or ""),
            [str(item.get("id") or "") for item in selected],
            options,
            **binding,
        )
        plan = dict(preview.get("plan") or {})
        if binding:
            frozen = (plan.get("manifest") or {}).get("artifacts") or []
            expected = {item["id"]: item for item in selected}
            if (len(frozen) != len(selected) or any(
                any(item.get(key) != expected.get(item.get("id"), {}).get(key)
                    for key in ("size", "sha256", "platform", "arch", "target", "kind", "install"))
                for item in frozen
            ) or any((plan.get("manifest") or {}).get("release", {}).get(key) != candidate.get(key)
                     for key in ("buildId", "version", "sequence", "kitUpdateProtocol"))):
                raise KitCapabilityError("构建候选在冻结发布计划期间已改变")
        public_plan = _public_plan(plan)
        blockers = list(public_plan.get("blockers") or [])
        return {
            "phase": "blocked" if blockers else "waiting_approval",
            "planId": str(plan.get("id") or ""),
            "planFingerprint": str(plan.get("fingerprint") or ""),
            "plan": public_plan,
            "message": (
                "发布预检存在阻断项" if blockers
                else "发布计划已冻结，等待人工确认或已获本次委托的 Agent 核对后确认"
            ),
        }

    async def start(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        plan_id = str(runtime.get("planId") or "")
        if not plan_id:
            raise KitCapabilityError("冻结发布计划不存在，请重新运行 KIT")
        result = await context.release_center.start_publish(plan_id)
        job = dict(result.get("job") or {})
        if not job.get("id"):
            raise KitCapabilityError("发布中心没有返回任务 ID")
        return job

    async def poll(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        job_id = str(runtime.get("jobId") or "")
        if not job_id:
            raise KitCapabilityError("发布任务 ID 不存在")
        job = await asyncio.to_thread(context.release_center.job_status, job_id)
        if job.get("status") == "succeeded" and runtime.get("boundBuild"):
            job["publishedRelease"] = await asyncio.to_thread(
                context.release_center.published_result, job_id,
                str(runtime.get("planId") or ""), str(runtime.get("planFingerprint") or ""),
                context.run_id, context.step_id,
            )
        return job

    async def cancel(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> None:
        job_id = str(runtime.get("jobId") or "")
        if job_id:
            await context.release_center.cancel_publish(job_id)


class LocalPublishedUpdateCapability:
    id = UPDATE_CAPABILITY
    title = "安装本次发布并验收重启"
    description = "仅安装同一次运行中唯一成功的 bindBuild 发布；不能独立使用。安装须在 Kit 面板单独确认。"
    risk_level = "high"
    permission = "node.update.manage"
    approval = "required"
    requires_explicit_intent = True
    intent_hints = ("本机更新", "更新本机", "本机完成更新", "本地更新", "安装本次发布", "local update")
    argument_schema = {}
    example = {"type": "awu_capability", "target": "executor", "title": title,
               "config": {"capability": id, "arguments": {}}}

    @staticmethod
    def _services(context: KitCapabilityContext) -> KitLocalUpdateServices:
        if context.local_update is None:
            raise KitCapabilityError("缺少本次执行器绑定的更新服务")
        return context.local_update

    async def prepare(self, arguments: dict[str, Any], context: KitCapabilityContext) -> dict[str, Any]:
        if arguments:
            raise KitCapabilityError("本机更新不能接受外部参数")
        return await self._services(context).prepare()

    async def start(self, runtime: dict[str, Any], context: KitCapabilityContext) -> dict[str, Any]:
        raise KitCapabilityError("安装只能由面板的独立冻结计划确认交接，不能从通用 start 启动")

    async def poll(self, runtime: dict[str, Any], context: KitCapabilityContext) -> dict[str, Any]:
        return self._services(context).reconcile()

    async def cancel(self, runtime: dict[str, Any], context: KitCapabilityContext) -> None:
        self._services(context).cancel()


class LocalCheckUpdateCapability(LocalPublishedUpdateCapability):
    id = CHECK_UPDATE_CAPABILITY
    title = "本机检查更新并验收重启"
    description = "从执行设备更新中心已配置的源与通道检查，冻结版本后下载；无更新则仅报告检查结果，有更新须面板独立确认安装。无需构建或发布步骤。"
    intent_hints = ("本机更新", "更新本机", "本机一键检查并更新", "检查并更新", "检查更新并安装",
                    "本地更新", "local update", "check and update")
    example = {"type": "awu_capability", "target": "executor", "title": title,
               "config": {"capability": id, "arguments": {}}}


class LocalBuildUpdateCapability(LocalPublishedUpdateCapability):
    id = BUILD_UPDATE_CAPABILITY
    title = "安装本次本机构建并验收重启"
    description = "直接使用当前运行唯一成功构建的本地安装包，校验并暂存后独立确认安装；不上传、不下载、不读取 latest。"
    intent_hints = ("本机更新", "更新本机", "本地更新", "本机打包", "本地打包", "本机构建", "本地构建", "local build", "local update")
    example = {"type": "awu_capability", "target": "executor", "title": title,
               "config": {"capability": id, "arguments": {}}}


class KitCapabilityRegistry:
    """稳定 capability id 白名单及其统一生命周期入口。"""

    def __init__(self) -> None:
        handlers = [ReleasePublishLatestCapability(), LocalPublishedUpdateCapability(), LocalCheckUpdateCapability(), LocalBuildUpdateCapability()]
        self._handlers = {handler.id: handler for handler in handlers}

    def metadata(self, capability_id: str) -> dict[str, Any]:
        handler = self._handlers.get(str(capability_id or ""))
        if handler is None:
            raise KitCapabilityError(f"未注册的 AgentWithU 能力：{capability_id}")
        return {
            "id": handler.id,
            "title": handler.title,
            "description": handler.description,
            "riskLevel": handler.risk_level,
            "permission": handler.permission,
            "approval": handler.approval,
            "requiresExplicitIntent": handler.requires_explicit_intent,
            "intentHints": list(handler.intent_hints),
            "argumentSchema": handler.argument_schema,
            "example": handler.example,
        }

    def list(self) -> list[dict[str, Any]]:
        return [self.metadata(capability_id) for capability_id in self._handlers]

    def intent_matches(self, capability_id: str, human_intent: str) -> bool:
        """判断人类契约是否明确授权使用该能力。

        这里不让模型自行解释“差不多算授权”：需要显式意图的能力必须命中能力
        自己登记的提示词。低风险、无需显式授权的能力则可由编译器按目标自动选择。
        """
        metadata = self.metadata(capability_id)
        if not metadata.get("requiresExplicitIntent"):
            return True
        normalized = str(human_intent or "").casefold()
        return any(
            str(hint).strip().casefold() in normalized
            for hint in (metadata.get("intentHints") or [])
            if str(hint).strip()
        )

    def validate(self, capability_id: str, arguments: Any) -> dict[str, Any]:
        self.metadata(capability_id)
        if arguments is None:
            return {}
        if not isinstance(arguments, dict):
            raise KitCapabilityError("AgentWithU 能力参数必须是 JSON 对象")
        if capability_id in LOCAL_UPDATE_CAPABILITIES and arguments:
            raise KitCapabilityError("本机更新不接受目标、路径、命令、owner 或外部发布回执参数")
        return dict(arguments)

    async def prepare(
        self, capability_id: str, arguments: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        handler = self._handlers[capability_id]
        return await handler.prepare(arguments, context)

    async def start(
        self, capability_id: str, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        return await self._handlers[capability_id].start(runtime, context)

    async def poll(
        self, capability_id: str, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        return await self._handlers[capability_id].poll(runtime, context)

    async def cancel(
        self, capability_id: str, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> None:
        await self._handlers[capability_id].cancel(runtime, context)
