/**
 * 内网穿透中转服务器 - 生产级实现
 * 基于 Node.js + Koa 框架
 * 支持 HTTP/WebSocket 代理和多客户端连接
 */

// 加载环境变量
require('dotenv').config();

const net = require('net');
const http = require('http');
const https = require('https');
const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const WebSocket = require('ws');
const httpProxy = require('http-proxy');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 配置常量
const CONFIG = {
  // 服务端口
  TUNNEL_PORT: process.env.TUNNEL_PORT || 3080,    // 隧道连接端口
  PROXY_PORT: process.env.PROXY_PORT || 3081,      // HTTP代理端口
  ADMIN_PORT: process.env.ADMIN_PORT || 3082,      // 管理后台端口

  // 安全配置
  JWT_SECRET: process.env.JWT_SECRET || 'tunnel-server-secret-2023',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'password',

  // 连接配置
  MAX_CLIENTS: parseInt(process.env.MAX_CLIENTS) || 10,
  HEARTBEAT_INTERVAL: 30000,    // 30秒心跳
  CLIENT_TIMEOUT: 60000,        // 60秒超时

  // SSL配置 (可选)
  SSL_ENABLED: process.env.SSL_ENABLED === 'true',
  SSL_KEY_PATH: process.env.SSL_KEY_PATH,
  SSL_CERT_PATH: process.env.SSL_CERT_PATH,

  // 日志配置
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};

/**
 * 日志记录器
 */
class Logger {
  static levels = { error: 0, warn: 1, info: 2, debug: 3 };
  static currentLevel = this.levels[CONFIG.LOG_LEVEL] || 2;

  static log(level, message, ...args) {
    if (this.levels[level] <= this.currentLevel) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, ...args);
    }
  }

  static error(message, ...args) { this.log('error', message, ...args); }
  static warn(message, ...args) { this.log('warn', message, ...args); }
  static info(message, ...args) { this.log('info', message, ...args); }
  static debug(message, ...args) { this.log('debug', message, ...args); }
}

/**
 * 客户端连接管理
 */
class ClientManager {
  constructor() {
    this.clients = new Map();       // clientId -> clientInfo
    this.connections = new Map();   // socket -> clientInfo
    this.routes = new Map();        // subdomain/path -> clientId
  }

  /**
   * 注册新客户端
   */
  registerClient(socket, clientInfo) {
    this.connections.set(socket, clientInfo);

    if (clientInfo.clientId) {
      this.clients.set(clientInfo.clientId, clientInfo);
      Logger.info(`客户端注册成功: ${clientInfo.clientId} (${clientInfo.remoteAddress})`);
    }
  }

  /**
   * 移除客户端
   */
  removeClient(socket) {
    const clientInfo = this.connections.get(socket);
    if (clientInfo) {
      if (clientInfo.clientId) {
        this.clients.delete(clientInfo.clientId);
        this.removeRoutes(clientInfo.clientId);
        Logger.info(`客户端断开连接: ${clientInfo.clientId}`);
      }
      this.connections.delete(socket);
    }
  }

  /**
   * 获取客户端信息
   */
  getClient(clientId) {
    return this.clients.get(clientId);
  }

  /**
   * 获取所有客户端
   */
  getAllClients() {
    return Array.from(this.clients.values());
  }

  /**
   * 检查客户端数量限制
   */
  canAcceptNewClient() {
    return this.clients.size < CONFIG.MAX_CLIENTS;
  }

  /**
   * 添加路由映射
   */  addRoute(route, clientId) {
    this.routes.set(route, clientId);
    // Logger.debug(`添加路由映射: ${route} -> ${clientId}`);
  }

  /**
   * 移除客户端的所有路由
   */
  removeRoutes(clientId) {    for (const [route, cId] of this.routes.entries()) {
      if (cId === clientId) {
        this.routes.delete(route);
        // Logger.debug(`移除路由映射: ${route}`);
      }
    }
  }

  /**
   * 根据路由获取客户端
   */
  getClientByRoute(route) {
    const clientId = this.routes.get(route);
    return clientId ? this.clients.get(clientId) : null;
  }
}

/**
 * 隧道服务器 - 处理客户端连接
 */
class TunnelServer {
  constructor(clientManager) {
    this.clientManager = clientManager;
    this.server = null;
    this.requestQueue = new Map(); // 存储待处理的请求
  }

  /**
   * 启动隧道服务器
   */
  start() {
    this.server = net.createServer((socket) => {
      this.handleClientConnection(socket);
    }); this.server.listen(CONFIG.TUNNEL_PORT, '0.0.0.0', () => {
      Logger.info(`隧道服务器启动在端口 ${CONFIG.TUNNEL_PORT}`);
    });

    this.server.on('error', (error) => {
      Logger.error('隧道服务器错误:', error.message);
    });

    // 启动心跳检查
    this.startHeartbeatCheck();
  }

