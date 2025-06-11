#!/bin/bash

# 内网穿透服务端启动脚本

echo "🚀 启动内网穿透服务端..."

# 检查Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到Node.js，请先安装Node.js 18+"
    exit 1
fi

# 检查npm
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: 未找到npm"
    exit 1
fi

# 安装依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖包..."
    npm install
fi

# 检查环境配置
if [ ! -f ".env" ]; then
    echo "📋 创建环境配置文件..."
    cp .env.example .env
    echo "⚠️  请编辑 .env 文件配置您的环境参数"
fi

# 启动服务
echo "🔥 启动服务器..."
if [ "$1" = "dev" ]; then
    echo "🛠️  开发模式启动..."
    npm run dev
elif [ "$1" = "pm2" ]; then
    echo "⚡ PM2守护进程启动..."
    npm run pm2
else
    echo "🏃 生产模式启动..."
    npm start
fi
