@echo off
title Alka Vida - save a checkpoint
cd /d "%~dp0"

REM Saves everything in this folder as one checkpoint in the app's own
REM history (git), so any later change can be undone back to this point.
REM Your data (packages\api\.data), your settings file and the logo are
REM never included: .gitignore keeps them out.

set "GIT=git"
where git >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\Git\cmd\git.exe" (
    set "GIT=C:\Program Files\Git\cmd\git.exe"
  ) else (
    echo.
    echo   Git is not installed on this computer, so a checkpoint cannot be saved.
    echo   Tell Claude and it will suggest another way.
    echo.
    pause
    goto :eof
  )
)

"%GIT%" add -A
"%GIT%" diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo   Nothing has changed since the last checkpoint. Nothing to save.
  echo.
  pause
  goto :eof
)

"%GIT%" commit -q -m "Checkpoint: screens rebuilt from the Claude Design mockups (28-30 Sep 2026)" -m "Needs a decision, Orders, New order, Invoice, Payments, Reports (incl. Rounds and cash), Sign in, Open an account, delivery round, driver stop, portal order, top bar, customer hub, seven-section menu, logo colours, readable dates, in-app confirm boxes. Details in HANDOFF.md." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Wsp85x62qLte8Y6KiaQifX"
if errorlevel 1 (
  echo.
  echo   The checkpoint could not be saved. Please tell Claude what it says above.
  echo.
  pause
  goto :eof
)

echo.
echo   Checkpoint saved:
"%GIT%" log -1 --format="    %%h  %%s"
echo.
pause
