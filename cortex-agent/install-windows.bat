@echo off
title CORTEX Desktop Agent - Installation
color 0B

echo.
echo  ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗
echo ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝
echo ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝
echo ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗
echo ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗
echo  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
echo.
echo  Desktop Agent v1.0 - Installation
echo  ─────────────────────────────────────────────────
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [FEHLER] Node.js ist nicht installiert!
    echo Bitte Node.js von https://nodejs.org herunterladen und installieren.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js gefunden
echo.

:: Install dependencies
echo Installiere Abhängigkeiten...
npm install socket.io-client --save >nul 2>&1
echo [OK] Dependencies installiert
echo.

:: Get token from user
set /p TOKEN="Gib deinen CORTEX Agent-Token ein (aus dem User Panel): "

if "%TOKEN%"=="" (
    echo [FEHLER] Kein Token eingegeben!
    pause
    exit /b 1
)

:: Create startup script
echo @echo off > start-cortex-agent.bat
echo title CORTEX Desktop Agent >> start-cortex-agent.bat
echo color 0B >> start-cortex-agent.bat
echo node cortex-agent.js --token %TOKEN% --server http://187.77.70.209:8201 >> start-cortex-agent.bat
echo pause >> start-cortex-agent.bat

echo.
echo [OK] Installation abgeschlossen!
echo.
echo Starte den Agent jetzt mit: start-cortex-agent.bat
echo.
pause
start start-cortex-agent.bat
