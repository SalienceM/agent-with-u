# -*- coding: utf-8 -*-
"""
test_skip_permission_flow.py - 测试跳过确认的非激活流程

测试场景:
  当 skip_permissions=False 时, 敏感工具(Bash/Edit/Write)需要用户确认。
  但如果 on_permission_request 回调未设置(非激活状态), 权限应被自动授予。

运行方式:
  python test_skip_permission_flow.py
"""

import asyncio
import sys
import os

# 设置控制台编码
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 敏感工具列表 (与 backends.py 中定义一致)
PERMISSION_SENSITIVE_TOOLS = {"Bash", "Edit", "Write"}


class PermissionRequest:
    """权限请求类"""

    def __init__(self, session_id: str, message_id: str, tool_id: str,
                 tool_name: str, tool_input: str):
        self.session_id = session_id
        self.message_id = message_id
        self.tool_id = tool_id
        self.tool_name = tool_name
        self.tool_input = tool_input
        self._event = asyncio.Event()
        self._granted = None

    def grant(self, granted: bool):
        self._granted = granted
        self._event.set()

    async def wait_for_decision(self, timeout: float = 300.0) -> bool:
        try:
            await asyncio.wait_for(self._event.wait(), timeout=timeout)
            return self._granted or False
        except asyncio.TimeoutError:
            return False


class SkipRestManager:
    """模拟 bridge_ws.py 中的 skip_rest 逻辑"""

    def __init__(self):
        self._skip_rest_sessions: set[str] = set()

    def grant_permission(self, session_id: str, granted: bool, skip_rest: bool = False):
        """处理权限确认"""
        if skip_rest and granted:
            self._skip_rest_sessions.add(session_id)
            print(f"    [SkipRestManager] Session {session_id} 设置 skip_rest=True")

    def check_skip_permission(self, session_id: str) -> bool:
        """检查 session 是否已设置跳过权限确认"""
        return session_id in self._skip_rest_sessions

    def clear_skip_permission(self, session_id: str):
        """清除 session 的跳过权限标志"""
        self._skip_rest_sessions.discard(session_id)


async def mock_wait_for_permission(
    tool_name: str,
    tool_id: str,
    skip_permissions: bool,
    on_permission_request,
    skip_rest_manager: SkipRestManager,
    session_id: str
) -> bool:
    """
    模拟 backends.py 中的 _wait_for_permission 逻辑

    核心逻辑:
    1. skip_permissions=True -> 直接返回 True
    2. 工具不在敏感列表 -> 直接返回 True
    3. skip_rest 已设置 -> 直接返回 True (★ 新增)
    4. on_permission_request=None (非激活) -> 直接返回 True
    5. 否则调用回调等待用户决策
    """
    if skip_permissions:
        print(f"    [DEBUG] skip_permissions=True, 自动授予")
        return True

    if tool_name not in PERMISSION_SENSITIVE_TOOLS:
        print(f"    [DEBUG] {tool_name} 不在敏感列表, 自动授予")
        return True

    # ★ 新增: 检查 skip_rest 标志
    if skip_rest_manager.check_skip_permission(session_id):
        print(f"    [DEBUG] skip_rest 已设置, 自动授予")
        return True

    if not on_permission_request:
        print(f"    [DEBUG] on_permission_request=None (非激活), 自动授予")
        return True

    # 激活流程: 创建权限请求并等待
    print(f"    [DEBUG] 激活流程, 等待用户确认...")
    req = PermissionRequest(
        session_id=session_id,
        message_id="test-msg",
        tool_id=tool_id,
        tool_name=tool_name,
        tool_input=""
    )
    return await on_permission_request(req)


class TestResult:
    """收集测试结果"""
    def __init__(self):
        self.permission_requests = []
        self.permission_decisions = []

    async def on_permission_request(self, req: PermissionRequest) -> bool:
        self.permission_requests.append(req)
        print(f"    [Permission] 请求确认: tool={req.tool_name}")
        decision = True  # 模拟用户同意
        self.permission_decisions.append(decision)
        return decision


