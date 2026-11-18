@echo off
setlocal
rem Launcher: runs cli\harness.js on the Bun runtime embedded in the installed OpenCode.
if defined TEAM_HARNESS_HOME (set "BASE=%TEAM_HARNESS_HOME%") else (set "BASE=%LOCALAPPDATA%\team-harness")
set "CLI=%~dp0..\cli\harness.js"
if not exist "%CLI%" set "CLI=%BASE%\repo\cli\harness.js"
set "RT="
if exist "%BASE%\engine\current" set /p RT=<"%BASE%\engine\current"
if not defined RT (
  echo team-harness: not installed. Run: powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/loviglass/team-harness/main/install.ps1 | iex" 1>&2
  exit /b 1
)
set BUN_BE_BUN=1
"%RT%" "%CLI%" %*
exit /b %ERRORLEVEL%
