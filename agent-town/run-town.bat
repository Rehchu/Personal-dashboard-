@echo off
rem Dyer Town launcher — keeps the town running and restarts it if it crashes.
rem
rem The newest launcher always WINS: on startup it stops any older instance
rem still holding the port (including one whose window you already closed —
rem closing the window leaves its node child running) and takes over.
rem
rem The sync passphrase is read from town-key.txt next to this script: put
rem your dashboard sign-in passphrase in that file — nothing else, one line,
rem no quotes. A plain file sidesteps every batch quoting pitfall (trailing
rem spaces, %, &, ^ characters), which is what causes "Bridge: dashboard 401".

cd /d "%~dp0"
set DASH_URL=https://lifehq.dyer-hq.workers.dev
set TOWN_MODEL=claude-opus-4-8
set TOWN_EFFORT=low
set TOWN_PORT=8787
set "TOWN_KEY="

rem Subscription only: clear any stray API key so the town runs on your
rem `claude login` session and can NEVER bill you per token. (If you ever
rem set ANTHROPIC_API_KEY as a Windows variable for something else, this
rem just hides it from the town — it doesn't delete it.)
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_AUTH_TOKEN="

rem A title of our own, with no space, so the sweep below cannot match US:
rem the old launcher windows are titled "Dyer Town".
set "SELFTAG=DyerTown-%RANDOM%%RANDOM%"
title %SELFTAG%

rem --- take over from any older instance --------------------------------
rem 1) the old launcher windows (started minimized at logon, titled "Dyer Town")
taskkill /f /fi "WINDOWTITLE eq Dyer Town*" >nul 2>nul
rem 2) whatever node is actually holding the port — this is the orphan left
rem    behind when a window gets closed without stopping its child
set "FREED="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr ":%TOWN_PORT%"') do (
  for /f "tokens=1" %%n in ('tasklist /fi "PID eq %%p" /nh 2^>nul') do (
    if /i "%%n"=="node.exe" (
      echo   stopping the older town still on port %TOWN_PORT% ^(PID %%p^)...
      taskkill /f /pid %%p >nul 2>nul
      set "FREED=1"
    )
  )
)
if defined FREED (
  rem give Windows a breath to release the socket before we bind it
  timeout /t 3 /nobreak >nul
  echo   port %TOWN_PORT% is free — this window is the town now.
  echo.
)

if exist "%~dp0town-key.txt" set /p TOWN_KEY=<"%~dp0town-key.txt"

if not defined TOWN_KEY (
  echo.
  echo   No passphrase found. Create a file named town-key.txt in this folder
  echo   containing ONLY your dashboard sign-in passphrase on one line, save,
  echo   and run this again.
  echo.
  pause
  exit /b 1
)

:loop
echo [%date% %time%] starting Dyer Town...
node town.mjs
if "%errorlevel%"=="2" (
  rem the port was taken by something we could not stop — stand down rather
  rem than crash-loop against it (a stale launcher closes itself in ~15s,
  rem so simply running this file again usually wins)
  echo Another copy of Dyer Town is already running — this window will close.
  timeout /t 8 >nul
  exit /b 0
)
echo [%date% %time%] town stopped (exit %errorlevel%^) — restarting in 15s. Close this window to stop.
timeout /t 15 /nobreak >nul
goto loop
