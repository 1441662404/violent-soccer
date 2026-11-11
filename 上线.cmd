@echo off
REM ============================================================
REM  上线.cmd —— 快速上线（双击即可，或命令行传参）
REM
REM   双击           = 只推改动过的文件（最常用）
REM   上线.cmd all   = 全量推（含 glb / 贴图，换素材后用）
REM   上线.cmd dry   = 只列要推什么，不动线上
REM
REM  内部调用同目录的 deploy.sh（Git Bash / WSL 均可）。
REM ============================================================
setlocal
set SH=
where bash >nul 2>&1 && set SH=bash
if "%SH%"=="" (
  if exist "%ProgramFiles%\Git\bin\bash.exe" set SH="%ProgramFiles%\Git\bin\bash.exe"
)
if "%SH%"=="" (
  echo [错误] 找不到 bash。请安装 Git for Windows，或用 WSL 手动执行：
  echo        bash deploy.sh
  pause
  exit /b 1
)

set ARG=
if /i "%1"=="all" set ARG=--all
if /i "%1"=="dry" set ARG=--dry
if /i "%1"=="--all" set ARG=--all
if /i "%1"=="--dry" set ARG=--dry

%SH% "%~dp0deploy.sh" %ARG%
if errorlevel 1 (
  echo.
  echo [失败] 部署未完成，请看上方输出。
  pause
  exit /b 1
)
echo.
echo 按任意键关闭...
pause >nul
