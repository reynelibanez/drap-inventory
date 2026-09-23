@echo off
cd /d "%~dp0"
title DRAP Inventory
if not exist .env (
  echo Primero ejecuta setup.bat
  pause
  exit /b 1
)
echo Iniciando DRAP Inventory... (cierra esta ventana para detenerlo)
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause
