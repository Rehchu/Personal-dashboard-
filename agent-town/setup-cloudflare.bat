@echo off
rem One-time, optional: let the villagers publish their own apps to the
rem internet. Until you do this, they build for the joy of it and nothing
rem they write can reach Cloudflare at all — the town never even sees a
rem credential.
rem
rem Read this part before you decide.
rem
rem A work session is a real Claude session with a real shell. Dyer Town
rem refuses the dangerous shapes at the tool boundary (no wrangler delete,
rem no d1/r2/kv, no --name flag, no reading your token file), but the only
rem HARD wall between these agents and a Cloudflare account is the token
rem itself. So the token you paste here decides the blast radius — which is
rem why the steps below use a SEPARATE free account and a scope of exactly
rem one permission.

cd /d "%~dp0"

if not exist "%~dp0package.json" (
  echo.
  echo   Can't find package.json next to this script.
  echo   Extract the whole dyer-town folder first ^(e.g. to C:\dyer-town^)
  echo   and run setup-cloudflare.bat from THERE — not from inside the zip.
  echo.
  pause
  exit /b 1
)

echo.
echo   ===============================================================
echo    Giving Dyer Town a place to publish
echo   ===============================================================
echo.
echo   1. Make a SECOND, FREE Cloudflare account with a different email.
echo      This is the important step. Your lifehq dashboard, your D1
echo      databases and your R2 buckets live in your MAIN account; if the
echo      town holds a token for a different account, it cannot reach any
echo      of them no matter what an agent decides to try.
echo.
echo   2. Signed into that NEW account, go to:
echo        My Profile  ^>  API Tokens  ^>  Create Token  ^>  Custom token
echo.
echo   3. Give it EXACTLY ONE permission and nothing else:
echo        Account  ^>  Workers Scripts  ^>  Edit
echo      No D1. No R2. No KV. No Zone. No Account Settings.
echo.
echo   4. Create the token and copy it.
echo.
echo   5. Save it in this folder as:  cloudflare-token.txt
echo      One line, just the token, nothing else.
echo.
echo   The town reads that file at startup. No file = no deploying, and
echo   the villagers are never told deploying is possible.
echo.

if not exist "%~dp0cloudflare-token.txt" (
  echo   -- cloudflare-token.txt is not here yet. Create it, then run this again.
  echo.
  pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org, then
  echo open a NEW window and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)

rem Install wrangler locally and pinned, so every deploy uses THIS copy — no
rem 50 MB npx download each time, and no npm-cache lock race with the running
rem town. That "EBUSY / resource busy" error is a LOCKED CACHE, not a bad token:
rem it happens when the town is running while npx tries to unpack wrangler.
if not exist "%~dp0node_modules\wrangler" (
  echo   Installing wrangler locally, one time ^(about 50 MB^)...
  call npm install --save-dev wrangler@4
  if errorlevel 1 (
    echo.
    echo   Could not install wrangler. If the town is running, CLOSE the
    echo   run-town window first ^(it locks the npm cache^), then run this again.
    echo.
    pause
    exit /b 1
  )
)

echo   Checking the token against Cloudflare's API...
echo.
for /f "usebackq delims=" %%k in ("%~dp0cloudflare-token.txt") do set "CLOUDFLARE_API_TOKEN=%%k"

rem Verify the token directly — instant, no download. curl ships with Windows 10/11.
where curl >nul 2>nul
if errorlevel 1 goto wranglercheck
curl -s -H "Authorization: Bearer %CLOUDFLARE_API_TOKEN%" https://api.cloudflare.com/client/v4/user/tokens/verify > "%TEMP%\dyertown-verify.txt" 2>nul
findstr /i "active" "%TEMP%\dyertown-verify.txt" >nul && goto tokgood
findstr /i "success" "%TEMP%\dyertown-verify.txt" >nul && goto tokbad
rem No clear answer (no network?) — fall back to wrangler.
del "%TEMP%\dyertown-verify.txt" >nul 2>nul
goto wranglercheck

:tokbad
echo.
echo   Cloudflare rejected that token. Check it was copied whole and that its
echo   only permission is Account ^> Workers Scripts ^> Edit.
type "%TEMP%\dyertown-verify.txt"
echo.
del "%TEMP%\dyertown-verify.txt" >nul 2>nul
pause
exit /b 1

:tokgood
del "%TEMP%\dyertown-verify.txt" >nul 2>nul
goto tokok

:wranglercheck
echo   ^(checking with wrangler instead^)...
call npx --yes wrangler whoami > "%TEMP%\dyertown-whoami.txt" 2>&1
findstr /i "Account" "%TEMP%\dyertown-whoami.txt" >nul
if errorlevel 1 (
  echo.
  echo   Could not confirm the token. If you see "EBUSY" or "resource busy"
  echo   above, that is NOT a bad token — the npm cache is locked because the
  echo   town is still running. Close the run-town window and run this again.
  echo   Otherwise, re-copy the token ^(Account ^> Workers Scripts ^> Edit^).
  echo.
  type "%TEMP%\dyertown-whoami.txt"
  del "%TEMP%\dyertown-whoami.txt" >nul 2>nul
  pause
  exit /b 1
)
del "%TEMP%\dyertown-whoami.txt" >nul 2>nul

:tokok

echo.
echo   Done. The townsfolk can publish their own apps now.
echo.
echo   What that means in practice:
echo    - Each villager builds in workshop\^<their id^>\projects\^<app^>\
echo    - They deploy it themselves as  dyertown-^<their id^>-^<app^>
echo    - Shipped apps show up in the dashboard's Shipped panel as links
echo    - The ids never change even when a villager renames themselves:
echo      ctrl, arise, apex, draco, spork, meta, watch, hire-1, hire-2 ...
echo.
echo   To take it back later: delete cloudflare-token.txt from this folder,
echo   and roll the token in that Cloudflare account's API Tokens page.
echo.
pause
