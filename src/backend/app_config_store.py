"""
AppConfigStore: Manages application-level configuration (theme, preferences, etc.).

Config stored in ~/.claude-shell/app-config.json
"""

import json
from pathlib import Path
from typing import Optional


class AppConfigStore:
    """Application configuration store with persistence."""

    def __init__(self):
        self._config_path = Path.home() / ".claude-shell" / "app-config.json"
        self._config: dict = {}
        self._load()

    def _load(self):
        """Load config from disk."""
        if self._config_path.exists():
            try:
                data = json.loads(self._config_path.read_text(encoding="utf-8"))
                self._config = data
                print(f"[AppConfigStore] Loaded config: {self._config}", flush=True)
            except Exception as e:
                print(f"[AppConfigStore] Failed to load config: {e}", flush=True)
                self._config = {}
        else:
            print(f"[AppConfigStore] No config file found, starting with defaults", flush=True)
            self._config = {}

    def _save(self):
        """Save config to disk."""
        try:
            self._config_path.write_text(
                json.dumps(self._config, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"[AppConfigStore] Saved config: {self._config}", flush=True)
        except Exception as e:
            print(f"[AppConfigStore] Failed to save config: {e}", flush=True)

    def get(self, key: str, default=None):
        """Get a config value."""
        return self._config.get(key, default)

    def set(self, key: str, value):
        """Set a config value and save."""
        self._config[key] = value
        self._save()

    def get_all(self) -> dict:
        """Get all config values."""
        return self._config.copy()

    def set_all(self, config: dict):
        """Replace all config values and save."""
        self._config = config.copy()
        self._save()
