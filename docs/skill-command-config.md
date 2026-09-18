# Skill 的 / 命令配置

AgentWithU 用 `awu.commands.json` 把**稳定 Skill ID**与聊天 `/命令` 关联。配置属于 Skill 包，不属于某台控制端的浏览器，也不是由 AI 临时从手册推断。

## 使用入口

在 **扩展 → Skills 与 Prompts → 仓库或 Skill 的「···」→「/ 命令配置」** 中编辑。

- 父级保存：明确把同一份配置写入当前已安装的所有子 Skill；界面列出目标。父级显示名可改，不改变配置 ID 或子 Skill ID。
- 单项保存：只改该 Skill 包。共享配置的多个副本应保持一致，否则同 ID 的整组入口停用。
- 导入 JSON：只填入草稿；「校验并保存」才落盘。保存带版本检查，不覆盖另一个窗口的新编辑。
- 导出 JSON：导出当前草稿为 `awu.commands.json`，不会执行命令。将其提交到仓库，与 Skill 一起分享。
- 配置更新后重新打开 `/` 菜单读取；旧选择在发送时会重新核验，不会拿旧定义执行。

安装 Skill 不等于安装 CLI，也不等于初始化项目。选择命令只填写输入框；点击发送后才进入当前 Session 的 Agent 执行流程。命令在 Session 所在执行端校验和执行。

## 最小配置

放在 `SKILL.md` 同目录：

```json
{
  "schemaVersion": 1,
  "id": "my-review-suite",
  "skillIds": ["project-reviewer"],
  "commands": [
    {
      "name": "/project-review",
      "description": "检查当前项目的实现",
      "kind": "skill",
      "skillId": "project-reviewer"
    }
  ]
}
```

`skillIds` 对应实际安装 ID（标准 Skill 的 frontmatter `name`），不是仓库显示名称或本机 `repo.*` 引用 ID。一个配置可声明多个子 Skill。

带有命令配置的子 Skill 不允许直接改 ID，以免原有编辑器重建 Skill 时丢失关联；日常改名请修改父级显示名称。确需迁移 ID 时先迁移配置和调用方，再移除旧配置。

`kind: skill` 的入口仅在目标已安装且被当前 Session 绑定时出现在菜单；用户参数保持为任务文本，完整加载该 Skill 的说明。没有配置的普通 Skill 仍可用 `/skill <ID> <任务>`，不会凭名称生成快捷命令。

## 仓库父级共享

可以把配置放在多个子 Skill 的共同祖先目录（例如仓库根），并在 `skillIds` 中列出需要关联的子 Skill。市场/ZIP 安装将配置复制到相应子包，与其他文件一起纳入预览和安装摘要核验。子包自己的配置优先于祖先配置；相同共享配置安装多份只注册一次。

单个 Skill 包、标准 ZIP、市场安装以及 `.awu` 包均支持此文件；能力库备份也会携带它。第三方 Agent 可继续读取原有 `SKILL.md`，无需理解 AWU 配置。

## CLI / 项目入口

`kind: project` 适合 init、status、validate 等项目命令。至少一个关联 Skill 已安装时显示；不要求先绑定工作流 Skill，便于首次初始化。

```json
{
  "schemaVersion": 1,
  "id": "my-project-tools",
  "skillIds": ["project-reviewer"],
  "commands": [
    {
      "name": "/review-status",
      "description": "查看项目条目的状态",
      "kind": "project",
      "cli": {
        "executable": "reviewcli",
        "windowsExecutable": "reviewcli.cmd",
        "localBin": "node_modules/.bin"
      },
      "parameters": [{"name": "id", "type": "id", "required": true}],
      "argv": ["status", "{id}", "--json"],
      "checks": {"requiredPaths": ["review/config.yaml"]},
      "instructions": "只查询状态，报告实际结果，不修改项目。"
    }
  ]
}
```

CLI 先检查当前项目的 `localBin`，再检查当前 Backend 的 PATH；未找到即报错，不下载依赖。`argv` 是参数数组，不是 shell 字符串。该入口交给 Agent 使用现有工具执行，不是直接启动脚本的无人值守执行器，更不是原生 TUI slash 透传。

参数为有序的空白分隔标识符，最多 8 项；本版本不接受路径或自由文本 CLI 参数：

| 字段 | 规则 |
| --- | --- |
| `type: id` | 字母或数字开头，其余可含字母、数字、`_`、`-`，最多 128 字符 |
| `type: enum` | 必须匹配 `choices` 声明的选项 |
| `type: idOrEnum` | ID 或已声明的选项，例如 `--all` |
| `required` | 默认 false；必填参数放在可选参数之前 |
| `default` | 可选；缺省时使用此值；未提供且无默认值时省略相应占位符 |
| `argv` | 只允许独立的 `{参数名}` 占位符，不支持拼接、shell 插值或表达式 |

`checks` 可选，用于发送前的只读预检，也可用于 `kind: skill`：

- `requiredPaths`：当前项目内必须存在的文件/目录。
- `absentPaths`：必须不存在；用于禁止重复初始化或覆盖残留。
- `noAncestorPaths`：父目录中不能存在该标记，避免误用父项目。
- `yamlGuards`：`[{"path":"openspec/config.yaml","forbidKeys":["store"]}]`，限量读取 YAML 顶层映射，拒绝指定键。

所有预检路径均为项目相对路径，不允许 `..`、绝对路径或逃逸项目的符号链接。配置不能更换执行端或 cwd，不能修改权限、触发 Kit 代确认或添加安装钩子。

## OpenSpec 兼容

旧版已安装的 OpenSpec 工作流仍有快捷入口，但映射现在是一份采用相同 schema 的 **AWU 兼容配置**，不是解析器里的 OpenSpec 专用分支。没有对应 Skill 就不会出现这些入口。

在「命令配置」中可以直接查看、保存或导出此兼容配置，之后由仓库维护。只要关联的已安装子 Skill 带有包内配置，兼容配置就让位；坏配置也不会悄悄退回兼容入口。将 `commands` 设为 `[]` 可以明确关闭这一组快捷入口；通用 `/skill` 不受影响。

## 冲突与答疑

`/help`、`/init`、`/clear` 等应用命令不能被覆盖；扩展应使用自己的前缀。同名命令来自不同配置、同一配置 ID 的内容不一致、配置无效时，相关入口停用并在命令菜单显示原因，不采取“最后一份覆盖”的规则。

俺寻思与聊天菜单使用同一份实际注册清单。只在本轮明确 `@SKILL` 时附加该父级/子级资料，仍围绕当前 Session 的项目答疑，不切换工作空间，不自动执行，不把手册里的 CLI 写法当成已接入命令。

配置最多 128 KB、128 个关联 Skill、128 条命令。请把配置与 Skill 当作需要审阅的第三方内容；格式校验和路径检查并不证明业务动作本身安全。
