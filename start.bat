@echo off
chcp 65001 >nul
echo 🚀 启动内网穿透服务端...

REM 检查Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 错误: 未找到Node.js，请先安装Node.js 18+
    pause
    exit /b 1
)

REM 安装依赖
if not exist "node_modules" (
    echo 📦 安装依赖包...
    npm install
)

REM 检查环境配置
if not exist ".env" (
    echo 📋 创建环境配置文件...
    copy .env.example .env >nul
    echo ⚠️  请编辑 .env 文件配置您的环境参数
)

REM 启动服务
echo 🔥 启动服务器...
if "%1"=="dev" (
    echo 🛠️  开发模式启动...
    npm run dev
) else if "%1"=="pm2" (
    echo ⚡ PM2守护进程启动...
    npm run pm2
) else (
    echo 🏃 生产模式启动...
    npm start
)

pause
