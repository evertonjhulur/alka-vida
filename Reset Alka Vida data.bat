@echo off
title Reset Alka Vida data
cd /d "%~dp0packages\api"

echo.
echo   This deletes ALL Alka Vida data on this machine - every customer,
echo   order, invoice and payment you have entered while testing.
echo.
echo   The starting sample data will be loaded again next time you open
echo   Alka Vida.
echo.

choice /c YN /n /m "  Type Y to erase and start fresh, or N to cancel: "
if errorlevel 2 goto cancelled

echo.
echo   Erasing...
rmdir /s /q ".data" 2>nul
echo   Done. Open Alka Vida again to start fresh.
echo.
pause
goto :eof

:cancelled
echo.
echo   Cancelled - nothing was changed.
echo.
pause
