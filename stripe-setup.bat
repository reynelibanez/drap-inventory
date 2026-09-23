@echo off
cd /d "%~dp0"
title DRAP Inventory - Configurar Stripe
echo.
echo ==============================================
echo   DRAP Inventory - Configurar pagos (Stripe)
echo ==============================================
echo.
echo Esto crea en tu cuenta de Stripe los productos y precios de los
echo planes Business y Enterprise, y guarda sus identificadores en la
echo base de datos. Antes de continuar, agrega en el archivo .env:
echo   STRIPE_SECRET_KEY=...
echo   STRIPE_PUBLISHABLE_KEY=...
echo (las claves de tu cuenta de Stripe, de prueba o reales).
echo.
pause
call npm run stripe:setup
if errorlevel 1 goto :fail
echo.
echo Listo. Reinicia el sistema con start.bat para que tome los precios nuevos.
pause
exit /b 0
:fail
echo.
echo [X] Algo fallo. Revisa el mensaje de arriba (probablemente falten las
echo     claves de Stripe en el archivo .env, o no hay conexion a internet).
pause
exit /b 1
