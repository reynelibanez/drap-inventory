@echo off
setlocal
cd /d "%~dp0"
title DRAP Inventory - Instalacion
echo.
echo ==============================================
echo   DRAP Inventory - Instalacion inicial
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] No se encontro Node.js. Instala la version LTS desde https://nodejs.org y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
if %NODEMAJOR% LSS 20 (
  echo [X] Se necesita Node.js 20 o superior. Tienes una version anterior; actualiza desde https://nodejs.org
  pause
  exit /b 1
)

echo [1/5] Configurando la conexion a la base de datos...
node scripts\setup-env.mjs --no-db-setup
if errorlevel 1 goto :fail

echo [2/5] Instalando dependencias (puede tardar unos minutos)...
call npm install
if errorlevel 1 goto :fail

echo [3/5] Compilando el sistema...
call npm run build
if errorlevel 1 goto :fail

echo [4/5] Preparando la base de datos...
call npm run db:setup
if errorlevel 1 goto :fail

echo [5/5] Crear el administrador y la primera empresa
call npm run create-admin
if errorlevel 1 goto :fail

echo.
echo ----------------------------------------------------------------
echo  DATOS DE PRUEBA (opcional): carga un negocio de ejemplo completo:
echo  un lote con unos 170 equipos variados, otros 4 lotes en distintos
echo  estados, clientes, proveedores, vendedores, costos, precios,
echo  pedidos, ventas rapidas, activos y usuarios de prueba.
echo  Responde S solo para probar; N si vas a usar el sistema de verdad.
echo ----------------------------------------------------------------
set /p DEMO=Cargar datos de prueba? (S/N): 
if /i "%DEMO%"=="S" call npm run db:seed-demo

echo.
echo ==============================================
echo   Listo. Para iniciar el sistema usa start.bat
echo ==============================================
pause
exit /b 0

:fail
echo.
echo [X] Algo fallo. Lee el mensaje de arriba (o enviamelo) y vuelve a ejecutar setup.bat.
pause
exit /b 1
