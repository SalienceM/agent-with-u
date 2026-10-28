# Verification

日期：2026-10-28。范围：常驻沙盘、准备转执行、场景内详情和连接配置。使用仓库 `.qa/home` 内的独立数据目录、隔离浏览器与合成模型状态；真实创建会话只写隔离目录，没有请求生产模型或执行用户项目。

## Result

规格三项要求、五个场景均有实现和浏览器验证。准备、记录、评委、反馈和设置共用沙盘；桌面右侧面板、360×640 窄屏下面板独立滚动。相机位置、同一 Canvas、静态选择和草稿保持；普通 LOOP 保留原模态覆盖及焦点约束。

| 检查 | 结果 |
| --- | --- |
| 最终 AIMEIN 定向浏览器回归，桌面与窄屏 | 22/22 通过，1.6 分钟 |
| 通用 LOOP 焦点/覆盖、来源说明、目标与 Addon 草稿，及真实隔离创建；重复两轮 | 10/10 通过，38.9 秒 |
| 电流航线、成果聚集、隐藏取消、历史不播放、3D 拆分聚合 | 此前全量运行中的对应桌面/窄屏案例通过 |
| TypeScript 与 Vite 生产构建 | 通过；保留原有大 chunk、uuid 混合导入提示 |
| `openspec validate keep-aimein-world-persistent --strict` | 通过 |
| 修改文件 diff whitespace 检查 | 通过 |

新增检查不止核对元素存在：对同一 Canvas 节点身份和拖动后的相机位置做比较；切换记录/评委/设置并滚动长内容后，要求可视区完整留在视口，Canvas 高度大于 100 CSS px，中心命中 Canvas；验证设置关闭的焦点返回、未保存草稿、零隐式执行写入以及显式开始仅提交一次。

创建连接管理通过 Portal 放入同一个场景面板，检查配置打开时可点击的 Canvas 区域、创建目录草稿和关闭后的实际连接刷新。静态场景保持图与按钮同一纵横比例，WebGL 失败和上下文丢失仍可反馈。

## Findings retained

全量第一轮结果为 30 通过、5 失败、1 个窄屏专用录像跳过。其中 4 项来自工具移入折叠菜单与隐藏的重复阶段选择器：补齐菜单操作，移除不需要的隐藏观察内容（草稿仍在父组件保存），相应用例已在最终定向运行通过。通用 LOOP 首次兼容检查发现详情定位改变，已将新定位限于 AIMEIN，重复回归通过。

另一次真实隔离创建在 10:31:08 出现 Windows `WinError 5`，失败位置为 `loops/<session-id>.json.tmp` 替换正文。后续桌面与窄屏创建、以及额外两次桌面创建均通过。根因未确认，本变更没有修改后端持久化、权限或增加写重试，不能据重跑成功声称修复该偶发落盘问题。失败结果与日志保留于 `.qa/aimein-persistent/full-browser-results.json` 和 `backend.log`。

最终记录：`.qa/aimein-persistent/targeted-browser-results.json`、`compatibility-browser-results.json`。页面可交互和合成推送验证不等于生产模型完成验收；本次没有重新构建 Tauri 安装包。

## Artifacts

- `downloads/AIMEIN-persistent-desktop.png`：观察评委时的完整桌面。
- `downloads/AIMEIN-persistent-mobile.png`：360×640 下的沙盘与观察面板。
- `downloads/AIMEIN-persistent-desktop.webm`、`AIMEIN-persistent-mobile.webm`：浏览器真实交互录像，环视、记录、评委、设置、草稿和收起/展开。
- `downloads/AIMEIN-persistent-connection-desktop.png`、`AIMEIN-persistent-connection-mobile.png`：首次连接配置与沙盘共存。
- `docs/aimein-execution-mode.md` 第 17 节：后续实施使用的独立模式说明。
