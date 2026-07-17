import json

from src.backend.bridge_ws import BridgeWS


def _bridge() -> BridgeWS:
    # 目录 RPC 不依赖 BridgeWS 的存储和模型后端，绕过重量级初始化。
    return BridgeWS.__new__(BridgeWS)


def test_create_and_rename_directory(tmp_path):
    bridge = _bridge()

    created = json.loads(bridge._rpc_createDirectory(str(tmp_path), "new-workspace"))
    assert created["status"] == "ok"
    assert (tmp_path / "new-workspace").is_dir()

    listed = json.loads(bridge._rpc_listDirectory(str(tmp_path)))
    assert any(item["name"] == "new-workspace" and item["isDir"] for item in listed)

    renamed = json.loads(bridge._rpc_renameDirectory(created["path"], "renamed-workspace"))
    assert renamed["status"] == "ok"
    assert not (tmp_path / "new-workspace").exists()
    assert (tmp_path / "renamed-workspace").is_dir()


def test_directory_mutations_reject_path_components(tmp_path):
    bridge = _bridge()

    created = json.loads(bridge._rpc_createDirectory(str(tmp_path), "../outside"))
    assert created["status"] == "error"
    assert not (tmp_path.parent / "outside").exists()

    source = tmp_path / "source"
    source.mkdir()
    renamed = json.loads(bridge._rpc_renameDirectory(str(source), "nested/name"))
    assert renamed["status"] == "error"
    assert source.is_dir()
