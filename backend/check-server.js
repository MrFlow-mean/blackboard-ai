// 后端自检脚本：检查 HTTP /health + WebSocket + Node 版本 + .env（不泄露密钥）
// EN: Backend doctor script: checks HTTP /health + WebSocket + Node version + .env (without leaking secrets)

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 2500;

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 3002, secure: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--secure' || a === '--https') args.secure = true;
    else if (a === '--host' && argv[i + 1]) args.host = String(argv[++i]);
    else if (a === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
  }
  if (!Number.isFinite(args.port) || args.port <= 0) args.port = 3002;
  return args;
}

function getNodeMajor() {
  const raw = String(process.versions.node || '').split('.')[0];
  const major = Number(raw);
  return Number.isFinite(major) ? major : 0;
}

function readEnvHints() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return { hasEnv: false, hasOpenAIKey: false, hasOpenRouterKey: false };
  }
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const hasOpenAIKey = /^\s*OPENAI_API_KEY\s*=\s*\S+/m.test(content);
    const hasOpenRouterKey = /^\s*OPENROUTER_API_KEY\s*=\s*\S+/m.test(content);
    return { hasEnv: true, hasOpenAIKey, hasOpenRouterKey };
  } catch (e) {
    return { hasEnv: true, hasOpenAIKey: false, hasOpenRouterKey: false, readError: e?.message || String(e) };
  }
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* ignore */ }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 0,
          json,
          raw: raw.slice(0, 2000)
        });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err?.message || String(err) }));
    req.setTimeout(TIMEOUT_MS, () => {
      try { req.destroy(new Error('timeout')); } catch (_) { /* ignore */ }
    });
  });
}

function checkWs(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { ws.terminate(); } catch (_) { /* ignore */ }
      resolve({ ok: false, reason: 'timeout' });
    }, TIMEOUT_MS);

    ws.on('open', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch (_) { /* ignore */ }
      resolve({ ok: true });
    });

    ws.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ ok: false, reason: error?.message || 'error' });
    });
  });
}

function printHelp() {
  console.log('用法: node check-server.js [--host 127.0.0.1] [--port 3002] [--secure]');
  console.log('示例: node check-server.js --host 127.0.0.1 --port 3002');
  console.log('示例(https/wss): node check-server.js --host api.xxx.com --port 443 --secure');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const nodeMajor = getNodeMajor();
  const envHints = readEnvHints();

  const httpBase = `${args.secure ? 'https' : 'http'}://${args.host}:${args.port}`;
  const wsUrl = `${args.secure ? 'wss' : 'ws'}://${args.host}:${args.port}`;

  console.log('🔍 后端自检开始\n');
  console.log(`- Node 版本: ${process.versions.node} ${nodeMajor >= 18 ? '(OK)' : '(建议 >= 18)'}`);
  console.log(`- 目标 HTTP: ${httpBase}`);
  console.log(`- 目标 WS  : ${wsUrl}`);
  console.log(`- backend/.env: ${envHints.hasEnv ? '存在' : '不存在'}${envHints.readError ? `（读取失败：${envHints.readError}）` : ''}`);
  if (envHints.hasEnv) {
    console.log(`  - OPENAI_API_KEY: ${envHints.hasOpenAIKey ? '已配置(不显示)' : '未配置'}`);
    console.log(`  - OPENROUTER_API_KEY: ${envHints.hasOpenRouterKey ? '已配置(不显示)' : '未配置'}`);
  }
  console.log('');

  const health = await httpGetJson(`${httpBase}/health`);
  if (health.ok && health.json && typeof health.json === 'object') {
    console.log('✅ /health 可访问');
    const j = health.json;
    console.log(`  - ok: ${String(j.ok)}`);
    if (typeof j.structure_model === 'string') console.log(`  - structure_model: ${j.structure_model}`);
    if (typeof j.text_model === 'string') console.log(`  - text_model: ${j.text_model}`);
    if (typeof j.realtime_model === 'string') console.log(`  - realtime_model: ${j.realtime_model}`);
    if (typeof j.has_openai_key === 'boolean') console.log(`  - has_openai_key: ${j.has_openai_key}`);
    if (typeof j.has_openrouter_key === 'boolean') console.log(`  - has_openrouter_key: ${j.has_openrouter_key}`);
  } else {
    console.log('❌ /health 不可访问');
    console.log(`  - status: ${health.status || 0}`);
    if (health.error) console.log(`  - error: ${health.error}`);
    else console.log(`  - resp: ${health.raw || '(empty)'}`);
  }
  console.log('');

  const ws = await checkWs(wsUrl);
  if (ws.ok) {
    console.log('✅ WebSocket 可连接');
  } else {
    console.log('❌ WebSocket 无法连接');
    console.log(`  - reason: ${ws.reason}`);
  }
  console.log('');

  const allOk = !!(health.ok && ws.ok);
  if (allOk) {
    console.log('🎉 自检通过：后端服务已就绪。');
    process.exit(0);
  }

  console.log('📋 建议排查：');
  if (nodeMajor && nodeMajor < 18) {
    console.log('- 升级 Node.js 到 18+（推荐 20 LTS），再重启后端。');
  }
  console.log('- 确认你已在 backend 目录执行过 `npm install`。');
  console.log('- 用 `npm start` 启动后端后，再运行本检查脚本。');
  console.log('- 若报端口占用（3002），先结束占用进程或修改后端端口。');
  console.log('- 若只在服务器上部署：请通过 Nginx 反代并启用 WS Upgrade（wss）。');
  process.exit(1);
})();
