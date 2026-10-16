@echo off
title PC Sentinel — Pre-Login Boot Service Installer
:: Check for Administrator privileges
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :admin
) else (
    echo Requesting Administrator privileges to register Pre-Login System Boot Service...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:admin
echo ========================================================
echo   Installing PC Sentinel Pre-Login System Boot Service
echo ========================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\DFIT\PCTrackerAgent\install-service.ps1"
echo.
echo ========================================================
echo   SUCCESS! PC Sentinel will now start BEFORE Windows Login
echo   (right at the password screen) and on Wake/Fast Startup!
echo ========================================================
pause
