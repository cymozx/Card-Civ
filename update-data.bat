@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo ===================================================
echo  card_recipe_table_v3.xlsx  --^>  cards-data.js
echo ===================================================
echo.
echo  엑셀 파일이 열려 있으면 먼저 닫아 주세요.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\convert_xlsx_to_js.ps1"
echo.
pause
