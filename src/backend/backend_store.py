"""
BackendStore: Manages backend configuration persistence as JSON files.

Backend configs stored in ~/.claude-shell/backends/config.json
"""

import json
import os
from pathlib import Path
from typing import Optional

from ..types import ModelBackendConfig, BackendType


class BackendStore:
    def __init__(self):
        self._dir = Path.home() / ".claude-shell" / "backends"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._config_path = self._dir / "config.json"
        self._configs: dict[str, ModelBackendConfig] = {}
        self._load()

    def _load(self):
        """Load backend configs from disk."""
        if self._config_path.exists():
            try:
                data = json.loads(self._config_path.read_text(encoding="utf-8"))
                for item in data:
                    config = ModelBackendConfig(
                        id=item["id"],
                        type=BackendType(item["type"]),
                        label=item["label"],
                        base_url=item.get("baseUrl"),
                        model=item.get("model"),
                        api_key=item.get("apiKey"),
                        working_dir=item.get("workingDir"),
                        allowed_tools=item.get("allowedTools"),
                        skip_permissions=item.get("skipPermissions", True),
                        env=item.get("env"),
                    )
                    self._configs[config.id] = config
                print(f"[BackendStore] Loaded {len(self._configs)} backend configs", flush=True)
            except Exception as e:
                print(f"[BackendStore] Failed to load configs: {e}", flush=True)
                self._configs = {}
        else:
            print(f"[BackendStore] No config file found, starting with empty configs", flush=True)

    def _save(self):
        """Save backend configs to disk."""
        try:
            data = [self._to_dict(c) for c in self._configs.values()]
            self._config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[BackendStore] Saved {len(self._configs)} backend configs", flush=True)
        except Exception as e:
            print(f"[BackendStore] Failed to save configs: {e}", flush=True)

    def _to_dict(self, config: ModelBackendConfig) -> dict:
        """Convert config to dict for JSON serialization."""
        return {
            "id": config.id,
            "type": config.type.value,
            "label": config.label,
            "baseUrl": config.base_url,
            "model": config.model,
            "apiKey": config.api_key,
            "workingDir": config.working_dir,
            "allowedTools": config.allowed_tools,
            "skipPermissions": config.skip_permissions,
            "env": config.env,
        }

    def list(self) -> list[ModelBackendConfig]:
        """List all backend configs."""
        return list(self._configs.values())

    def get(self, config_id: str) -> Optional[ModelBackendConfig]:
        """Get a specific backend config by ID."""
        return self._configs.get(config_id)

    def save(self, config: ModelBackendConfig):
        """Save a backend config."""
        self._configs[config.id] = config
        self._save()

    def delete(self, config_id: str) -> bool:
        """Delete a backend config."""
        if config_id in self._configs:
            del self._configs[config_id]
            self._save()
            return True
        return False

    def export_config(self, target_path: str) -> bool:
        """Export backend configs to a JSON file."""
        try:
            data = [self._to_dict(c) for c in self._configs.values()]
            Path(target_path).write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return True
        except Exception as e:
            print(f"Failed to export backend configs: {e}")
            return False

    def import_config(self, source_path: str) -> bool:
        """Import backend configs from a JSON file, overwriting existing data."""
        try:
            data = json.loads(Path(source_path).read_text(encoding="utf-8"))
            # Clear existing configs
            self._configs.clear()
            # Load imported configs
            for item in data:
                config = ModelBackendConfig(
                    id=item["id"],
                    type=BackendType(item["type"]),
                    label=item["label"],
                    base_url=item.get("baseUrl"),
                    model=item.get("model"),
                    api_key=item.get("apiKey"),
                    working_dir=item.get("workingDir"),
                    allowed_tools=item.get("allowedTools"),
                    skip_permissions=item.get("skipPermissions", True),
                    env=item.get("env"),
                )
                self._configs[config.id] = config
            # Save to disk
            self._save()
            return True
        except Exception as e:
            print(f"Failed to import backend configs: {e}")
            return False
