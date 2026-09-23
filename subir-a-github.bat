@echo off
title DRAP Inventory - Subir a GitHub
cd /d "%~dp0"

echo.
echo Este script sube el proyecto a:
echo   https://github.com/reynelibanez/drap-inventory
echo.
echo La primera vez te va a abrir el navegador para que inicies sesion en GitHub
echo (asi Windows recuerda tu cuenta y no hace falta pegar ningun token).
echo.
echo No sube el archivo .env ni las claves/certificados (carpeta data) ni node_modules:
echo eso ya esta excluido en .gitignore.
echo.
pause

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo No se encontro "git" en esta PC. Abri Visual Studio 2022, entra a esta carpeta
  echo como proyecto/carpeta, y usa el menu "Git" - "Crear repositorio Git" una vez
  echo ^(instala las herramientas de Git automaticamente^). Despues volve a correr este script.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo Iniciando repositorio...
  git init
  if errorlevel 1 goto :fail
)

git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Actualizacion de DRAP Inventory"
  if errorlevel 1 goto :fail
) else (
  echo No hay cambios nuevos para subir ^(o ya esta todo commiteado^).
)

git branch -M main

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin https://github.com/reynelibanez/drap-inventory.git
) else (
  git remote set-url origin https://github.com/reynelibanez/drap-inventory.git
)

echo.
echo Subiendo (puede pedir que inicies sesion en GitHub en el navegador)...
git push -u origin main
if errorlevel 1 goto :fail

echo.
echo ==============================================
echo   Listo. Proyecto subido a GitHub.
echo ==============================================
echo.
pause
exit /b 0

:fail
echo.
echo [X] Algo fallo al subir. Si el mensaje dice algo de "rejected" o "diverged",
echo     es porque el repositorio en GitHub ya tenia contenido (por ejemplo un
echo     README inicial): avisame el mensaje exacto y te digo como seguir.
echo.
pause
exit /b 1
