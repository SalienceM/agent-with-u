"""
MainWindow: PySide6 window with QWebEngineView hosting the React frontend.

The React app communicates with Python via QWebChannel.
In dev mode, loads from Vite dev server (localhost:5173).
In production, loads from bundled dist/index.html.
"""

import os
import sys
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEngineProfile, QWebEngineSettings
from PySide6.QtWidgets import QMainWindow

from ..backend.bridge import Bridge


class MainWindow(QMainWindow):
    def __init__(self, bridge: Bridge, dev_mode: bool = False):
        super().__init__()
        self._bridge = bridge

        self.setWindowTitle("AgentWithU")
        self.resize(1200, 800)
        self.setMinimumSize(800, 600)

        # WebEngine view
        self._web = QWebEngineView()
        self.setCentralWidget(self._web)

        # ★ Enable hardware acceleration for smoother rendering
        profile = QWebEngineProfile.defaultProfile()
        profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.MemoryHttpCache)
        profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)

        # Enable hardware acceleration & WebGL via page-level settings
        settings = self._web.page().settings()
        settings.setAttribute(
            QWebEngineSettings.WebAttribute.Accelerated2dCanvasEnabled, True
        )
        settings.setAttribute(
            QWebEngineSettings.WebAttribute.WebGLEnabled, True
        )
        settings.setAttribute(
            QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False
        )

        # Set up QWebChannel
        self._channel = QWebChannel()
        self._channel.registerObject("bridge", self._bridge)
        self._web.page().setWebChannel(self._channel)

        # Load frontend
        if dev_mode:
            self._web.setUrl(QUrl("http://localhost:5173"))
        else:
            # Production: load from bundled frontend
            dist_dir = Path(__file__).parent.parent.parent / "frontend" / "dist"
            index_path = dist_dir / "index.html"
            if index_path.exists():
                self._web.setUrl(QUrl.fromLocalFile(str(index_path)))
            else:
                # Fallback: try dev server
                print("Warning: frontend/dist not found, trying dev server...")
                self._web.setUrl(QUrl("http://localhost:5173"))

        # Dark title bar on Windows
        self._apply_dark_theme()

    def _apply_dark_theme(self):
        """Apply dark window chrome on Windows."""
        if sys.platform == "win32":
            try:
                import ctypes
                hwnd = int(self.winId())
                DWMWA_USE_IMMERSIVE_DARK_MODE = 20
                ctypes.windll.dwmapi.DwmSetWindowAttribute(
                    hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE,
                    ctypes.byref(ctypes.c_int(1)), ctypes.sizeof(ctypes.c_int)
                )
            except Exception:
                pass