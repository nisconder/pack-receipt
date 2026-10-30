@echo off
setlocal
if not exist "%~dp0index.html" (
  echo Pack Receipt: index.html was not found next to this launcher.
  pause
  exit /b 1
)
start "" "%~dp0index.html"
