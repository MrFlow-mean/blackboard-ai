// OpenAI Realtime API 音频流处理
// EN: OpenAI Realtime API audio streaming handler
// 这个文件处理与 OpenAI Realtime API 的 WebSocket 连接
// EN: This file manages the WebSocket connection to OpenAI Realtime API

/*
EN GLOSSARY (Chinese strings used in this file, for handoff only)
- "未配置 OPENAI_API_KEY，请在后端环境变量中设置" => "OPENAI_API_KEY not configured; set it in backend env vars"
- "已连接到 OpenAI Realtime API" => "Connected to OpenAI Realtime API"
- "OpenAI Realtime API 连接错误" => "OpenAI Realtime API connection error"
- "OpenAI Realtime API 连接已关闭" => "OpenAI Realtime API connection closed"
- Instructions string describes a friendly, patient language-learning tutor (kept in Chinese intentionally).
*/

const WebSocket = require('ws');

function normalizeApiBase(apiBase) {
  const trimmed = (apiBase || '').trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

// OpenAI Realtime API 配置
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_API_BASE = normalizeApiBase(process.env.OPENAI_API_BASE || 'https://api.openai.com');
const OPENAI_REALTIME_API_URL = process.env.OPENAI_REALTIME_URL || buildRealtimeUrl(OPENAI_API_BASE, OPENAI_REALTIME_MODEL);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function buildRealtimeUrl(apiBase, model) {
  const base = normalizeApiBase(apiBase);
  const wsBase = base.replace(/^http(s?):/i, (_, isHttps) => (isHttps ? 'wss:' : 'ws:'));
  return `${wsBase}/v1/realtime?model=${encodeURIComponent(model)}`;
}

/**
 * 创建 OpenAI Realtime API 连接
 * @param {string} apiKey - OpenAI API 密钥
 * @returns {Promise<WebSocket>} WebSocket 连接
 */
function createOpenAIRealtimeConnection(apiKey = OPENAI_API_KEY) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('未配置 OPENAI_API_KEY，请在后端环境变量中设置'));
      return;
    }

    const ws = new WebSocket(OPENAI_REALTIME_API_URL, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    ws.on('open', () => {
      console.log('✅ 已连接到 OpenAI Realtime API');
      
      // 发送会话配置
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: '你是一位专业、友好、耐心的AI语言学习导师。用友好、鼓励的语气回复，帮助用户练习外语对话。',
          // EN: System instructions: act as a professional, friendly, patient language tutor; encourage user and help practice a foreign language.
          voice: 'nova',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }));
      
      resolve(ws);
    });

    ws.on('error', (error) => {
      console.error('❌ OpenAI Realtime API 连接错误:', error);
      reject(error);
    });

    ws.on('close', () => {
      console.log('🔌 OpenAI Realtime API 连接已关闭');
    });
  });
}

/**
 * 处理音频数据
 * @param {Buffer} audioData - PCM16 格式的音频数据
 * @param {WebSocket} openAIWs - OpenAI Realtime API WebSocket 连接
 */
function sendAudioToOpenAI(audioData, openAIWs) {
  if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
    // 将音频数据转换为 base64
    const base64Audio = audioData.toString('base64');
    
    // 发送音频输入事件
    openAIWs.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    }));
  }
}

/**
 * 提交音频缓冲并请求响应
 * @param {WebSocket} openAIWs - OpenAI Realtime API WebSocket 连接
 */
function commitAudioToOpenAI(openAIWs) {
  if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
    openAIWs.send(JSON.stringify({
      type: 'input_audio_buffer.commit'
    }));
    openAIWs.send(JSON.stringify({
      type: 'response.create'
    }));
  }
}

/**
 * 处理 OpenAI 返回的音频数据
 * @param {Object} event - OpenAI 事件
 * @returns {Buffer|null} PCM16 格式的音频数据，如果没有音频则返回 null
 */
function extractAudioFromOpenAI(event) {
  if (event.type === 'response.audio_transcript.delta' || 
      event.type === 'response.audio_transcript.done') {
    // 文本转录（可选，用于显示）
    return {
      type: 'transcript',
      text: event.delta || event.text || ''
    };
  }
  
  if (event.type === 'response.audio.delta') {
    // 音频数据
    if (event.delta) {
      return {
        type: 'audio',
        data: Buffer.from(event.delta, 'base64')
      };
    }
  }
  
  if (event.type === 'response.done') {
    // 响应完成
    return {
      type: 'done'
    };
  }
  
  return null;
}

module.exports = {
  createOpenAIRealtimeConnection,
  sendAudioToOpenAI,
  commitAudioToOpenAI,
  extractAudioFromOpenAI
};