  /**
   * 处理客户端连接
   */
  handleClientConnection(socket) {
    // 检查连接数限制
    if (!this.clientManager.canAcceptNewClient()) {
      Logger.warn(`拒绝新连接: 已达到最大客户端数量 (${CONFIG.MAX_CLIENTS})`);
      socket.write(JSON.stringify({
        type: 'error',
        message: '服务器已达到最大连接数',
        timestamp: Date.now()
      }) + '\n');
      socket.destroy();
      return;
    } const clientInfo = {
      socket: socket,
      authenticated: false,
      clientId: null,
      username: null,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      connectTime: Date.now(),
      lastHeartbeat: Date.now(),
      requestCount: 0,
      bytesSent: 0,
      bytesReceived: 0,
      messageBuffer: '' // 添加消息缓冲区
    };

    Logger.info(`新客户端连接: ${clientInfo.remoteAddress}:${clientInfo.remotePort}`);
    this.clientManager.registerClient(socket, clientInfo);

    // 设置socket事件
    socket.on('data', (data) => {
      clientInfo.bytesReceived += data.length;
      this.handleClientMessage(clientInfo, data);
    });    socket.on('close', () => {
      // Logger.debug(`客户端关闭连接: ${clientInfo.remoteAddress}:${clientInfo.remotePort}`);
      this.clientManager.removeClient(socket);
    });

    socket.on('error', (error) => {
      Logger.error(`客户端连接错误 (${clientInfo.remoteAddress}): ${error.message}`);
      this.clientManager.removeClient(socket);
    });

    // 设置超时
    socket.setTimeout(CONFIG.CLIENT_TIMEOUT, () => {
      Logger.warn(`客户端连接超时: ${clientInfo.remoteAddress}`);
      socket.destroy();
    });
  }
  /**
   * 处理客户端消息
   */
  handleClientMessage(clientInfo, data) {
    try {
      // 将新数据添加到缓冲区
      clientInfo.messageBuffer += data.toString();

      // 处理完整的消息（以换行符分隔）
      const lines = clientInfo.messageBuffer.split('\n');

      // 保留最后一个可能不完整的消息
      clientInfo.messageBuffer = lines.pop() || '';

      // 处理完整的消息
      for (const messageStr of lines) {
        if (messageStr.trim()) {          try {            const message = JSON.parse(messageStr);
            // Logger.debug(`收到消息: ${message.type} from ${clientInfo.clientId || clientInfo.remoteAddress}`);

            switch (message.type) {
              case 'auth':
                this.handleAuth(clientInfo, message);
                break;
              case 'heartbeat':
                this.handleHeartbeat(clientInfo, message);
                break;
              case 'heartbeat_ack':
                clientInfo.lastHeartbeat = Date.now();
                break;
              case 'proxy_response':
                this.handleProxyResponse(clientInfo, message);
                break;
              case 'websocket_upgrade_response':
                this.handleWebSocketUpgradeResponse(clientInfo, message);
                break;
              case 'websocket_data':
                this.handleWebSocketData(clientInfo, message);
                break;
              case 'websocket_close':
                this.handleWebSocketClose(clientInfo, message);
                break;
              case 'register_route':
                this.handleRouteRegister(clientInfo, message);
                break;
              default:
                Logger.warn(`未知消息类型: ${message.type}`);
            }
          } catch (parseError) {
            Logger.error(`JSON解析失败 (${clientInfo.remoteAddress}): ${parseError.message}, 消息内容: ${messageStr.substring(0, 100)}...`);
          }
        }
      }
    } catch (error) {
      Logger.error(`处理客户端消息失败 (${clientInfo.remoteAddress}): ${error.message}`);
      // 清空缓冲区以防止错误累积
      clientInfo.messageBuffer = '';
    }
  }

  /**
   * 处理身份验证
   */
  handleAuth(clientInfo, message) {
    const { username, password, client_id } = message;

    Logger.info(`认证请求: ${username} / ${client_id} from ${clientInfo.remoteAddress}`);

    // 简单验证 - 生产环境应使用数据库和加密
    const validCredentials = this.validateCredentials(username, password);

    if (validCredentials && client_id) {
      // 检查clientId是否已被使用
      const existingClient = this.clientManager.getClient(client_id);
      if (existingClient && existingClient.socket !== clientInfo.socket) {
        this.sendMessage(clientInfo.socket, {
          type: 'auth_failed',
          reason: '客户端ID已被使用',
          timestamp: Date.now()
        });
        return;
      }

      clientInfo.authenticated = true;
      clientInfo.clientId = client_id;
      clientInfo.username = username;

      // 重新注册客户端（更新clientId）
      this.clientManager.registerClient(clientInfo.socket, clientInfo);

      this.sendMessage(clientInfo.socket, {
        type: 'auth_success',
        client_id: client_id,
        timestamp: Date.now()
      });

      Logger.info(`客户端认证成功: ${client_id} (${username})`);
    } else {
      this.sendMessage(clientInfo.socket, {
        type: 'auth_failed',
        reason: '用户名、密码或客户端ID错误',
        timestamp: Date.now()
      });

      Logger.warn(`客户端认证失败: ${username} from ${clientInfo.remoteAddress}`);
    }
  }

  /**
   * 验证凭据
   */
  validateCredentials(username, password) {
    // 简单验证 - 生产环境应使用更安全的方式
    const validUsers = {
      'admin': 'password',
      'user1': 'pass123',
      'demo': 'demo123'
    };

    return validUsers[username] === password;
  }

