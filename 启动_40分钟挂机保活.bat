@echo off
chcp 65001 >nul
title FreeMCHost 40分钟循环保活挂机脚本
echo ========================================================
echo          FreeMCHost 服务器 40 分钟在线保活工具
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

echo [状态] 正在启动 40 分钟常驻挂机模式...
echo [提示] 请保持本窗口打开，脚本将每隔 40 分钟自动点击一次 Reset！
echo.

node renew.js --loop

pause
