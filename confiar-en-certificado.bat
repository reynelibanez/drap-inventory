@echo off
title DRAP Inventory - Confiar en el certificado HTTPS
cd /d "%~dp0"

echo.
echo Este script descarga el certificado de DRAP Inventory desde el propio sistema
echo y lo marca como confiable en ESTA PC (no hace falta ser administrador; solo
echo afecta a tu usuario de Windows). Despues de esto, https ya no muestra avisos
echo y aparece la opcion de instalar la app.
echo.
echo IMPORTANTE: DRAP Inventory debe estar abierto en esta PC ahora mismo
echo (el start.bat corriendo), porque el certificado se descarga desde ahi.
echo.
pause

powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://localhost:3000/ca.crt' -OutFile 'drap-inventory-ca.crt' -UseBasicParsing -ErrorAction Stop } catch { Write-Host ''; Write-Host 'No se pudo descargar el certificado. Revisa que DRAP Inventory este abierto en esta PC (start.bat) e intenta de nuevo.'; exit 1 }"
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