  /**
   * 处理心跳
   */
  handleHeartbeat(clientInfo, message) {
    clientInfo.lastHeartbeat = Date.now();    this.sendMessage(clientInfo.socket, {
      type: 'heartbeat_ack',
      timestamp: Date.now()
    });

    // Logger.debug(`心跳响应: ${clientInfo.clientId || clientInfo.remoteAddress}`);
  }

  /**
   * 处理路由注册
   */
  handleRouteRegister(clientInfo, message) {
    if (!clientInfo.authenticated) {
      return;
    }

    const { route } = message;
    if (route) {
      this.clientManager.addRoute(route, clientInfo.clientId);

      this.sendMessage(clientInfo.socket, {
        type: 'route_registered',
        route: route,
        timestamp: Date.now()
      });
    }
  }  /**
   * 处理代理响应
   */
  handleProxyResponse(clientInfo, message) {
    const { request_id, status_code, headers, body } = message;

    // 查找对应的原始请求
    const requestInfo = this.requestQueue.get(request_id);
    if (requestInfo) {
      const { res } = requestInfo;

      try {
        // 设置响应头
        if (headers) {
          Object.entries(headers).forEach(([key, value]) => {
            res.setHeader(key, value);
          });
        }        // 智能处理响应体
        let responseBody;
        if (body) {
          // Logger.debug(`原始响应体长度: ${body.length}, 类型: ${typeof body}`);

          // 尝试多种解码方式
          try {
            // 方法1: 检查是否为有效的base64
            if (typeof body === 'string' && body.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(body.trim())) {
              const base64Test = Buffer.from(body.trim(), 'base64');
              responseBody = base64Test;
              // Logger.debug(`使用Base64解码: ${body.length} chars -> ${base64Test.length} bytes`);
            } else {
              throw new Error('Not valid base64');
            }
          } catch (error1) {
            // 方法2: 使用binary编码（最适合二进制数据）
            responseBody = Buffer.from(body, 'binary');
            // Logger.debug(`使用binary编码: ${body.length} chars -> ${responseBody.length} bytes`);
          }
        } else {
          responseBody = Buffer.alloc(0);
          // Logger.debug('空响应体');
        }// 发送响应
        res.statusCode = status_code || 200;
        res.end(responseBody);        clientInfo.bytesSent += (responseBody.length || 0);
        clientInfo.requestCount++;

        // Logger.debug(`代理响应完成: ${request_id} -> ${status_code}, body: ${responseBody.length} bytes`);
      } catch (error) {
        Logger.error(`发送代理响应失败: ${error.message}`);

        // 发送错误响应，但只有在响应还没有发送的情况下
        try {
          if (!res.headersSent) {
            // 如果原始状态码是客户端错误（4xx），保持原状态码
            if (status_code >= 400 && status_code < 500) {
              res.statusCode = status_code;
              res.end(body || 'Client Error');
            } else {
              res.statusCode = 500;
              res.end('Internal Server Error');
            }
          }
        } catch (e) {
          Logger.error(`发送错误响应也失败: ${e.message}`);
        }
      }

      this.requestQueue.delete(request_id);
    }
  }  /**
   * 处理WebSocket升级响应
   */  handleWebSocketUpgradeResponse(clientInfo, message) {
    const { upgrade_id, status_code, headers } = message;

    // Logger.debug(`收到WebSocket升级响应: ${upgrade_id}, 状态: ${status_code}`);

    // 查找对应的WebSocket升级请求 - 从ProxyServer的requestQueue中查找
    const upgradeInfo = global.proxyServer.requestQueue.get(upgrade_id);
    if (!upgradeInfo || upgradeInfo.type !== 'websocket_upgrade') {
      Logger.warn(`未找到WebSocket升级请求: ${upgrade_id}`);
      // Logger.debug(`TunnelServer请求队列中的项目: ${Array.from(this.requestQueue.keys()).join(', ')}`);
      // Logger.debug(`ProxyServer请求队列中的项目: ${Array.from(global.proxyServer.requestQueue.keys()).join(', ')}`);
      return;
    }

    const { socket } = upgradeInfo;

    try {
      if (status_code === 101) {
        // WebSocket升级成功
        Logger.info(`WebSocket升级成功: ${upgrade_id}`);

        // 发送101响应
        let responseHeaders = 'HTTP/1.1 101 Switching Protocols\r\n';
        responseHeaders += 'Upgrade: websocket\r\n';
        responseHeaders += 'Connection: Upgrade\r\n';

        if (headers) {
          Object.entries(headers).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'connection' && key.toLowerCase() !== 'upgrade') {
              responseHeaders += `${key}: ${value}\r\n`;
            }
          });
        }

        responseHeaders += '\r\n';
        socket.write(responseHeaders);

