@echo off
title Alka Vida - send to GitHub
cd /d "%~dp0"

REM Saves everything as a checkpoint, then sends the app's code to your
REM private GitHub repository, where Railway picks it up.
REM Your data (packages\api\.data), your settings file (it holds the mail
REM password) and the logo are NEVER sent: .gitignore keeps them out.

set "GIT=git"
where git >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\Git\cmd\git.exe" (
    set "GIT=C:\Program Files\Git\cmd\git.exe"
  ) else (
    echo.
    echo   Git is not installed on this computer. Tell Claude.
    echo.
    pause
    goto :eof
  )
)

echo.
echo   Paste the address of your GitHub repository and press Enter.
echo   It looks like:  https://github.com/yourname/alka-vida.git
echo.
set /p "URL=  Address: "
if "%URL%"=="" (
  echo   No address given. Nothing was sent.
  pause
  goto :eof
)

REM 1. A checkpoint of everything, so what goes up is exactly what is here.
"%GIT%" add -A
"%GIT%" diff --cached --quiet
if errorlevel 1 (
  "%GIT%" commit -q -m "Everton's round of 7 Oct 2026: portal, emails, office, purchasing (14 points)" -m "Details in HANDOFF.md." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01VoXQGrGq6CUsFujNwTgV52"
)

REM 2. Point at GitHub and send. The first time, a window opens asking you
REM    to sign in to GitHub: choose "Sign in with your browser" and approve.
"%GIT%" remote remove origin >nul 2>&1
"%GIT%" remote add origin "%URL%"
"%GIT%" push -u origin HEAD:main
if errorlevel 1 (
  echo.
  echo   It could not be sent. Please tell Claude what it says above.
  echo.
  pause
  goto :eof
)

echo.
echo   Done. Your code is on GitHub (private). Tell Claude it worked.
echo.
pause
