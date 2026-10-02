@echo off
chcp 65001 >nul
title FreeMCHost 立即测试运行一次
echo ========================================================
echo          FreeMCHost 立即单次测试运行
echo ========================================================
echo.
cd /d "%~dp0"

if not exist node_modules (
    echo [提示] 首次运行，正在自动安装 Playwright 依赖...
    call npm install playwright
    call npx playwright install chromium
    echo [提示] 依赖安装完成！
    echo.
)

echo [状态] 正在执行单次测试...
node renew.js

echo.
echo [完成] 测试运行结束，请查看控制台输出或 screenshots 截图！
pause
