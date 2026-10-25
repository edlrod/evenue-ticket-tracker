@echo off
rem Wrapper for the scheduled fetcher. Copy to run.cmd and adjust the two
rem paths below, then register with Windows Task Scheduler, e.g.:
rem   schtasks /create /tn "ShowFetcher" /tr "<project>\run.cmd" /sc hourly /mo 1 /f

rem %~dp0 = this script's own directory, so the project can live anywhere.
cd /d "%~dp0"
if not exist logs mkdir logs

rem Absolute path to bun (bunx/npx also work if they're on PATH).
"C:\path\to\bun.exe" scripts\fetcher.mjs >> logs\fetcher.log 2>&1
