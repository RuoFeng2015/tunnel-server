/**
 * 服务端功能测试脚本
 */

const axios = require('axios');

const CONFIG = {
  ADMIN_PORT: process.env.ADMIN_PORT || 8082,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'password'
};

class ServerTester {
  constructor() {
    this.token = null;
    this.baseURL = `http://localhost:${CONFIG.ADMIN_PORT}`;
  }

  async test() {
    console.log('🧪 开始服务端功能测试...\n');

    try {
      // 测试健康检查
      await this.testHealth();

      // 测试登录
      await this.testLogin();

      // 测试状态接口
      await this.testStatus();

      console.log('\n✅ 所有测试通过！服务端运行正常');

    } catch (error) {
      console.error('\n❌ 测试失败:', error.message);
      process.exit(1);
    }
  }

  async testHealth() {
    console.log('🔍 测试健康检查接口...');

    try {
      const response = await axios.get(`${this.baseURL}/api/health`);
      console.log('✓ 健康检查通过:', response.data);
    } catch (error) {
      throw new Error(`健康检查失败: ${error.message}`);
    }
  }

  async testLogin() {
    console.log('🔐 测试管理员登录...');

    try {
      const response = await axios.post(`${this.baseURL}/api/auth/login`, {
        username: CONFIG.ADMIN_USERNAME,
        password: CONFIG.ADMIN_PASSWORD
      });

      this.token = response.data.token;
      console.log('✓ 登录成功，获得令牌');
    } catch (error) {
      throw new Error(`登录失败: ${error.message}`);
    }
  }

  async testStatus() {
    console.log('📊 测试状态接口...');

    if (!this.token) {
      throw new Error('未获得认证令牌');
    }

    try {
      const response = await axios.get(`${this.baseURL}/api/status`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      const data = response.data;
      console.log('✓ 状态接口响应正常');
      console.log(`  - 服务器运行时间: ${Math.floor(data.server.uptime)}秒`);
      console.log(`  - 当前客户端数: ${data.clients.total}`);
      console.log(`  - 已认证客户端: ${data.clients.authenticated}`);
      console.log(`  - 配置端口: 隧道=${data.config.tunnel_port}, 代理=${data.config.proxy_port}`);

    } catch (error) {
      throw new Error(`状态接口失败: ${error.message}`);
    }
  }
}

// 运行测试
if (require.main === module) {
  const tester = new ServerTester();
  tester.test();
}

module.exports = ServerTester;
