# 语音后端服务器（OpenAI Realtime + OpenRouter 文本）

> EN: This is the Chinese README kept for the original authoring context.  
> EN: For a full English version, see `backend/README_EN.md`.  
> EN: Below are brief English annotations for handoff.

## 快速开始

> EN: Quick start.

### 1. 安装依赖
> EN: Install dependencies.
```bash
cd backend
npm install
```

### 2. 启动服务器
> EN: Start the server.
```bash
npm start
```

服务器将在 `ws://localhost:3002` 启动。
> EN: The server will be available at `ws://localhost:3002`.

### 3. 配置密钥
> EN: Configure API keys.

支持两种方式（至少配置一种）：
> EN: Two options are supported (configure at least one).

- **OpenAI Realtime（语音 + 文本）**：`OPENAI_API_KEY`
- **OpenRouter（文本）**：`OPENROUTER_API_KEY`
> EN: OpenAI Realtime supports voice + text; OpenRouter is text-only fallback.

可选配置：
> EN: Optional configuration.

- OpenAI 代理/中转：`OPENAI_API_BASE`、`OPENAI_REALTIME_URL`
- OpenRouter：`OPENROUTER_API_BASE`（默认 `https://openrouter.ai/api`）
- OpenRouter 模型：`OPENROUTER_MODEL`（默认 `deepseek/deepseek-chat`）
> EN: `*_API_BASE` lets you use a proxy/relay base URL; `*_MODEL` selects the model name.

### 4. 测试
> EN: Test from the browser UI.

打开浏览器，访问 `AI语音通话学习模式.html`，点击麦克风按钮开始对话。
> EN: Open `AI语音通话学习模式.html` and click the microphone button to start.

## 功能说明
> EN: Features.

- ✅ OpenAI Realtime 音频直连（语音通话）
- ✅ OpenRouter 文本对话兜底（未配置 OpenAI 时仍可文本学习）
- ✅ 会话管理与错误处理

## 下一步
> EN: Next steps / roadmap (not implemented yet).

1. 添加用户认证与会话存储
2. 添加多语言支持
