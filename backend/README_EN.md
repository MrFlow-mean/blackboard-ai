# Voice Backend Server (OpenAI Realtime + OpenRouter Text)

## Quick Start

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Start server
```bash
npm start
```

The server will run on `ws://localhost:3002`.

### 3. Configure keys

At least one key is required:

- **OpenAI Realtime (voice + text)**: `OPENAI_API_KEY`
- **OpenRouter (text mode)**: `OPENROUTER_API_KEY`

Optional configs:

- OpenAI relay: `OPENAI_API_BASE`, `OPENAI_REALTIME_URL`
- OpenRouter base: `OPENROUTER_API_BASE` (default `https://openrouter.ai/api`)
- OpenRouter model: `OPENROUTER_MODEL` (default `deepseek/deepseek-chat`)

### 4. Test

Open the browser and visit `AI语音通话学习模式.html` (EN: "AI Voice Call Learning Mode"), then click the microphone button.

## Features

- ✅ OpenAI Realtime audio streaming
- ✅ OpenRouter text fallback when OpenAI Realtime key is missing
- ✅ Session management and error handling

## Next Steps

1. Add authentication and session storage
2. Add multi-language support
