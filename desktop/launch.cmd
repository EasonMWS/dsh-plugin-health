@echo off
rem Start the Electron app with the environment repaired.
rem
rem ELECTRON_RUN_AS_NODE must be gone before electron.exe starts: Electron reads it before loading any
rem script, so clearing it inside main.cjs is too late. This file is started hidden by launch.vbs, so
rem the console it needs never appears.

set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
