@echo off
cd /d "%~dp0"
title DRAP Inventory - Crear paquete de produccion
echo.
echo Crea un paquete de PRODUCCION (sin codigo fuente) para llevar a otra PC o servidor.
echo Resultado: carpeta "release" (un .zip)
echo.
echo   1) Liviano: la otra maquina necesita Node.js, PostgreSQL e internet la primera vez
echo   2) Con dependencias: la otra maquina necesita Node.js y PostgreSQL, pero NO internet
echo   3) Con Node.js incluido: la otra maquina solo necesita PostgreSQL
echo   4) TODO INCLUIDO (Node.js + PostgreSQL): la otra maquina no necesita instalar nada
echo      (usa el PostgreSQL instalado en ESTA PC; el zip pesa unos 150-300 MB)
echo.
set /p OPC=Elige 1, 2, 3 o 4:
if "%OPC%"=="4" (
  call npm run release -- --with-node --with-postgres
) else if "%OPC%"=="3" (
  call npm run release -- --with-node
) else if "%OPC%"=="2" (
  call npm run release -- --with-modules
) else (
  call npm run release
)
if errorlevel 1 goto :fail
echo.
echo Listo. Copia el .zip de la carpeta "release" a la otra maquina, descomprimelo y ejecuta instalar.bat alli.
pause
exit /b 0
:fail
echo [X] Algo fallo. Revisa el mensaje de arriba.
pause
exit /b 1
