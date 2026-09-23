@echo off
title DRAP Inventory - Permitir HTTPS en el Firewall
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Este ajuste necesita permisos de administrador. Se va a pedir permiso...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo Configurando el Firewall de Windows para permitir el acceso por HTTPS
echo (puerto 443) desde otros dispositivos de tu red (celular, otra PC)...
echo.
netsh advfirewall firewall delete rule name="DRAP Inventory HTTPS" >nul 2>&1
netsh advfirewall firewall add rule name="DRAP Inventory HTTPS" dir=in action=allow protocol=TCP localport=443 profile=private,domain
if %errorlevel% equ 0 (
  echo.
  echo ==============================================
  echo   Listo. Ahora se puede entrar por HTTPS
  echo   desde otros dispositivos de tu misma red.
  echo ==============================================
) else (
  echo.
  echo No se pudo agregar la regla. Haz clic derecho sobre este archivo
  echo y elige "Ejecutar como administrador", y vuelve a intentar.
)
echo.
pause
