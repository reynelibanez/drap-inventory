@echo off
cd /d "%~dp0"
title DRAP Inventory - Actualizar
echo Actualizando dependencias, compilando y aplicando cambios de base de datos...
call npm install
if errorlevel 1 goto :fail
call npm run build
if errorlevel 1 goto :fail
call npm run db:migrate
if errorlevel 1 goto :fail
echo.
echo Listo. Reinicia el sistema con start.bat
pause
exit /b 0
:fail
echo [X] Algo fallo. Revisa el mensaje de arriba.
pause
exit /b 1
