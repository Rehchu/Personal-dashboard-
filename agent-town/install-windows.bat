@echo off
rem One-time setup: makes Dyer Town start automatically when you log into this
rem PC, and starts it right now. No administrator rights needed — it drops a
rem launcher into your Startup folder instead of using the task scheduler.
rem
rem Run this from the EXTRACTED dyer-town folder (e.g. C:\dyer-town), never
rem from inside the zip preview window.

cd /d "%~dp0"

if not exist "%~dp0package.json" (
  echo.
  echo   Can't find package.json next to this script.
  echo   Extract the whole dyer-town folder first (e.g. to C:\dyer-town^)
  echo   and run install-windows.bat from THERE — not from inside the zip.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed (or this window was open before you installed it^).
  echo Install it from https://nodejs.org, then open a NEW window and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed — scroll up for the red error. Common causes:
    echo   - no internet on this PC right now
    echo   - the folder is somewhere protected like Program Files; use C:\dyer-town
    echo.
    pause
    exit /b 1
  )
)

rem Startup-folder launcher: runs at every login for this user, no admin needed.
set "SU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%SU%\DyerTown.cmd" echo @start "Dyer Town" /min cmd /c ""%~dp0run-town.bat""
if not exist "%SU%\DyerTown.cmd" (
  echo Could not write to the Startup folder. Nothing was installed.
  pause
  exit /b 1
)

echo.
echo Done. Dyer Town will start automatically every time you log in.
echo Starting it now...
start "Dyer Town" /min cmd /c ""%~dp0run-town.bat""
echo.
echo Tips:
echo  - Set Windows power settings so the PC never sleeps (Settings ^> System ^> Power^).
echo  - To stop auto-start later: delete DyerTown.cmd from shell:startup
echo    (press Win+R, type shell:startup, press Enter^).
pause
