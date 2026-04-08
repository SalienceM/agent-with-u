#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
验证 PyInstaller 打包所需的关键模块是否已正确安装和导入。

Usage:
    python verify_pyimport.py
"""

import sys
import importlib

# 确保 Windows 控制台使用 UTF-8 编码
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

MODULES = [
    "websockets",
    "PIL",
    "httpx",
    "claude_agent_sdk",
    "PySide6",
]

SUBMODULES = [
    ("claude_agent_sdk", "query"),
    ("claude_agent_sdk", "ClaudeAgentOptions"),
]


def check_module(module_name: str) -> bool:
    """尝试导入模块并返回结果。"""
    try:
        importlib.import_module(module_name)
        print(f"[OK] {module_name}")
        return True
    except ImportError as e:
        print(f"[FAIL] {module_name}: {e}")
        return False


def main():
    print("=" * 60)
    print("PyInstaller 打包模块验证")
    print("=" * 60)
    print(f"Python: {sys.executable}")
    print(f"版本：{sys.version}")
    print()

    results = []
    for mod in MODULES:
        results.append(check_module(mod))

    # 检查子模块导入
    for parent, sub in SUBMODULES:
        try:
            parent_mod = importlib.import_module(parent)
            getattr(parent_mod, sub)
            print(f"[OK] {parent}.{sub}")
            results.append(True)
        except (ImportError, AttributeError) as e:
            print(f"[FAIL] {parent}.{sub}: {e}")
            results.append(False)

    print()
    print("=" * 60)
    success = sum(results)
    total = len(results)
    print(f"结果：{success}/{total} 模块可用")

    if success == total:
        print("[OK] 所有模块已正确安装，可以开始打包")
        return 0
    else:
        print("[FAIL] 部分模块缺失，请先安装缺失的模块")
        print()
        print("建议运行:")
        print("  pip install -r requirements.txt")
        return 1


if __name__ == "__main__":
    sys.exit(main())
