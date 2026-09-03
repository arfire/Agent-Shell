@echo off
where corepack >nul 2>nul
if %errorlevel% equ 0 (
    corepack yarn@1.22.22 %*
) else (
    npx --yes yarn@1.22.22 %*
)
