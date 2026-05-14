; =====================================================================
;  AgentWithU NSIS Installer — Lite + Fat (optional Claude Code)
; =====================================================================
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

; --- 基本信息 ---
!define PRODUCT_NAME    "AgentWithU"
!define PRODUCT_EXE     "AgentWithU.exe"
!define SIDECAR_EXE     "agent-with-u-backend.exe"
!define PUBLISHER       "AgentWithU"
!define UNINST_KEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

; 构建时由 build_fat.bat 通过 /D 注入
; /DVERSION=26.5.9  /DTAURI_BUNDLE_DIR=...  /DFAT_MODE=1
!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Name "${PRODUCT_NAME} ${VERSION}"
OutFile "..\dist\AgentWithU-${VERSION}-setup.exe"
InstallDir "$LOCALAPPDATA\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Unicode true

; --- MUI 配置 ---
!define MUI_ABORTWARNING
!define MUI_ICON "..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\src-tauri\icons\icon.ico"

; --- 页面 ---
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; =====================================================================
;  Section 1: AgentWithU 主程序 (必选)
; =====================================================================
Section "AgentWithU 主程序" SEC_MAIN
  SectionIn RO  ; read-only, 不可取消

  SetOutPath "$INSTDIR"

  ; Tauri 主程序
  File "${TAURI_BUNDLE_DIR}\${PRODUCT_EXE}"

  ; Python sidecar
  File "${TAURI_BUNDLE_DIR}\${SIDECAR_EXE}"

  ; WebView2 bootstrapper (Tauri 自带)
  File /nonfatal "${TAURI_BUNDLE_DIR}\WebView2Loader.dll"

  ; 写注册表：卸载信息
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher"        "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation"  "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString"  '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; 快捷方式
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut  "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}"
  CreateShortCut  "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}"

  ; 卸载程序
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 计算安装大小
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

; =====================================================================
;  Section 2: Claude Code CLI (可选)
; =====================================================================
!ifdef FAT_MODE
Section "Claude Code CLI (含 Node.js 运行时)" SEC_CLAUDE
  SetOutPath "$INSTDIR\claude-env"

  ; portable Node.js
  File /r "${CLAUDE_ENV_DIR}\node"

  ; 预装好的 claude-code 全局包
  File /r "${CLAUDE_ENV_DIR}\npm-global"

  ; claude.cmd 启动器
  File "${CLAUDE_ENV_DIR}\claude.cmd"

  ; 标记文件，方便后端检测
  FileOpen $0 "$INSTDIR\claude-env\.installed" w
  FileWrite $0 "claude-code bundled"
  FileClose $0
SectionEnd
!endif

; --- 组件描述 ---
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN} \
    "AgentWithU 主程序 + AI 后端引擎（必选）"
!ifdef FAT_MODE
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CLAUDE} \
    "内置 Claude Code CLI 和 Node.js 运行时。$\n如已安装 Node.js 和 claude，可不勾选。$\n约占 200MB 磁盘空间。"
!endif
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; =====================================================================
;  卸载
; =====================================================================
Section "Uninstall"
  ; 关闭正在运行的进程
  nsExec::ExecToLog 'taskkill /F /IM "${PRODUCT_EXE}" /T'
  nsExec::ExecToLog 'taskkill /F /IM "${SIDECAR_EXE}" /T'

  ; 删除文件
  RMDir /r "$INSTDIR\claude-env"
  Delete "$INSTDIR\${PRODUCT_EXE}"
  Delete "$INSTDIR\${SIDECAR_EXE}"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; 快捷方式
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${PRODUCT_NAME}"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  ; 注册表
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
