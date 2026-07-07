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
;  .onInit — 安装初始化（先于所有页面执行）
; =====================================================================
Function .onInit
  ; ★ 确保 WebView2 Runtime 已安装（Tauri v2 依赖它渲染 UI）
  Call CheckAndInstallWebView2
FunctionEnd

; =====================================================================
;  WebView2 Runtime 检测 & 自动安装
;  Tauri v2 基于 WebView2 渲染，目标机器若无运行时则白屏。
;  检测路径：先 NSIS 本地注册表读取（瞬间完成），
;  未找到则用 PowerShell 下载 Evergreen Bootstrapper 并静默安装。
; =====================================================================
Function CheckAndInstallWebView2

  ; 常量定义
  StrCpy $R0 "F3017226-FE2A-4295-8BDF-00C3A9A7E4C5"  ; WebView2 runtime GUID
  StrCpy $R1 "https://go.microsoft.com/fwlink/p/?LinkId=2124703"  ; Evergreen Bootstrapper

  ; ── 1. 快速检测：NSIS 原生注册表读取（32 位视图 + 64 位视图）──
  ClearErrors
  ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\$R0" "pv"
  IfErrors _wv2_try64 0
  StrCmp $0 "" _wv2_try64 _wv2_found

  _wv2_try64:
  SetRegView 64
  ClearErrors
  ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\$R0" "pv"
  SetRegView 32
  IfErrors _wv2_download 0
  StrCmp $0 "" _wv2_download _wv2_found

  ; ── 已安装，直接跳过 ──
  _wv2_found:
  DetailPrint "WebView2 Runtime detected (v$0)"
  Goto _wv2_done

  ; ── 2. 未检测到 —— 下载并安装 WebView2 Evergreen Bootstrapper ──
  _wv2_download:
  DetailPrint "WebView2 Runtime not found. Downloading..."
  MessageBox MB_OKCANCEL \
    "AgentWithU requires Microsoft Edge WebView2 Runtime.$\r$\n$\r$\n\
     The installer will now download and install it automatically.$\r$\n\
     This may take a minute depending on your network." \
     IDOK _wv2_proceed
  Abort "WebView2 Runtime is required to run AgentWithU."

  _wv2_proceed:
  ; 将 bootstrapper 下载到临时目录
  StrCpy $0 "$TEMP\AgentWithU_wv2setup.exe"

  ; 生成 PowerShell 下载脚本（避免 NSIS 字符串转义问题）
  StrCpy $1 "$TEMP\awv2_dl.ps1"
  FileOpen $2 $1 w
  FileWrite $2 "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12$\r$\n"
  FileWrite $2 "Invoke-WebRequest -Uri '$R1' -OutFile '$0' -UseBasicParsing$\r$\n"
  FileClose $2

  ; 执行下载
  nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -File "$1"'
  Pop $3  ; exit code
  Pop $4  ; stdout

  ; 删除临时 PS 脚本
  Delete $1

  ; 校验下载结果：exit code ≠ 0 或文件不存在 → 失败
  IntCmp $3 0 0 _wv2_fail _wv2_fail
  IfFileExists $0 _wv2_install 0
  Goto _wv2_fail

  ; ── 3. 静默安装 WebView2 ──
  _wv2_install:
  DetailPrint "Installing WebView2 Runtime..."

  ; 生成安装脚本
  StrCpy $1 "$TEMP\awv2_inst.ps1"
  FileOpen $2 $1 w
  FileWrite $2 "exit (Start-Process -FilePath '$0' -ArgumentList '/install','/silent' -Wait -PassThru).ExitCode$\r$\n"
  FileClose $2

  ; 执行安装（可能需要几分钟）
  nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -File "$1"'
  Pop $3
  Pop $4

  Delete $1
  Delete $0  ; 删除 bootstrapper 临时文件

  IntCmp $3 0 _wv2_ok 0 0
  MessageBox MB_OK "WebView2 Runtime installation failed (code $3).$\r$\n$\r$\n\
    AgentWithU may display a blank window.$\r$\n\
    Please install manually: https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
  Goto _wv2_done

  _wv2_fail:
  MessageBox MB_OK "Failed to download WebView2 Runtime.$\r$\n$\r$\n\
    Please check your network and install manually:$\r$\n\
    https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
  Goto _wv2_done

  _wv2_ok:
  MessageBox MB_OK "WebView2 Runtime installed successfully!"
  DetailPrint "WebView2 Runtime installed successfully."

  _wv2_done:

FunctionEnd

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

  ; WebView2 Runtime 已由 .onInit 中的 CheckAndInstallWebView2 检测并安装

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
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; 快捷方式
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${PRODUCT_NAME}"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  ; 注册表
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