        // 建立WebSocket数据转发
        this.setupWebSocketDataForwarding(socket, clientInfo, upgrade_id);

      } else {
        // WebSocket升级失败
        Logger.warn(`WebSocket升级失败: ${upgrade_id}, 状态码: ${status_code}`);
        socket.write(`HTTP/1.1 ${status_code} WebSocket Upgrade Failed\r\n\r\n`);
        socket.destroy();
      }
    } catch (error) {
      Logger.error(`处理WebSocket升级响应失败: ${error.message}`);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }

    // 从ProxyServer的requestQueue中删除请求
    global.proxyServer.requestQueue.delete(upgrade_id);
  }

  /**
   * 设置WebSocket数据转发
   */  setupWebSocketDataForwarding(browserSocket, clientInfo, upgradeId) {
    // Logger.debug(`设置WebSocket数据转发: ${upgradeId}`);

    // 存储WebSocket连接
    this.requestQueue.set(`ws_${upgradeId}`, {
      browserSocket,
      clientInfo,
      timestamp: Date.now(),
      type: 'websocket_connection'
    });

    // 浏览器 -> 客户端
    browserSocket.on('data', (data) => {
      const wsMessage = {
        type: 'websocket_data',
        upgrade_id: upgradeId,
        data: data.toString('base64'), // 使用base64编码传输
        timestamp: Date.now()
      };
      this.sendMessage(clientInfo.socket, wsMessage);
    });    // 处理浏览器连接关闭
    browserSocket.on('close', () => {
      // Logger.debug(`浏览器WebSocket连接关闭: ${upgradeId}`);
      const wsMessage = {
        type: 'websocket_close',
        upgrade_id: upgradeId,
        timestamp: Date.now()
      };
      this.sendMessage(clientInfo.socket, wsMessage);
      this.requestQueue.delete(`ws_${upgradeId}`);
    });

    browserSocket.on('error', (error) => {
      Logger.error(`浏览器WebSocket连接错误: ${error.message}`);
      const wsMessage = {
        type: 'websocket_close',
        upgrade_id: upgradeId,
        timestamp: Date.now()
      };
      this.sendMessage(clientInfo.socket, wsMessage);
      this.requestQueue.delete(`ws_${upgradeId}`);
    });
  }

  /**
   * 处理WebSocket数据
   */
  handleWebSocketData(clientInfo, message) {
    const { upgrade_id, data } = message;

    const wsConnection = this.requestQueue.get(`ws_${upgrade_id}`);
    if (!wsConnection || wsConnection.type !== 'websocket_connection') {
      Logger.warn(`未找到WebSocket连接: ${upgrade_id}`);
      return;
    }

    try {
      // 解码base64数据并发送到浏览器
      const binaryData = Buffer.from(data, 'base64');
      wsConnection.browserSocket.write(binaryData);
    } catch (error) {
      Logger.error(`WebSocket数据转发失败: ${error.message}`);
    }
  }

  /**
   * 处理WebSocket关闭
   */
  handleWebSocketClose(clientInfo, message) {
    const { upgrade_id } = message;

    const wsConnection = this.requestQueue.get(`ws_${upgrade_id}`);
    if (wsConnection && wsConnection.type === 'websocket_connection') {
      Logger.debug(`关闭WebSocket连接: ${upgrade_id}`);
      wsConnection.browserSocket.destroy();
      this.requestQueue.delete(`ws_${upgrade_id}`);
    }
  }

  /**
   * 发送代理请求给客户端
   */
  sendProxyRequest(clientInfo, req, res, ctx = null) {
    const requestId = this.generateRequestId();

    // 存储请求信息
    this.requestQueue.set(requestId, { req, res, clientInfo, timestamp: Date.now() });

    // 检查是否是multipart请求
    const contentType = req.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');    if (isMultipart && ctx) {
      // Logger.debug('处理multipart/form-data请求');

      // 对于multipart请求，从原始请求流读取数据
      let body = '';

      ctx.req.on('data', chunk => {
        body += chunk.toString();
      });

      ctx.req.on('end', () => {
        const message = {
          type: 'proxy_request',
          request_id: requestId,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body,
          timestamp: Date.now()
        };

        // Logger.debug(`Sending multipart proxy_request to client ${clientInfo.clientId}: ID=${requestId}, Method=${message.method}, URL=${message.url}, BodyLength=${body.length}`);
        this.sendMessage(clientInfo.socket, message);
      });

    } else {
      // 对于非multipart请求，使用原来的逻辑
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', () => {
        const message = {
          type: 'proxy_request',
          request_id: requestId,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body,
          timestamp: Date.now()
        };

        // Logger.debug(`Sending proxy_request to client ${clientInfo.clientId}: ID=${requestId}, Method=${message.method}, URL=${message.url}, Headers=${JSON.stringify(message.headers)}, BodyLength=${body.length}`);
        this.sendMessage(clientInfo.socket, message);
      });
    }

    // 设置超时
    setTimeout(() => {
      if (this.requestQueue.has(requestId)) {
        this.requestQueue.delete(requestId);
        if (!res.headersSent) {
          res.statusCode = 504;
          res.end('Gateway Timeout');
        }
        Logger.warn(`代理请求超时: ${requestId}`);
      }
    }, 30000); // 30秒超时
  }

  /**
   * 发送消息给客户端
   */
  sendMessage(socket, message) {
    try {
      const data = JSON.stringify(message) + '\n';
      socket.write(data);
      return true;
    } catch (error) {
      Logger.error(`发送消息失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 生成请求ID
   */
  generateRequestId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * 启动心跳检查
   */
  startHeartbeatCheck() {
    setInterval(() => {
      const now = Date.now();
      const clients = this.clientManager.getAllClients();

      for (const client of clients) {
        if (now - client.lastHeartbeat > CONFIG.CLIENT_TIMEOUT) {
          Logger.warn(`客户端心跳超时: ${client.clientId || client.remoteAddress}`);
          client.socket.destroy();
        }
      }

      // 清理过期请求
      for (const [requestId, requestInfo] of this.requestQueue.entries()) {
        if (now - requestInfo.timestamp > 30000) {
          this.requestQueue.delete(requestId);
          if (!requestInfo.res.headersSent) {
            requestInfo.res.statusCode = 504;
            requestInfo.res.end('Request Timeout');
          }
        }
      }
    }, CONFIG.HEARTBEAT_INTERVAL);
  }

  /**
   * 停止服务器
   */
  stop() {
    if (this.server) {
      this.server.close();
      Logger.info('隧道服务器已停止');
    }
  }
}

/**
 * HTTP代理服务器
 */
class ProxyServer {
  constructor(clientManager) {
    this.clientManager = clientManager;
    this.app = new Koa();
    this.server = null;
    this.requestQueue = new Map(); // 存储待处理的请求
    this.setupRoutes();
  }

  /**
   * 设置路由
   */
  setupRoutes() {    // CORS配置
    this.app.use(cors());

    // 配置body parser以更好地处理各种类型的请求
    this.app.use(async (ctx, next) => {
      const contentType = ctx.headers['content-type'] || '';    // 如果是multipart/form-data，跳过body parser，让它作为原始数据传递
      if (contentType.includes('multipart/form-data')) {
        // Logger.debug(`跳过multipart请求的body parser: ${ctx.method} ${ctx.url}`);
        // 不解析body，保持原始格式
        await next();
      } else {
        // 对于其他类型，使用标准body parser
        await bodyParser({
          jsonLimit: '10mb',
          formLimit: '10mb',
          textLimit: '10mb',
          enableTypes: ['json', 'form', 'text'],
          onerror: (err, ctx) => {
            Logger.error(`Body parser错误: ${err.message}, URL: ${ctx.url}, Method: ${ctx.method}`);
            ctx.status = 400;
            ctx.body = { error: 'Invalid request body', message: err.message };
          }
        })(ctx, next);
      }
    });

    // 根据subdomain或路径路由到不同客户端
    this.app.use(async (ctx, next) => {
      try {
        const host = ctx.headers.host;
        const path = ctx.path;

        // 提取subdomain
        const subdomain = this.extractSubdomain(host);        // 查找对应的客户端
        let client = null;

        // Logger.debug(`收到代理请求: ${ctx.method} ${ctx.url} from ${ctx.ip}`);

        // 首先尝试subdomain路由
        if (subdomain) {
          client = this.clientManager.getClientByRoute(subdomain);
          // Logger.debug(`Subdomain路由查找: ${subdomain} -> ${client ? client.clientId : 'not found'}`);
        }

        // 如果没找到，尝试路径路由
        if (!client) {
          const pathRoute = path.split('/')[1]; // 获取第一级路径
          if (pathRoute) {
            // 首先尝试路由映射
            client = this.clientManager.getClientByRoute(pathRoute);

            // 如果路由映射没找到，直接尝试按客户端ID查找
            if (!client) {
              client = this.clientManager.getClient(pathRoute);
            }

            // Logger.debug(`路径路由查找: ${pathRoute} -> ${client ? client.clientId : 'not found'}`);
          }
        }

        // 如果还没找到，使用默认的已认证客户端
        if (!client) {
          const clients = this.clientManager.getAllClients();
          client = clients.find(c => c.authenticated);
          // Logger.debug(`使用默认客户端: ${client ? client.clientId : 'none available'}`);
        }

        if (!client || !client.authenticated) {
          ctx.status = 502;
          ctx.body = {
            error: 'No available tunnel client',
            message: '没有可用的隧道客户端'
          };
          return;
        }

        // 发送代理请求
        await this.forwardRequest(ctx, client);

      } catch (error) {
        Logger.error(`代理请求处理错误: ${error.message}`);
        ctx.status = 500;
        ctx.body = { error: 'Internal Server Error' };
      }
    });
  }

  /**
   * 提取subdomain
   */
  extractSubdomain(host) {
    if (!host) return null;

    const parts = host.split('.');
    if (parts.length > 2) {
      return parts[0]; // 返回第一级subdomain
    }
    return null;
  }

  /**
   * 转发请求到客户端
   */  async forwardRequest(ctx, client) {
    return new Promise((resolve, reject) => {
      const tunnelServer = global.tunnelServer;

      const originalUrl = ctx.url;
      let proxiedUrl = originalUrl;
      const clientIdFromPath = ctx.path.split('/')[1]; // e.g. ha-client-001

      if (client && client.clientId && clientIdFromPath === client.clientId) {
        const pathPrefix = `/${client.clientId}`;
        if (originalUrl.startsWith(pathPrefix)) {
          proxiedUrl = originalUrl.substring(pathPrefix.length);
          if (!proxiedUrl.startsWith('/')) {
            proxiedUrl = '/' + proxiedUrl;
          }
        }
        if (proxiedUrl === '') {
          proxiedUrl = '/';
        }        // Logger.debug(`URL rewritten: original='${originalUrl}', new='${proxiedUrl}' for client='${client.clientId}'`);
      } else {
        // Logger.debug(`URL not rewritten. original='${originalUrl}', client='${client ? client.clientId : 'N/A'}', clientIdFromPath='${clientIdFromPath}'`);
      }      // Prepare headers: copy original headers and remove problematic headers
      const headersToSend = { ...ctx.headers };
      const originalHostHeader = headersToSend.host;

      // 删除可能导致问题的头信息
      delete headersToSend.host; // 删除host头，让目标客户端自己设置
      delete headersToSend.connection; // 删除connection头
      delete headersToSend['content-length']; // 删除content-length，让目标客户端重新计算

      // Logger.debug(`Headers cleaned. Original host: '${originalHostHeader}'. Removed: host, connection, content-length. Forwarding to client: ${client.clientId}`);

      const req = {
        method: ctx.method,
        url: proxiedUrl, // 使用修改后的URL
        headers: headersToSend, // 使用清理后的headers
        _dataHandlers: [],
        _endHandlers: [],
        on: (event, callback) => {
          if (event === 'data') {
            req._dataHandlers.push(callback);
          } else if (event === 'end') {
            req._endHandlers.push(callback);
          }
        }
      };      // 模拟异步触发事件
      setImmediate(() => {
        // 从Koa解析的请求体获取数据，而不是从原始请求流
        let bodyToSend = '';

        if (ctx.request.body !== undefined && ctx.request.body !== null) {
          if (typeof ctx.request.body === 'string') {
            bodyToSend = ctx.request.body;
          } else if (typeof ctx.request.body === 'object') {
            // 如果是对象且不为空，序列化为JSON
            if (Object.keys(ctx.request.body).length > 0) {
              bodyToSend = JSON.stringify(ctx.request.body);
            }
          }
        }        // 只在有实际内容时触发data事件
        if (bodyToSend) {
          req._dataHandlers.forEach(handler => handler(bodyToSend));
          // Logger.debug(`Forwarding request body: ${bodyToSend.length} bytes`);
        } else {
          // Logger.debug('No request body to forward');
        }

        // 触发end事件
        req._endHandlers.forEach(handler => handler());
      });

      const res = {
        statusCode: 200,
        headers: {},
        headersSent: false,
        setHeader: (key, value) => {
          res.headers[key] = value;
        },
        end: (body) => {
          res.headersSent = true;
          ctx.status = res.statusCode;
          Object.entries(res.headers).forEach(([key, value]) => {
            ctx.set(key, value);
          });
          ctx.body = body;
          resolve();
        }
      };

      tunnelServer.sendProxyRequest(client, req, res, ctx);

      // 设置超时
      setTimeout(() => {
        if (!res.headersSent) {
          ctx.status = 504;
          ctx.body = 'Gateway Timeout';
          resolve();
        }
      }, 30000);
    });
  }

  /**
   * 启动代理服务器
   */
  start() {
    const serverOptions = {};

    // SSL配置
    if (CONFIG.SSL_ENABLED && CONFIG.SSL_KEY_PATH && CONFIG.SSL_CERT_PATH) {
      try {
        serverOptions.key = fs.readFileSync(CONFIG.SSL_KEY_PATH);
        serverOptions.cert = fs.readFileSync(CONFIG.SSL_CERT_PATH);
        this.server = https.createServer(serverOptions, this.app.callback());
        Logger.info(`HTTPS代理服务器启动在端口 ${CONFIG.PROXY_PORT}`);
      } catch (error) {
        Logger.error(`SSL证书加载失败: ${error.message}`);
        this.server = http.createServer(this.app.callback());
        Logger.info(`HTTP代理服务器启动在端口 ${CONFIG.PROXY_PORT}`);
      }
    } else {
      this.server = http.createServer(this.app.callback());
      Logger.info(`HTTP代理服务器启动在端口 ${CONFIG.PROXY_PORT}`);
    }

    this.server.listen(CONFIG.PROXY_PORT, '0.0.0.0');

    this.server.on('error', (error) => {
      Logger.error('代理服务器错误:', error.message);
    });

    // WebSocket支持
    this.setupWebSocketProxy();
  }
  /**
   * 设置WebSocket代理
   */  setupWebSocketProxy() {
    this.server.on('upgrade', (request, socket, head) => {
      // Logger.debug(`WebSocket升级请求: ${request.url}`);

      // 解析URL来确定客户端
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathRoute = url.pathname.split('/')[1]; // 获取第一级路径，如 ha-client-001

      // 查找对应的客户端
      let client = null;

      if (pathRoute) {
        client = this.clientManager.getClientByRoute(pathRoute);
        if (!client) {
          client = this.clientManager.getClient(pathRoute);
        }
      }

      // 如果没找到特定客户端，使用默认的已认证客户端
      if (!client) {
        const clients = this.clientManager.getAllClients();
        client = clients.find(c => c.authenticated);
      }

      if (!client || !client.authenticated) {
        Logger.warn('WebSocket升级失败：没有可用的客户端');
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
        return;
      } Logger.info(`WebSocket升级请求转发到客户端: ${client.clientId}`);

      // 发送WebSocket升级请求到客户端
      this.handleWebSocketUpgrade(request, socket, head, client);
    });
  }

  /**
   * 处理WebSocket升级
   */
  handleWebSocketUpgrade(request, socket, head, client) {
    const upgradeId = this.generateRequestId();

    // 存储WebSocket连接信息
    this.requestQueue.set(upgradeId, {
      socket,
      clientInfo: client,
      timestamp: Date.now(),
      type: 'websocket_upgrade'
    });

    // 重写URL（移除客户端ID前缀）
    let proxiedUrl = request.url;
    const clientIdFromPath = request.url.split('/')[1];
    if (client.clientId && clientIdFromPath === client.clientId) {
      const pathPrefix = `/${client.clientId}`;
      if (request.url.startsWith(pathPrefix)) {
        proxiedUrl = request.url.substring(pathPrefix.length);
        if (!proxiedUrl.startsWith('/')) {
          proxiedUrl = '/' + proxiedUrl;
        }
      }
    }

    // 准备头信息
    const headersToSend = { ...request.headers };
    delete headersToSend.host; // 让客户端设置正确的host
    delete headersToSend.connection;
    const upgradeMessage = {
      type: 'websocket_upgrade',
      upgrade_id: upgradeId,
      method: request.method,
      url: proxiedUrl,
      headers: headersToSend,
      timestamp: Date.now()
    };

    // Logger.debug(`发送WebSocket升级请求: ${upgradeId} ${proxiedUrl}`);
    this.sendMessage(client.socket, upgradeMessage);

    // 设置超时
    setTimeout(() => {
      if (this.requestQueue.has(upgradeId)) {
        this.requestQueue.delete(upgradeId);
        Logger.warn(`WebSocket升级超时: ${upgradeId}`);
        socket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
        socket.destroy();
      }
    }, 10000); // 10秒超时
  }
  /**
   * 停止代理服务器
   */
  stop() {
    if (this.server) {
      this.server.close();
      Logger.info('代理服务器已停止');
    }
  }

  /**
   * 生成请求ID
   */
  generateRequestId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * 发送消息给客户端
   */
  sendMessage(socket, message) {
    try {
      const data = JSON.stringify(message) + '\n';
      socket.write(data);
      return true;
    } catch (error) {
      Logger.error(`发送消息失败: ${error.message}`);
      return false;
    }
  }
}

/**
 * 管理后台服务器
 */
class AdminServer {
  constructor(clientManager) {
    this.clientManager = clientManager;
    this.app = new Koa();
    this.server = null;
    this.setupRoutes();
  }

  /**
   * 设置管理路由
   */
  setupRoutes() {
    const router = new Router();

    // CORS和body parser    this.app.use(cors());

    // 配置管理接口的body parser
    this.app.use(bodyParser({
      jsonLimit: '1mb',
      formLimit: '1mb',
      textLimit: '1mb',
      enableTypes: ['json', 'form', 'text'],
      onerror: (err, ctx) => {
        Logger.error(`管理接口Body parser错误: ${err.message}, URL: ${ctx.url}`);
        ctx.status = 400;
        ctx.body = { error: 'Invalid request body', message: err.message };
      }
    }));

    // 错误处理
    this.app.use(async (ctx, next) => {
      try {
        await next();
      } catch (err) {
        Logger.error(`管理接口错误: ${err.message}`);
        ctx.status = err.status || 500;
        ctx.body = { error: err.message };
      }
    });

    // 认证中间件
    const authMiddleware = async (ctx, next) => {
      const token = ctx.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        ctx.status = 401;
        ctx.body = { error: '缺少认证令牌' };
        return;
      }

      try {
        const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
        ctx.user = decoded;
        await next();
      } catch (error) {
        ctx.status = 401;
        ctx.body = { error: '无效的认证令牌' };
      }
    };

    // 登录接口
    router.post('/api/auth/login', async (ctx) => {
      const { username, password } = ctx.request.body;

      if (username === CONFIG.ADMIN_USERNAME && password === CONFIG.ADMIN_PASSWORD) {
        const token = jwt.sign(
          { username, role: 'admin' },
          CONFIG.JWT_SECRET,
          { expiresIn: '24h' }
        );

        ctx.body = {
          token,
          user: { username, role: 'admin' },
          expires_in: 86400
        };

        Logger.info(`管理员登录成功: ${username}`);
      } else {
        ctx.status = 401;
        ctx.body = { error: '用户名或密码错误' };
      }
    });

    // 获取服务器状态
    router.get('/api/status', authMiddleware, async (ctx) => {
      const clients = this.clientManager.getAllClients();

      ctx.body = {
        server: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          version: '1.0.0',
          timestamp: Date.now()
        },
        config: {
          max_clients: CONFIG.MAX_CLIENTS,
          tunnel_port: CONFIG.TUNNEL_PORT,
          proxy_port: CONFIG.PROXY_PORT,
          ssl_enabled: CONFIG.SSL_ENABLED
        },
        clients: {
          total: clients.length,
          authenticated: clients.filter(c => c.authenticated).length,
          list: clients.map(c => ({
            client_id: c.clientId,
            username: c.username,
            remote_address: c.remoteAddress,
            connect_time: c.connectTime,
            last_heartbeat: c.lastHeartbeat,
            authenticated: c.authenticated,
            request_count: c.requestCount,
            bytes_sent: c.bytesSent,
            bytes_received: c.bytesReceived
          }))
        },
        routes: Array.from(this.clientManager.routes.entries()).map(([route, clientId]) => ({
          route,
          client_id: clientId
        }))
      };
    });

    // 获取客户端详情
    router.get('/api/clients/:clientId', authMiddleware, async (ctx) => {
      const client = this.clientManager.getClient(ctx.params.clientId);

      if (!client) {
        ctx.status = 404;
        ctx.body = { error: '客户端不存在' };
        return;
      }

      ctx.body = {
        client_id: client.clientId,
        username: client.username,
        remote_address: client.remoteAddress,
        remote_port: client.remotePort,
        connect_time: client.connectTime,
        last_heartbeat: client.lastHeartbeat,
        authenticated: client.authenticated,
        request_count: client.requestCount,
        bytes_sent: client.bytesSent,
        bytes_received: client.bytesReceived
      };
    });

    // 断开客户端连接
    router.delete('/api/clients/:clientId', authMiddleware, async (ctx) => {
      const client = this.clientManager.getClient(ctx.params.clientId);

      if (!client) {
        ctx.status = 404;
        ctx.body = { error: '客户端不存在' };
        return;
      }

      client.socket.destroy();
      ctx.body = { message: '客户端连接已断开' };
      Logger.info(`管理员断开客户端连接: ${ctx.params.clientId}`);
    });

    // 健康检查
    router.get('/api/health', async (ctx) => {
      ctx.body = {
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime()
      };
    });

    this.app.use(router.routes());
    this.app.use(router.allowedMethods());
  }

  /**
   * 启动管理服务器
   */
  start() {
    this.server = http.createServer(this.app.callback()); this.server.listen(CONFIG.ADMIN_PORT, '0.0.0.0', () => {
      Logger.info(`管理后台启动在端口 ${CONFIG.ADMIN_PORT}`);
    });

    this.server.on('error', (error) => {
      Logger.error('管理服务器错误:', error.message);
    });
  }

  /**
   * 停止管理服务器
   */
  stop() {
    if (this.server) {
      this.server.close();
      Logger.info('管理服务器已停止');
    }
  }
}

/**
 * 主服务器类
 */
class TunnelServerMain {
  constructor() {
    this.clientManager = new ClientManager();
    this.tunnelServer = new TunnelServer(this.clientManager);
    this.proxyServer = new ProxyServer(this.clientManager);
    this.adminServer = new AdminServer(this.clientManager);    // 设置全局引用
    global.tunnelServer = this.tunnelServer;
    global.proxyServer = this.proxyServer;
  }

  /**
   * 启动所有服务
   */
  async start() {
    Logger.info('启动内网穿透中转服务器...');

    try {
      // 启动隧道服务器
      this.tunnelServer.start();

      // 启动代理服务器
      this.proxyServer.start();

      // 启动管理后台
      this.adminServer.start();

      Logger.info('所有服务启动成功！');
      this.printServerInfo();

    } catch (error) {
      Logger.error(`服务启动失败: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * 停止所有服务
   */
  stop() {
    Logger.info('正在停止服务器...');

    this.tunnelServer.stop();
    this.proxyServer.stop();
    this.adminServer.stop();

    Logger.info('服务器已停止');
  }

  /**
   * 打印服务器信息
   */
  printServerInfo() {
    console.log('\n==================== 服务器信息 ====================');
    console.log(`隧道连接端口: ${CONFIG.TUNNEL_PORT}`);
    console.log(`HTTP代理端口: ${CONFIG.PROXY_PORT} ${CONFIG.SSL_ENABLED ? '(HTTPS)' : '(HTTP)'}`);
    console.log(`管理后台端口: ${CONFIG.ADMIN_PORT}`);
    console.log(`最大客户端数: ${CONFIG.MAX_CLIENTS}`);
    console.log(`管理员账号: ${CONFIG.ADMIN_USERNAME} / ${CONFIG.ADMIN_PASSWORD}`);
    console.log('==================================================\n');
  }
}

// 主程序
const server = new TunnelServerMain();

// 优雅关闭
process.on('SIGTERM', () => {
  Logger.info('收到SIGTERM信号，正在停止服务器...');
  server.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  Logger.info('收到SIGINT信号，正在停止服务器...');
  server.stop();
  process.exit(0);
});

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  Logger.error(`未捕获的异常: ${error.message}`);
  Logger.error(error.stack);
  server.stop();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error(`未处理的Promise拒绝: ${reason}`);
  server.stop();
  process.exit(1);
});

// 启动服务器
if (require.main === module) {
  server.start();
}

module.exports = { TunnelServerMain, CONFIG, Logger };
