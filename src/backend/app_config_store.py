"""
AppConfigStore: Manages application-level configuration (theme, preferences, etc.).

Config stored in ~/.agent-with-u/app-config.json
bgImage stored separately in ~/.agent-with-u/bg-image.dat (can be MB-sized base64)
"""

import json
from pathlib import Path


_BG_IMAGE_SENTINEL = "__bg_image_file__"


class AppConfigStore:
    """Application configuration store with persistence."""

    def __init__(self):
        self._dir = Path.home() / ".agent-with-u"
        self._config_path = self._dir / "app-config.json"
        self._bg_image_path = self._dir / "bg-image.dat"
        self._config: dict = {}
        self._load()

    def _load(self):
        """Load config from disk."""
        if self._config_path.exists():
            try:
                data = json.loads(self._config_path.read_text(encoding="utf-8"))
                self._config = data
                # Restore bgImage from separate file if present
                if self._config.get("bgImage") == _BG_IMAGE_SENTINEL:
                    if self._bg_image_path.exists():
                        self._config["bgImage"] = self._bg_image_path.read_text(encoding="utf-8")
                    else:
                        self._config["bgImage"] = ""
                print(f"[AppConfigStore] Loaded config (bgImage={'yes' if self._config.get('bgImage') else 'no'})", flush=True)
            except Exception as e:
                print(f"[AppConfigStore] Failed to load config: {e}", flush=True)
                self._config = {}
        else:
            print("[AppConfigStore] No config file found, starting with defaults", flush=True)
            self._config = {}

    def _save(self):
        """Save config to disk. bgImage is written to a separate file."""
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            to_disk = self._config.copy()
            bg_image = to_disk.pop("bgImage", "")

            if bg_image:
                self._bg_image_path.write_text(bg_image, encoding="utf-8")
                to_disk["bgImage"] = _BG_IMAGE_SENTINEL
            else:
                # Clear separate file when image is removed
                if self._bg_image_path.exists():
                    self._bg_image_path.unlink()
                to_disk["bgImage"] = ""

            self._config_path.write_text(
                json.dumps(to_disk, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"[AppConfigStore] Saved config (bgImage={'yes' if bg_image else 'no'})", flush=True)
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
        """Get all config values (bgImage included as data URL)."""
        return self._config.copy()

    def set_all(self, config: dict):
        """Replace all config values and save.

        If 'bgImage' key is absent from config, the existing bgImage is preserved
        (allows sliders to save without re-transmitting the image data).
        If 'bgImage' is present (even as empty string), it is updated.
        """
        if 'bgImage' not in config and 'bgImage' in self._config:
            # Patch mode: preserve existing bgImage
            merged = config.copy()
            merged['bgImage'] = self._config['bgImage']
            self._config = merged
        else:
            self._config = config.copy()
        self._save()
