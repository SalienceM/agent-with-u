"""保存连接的 Linux Kit：沿用 Kit 命令执行器、版本和停止语义。"""
from __future__ import annotations

import base64
import copy
import json
import os
import time
import uuid

from .ssh_connections import ConnectionStore, authentication, endpoint, known_hosts, probe, ssh_options, test_connection
from .workspace_kit_store import FINAL_RUN_STATUSES


def key_candidate(legacy: dict) -> dict:
    """复用旧版已验收的部署正文；认证入口改为冻结的连接引用。旧版字节保持不变。"""
    candidate = copy.deepcopy(legacy)
    command = candidate["steps"][0]["command"].split("$sshArgs = @(", 1)[0]
    command = command.replace("$password = [string]$env:KIT_INPUT_SSH_PASSWORD\n", "")
    command = command.replace("$sudoPassword = [string]$env:KIT_INPUT_SUDO_PASSWORD\n", "")
    start = command.index("sudo_pw_b64=''")
    end = command.index('repo="$(printf', start)
    command = command[:start] + command[end:]
    start = command.index('elif [ -n "$sudo_password" ]')
    end = command.index("else\n", start)
    command = command[:start] + command[end:]
    command = command.replace("    sudo-password) printf '%s\\n' \"$sudo_password\" | sudo -S -p '' docker \"$@\" ;;\n", "")
    command = command.replace("远端账户没有 Docker 权限，且提供的 sudo 密码无效；请检查账户权限",
                              "远端账户需要 Docker 权限或已配置的免密 sudo；本连接不保存 sudo 密码")
    command = command.replace("# 权限写入随机临时文件，再交给 Bash；SSH stdin 专门承载 sudo 密码。",
                              "# 权限写入随机临时文件，再交给 Bash。")
    command += r'''# 连接参数与公钥由 Kit 执行器冻结，绝不接受自动更新指纹或密码回退。
$knownHostsPath = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllBytes($knownHostsPath, [Convert]::FromBase64String($env:KIT_SSH_KNOWN_HOSTS))
  $sshArgs = @((ConvertFrom-Json $env:KIT_SSH_ARGUMENTS_JSON) | ForEach-Object {
    ([string]$_).Replace('__AWU_KNOWN_HOSTS__', $knownHostsPath)
  })
  $sshArgs += @("$userName@$hostName", $remoteCommand)
  '' | & $ssh @sshArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -LiteralPath $knownHostsPath -Force -ErrorAction SilentlyContinue
}'''
    candidate["steps"][0].update(command=command, config={"sshConnection": 1})
    candidate["inputs"] = [
        {"key": "ssh_connection", "label": "已保存的 SSH 连接", "type": "text", "required": True},
        *[item for item in candidate["inputs"] if item["key"] in {"remote_repo", "git_branch", "build_proxy"}],
    ]
    candidate["description"] = "通过已核对指纹的 SSH 密钥连接更新 Linux Backend/Web"
    return candidate


