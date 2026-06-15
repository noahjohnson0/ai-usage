@echo off
REM Launcher for the scheduled task: collect this machine's AI usage and push it
REM to the hub. Quiet Node's experimental warnings. Logs to scripts\last-run.log.
set NODE_OPTIONS=--no-warnings
node "%~dp0..\reporter\collect.mjs" --push > "%~dp0last-run.log" 2>&1
