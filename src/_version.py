"""
应用版本号（由 build_all.bat 在构建时自动写入）。

版本格式：YY.MM.DD（例如 26.4.9 表示 2026 年 4 月 9 日构建）。
MSI 打包要求 MAJOR<=255, MINOR<=255, PATCH<=65535，YY.MM.DD 完全符合。

dev 模式下保持最近一次构建时写入的值，也可以运行 build_all.bat 手动触发更新。
"""

__version__ = "26.4.9"
