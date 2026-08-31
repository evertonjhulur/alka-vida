@echo off
title Alka Vida
cd /d "%~dp0packages\api"

REM If Alka Vida is already running, do not try to start a second copy -
REM just open the browser on the one that is already there. Double-clicking
REM the icon twice is a normal thing to do and must not produce an error.
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('localhost',3001);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto alreadyrunning

echo.
echo   Starting Alka Vida...
echo   Your browser will open automatically once it is ready.
echo.

REM Wait in the background until the server is accepting connections, then
REM open the browser. Kept to a single line with no pipe and no percent sign:
REM a caret continuation leaks into PowerShell as a stray token, and a bare
REM %% is eaten by the batch parser.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 120;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('localhost',3001);$c.Close();Start-Process 'http://localhost:3001';break}catch{Start-Sleep -Milliseconds 500}}"

"C:\Program Files\nodejs\node.exe" src\server.ts

echo.
echo   Alka Vida has stopped.
echo.
pause
goto :eof

:alreadyrunning
echo.
echo   Alka Vida is already running - opening it now.
echo.
echo   (You do not need to start it twice. To stop it, close the other
echo    Alka Vida window.)
echo.
start "" http://localhost:3001
timeout /t 4 >nul 2>&1
goto :eof