def print_header(title: str):
    print("\n" + "=" * 60)
    print(f"  {title}")
    print("=" * 60)


async def test1_skip_permissions_true():
    """测试 1: skip_permissions=True - 应直接跳过所有权限检查"""
    print_header("Test 1: skip_permissions=True")

    print("  测试所有工具在 skip_permissions=True 时的行为:")

    for tool_name in ["Read", "Bash", "Edit", "Write"]:
        is_sensitive = tool_name in PERMISSION_SENSITIVE_TOOLS
        granted = await mock_wait_for_permission(
            tool_name=tool_name,
            tool_id=f"tool-{tool_name}",
            skip_permissions=True,  # 关键: 跳过确认
            on_permission_request=None,
            skip_rest_manager=SkipRestManager(),
            session_id="test-session"
        )
        status = "PASS" if granted else "FAIL"
        print(f"  [{status}] {tool_name}: 敏感={is_sensitive}, 授予={granted}")

        if not granted:
            print("    ERROR: skip_permissions=True 时应自动授予!")
            return False

    print("\n  [OK] Test 1 通过: skip_permissions=True 时所有工具直接执行")
    return True


async def test2_non_activated_flow():
    """测试 2: skip_permissions=False + 无回调 -> 非激活流程, 自动授予"""
    print_header("Test 2: skip_permissions=False + 无回调 (非激活)")

    print("  测试非激活流程 (on_permission_request=None):")

    for tool_name in ["Read", "Bash", "Edit", "Write"]:
        is_sensitive = tool_name in PERMISSION_SENSITIVE_TOOLS
        granted = await mock_wait_for_permission(
            tool_name=tool_name,
            tool_id=f"tool-{tool_name}",
            skip_permissions=False,  # 不跳过
            on_permission_request=None,  # 关键: 无回调 -> 非激活
            skip_rest_manager=SkipRestManager(),
            session_id="test-session"
        )
        status = "PASS" if granted else "FAIL"
        print(f"  [{status}] {tool_name}: 敏感={is_sensitive}, 授予={granted}")

        if not granted:
            print("    ERROR: 非激活流程应自动授予敏感工具权限!")
            return False

    print("\n  [OK] Test 2 通过: 非激活流程时敏感工具自动获得权限")
    return True


async def test3_activated_flow():
    """测试 3: skip_permissions=False + 有回调 -> 激活流程, 等待确认"""
    print_header("Test 3: skip_permissions=False + 有回调 (激活)")

    result = TestResult()
    skip_rest_manager = SkipRestManager()

    print("  测试激活流程 (on_permission_request 已设置):")

    # 非敏感工具: 应直接通过
    for tool_name in ["Read"]:
        granted = await mock_wait_for_permission(
            tool_name=tool_name,
            tool_id=f"tool-{tool_name}",
            skip_permissions=False,
            on_permission_request=result.on_permission_request,
            skip_rest_manager=skip_rest_manager,
            session_id="test-session"
        )
        is_sensitive = tool_name in PERMISSION_SENSITIVE_TOOLS
        status = "PASS" if granted else "FAIL"
        print(f"  [{status}] {tool_name}: 敏感={is_sensitive}, 授予={granted}")

    # 敏感工具: 应触发权限请求
    for tool_name in ["Bash", "Edit", "Write"]:
        granted = await mock_wait_for_permission(
            tool_name=tool_name,
            tool_id=f"tool-{tool_name}",
            skip_permissions=False,
            on_permission_request=result.on_permission_request,
            skip_rest_manager=skip_rest_manager,
            session_id="test-session"
        )
        is_sensitive = tool_name in PERMISSION_SENSITIVE_TOOLS
        status = "PASS" if granted else "FAIL"
        print(f"  [{status}] {tool_name}: 敏感={is_sensitive}, 授予={granted}")

    # 验证权限请求次数
    print(f"\n  权限请求次数: {len(result.permission_requests)}")

    if len(result.permission_requests) != 3:
        print(f"    ERROR: 应触发 3 次权限请求 (Bash/Edit/Write)")
        return False

    print("\n  [OK] Test 3 通过: 激活流程正确触发权限请求")
    return True


