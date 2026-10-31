# Proposal

## Why

完整打包 Kit 的实际构建在 PyInstaller 读取 Harness 清单时失败：依赖准备验证成功后，`build_all.bat` 删除整个 `build`，误删新增的 `build/deepseek-harness` 输入资源。`build_fat_sideonly.bat` 存在同一问题，重跑还会因已丢失的 wheels/桥/清单提前失败。

## What Changes

- 两个入口停止删除共享 `build`/`dist` 根目录，由共享冻结入口清理本次 sidecar 的专属缓存和输出。
- 清理前检查路径归属及链接，保留 Harness 资源和其他发行产物；继续保留失败退出与冻结后自检。
- 恢复本机被旧脚本误删的受校验构建输入，运行回归及实际 Windows 打包验证。
- 记录恢复方式与验证边界，沿用原有 Kit 串联及发布门禁。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。此次为打包工具修复，恢复已有受控发行依赖要求，不改变产品或发布授权语义；设置 `skip_specs: true`。

## Impact

`build_all.bat`、`build_fat_sideonly.bat`、`scripts/build_backend_package.py`、打包回归测试及维护文档。不会自动发布远端稳定通道或修改已有 Kit 配置。Linux/Web 入口审计其清理行为，实际验收范围单独记录。
