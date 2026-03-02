// OpenAI Realtime API 实时语音处理
// EN: OpenAI Realtime API live voice handler
// 参考 OpenAI 的实时语音模式，实现自然流畅的对话
// EN: Reference implementation for a natural, low-latency realtime voice conversation flow

/*
EN GLOSSARY (Chinese strings used in this file, for handoff only)
- "OpenAI Realtime API 连接已建立" => "OpenAI Realtime API connection established"
- "会话已创建" => "Session created"
- "响应完成" => "Response done"
- "解析消息错误" => "Failed to parse message"
- The large `instructions` template is a Chinese tutor-style system prompt; it stays Chinese by default.
*/

const WebSocket = require('ws');
const https = require('https');

function normalizeApiBase(apiBase) {
  const trimmed = (apiBase || '').trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_API_BASE = normalizeApiBase(process.env.OPENAI_API_BASE || 'https://api.openai.com');
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL || buildRealtimeUrl(OPENAI_API_BASE, OPENAI_REALTIME_MODEL);

function buildRealtimeUrl(apiBase, model) {
  const base = normalizeApiBase(apiBase);
  const wsBase = base.replace(/^http(s?):/i, (_, isHttps) => (isHttps ? 'wss:' : 'ws:'));
  return `${wsBase}/v1/realtime?model=${encodeURIComponent(model)}`;
}

class OpenAIRealtimeVoice {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.audioQueue = [];
    this.isProcessing = false;
  }

  // 创建与 OpenAI Realtime API 的 WebSocket 连接
  async connect(sessionId, onMessage, onAudio, onError) {
    return new Promise((resolve, reject) => {
      // OpenAI Realtime API WebSocket URL
      const wsUrl = OPENAI_REALTIME_URL;
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      this.ws.on('open', () => {
        console.log('✅ OpenAI Realtime API 连接已建立');
        
        // 发送会话配置
        this.send({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            // EN: System prompt summary: professional, friendly, patient language tutor; encourage user, gently correct grammar,
            // EN: expand topic appropriately, keep replies concise, adapt difficulty, reply in Chinese unless user requests otherwise.
            instructions: `你是一位专业、友好、耐心的AI语言学习导师。你的任务是帮助用户练习外语对话。

请遵循以下原则：
1. 用友好、鼓励的语气回复，营造轻松的学习氛围
2. 当用户有语法错误时，温和地指出并给出正确表达
3. 适当扩展话题，引导用户多说多练
4. 回复要简洁自然，不要太长（建议50-150字）
5. 根据用户的水平调整语言难度
6. 可以适当提问，鼓励用户继续对话

请用中文回复（除非用户明确要求用其他语言）。`,
            voice: 'nova', // 自然流畅的女声
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
            },
            temperature: 0.8,
            max_response_output_tokens: 4096
          }
        });

        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message, onMessage, onAudio);
        } catch (error) {
          console.error('解析消息错误:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket 错误:', error);
        if (onError) onError(error);
        reject(error);
      });

      this.ws.on('close', () => {
        console.log('OpenAI Realtime API 连接已关闭');
      });
    });
  }

  // 处理来自 OpenAI 的消息
  handleMessage(message, onMessage, onAudio) {
    switch (message.type) {
      case 'session.created':
        console.log('✅ 会话已创建:', message.session_id);
        break;

      case 'response.audio_transcript.delta':
        // 流式文本输出
        if (onMessage && message.delta) {
          onMessage({
            type: 'text_delta',
            text: message.delta
          });
        }
        break;

      case 'response.audio_transcript.done':
        // 完整文本输出
        if (onMessage && message.transcript) {
          onMessage({
            type: 'text_done',
            text: message.transcript
          });
        }
        break;

      case 'response.audio.delta':
        // 流式音频输出
        if (onAudio && message.delta) {
          onAudio({
            type: 'audio_delta',
            audio: message.delta
          });
        }
        break;

      case 'response.audio.done':
        // 音频输出完成
        if (onAudio) {
          onAudio({
            type: 'audio_done'
          });
        }
        break;

      case 'response.done':
        console.log('✅ 响应完成');
        break;

      case 'error':
        console.error('❌ API 错误:', message.error);
        break;

      default:
        console.log('收到消息:', message.type);
    }
  }

  // 发送音频数据
  sendAudio(audioData) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: 'input_audio_buffer.append',
        audio: audioData
      });
    }
  }

  // 提交音频输入（触发处理）
  commitAudio() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: 'input_audio_buffer.commit'
      });
    }
  }

  // 发送文本消息（备用）
  sendText(text) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: text
            }
          ]
        }
      });

      // 触发响应
      this.send({
        type: 'response.create'
      });
    }
  }

  // 发送消息
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // 关闭连接
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

module.exports = OpenAIRealtimeVoice;