async def test4_permission_request_class():
    """测试 4: PermissionRequest 类功能"""
    print_header("Test 4: PermissionRequest 类")

    req = PermissionRequest(
        session_id="test-session",
        message_id="test-msg",
        tool_id="tool-123",
        tool_name="Bash",
        tool_input="echo test"
    )

    print(f"  创建请求: tool={req.tool_name}, id={req.tool_id}")

    # 测试 grant
    req.grant(True)
    print(f"  调用 grant(True)")
    print(f"  _granted = {req._granted}")
    print(f"  _event.is_set() = {req._event.is_set()}")

    if req._granted != True:
        print("    ERROR: grant 后 _granted 应为 True")
        return False

    # 测试 wait_for_decision
    result = await req.wait_for_decision(timeout=0.1)
    print(f"  wait_for_decision(0.1s) = {result}")

    if result != True:
        print("    ERROR: 已 grant 的请求应返回 True")
        return False

    print("\n  [OK] Test 4 通过: PermissionRequest 类功能正确")
    return True


async def test5_skip_rest_immediate_effect():
    """测试 5: skip rest 点击后即时生效"""
    print_header("Test 5: skip rest 即时生效")

    skip_rest_manager = SkipRestManager()
    result = TestResult()

    print("  模拟用户点击 '允许并跳过后续' 按钮:")

    # 第一次权限请求: 触发权限确认
    print("\n  [第1个工具 Bash]")
    granted = await mock_wait_for_permission(
        tool_name="Bash",
        tool_id="tool-1",
        skip_permissions=False,
        on_permission_request=result.on_permission_request,
        skip_rest_manager=skip_rest_manager,
        session_id="test-session"
    )
    print(f"  权限请求次数: {len(result.permission_requests)}, 授予: {granted}")

    # 模拟用户点击 "允许并跳过后续"
    print("\n  用户点击 '允许并跳过后续'...")
    skip_rest_manager.grant_permission("test-session", granted=True, skip_rest=True)

    # 后续工具: 应自动授予，不再触发权限请求
    print("\n  [第2个工具 Edit]")
    granted = await mock_wait_for_permission(
        tool_name="Edit",
        tool_id="tool-2",
        skip_permissions=False,
        on_permission_request=result.on_permission_request,
        skip_rest_manager=skip_rest_manager,
        session_id="test-session"
    )
    print(f"  权限请求次数: {len(result.permission_requests)}, 授予: {granted}")

    print("\n  [第3个工具 Write]")
    granted = await mock_wait_for_permission(
        tool_name="Write",
        tool_id="tool-3",
        skip_permissions=False,
        on_permission_request=result.on_permission_request,
        skip_rest_manager=skip_rest_manager,
        session_id="test-session"
    )
    print(f"  权限请求次数: {len(result.permission_requests)}, 授予: {granted}")

    # 验证: 只有第一个工具触发了权限请求
    if len(result.permission_requests) != 1:
        print(f"\n  [FAIL] 权限请求次数应为 1，实际为 {len(result.permission_requests)}")
        return False

    print("\n  [OK] Test 5 通过: skip rest 点击后即时生效，后续工具自动授权")
    return True


