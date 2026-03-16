/**
 * PM2 进程配置 - 阿里云等服务器上常驻运行后端
 * 使用: 在 backend 目录执行 pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: 'blackboard-ai',
      script: 'realtime-audio-server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      time: true,
    },
  ],
};
