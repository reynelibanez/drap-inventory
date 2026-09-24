@echo off
title DRAP Inventory - Confiar en el certificado HTTPS (desde otra PC)
cd /d "%~dp0"

echo.
echo Este script es para instalar en ESTA PC el certificado de DRAP Inventory
echo cuando el sistema corre en OTRA PC (no en esta). Despues de esto, https
echo ya no muestra avisos de "conexion no privada" al entrar desde aqui.
echo.
echo Necesitas la direccion de la PC donde corre DRAP Inventory (la que tiene
echo abierto el start.bat). Esa PC la muestra en su propia ventana al iniciar,
echo por ejemplo: 192.168.1.23
echo.
set /p HOST="Escribe esa direccion (IP o nombre de la PC) y presiona Enter: "
if "%HOST%"=="" (
  echo.
  echo No escribiste nada. Vuelve a ejecutar este archivo e intenta de nuevo.
  echo.
  pause
  exit /b 1
)

echo.
echo Descargando el certificado desde http://%HOST%:3000/ca.crt ...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://%HOST%:3000/ca.crt' -OutFile 'drap-inventory-ca.crt' -UseBasicParsing -ErrorAction Stop } catch { Write-Host ''; Write-Host 'No se pudo descargar el certificado. Revisa que:'; Write-Host '  - DRAP Inventory este abierto en esa PC (start.bat corriendo)'; Write-Host '  - la direccion escrita sea correcta'; Write-Host '  - esta PC y esa PC esten en la misma red'; exit 1 }"
if %errorlevel% neq 0 (
  echo.
  pause
  exit /b 1
)

certutil -user -addstore -f "Root" "drap-inventory-ca.crt"
if %errorlevel% equ 0 (
  echo.
  echo ==============================================
  echo   Listo. Cierra y vuelve a abrir el navegador,
  echo   y entra de nuevo a la direccion https.
  echo ==============================================
) else (
  echo.
  echo No se pudo instalar el certificado. Como alternativa, haz doble clic
  echo en drap-inventory-ca.crt ^(se descargo en esta misma carpeta^), elige
  echo "Instalar certificado", "Usuario actual", coloca todos los certificados
  echo en "Entidades de certificacion raiz de confianza", y termina el asistente.
)
echo.
pause