class KitSshConnectionsBridge:
    def _ssh_guard(self, session_id: str) -> None:
        self._require_session_access(session_id)
        self._require_node_update_capability()

    def _ssh_store(self) -> ConnectionStore:
        return ConnectionStore(self._current_owner_id())

    def _ssh_template(self, *, key: bool = False) -> dict:
        legacy = self._kit_builtin_ssh_linux_update_candidate("SSH update AgentWithU", [])
        return key_candidate(legacy) if key else legacy

    def _ssh_kit_mode(self, kit) -> str:
        if kit and len(kit.steps) == 1 and kit.steps[0].get("type") == "command":
            for mode in ("legacy", "key"):
                expected = self._ssh_template(key=mode == "key")["steps"][0]
                actual = kit.steps[0]
                if (actual.get("command", "").replace("\r\n", "\n") == expected["command"]
                        and actual.get("target", kit.execution_target) == "executor"
                        and actual.get("shell", kit.shell) == "powershell"):
                    return mode
        return "custom"

    def _rpc_kitSshConnections(self, session_id: str, kit_id: str) -> str:
        self._ssh_guard(session_id)
        kit = self._kit_find(self._kit_get(session_id), kit_id)
        if not kit:
            raise ValueError("Kit 不存在")
        return json.dumps({"status": "ok", "mode": self._ssh_kit_mode(kit),
                           "profiles": self._ssh_store().list()}, ensure_ascii=False)

    async def _rpc_kitSshProbe(self, session_id: str, data_json: str) -> str:
        self._ssh_guard(session_id)
        data = json.loads(data_json)
        result = await probe(data)
        self._ssh_guard(session_id)
        probes = self.__dict__.setdefault("_ssh_connection_probes", {})
        now = time.time()
        for key in list(probes):
            if probes[key]["expires"] < now:
                del probes[key]
        if len(probes) >= 64:
            raise ValueError("待核对的连接过多，请稍后再试")
        pid = str(uuid.uuid4())
        probes[pid] = {"owner": self._current_owner_id(), "session": session_id,
                       "expires": now + 600, "profile": result}
        return json.dumps({"status": "ok", "probeId": pid, **result}, ensure_ascii=False)

    def _rpc_kitSshSave(self, session_id: str, data_json: str, request_id: str) -> str:
        self._ssh_guard(session_id)
        data = json.loads(data_json)
        checked = getattr(self, "_ssh_connection_probes", {}).get(data.get("probeId"), {})
        if (checked.get("owner") != self._current_owner_id() or checked.get("session") != session_id
                or checked.get("expires", 0) < time.time()):
            raise ValueError("指纹核对已过期，请重新读取并核对服务器指纹")
        profile = checked["profile"]
        if endpoint(data) != {k: profile[k] for k in ("host", "port", "user")} or data.get("fingerprint") != profile["fingerprint"]:
            raise ValueError("连接或指纹已变化，请重新核对")
        if data.get("confirmed") is not True:
            raise ValueError("请先对照服务器管理端核对指纹，再保存")
        profile = {**profile, **authentication(data),
                   "label": str(data.get("label") or f"{profile['user']}@{profile['host']}").strip()[:100]}
        saved = self._ssh_store().save(profile, request_id)
        return json.dumps({"status": "ok", "profile": saved}, ensure_ascii=False)

    async def _rpc_kitSshTest(self, session_id: str, profile_id: str) -> str:
        self._ssh_guard(session_id)
        result = await test_connection(self._ssh_store().get(profile_id))
        self._ssh_guard(session_id)
        return json.dumps(result, ensure_ascii=False)

    def _rpc_kitSshUse(self, session_id: str, kit_id: str, profile_id: str, version_id: str) -> str:
        self._ssh_guard(session_id)
        if os.name != "nt":
            raise ValueError("此部署模板需要 Windows PowerShell 执行节点")
        profile = self._ssh_store().get(profile_id)
        state = self._kit_get(session_id)
        kit = self._kit_find(state, kit_id)
        if not kit or self._ssh_kit_mode(kit) not in {"legacy", "key"}:
            raise ValueError("这是自定义 SSH Kit，不能自动替换其命令；请新建标准 SSH 更新 Kit")
        selected = next((item.get("default") for item in kit.inputs if item["key"] == "ssh_connection"), None)
        if selected == profile_id and self._ssh_kit_mode(kit) == "key":
            return json.dumps({"status": "ok", "kit": kit.to_dict()}, ensure_ascii=False)
        if kit.active_version_id != version_id:
            raise ValueError("Kit 版本已变化，请刷新后选择连接")
        guard = self._kit_version_change_error(state, kit)
        if guard:
            raise ValueError(guard)
        if any(run.status not in FINAL_RUN_STATUSES and any(
                step.source_kit_id == kit_id or step.config.get("kitId") == kit_id for step in run.steps)
               for run in state.runs):
            raise ValueError("此 Kit 仍在组合运行中，请先等待或停止该运行，再更改连接")
        template = self._ssh_template(key=True)
        # 保留原部署路径/分支/代理默认值，只有认证实现进入新版本。
        old = {item["key"]: item for item in kit.inputs}
        inputs = [dict(item, **({"default": profile_id} if item["key"] == "ssh_connection" else {}))
                  if item["key"] == "ssh_connection" else old.get(item["key"], item) for item in template["inputs"]]
        patch = {"steps": template["steps"], "inputs": inputs, "description": template["description"],
                 "implementationSummary": "保存的连接使用固定服务器指纹和 SSH 密钥 / Agent；不保存密码。"}
        return self._rpc_kitUpdate(session_id, kit_id, json.dumps(patch, ensure_ascii=False))

    def _ssh_freeze(self, current, spec: dict, inputs: dict) -> dict:
        self._require_node_update_capability()
        if os.name != "nt" or self._ssh_kit_mode(current) != "key" or spec.get("config", {}).get("sshConnection") != 1:
            raise ValueError("保存的 SSH 连接仅用于标准 Windows SSH 更新 Kit")
        profile = self._ssh_store().get(str(inputs.get("ssh_connection", "")))
        authentication(profile)
        return {"owner": self._current_owner_id(), "profile": profile}

    def _ssh_runtime_env(self, snapshot: dict) -> dict[str, str]:
        self._require_node_update_capability()
        if snapshot.get("owner") != self._current_owner_id():
            raise ValueError("SSH 连接所属账号已变化，已停止执行")
        profile = snapshot["profile"]
        if self._ssh_store().get(profile["id"]) != profile:
            raise ValueError("SSH 连接与冻结计划不一致，已停止执行")
        authentication(profile)
        return {"KIT_INPUT_SSH_HOST": profile["host"], "KIT_INPUT_SSH_USER": profile["user"],
                "KIT_INPUT_SSH_PORT": str(profile["port"]),
                "KIT_SSH_KNOWN_HOSTS": base64.b64encode(known_hosts(profile).encode()).decode(),
                "KIT_SSH_ARGUMENTS_JSON": json.dumps(ssh_options(profile, "__AWU_KNOWN_HOSTS__"))}
