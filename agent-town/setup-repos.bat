@echo off
rem One-time: put each villager's REAL GitHub repo into their workshop, so
rem their deep-work sessions are real development sessions. Needs Git for
rem Windows (https://git-scm.com) — the first push will pop a GitHub sign-in
rem window once (Git Credential Manager) and remember it after that.

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed. Install "Git for Windows" from https://git-scm.com,
  echo then open a NEW window and run this again.
  pause
  exit /b 1
)

if not exist workshop mkdir workshop

call :give ctrl  ctrl-alt-pc-repair
call :give arise arisehub
call :give apex  apextraining
call :give draco dragons
call :give draco 3d-models
call :give draco dark-assassin
call :give spork super-spork
call :give meta  arise-youtube
call :give watch arise-youtube

echo.
echo Done. Each villager now has their repo(s) in workshop\^<name^>\.
echo They work on their own town/^<name^> branch — never main — so everything
echo they do lands on GitHub as a reviewable draft for you.
pause
exit /b 0

:give
if not exist "workshop\%1" mkdir "workshop\%1"
if exist "workshop\%1\%2\.git" (
  echo   %1 already has %2 — leaving it alone.
  goto :eof
)
echo   cloning %2 into %1's workshop...
git clone "https://github.com/rehchu/%2.git" "workshop\%1\%2"
if errorlevel 1 echo   (could not clone %2 — check the repo name and your internet)
goto :eof
