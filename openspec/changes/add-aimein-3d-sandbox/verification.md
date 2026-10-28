# Verification Report: add-aimein-3d-sandbox

日期：2026-10-27。对象：当前工作区内本次 3D 变更；未提交、打包或重启生产桌面程序。

## Summary

| Dimension | Status |
|---|---|
| Completeness | 6 项任务的实现、验证和交付文件齐备；4 项新增要求均有实现 |
| Correctness | 拆分聚合、瓶内核实、对象选择、渲染降级均有单元或实际浏览器覆盖 |
| Coherence | React 18 兼容依赖、动态分包、内联样式、原 RPC/证据/意见语义保持一致 |

## Requirement Implementation Mapping

| 要求 | 实现 | 验证 |
|---|---|---|
| 拆分聚合呈现真实范围 | `frontend/src/utils/aimeinWorld.ts:18`，`AimeinWorld.tsx:47`，`AimeinWorldScene.tsx:201` | 真实目标/条件映射、阶段外目标留置、历史/重复推送、实际中间帧与结束帧不同、无执行 RPC |
| 目标瓶依据三方核实变化 | 原 `goalObservation`，`AimeinWorldScene.tsx:108` | 未知/缺失/失败报告单元覆盖，浏览器读取 3/8、6/8 与历史 3/8；录屏展示 1/8 → 5/8 |
| 场景对象连接证据与意见 | `ObjectSite`、`CameraRig`、`AimeinWorkbench.observe` | 真实鼠标射线点击第三位评委、键盘选择第二位、录屏点击第二位进入档案；意见失败保留草稿与来源回归 |
| 渲染与降级不阻碍工作 | `AimeinWorld.tsx:10`、`:41` 与按需 Canvas | 桌面/360 像素视口、减少动效、背景暂停与取消回放、手动静态、真实 context loss、创建时无 WebGL、降级后的意见提交 |

## Validation

- `npm run test:home`：295/295 通过。新增两项 3D 状态投影测试，原目标瓶证据测试继续通过。
- `npm run build`：通过。3D 为单独动态分包，约 855 KB / gzip 230 KB；既有大包提示仍存在。
- AIMEIN 浏览器主集：桌面与窄屏共 20 个测试实例，17 通过、1 个桌面专用录屏在窄屏跳过、2 个新增鼠标点击测试首次失败。原因是**测试侧**用于定位点击的相机未刷新世界矩阵，点击坐标超出画布；修正测试矩阵后，定向复验 `--grep '3D sandbox|actual 3D'` 为 3 通过、1 跳过，覆盖两项原失败及窄屏动画。最终 19 个不同 AIMEIN 实例均有通过结果。
- 普通 LOOP 回归 `--grep 'each main action|two primary views'`：桌面/窄屏 4/4 通过，验证共享标题栏主操作及两种主视图。
- `openspec validate add-aimein-3d-sandbox --strict` 与 `git -c core.whitespace=cr-at-eol diff --check`：通过。

测试日志：`.qa/aimein-3d-unit.log`、`.qa/aimein-3d-build.log`、`.qa/aimein-3d-browser.log`、`.qa/aimein-3d-motion.log`、`.qa/aimein-3d-shared.log`。两批 AIMEIN 结果保存在 `.qa/aimein-preview/3d-interaction-results.json` 和 `3d-motion-results.json`。

## Rendering observations

使用 Chromium / ANGLE SwiftShader 软件渲染，桌面 1600×900 和窄屏 360×640。8 个目标的样例场景观察到约 131 draw calls；动效收敛后 500 ms 内新增渲染帧均为 0。后台模拟验证停止请求帧并取消回放。此处不承诺真实硬件帧率，未测打包 Tauri 与具体显卡驱动。

## Delivered motion

- `.qa/aimein-preview/3d-motion.webm`：11.88 秒真实浏览器录屏，1600×1000。
- `.qa/aimein-preview/3d-motion.mp4`：同一录屏转码，便于播放。
- `.qa/aimein-preview/3d-preview.gif`：从录屏裁出沙盘区域，7.74 秒 / 116 帧；无生成或替换界面内容。
- `.qa/aimein-preview/3d-desktop.png`、`3d-mobile.png`：实际 WebGL 场景截图。
- 抽查拆分、聚合、液面变化及评委选中帧；录屏末段进入实际观察区和档案入口。

以上使用隔离 QA 合成评审数据，不调用生产模型，不代表真实项目验收。独立说明已更新到 `docs/aimein-execution-mode.md` v0.4。

## Assessment

本次要求范围内未发现 CRITICAL、WARNING 或 SUGGESTION。生产模型评审、打包 Tauri / 实际 GPU 性能未验证，原因是本次采用隔离浏览器及软件渲染；不能将这里的验收扩展为这些环境的保证。变更未归档。
