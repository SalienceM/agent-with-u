"""
BackendStore: Manages backend configuration persistence as JSON files.

Backend configs stored in ~/.agent-with-u/backends/config.json
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Iterable, Optional

from ..types import ModelBackendConfig, BackendType
from . import paths


class BackendStore:
    def __init__(self):
        self._dir = paths.sub("backends")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._config_path = self._dir / "config.json"
        self._configs: dict[str, ModelBackendConfig] = {}
        self._load()

    def _load(self):
        """Load backend configs from disk."""
        if self._config_path.exists():
            try:
                data = json.loads(self._config_path.read_text(encoding="utf-8"))
                for config in self._parse_config_data(data):
                    self._configs[config.id] = config
                print(f"[BackendStore] Loaded {len(self._configs)} backend configs", flush=True)
            except Exception as e:
                print(f"[BackendStore] Failed to load configs: {e}", flush=True)
                self._configs = {}
        else:
            print(f"[BackendStore] No config file found, starting with empty configs", flush=True)

    def _write_configs(self, configs: dict[str, ModelBackendConfig]) -> None:
        """Atomically persist a complete config snapshot."""
        data = [self._to_dict(c) for c in configs.values()]
        temp_path: Optional[Path] = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._dir,
                prefix=".config-",
                suffix=".tmp",
                delete=False,
            ) as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
                temp_path = Path(handle.name)
            os.replace(temp_path, self._config_path)
        except Exception:
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise

    def _save(self):
        """Save backend configs to disk."""
        self._write_configs(self._configs)
        print(f"[BackendStore] Saved {len(self._configs)} backend configs", flush=True)

    def _to_dict(self, config: ModelBackendConfig) -> dict:
        """Convert config to dict for JSON serialization."""
        return {
            "id": config.id,
            "type": config.type.value,
            "label": config.label,
            "enabled": config.enabled,
            "baseUrl": config.base_url,
            "model": config.model,
            "apiKey": config.api_key,
            "workingDir": config.working_dir,
            "allowedTools": config.allowed_tools,
            "skipPermissions": config.skip_permissions,
            "env": config.env,
            "extraHeaders": config.extra_headers,
            "cliPath": config.cli_path,
            "qwenContextWindowSize": config.qwen_context_window_size,
            "qwenMaxOutputTokens": config.qwen_max_output_tokens,
            "mcpServers": config.mcp_servers,
        }

    @staticmethod
    def _optional_positive_int(item: dict, key: str, index: int) -> Optional[int]:
        value = item.get(key)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"Backend #{index + 1} field {key} must be a positive integer")
        return value

    @classmethod
    def _from_dict(cls, item: dict, index: int = 0) -> ModelBackendConfig:
        if not isinstance(item, dict):
            raise ValueError(f"Backend #{index + 1} must be an object")
        config_id = str(item.get("id") or "").strip()
        label = str(item.get("label") or "").strip()
        if not config_id:
            raise ValueError(f"Backend #{index + 1} is missing id")
        if not label:
            raise ValueError(f"Backend {config_id} is missing label")
        try:
            backend_type = BackendType(item.get("type"))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Backend {config_id} has an unsupported type") from exc

        for key in ("env", "extraHeaders", "mcpServers"):
            value = item.get(key)
            if value is not None and not isinstance(value, dict):
                raise ValueError(f"Backend {config_id} field {key} must be an object")
        allowed_tools = item.get("allowedTools")
        if allowed_tools is not None and (
            not isinstance(allowed_tools, list)
            or any(not isinstance(value, str) for value in allowed_tools)
        ):
            raise ValueError(f"Backend {config_id} field allowedTools must be a string array")

        context_window = cls._optional_positive_int(item, "qwenContextWindowSize", index)
        max_output = cls._optional_positive_int(item, "qwenMaxOutputTokens", index)
        if context_window is not None and max_output is not None and max_output >= context_window:
            raise ValueError(
                f"Backend {config_id} qwenMaxOutputTokens must be smaller than qwenContextWindowSize"
            )

        return ModelBackendConfig(
            id=config_id,
            type=backend_type,
            label=label,
            enabled=item.get("enabled", True) is not False,
            base_url=item.get("baseUrl"),
            model=item.get("model"),
            api_key=item.get("apiKey"),
            working_dir=item.get("workingDir"),
            allowed_tools=allowed_tools,
            skip_permissions=item.get("skipPermissions", True),
            env=item.get("env"),
            extra_headers=item.get("extraHeaders"),
            cli_path=item.get("cliPath"),
            qwen_context_window_size=context_window,
            qwen_max_output_tokens=max_output,
            mcp_servers=item.get("mcpServers"),
        )

    @classmethod
    def _parse_config_data(cls, data) -> list[ModelBackendConfig]:
        """Accept legacy raw arrays and the versioned selective-export envelope."""
        if isinstance(data, dict):
            data = data.get("backends")
        if not isinstance(data, list):
            raise ValueError("Backend config file must contain a backends array")

        configs: list[ModelBackendConfig] = []
        seen: set[str] = set()
        for index, item in enumerate(data):
            config = cls._from_dict(item, index)
            if config.id in seen:
                raise ValueError(f"Duplicate Backend id in import file: {config.id}")
            seen.add(config.id)
            configs.append(config)
        return configs

    @classmethod
    def parse_config_text(cls, content: str) -> list[ModelBackendConfig]:
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Backend config file is empty")
        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Backend config file is not valid JSON: {exc.msg}") from exc
        return cls._parse_config_data(data)

    def export_json(
        self,
        config_ids: Optional[Iterable[str]] = None,
        *,
        configs: Optional[Iterable[ModelBackendConfig]] = None,
        envelope: bool = True,
    ) -> str:
        source = list(configs) if configs is not None else list(self._configs.values())
        by_id = {config.id: config for config in source}
        if config_ids is None:
            selected = source
        else:
            requested = list(dict.fromkeys(str(value) for value in config_ids))
            missing = [config_id for config_id in requested if config_id not in by_id]
            if missing:
                raise ValueError(f"Unknown Backend id(s): {', '.join(missing)}")
            selected = [by_id[config_id] for config_id in requested]
        if not selected:
            raise ValueError("Select at least one Backend to export")
        payload = [self._to_dict(config) for config in selected]
        if envelope:
            value = {
                "format": "agent-with-u-backends",
                "version": 1,
                "backends": payload,
            }
        else:
            value = payload
        return json.dumps(value, ensure_ascii=False, indent=2) + "\n"

    def preview_import(
        self,
        content: str,
        *,
        existing_configs: Optional[Iterable[ModelBackendConfig]] = None,
        protected_ids: Optional[set[str]] = None,
    ) -> list[dict]:
        configs = self.parse_config_text(content)
        existing = {
            config.id: config
            for config in (
                list(existing_configs) if existing_configs is not None else self._configs.values()
            )
        }
        protected = protected_ids or set()
        return [{
            "id": config.id,
            "label": config.label,
            "type": config.type.value,
            "enabled": config.enabled,
            "conflict": config.id in existing,
            "protected": config.id in protected,
            "existingLabel": existing[config.id].label if config.id in existing else "",
        } for config in configs]

    def import_configs(
        self,
        content: str,
        *,
        selected_ids: Optional[Iterable[str]] = None,
        conflict_policy: str = "overwrite",
        existing_configs: Optional[Iterable[ModelBackendConfig]] = None,
        protected_ids: Optional[set[str]] = None,
    ) -> dict:
        """Validate the full file, then atomically merge only the selected configs."""
        configs = self.parse_config_text(content)
        imported_by_id = {config.id: config for config in configs}
        if selected_ids is None:
            selected = set(imported_by_id)
        else:
            selected = {str(value) for value in selected_ids}
        unknown = sorted(selected - imported_by_id.keys())
        if unknown:
            raise ValueError(f"Unknown selected Backend id(s): {', '.join(unknown)}")
        if conflict_policy not in {"overwrite", "skip"}:
            raise ValueError("Conflict policy must be overwrite or skip")

        base = list(existing_configs) if existing_configs is not None else list(self._configs.values())
        merged = {config.id: config for config in base}
        protected = protected_ids or set()
        added = overwritten = skipped = protected_count = 0
        changed_ids: list[str] = []
        for config in configs:
            if config.id not in selected:
                continue
            if config.id in protected:
                protected_count += 1
                continue
            if config.id in merged:
                if conflict_policy == "skip":
                    skipped += 1
                    continue
                overwritten += 1
            else:
                added += 1
            merged[config.id] = config
            changed_ids.append(config.id)

        if changed_ids:
            self._write_configs(merged)
            self._configs = merged
            print(f"[BackendStore] Imported {len(changed_ids)} backend configs", flush=True)
        return {
            "selected": len(selected),
            "imported": len(changed_ids),
            "added": added,
            "overwritten": overwritten,
            "skipped": skipped,
            "protected": protected_count,
            "changedIds": changed_ids,
        }

    def list(self) -> list[ModelBackendConfig]:
        """List all backend configs."""
        return list(self._configs.values())

    def get(self, config_id: str) -> Optional[ModelBackendConfig]:
        """Get a specific backend config by ID."""
        return self._configs.get(config_id)

    def save(self, config: ModelBackendConfig):
        """Save a backend config."""
        configs = dict(self._configs)
        configs[config.id] = config
        self._write_configs(configs)
        self._configs = configs
        print(f"[BackendStore] Saved {len(self._configs)} backend configs", flush=True)

    def delete(self, config_id: str) -> bool:
        """Delete a backend config."""
        if config_id in self._configs:
            configs = dict(self._configs)
            del configs[config_id]
            self._write_configs(configs)
            self._configs = configs
            print(f"[BackendStore] Saved {len(self._configs)} backend configs", flush=True)
            return True
        return False

    def export_config(
        self, target_path: str, config_ids: Optional[Iterable[str]] = None,
    ) -> bool:
        """Export backend configs to a JSON file."""
        try:
            Path(target_path).write_text(self.export_json(config_ids, envelope=False), encoding="utf-8")
            return True
        except Exception as e:
            print(f"Failed to export backend configs: {e}")
            return False

    def import_config(self, source_path: str) -> bool:
        """Legacy file API: merge all entries and overwrite matching IDs."""
        try:
            self.import_configs(Path(source_path).read_text(encoding="utf-8"))
            return True
        except Exception as e:
            print(f"Failed to import backend configs: {e}")
            return False