async def test6_session_level_skip_permissions():
    """测试 6: skip_permissions 是 session 级别的设置"""
    print_header("Test 6: skip_permissions session 级别设置")

    print("  模拟切换 session 时 skip_permissions 状态同步:")

    # 模拟两个 session
    sessions = {
        "session-A": {"skip_permissions": True, "name": "Session A"},
        "session-B": {"skip_permissions": False, "name": "Session B"},
    }

    # 模拟切换 session
    print("\n  切换到 Session A (skip_permissions=True):")
    current_session = "session-A"
    current_skip = sessions[current_session]["skip_permissions"]
    print(f"    skip_permissions = {current_skip}")
    granted = await mock_wait_for_permission(
        tool_name="Bash",
        tool_id="tool-1",
        skip_permissions=current_skip,
        on_permission_request=None,  # 非激活
        skip_rest_manager=SkipRestManager(),
        session_id=current_session
    )
    print(f"    Bash 工具授权: {granted}")
    if not granted:
        print("    [FAIL] skip_permissions=True 时应自动授权")
        return False

    print("\n  切换到 Session B (skip_permissions=False, 激活权限确认):")
    current_session = "session-B"
    current_skip = sessions[current_session]["skip_permissions"]
    print(f"    skip_permissions = {current_skip}")

    # 创建一个测试结果对象来捕获权限请求
    result = TestResult()
    skip_rest_manager = SkipRestManager()

    granted = await mock_wait_for_permission(
        tool_name="Bash",
        tool_id="tool-2",
        skip_permissions=current_skip,
        on_permission_request=result.on_permission_request,
        skip_rest_manager=skip_rest_manager,
        session_id=current_session
    )
    print(f"    权限请求次数: {len(result.permission_requests)}, 授予: {granted}")

    if len(result.permission_requests) != 1:
        print(f"    [FAIL] skip_permissions=False 时应触发权限请求")
        return False

    print("\n  切回 Session A:")
    current_session = "session-A"
    current_skip = sessions[current_session]["skip_permissions"]
    print(f"    skip_permissions = {current_skip} (从 session 加载)")

    granted = await mock_wait_for_permission(
        tool_name="Edit",
        tool_id="tool-3",
        skip_permissions=current_skip,
        on_permission_request=None,
        skip_rest_manager=SkipRestManager(),
        session_id=current_session
    )
    print(f"    Edit 工具授权: {granted}")
    if not granted:
        print("    [FAIL] Session A 的 skip_permissions=True 应生效")
        return False

    print("\n  [OK] Test 6 通过: skip_permissions 正确地在 session 级别维护")
    return True


async def main():
    """运行所有测试"""
    print("=" * 60)
    print("  跳过确认的非激活流程测试")
    print("  (skip_permissions flow test)")
    print("=" * 60)

    tests = [
        ("Test 1: skip_permissions=True", test1_skip_permissions_true),
        ("Test 2: 非激活流程 (无回调)", test2_non_activated_flow),
        ("Test 3: 激活流程 (有回调)", test3_activated_flow),
        ("Test 4: PermissionRequest 类", test4_permission_request_class),
        ("Test 5: skip rest 即时生效", test5_skip_rest_immediate_effect),
        ("Test 6: session 级别 skip_permissions", test6_session_level_skip_permissions),
    ]

    results = {}
    for name, test_func in tests:
        try:
            results[name] = await test_func()
        except Exception as e:
            print(f"\n  [ERROR] 测试异常: {e}")
            import traceback
            traceback.print_exc()
            results[name] = False

    # 汇总
    print("\n" + "=" * 60)
    print("  测试汇总 (Summary)")
    print("=" * 60)

    passed = 0
    failed = 0
    for name, result in results.items():
        status = "[PASS]" if result else "[FAIL]"
        print(f"  {status} {name}")
        if result:
            passed += 1
        else:
            failed += 1

    print("\n" + "-" * 60)
    print(f"  通过: {passed}/{len(results)}")
    print(f"  失败: {failed}/{len(results)}")

    if failed == 0:
        print("\n  [SUCCESS] 所有测试通过!")
    else:
        print("\n  [WARNING] 部分测试失败")
    print("=" * 60)

    return failed == 0


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)