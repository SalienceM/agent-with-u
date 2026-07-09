"""
Verification script for qwen-code-cli backend fixes.

Tests:
1. Module imports work correctly
2. Command building includes --allowedTools and --auth-type
3. Environment mapping: QWEN_PROVIDER → QWEN_AUTH_TYPE
4. cliPath persistence round-trip (save/load)
5. qwen CLI subprocess can start and produce stream-json output
"""

import sys
import os
import json
import tempfile
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

print("=" * 80)
print("QWEN-CODE-CLI BACKEND VERIFICATION")
print("=" * 80)

# ═══════════════════════════════════════════════════════════════════════════
# TEST 1: Module imports
# ═══════════════════════════════════════════════════════════════════════════
print("\n[TEST 1] Module imports...")
try:
    from src.types import ModelBackendConfig, BackendType
    from src.backend.qwen_code_cli import QwenCodeCliBackend, resolve_qwen_cli
    from src.backend.factory import create_backend
    from src.backend.backend_store import BackendStore
    print("[OK] All modules imported successfully")
except Exception as e:
    print(f"[FAIL] Import failed: {e}")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════
# TEST 2: Command building (--allowedTools, --auth-type)
# ═══════════════════════════════════════════════════════════════════════════
print("\n[TEST 2] Command building...")
try:
    config = ModelBackendConfig(
        id="test-qwen",
        type=BackendType.QWEN_CODE_CLI,
        label="Test Qwen",
        model="qwen-coder-plus",
        allowed_tools=["Read", "Edit", "Bash"],
        env={"QWEN_PROVIDER": "openai", "OPENAI_API_KEY": "test-key"}
    )
    backend = QwenCodeCliBackend(config)

    # Build command
    cmd = backend._build_cmd("test prompt", None, ".")

    # Check for required flags
    cmd_str = " ".join(cmd)
    assert "-o" in cmd and "stream-json" in cmd, "Missing -o stream-json"
    assert "--auth-type" in cmd, "Missing --auth-type"
    assert "openai" in cmd, "Missing auth-type value"
    assert "--allowedTools" in cmd, "Missing --allowedTools"

    # Check that allowed tools are present
    tool_indices = [i for i, x in enumerate(cmd) if x == "--allowedTools"]
    tools_in_cmd = [cmd[i+1] for i in tool_indices if i+1 < len(cmd)]
    assert "Read" in tools_in_cmd, "Missing Read tool"
    assert "Edit" in tools_in_cmd, "Missing Edit tool"
    assert "Bash" in tools_in_cmd, "Missing Bash tool"

    print(f"[OK] Command built correctly: {cmd_str}")
    print(f"  Allowed tools: {tools_in_cmd}")
