const http = require('http');

// 简单的本地服务器连接测试
async function testLocalConnection() {
    console.log('🔍 测试本地服务器连接...\n');

    const tests = [
        { host: 'localhost', port: 3081, name: '本地代理服务' },
        { host: 'localhost', port: 3082, name: '本地管理后台' },
        { host: '127.0.0.1', port: 3081, name: '127.0.0.1代理服务' },
    ];

    for (const test of tests) {
        console.log(`测试: ${test.name} (${test.host}:${test.port})`);

        try {
            await testConnection(test.host, test.port);
            console.log(`✅ ${test.name} - 连接成功\n`);
        } catch (error) {
            console.log(`❌ ${test.name} - 连接失败: ${error.message}\n`);
        }
    }
}

function testConnection(host, port) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: host,
            port: port,
            path: '/',
            method: 'GET',
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            console.log(`   状态码: ${res.statusCode}`);
            resolve(res.statusCode);
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('连接超时'));
        });

        req.end();
    });
}

// 运行测试
testLocalConnection();
