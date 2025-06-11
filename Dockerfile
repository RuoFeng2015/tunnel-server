# 内网穿透中转服务器 Docker 镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装必要的系统依赖
RUN apk add --no-cache \
  python3 \
  make \
  g++ \
  git

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装 Node.js 依赖
RUN npm ci --only=production && npm cache clean --force

# 复制应用程序文件
COPY . .

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
  adduser -S tunnelserver -u 1001

# 设置文件权限
RUN chown -R tunnelserver:nodejs /app
USER tunnelserver

# 暴露端口
EXPOSE 8080 8081 8082

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); });"

# 启动应用
CMD ["node", "app.js"]