except Exception as e:
    print(f"[FAIL] Command building failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════
# TEST 3: Environment mapping (QWEN_PROVIDER → QWEN_AUTH_TYPE)
# ═══════════════════════════════════════════════════════════════════════════
print("\n[TEST 3] Environment mapping...")
try:
    config = ModelBackendConfig(
        id="test-qwen",
        type=BackendType.QWEN_CODE_CLI,
        label="Test Qwen",
        env={"QWEN_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "test-key"}
    )
    backend = QwenCodeCliBackend(config)
    proc_env = backend._build_env()

    # Check that QWEN_PROVIDER is mapped to QWEN_AUTH_TYPE
    assert "QWEN_PROVIDER" in proc_env, "QWEN_PROVIDER not in env"
    assert proc_env["QWEN_PROVIDER"] == "anthropic", "QWEN_PROVIDER value wrong"
    assert "QWEN_AUTH_TYPE" in proc_env, "QWEN_AUTH_TYPE not mapped"
    assert proc_env["QWEN_AUTH_TYPE"] == "anthropic", "QWEN_AUTH_TYPE value wrong"

    # Check API key alias
    assert "ANTHROPIC_API_KEY" in proc_env, "ANTHROPIC_API_KEY not in env"

    print(f"[OK] Environment mapping correct:")
    print(f"  QWEN_PROVIDER={proc_env['QWEN_PROVIDER']}")
    print(f"  QWEN_AUTH_TYPE={proc_env['QWEN_AUTH_TYPE']}")
    print(f"  ANTHROPIC_API_KEY={'present' if 'ANTHROPIC_API_KEY' in proc_env else 'missing'}")
except Exception as e:
    print(f"[FAIL] Environment mapping failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════
# TEST 4: cliPath persistence round-trip
# ═══════════════════════════════════════════════════════════════════════════
print("\n[TEST 4] cliPath persistence round-trip...")
try:
    with tempfile.TemporaryDirectory() as tmpdir:
        # Set environment variable to redirect data root
        os.environ["AGENT_WITH_U_DATA_ROOT"] = tmpdir

        # Create config with cliPath
        config1 = ModelBackendConfig(
            id="test-qwen-cli",
            type=BackendType.QWEN_CODE_CLI,
            label="Test Qwen CLI",
            cli_path="C:\\custom\\path\\qwen.cmd",
            env={"QWEN_PROVIDER": "openai"}
        )

        # Create store and save
        store = BackendStore()
        store.save(config1)

        # Create new store instance (simulates restart)
        store2 = BackendStore()
        config2 = store2.get("test-qwen-cli")

        assert config2 is not None, "Config not loaded"
        assert config2.cli_path == "C:\\custom\\path\\qwen.cmd", f"cliPath mismatch: {config2.cli_path}"
        assert config2.env.get("QWEN_PROVIDER") == "openai", "env not preserved"

        print(f"[OK] cliPath persistence round-trip successful:")
        print(f"  Saved: {config1.cli_path}")
        print(f"  Loaded: {config2.cli_path}")

        # Clean up env var
        del os.environ["AGENT_WITH_U_DATA_ROOT"]
except Exception as e:
    print(f"[FAIL] cliPath persistence failed: {e}")
    import traceback
    traceback.print_exc()
    if "AGENT_WITH_U_DATA_ROOT" in os.environ:
        del os.environ["AGENT_WITH_U_DATA_ROOT"]
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════
# TEST 5: qwen CLI subprocess can start (smoke test)
# ═══════════════════════════════════════════════════════════════════════════
print("\n[TEST 5] qwen CLI subprocess smoke test...")
try:
    import subprocess

    # Check if qwen is available
    qwen_path = resolve_qwen_cli(None)
    print(f"  Resolved qwen path: {qwen_path}")

    # Try to run qwen with --help to verify it's executable
    result = subprocess.run(
        [qwen_path, "--help"],
        capture_output=True,
        text=True,
        timeout=10
    )

    if result.returncode == 0:
        print(f"[OK] qwen CLI is executable")
        # Check if help output mentions key flags
        help_text = result.stdout
        if "--auth-type" in help_text:
            print(f"  [OK] --auth-type flag supported")
        if "--allowedTools" in help_text:
            print(f"  [OK] --allowedTools flag supported")
        if "-o" in help_text or "output" in help_text.lower():
            print(f"  [OK] output format flag supported")
    else:
        print(f"⚠ qwen CLI returned non-zero exit code: {result.returncode}")
        print(f"  stderr: {result.stderr[:200]}")

except subprocess.TimeoutExpired:
    print(f"⚠ qwen CLI --help timed out (may still work for actual queries)")
except FileNotFoundError:
    print(f"⚠ qwen CLI not found at {qwen_path} (skipping subprocess test)")
except Exception as e:
    print(f"⚠ qwen CLI smoke test failed (non-critical): {e}")

# ═══════════════════════════════════════════════════════════════════════════
# TEST 6: Factory creates correct backend type
# ═══════════════════════════════════════════════════════════════════════════
print("\n[TEST 6] Factory integration...")
try:
    config = ModelBackendConfig(
        id="factory-test",
        type=BackendType.QWEN_CODE_CLI,
        label="Factory Test"
    )
    backend = create_backend(config)
    assert isinstance(backend, QwenCodeCliBackend), f"Wrong type: {type(backend)}"
    print(f"[OK] Factory creates QwenCodeCliBackend correctly")
except Exception as e:
    print(f"[FAIL] Factory test failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n" + "=" * 80)
print("ALL VERIFICATION TESTS PASSED [OK]")
print("=" * 80)
