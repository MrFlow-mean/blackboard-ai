# ✅ OpenAI Realtime / OpenRouter Integration Guide

This project supports:

- **OpenAI Realtime** (audio + text)
- **OpenRouter Chat** (text mode)

## 🚀 Start

```bash
cd backend
npm install
npm start
```

When you see:
```
✅ Realtime 音频流服务器运行在 ws://localhost:3002
✅ Realtime audio streaming server is running at ws://localhost:3002  <!-- EN note for handoff -->
```
the server is running.

## 🔑 API Keys

Use `设置API密钥.bat` to write `backend/.env`, or set environment variables manually:

At least one key is required:

- OpenAI (Realtime + text): `OPENAI_API_KEY`
- OpenRouter (text): `OPENROUTER_API_KEY`

Optional:

- OpenAI relay: `OPENAI_API_BASE` (with or without `/v1`) or `OPENAI_REALTIME_URL`
- OpenRouter base: `OPENROUTER_API_BASE` (default `https://openrouter.ai/api`)
- OpenRouter model: `OPENROUTER_MODEL`

## 🧩 Mode

- **OpenAI Realtime**: direct audio, low latency, barge-in supported
- **OpenRouter text mode**: board generation/update and text chat fallback

## 📝 System Prompt

The default prompt is language-teacher style. You can update it in:
`backend/realtime-audio-server.js` → `DEFAULT_INSTRUCTIONS`.

## 🐛 Common Issues

### 1. API call failed (401)
- Check if the API key is correct and active

### 2. Rate limit (429)
- Free quota may be exhausted
- Wait and retry, or upgrade to paid

### 3. Network error
- Check network connectivity
- Make sure OpenAI API domains are reachable
- Check firewall rules

## 📈 Next Improvements

1. **Streaming output** for smoother replies
2. **Multi-language support**
3. **Learning features** (corrections, vocab, review)
4. **Cost tracking** for API usage

## 🔒 Security Tips

⚠️ **Important**: Do not hardcode API keys.

1. Use environment variables or `.env`
2. Do not commit keys to Git
3. Rotate keys regularly
