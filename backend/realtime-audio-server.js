// 语音服务器（OpenAI Realtime）
// EN: Voice server (OpenAI Realtime)
// - OpenAI：音频直连 Realtime API
// EN: OpenAI: direct audio streaming via Realtime API

/*
EN GLOSSARY (Chinese strings used in this file, for handoff only)
- "已加载 .env 文件" => ".env file loaded"
- "当前 Node 版本缺少 fetch，请升级到 Node.js 18+" => "Current Node version lacks fetch; upgrade to Node.js 18+"
- "请求体必须是合法 JSON" => "Request body must be valid JSON"
- "服务器内部错误" => "Internal server error"
- "未配置 OPENAI_API_KEY" => "OPENAI_API_KEY is not configured"
- "未配置 OPENROUTER_API_KEY" => "OPENROUTER_API_KEY is not configured"
- "模型返回内容无法解析为JSON" => "Model output cannot be parsed as JSON"
- "生成黑板失败，fallback" => "Failed to generate board; falling back"
- "board 不存在" => "Board does not exist"
- "goal 不能为空" => "goal must not be empty"
- "board_id 与 user_input 必填" => "board_id and user_input are required"
- "语音Agent无权修改黑板结构，必须由用户输入触发。" => "Voice agent cannot modify board structure; must be triggered by user input"
- "黑板更新必须经过用户确认。" => "Board updates require user confirmation"
- "text 不能为空" => "text must not be empty"
- "模型调用失败" => "Model call failed"
- "获取Realtime token失败" => "Failed to get Realtime token"
- "服务器已就绪，等待客户端连接..." => "Server is ready; waiting for client connections"
*/

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let fetchFn = globalThis.fetch;
if (typeof fetchFn !== 'function') {
  try {
    fetchFn = require('node-fetch');
  } catch (error) {
    console.error('❌ 当前 Node 版本缺少 fetch，请升级到 Node.js 18+');
    process.exit(1);
  }
}

// 加载 .env 文件
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').trim();
        process.env[key.trim()] = value;
      }
    }
  });
  console.log('✅ 已加载 .env 文件');
}

const PORT = 3002; // 使用不同的端口
const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((error) => {
    console.error('HTTP处理异常:', error);
    sendJson(res, 500, { ok: false, message: error.message || '服务器内部错误' });
  });
});
const wss = new WebSocket.Server({ server });

function normalizeApiBase(apiBase) {
  const trimmed = (apiBase || '').trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

// OpenAI / OpenRouter API 配置
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_API_BASE = normalizeApiBase(process.env.OPENAI_API_BASE || 'https://api.openai.com');
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL || buildRealtimeUrl(OPENAI_API_BASE, OPENAI_REALTIME_MODEL);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_STRUCTURE_MODEL = process.env.OPENAI_STRUCTURE_MODEL || 'gpt-4o-mini';
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
const OPENAI_RESPONSES_URL = `${OPENAI_API_BASE}/v1/responses`;
const OPENAI_CHAT_URL = `${OPENAI_API_BASE}/v1/chat/completions`;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_API_BASE = normalizeApiBase(process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api');
const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/v1/chat/completions`;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';
const OPENROUTER_STRUCTURE_MODEL = process.env.OPENROUTER_STRUCTURE_MODEL || OPENROUTER_MODEL;
const OPENROUTER_APP_URL = process.env.OPENROUTER_APP_URL || 'http://localhost';
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'Linguify Blackboard AI';
const OPENROUTER_AUDIO_OUTPUT = (process.env.OPENROUTER_AUDIO_OUTPUT || '1') !== '0';
const OPENROUTER_AUDIO_VOICE = process.env.OPENROUTER_AUDIO_VOICE || 'alloy';
const OPENROUTER_AUDIO_FORMAT = process.env.OPENROUTER_AUDIO_FORMAT || 'wav';

const SUPPORTED_OPENAI_REALTIME_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
]);

function normalizeRealtimeVoice(voice) {
  const safe = (voice || '').toString().trim();
  if (SUPPORTED_OPENAI_REALTIME_VOICES.has(safe)) return safe;
  return 'alloy';
}

const DEFAULT_VOICE = normalizeRealtimeVoice(process.env.OPENAI_REALTIME_VOICE || 'alloy');
function buildClarificationInstructions(locale = 'zh-CN') {
  if (locale === 'en') {
    return [
      'You are the Realtime Clarification Agent for "Blackboard AI".',
      'Your ONLY job in this phase is to ask questions and help the user clarify:',
      '- What they want to learn (topic, sub-topics, scenario, constraints)',
      '- Their current level (experience, baseline, pain points)',
      'Hard rules:',
      '- Do NOT teach the subject matter yet.',
      '- Do NOT produce long explanations, formulas, or full lesson content.',
      '- Do NOT generate any blackboard content yourself.',
      '- Do NOT claim you cannot generate a blackboard. Instead, explain that after clarification, the system will generate it on the left blackboard.',
      '- Ask 2-4 short questions per turn. Keep them concrete and easy to answer.',
      'If the user asks you to "teach now" or requests content, politely say you will start teaching AFTER the blackboard is generated, and continue asking clarification questions.',
      'When you think the user is clear enough, summarize the goal & constraints in 3-6 bullets, then ask for confirmation to generate the blackboard (yes/no).'
    ].join('\n');
  }
  return [
    '你是「Blackboard AI」的实时澄清引导员（Realtime Clarification Agent）。',
    '你在当前阶段的唯一目标：通过提问与引导，帮助用户把学习目标、学习需求与学习计划说清楚。',
    '你需要澄清的核心只有两类信息：',
    '- 学什么：主题/子主题/场景/重点/约束',
    '- 当前水平：基础/学了多久/薄弱点/考试年级等',
    '硬规则：',
    '- 现在不要开始讲解知识点，不要推导公式，不要输出完整课文/习题/板书正文。',
    '- 不要自己生成板书内容；板书由左侧“黑板文本生成AI”在用户确认后生成。',
    '- 不要说“我无法生成板书”。正确说法：澄清清楚后会在左侧黑板生成板书。',
    '- 如果用户要求你“现在就讲/现在就出板书”，请礼貌说明：需要先澄清目标与水平，确认后才能生成板书并开始讲解，然后继续提问。',
    '- 每轮最多问 2–4 个短问题，问题要具体、好回答。',
    '当你认为信息足够清晰时：先用 3–6 条要点复述用户目标与约束（不是板书正文），再询问用户：是否生成新的板书（是/否）。'
  ].join('\n');
}

const DEFAULT_INSTRUCTIONS = process.env.OPENAI_REALTIME_INSTRUCTIONS
  || buildClarificationInstructions('zh-CN');
const DEFAULT_TURN_DETECTION = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500
};

function buildRealtimeUrl(apiBase, model) {
  const base = normalizeApiBase(apiBase);
  const wsBase = base.replace(/^http(s?):/i, (_, isHttps) => (isHttps ? 'wss:' : 'ws:'));
  return `${wsBase}/v1/realtime?model=${encodeURIComponent(model)}`;
}

function buildSessionUpdatePayload(config) {
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions: config.instructions,
      voice: normalizeRealtimeVoice(config.voice),
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'whisper-1'
      },
      turn_detection: config.turnDetection
    }
  };
}

const BOARD_STORE = new Map();
const BOARD_AUDIT_LOG = [];
const ALLOWED_NODE_STATUS = new Set(['pending', 'teaching', 'done', 'skipped']);

function clipText(value, max = 240) {
  const text = (value || '').toString().trim();
  if (!text) return '';
  if (max <= 0) return '';
  if (text.length <= max) return text;
  // 不要在关键业务字段上随意追加省略号，避免模型/解析混乱；直接硬截断
  return text.slice(0, max);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('请求体必须是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function buildFallbackBoard(goal, locale = 'zh-CN') {
  const safeGoal = clipText(goal, 200);
  const now = new Date().toISOString();
  if (locale === 'en') {
    return {
      board_id: crypto.randomUUID(),
      goal: safeGoal || 'Learn by structured steps',
      outline: [
        { id: '1', title: 'Concept Overview', status: 'teaching' },
        { id: '2', title: 'Worked Example', status: 'pending' },
        { id: '3', title: 'Guided Practice', status: 'pending' }
      ],
      nodes: {
        '1': { content: 'Clarify key definitions and boundaries of this topic.', examples: ['Start from intuitive explanation, then formal definition.'] },
        '2': { content: 'Walk through one representative example and map each step to rules.', examples: ['Explain why each step is valid.'] },
        '3': { content: 'User solves a similar problem with hints and correction.', examples: ['Ask one question, wait for user answer, then correct.'] }
      },
      progress: { current_node_id: '1', mastery_score: 0 },
      meta: { source: 'fallback', created_at: now, updated_at: now }
    };
  }

  return {
    board_id: crypto.randomUUID(),
    goal: safeGoal || '围绕目标结构化学习',
    outline: [
      { id: '1', title: '核心概念', status: 'teaching' },
      { id: '2', title: '例题拆解', status: 'pending' },
      { id: '3', title: '引导练习', status: 'pending' }
    ],
    nodes: {
      '1': { content: '先明确本节课概念定义、适用范围与常见误区。', examples: ['先直观解释，再给形式化定义。'] },
      '2': { content: '用一题完整样例拆解解题路径，并说明每一步依据。', examples: ['强调步骤与规则的对应关系。'] },
      '3': { content: '让用户完成同类型练习，AI 提示并纠错。', examples: ['先提问，等待作答，再反馈。'] }
    },
    progress: { current_node_id: '1', mastery_score: 0 },
    meta: { source: 'fallback', created_at: now, updated_at: now }
  };
}

function extractJsonObject(rawText) {
  const text = (rawText || '').toString().trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    // continue
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch (_) {
      // continue
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function extractResponseText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string') return data.output_text;
  if (Array.isArray(data.output_text)) {
    return data.output_text.map((item) => (typeof item === 'string' ? item : (item?.text || ''))).join('');
  }
  if (Array.isArray(data.output)) {
    const parts = [];
    data.output.forEach((item) => {
      if (!item || !Array.isArray(item.content)) return;
      item.content.forEach((content) => {
        if (typeof content?.text === 'string') parts.push(content.text);
      });
    });
    return parts.join('');
  }
  return '';
}

function extractChatCompletionText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function extractChatCompletionAudio(data) {
  const audio = data?.choices?.[0]?.message?.audio;
  if (!audio || typeof audio !== 'object') return null;
  const audioBase64 = typeof audio.data === 'string' ? audio.data : '';
  const format = typeof audio.format === 'string' ? audio.format : '';
  const transcript = typeof audio.transcript === 'string' ? audio.transcript : '';
  if (!audioBase64) return null;
  return {
    audio_base64: audioBase64,
    format: format || OPENROUTER_AUDIO_FORMAT || 'wav',
    transcript: transcript || extractChatCompletionText(data) || ''
  };
}

async function callOpenAIChatCompletion(messages, model = OPENAI_TEXT_MODEL, extraBody = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error('未配置 OPENAI_API_KEY');
  }

  const response = await fetchFn(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages,
      ...extraBody
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Chat Completions失败: ${response.status} ${text}`);
  }

  const data = await response.json();
  const text = extractChatCompletionText(data);
  if (!text) {
    throw new Error('OpenAI Chat Completions返回内容为空');
  }
  return text;
}

function shouldUseJsonResponseFormat(model) {
  const name = (model || '').toString().trim().toLowerCase();
  if (!name) return false;
  if (name.startsWith('o1') || name.startsWith('o3')) return false;
  return true;
}

async function callOpenAIChatCompletionForJson(systemPrompt, userPrompt, model = OPENAI_TEXT_MODEL, extraBody = {}) {
  const safeBody = extraBody && typeof extraBody === 'object' ? extraBody : {};
  const responseFormat = safeBody.response_format || (shouldUseJsonResponseFormat(model)
    ? { type: 'json_object' }
    : undefined);
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    ...safeBody
  };
  if (responseFormat) body.response_format = responseFormat;

  const response = await fetchFn(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Chat Completions失败: ${response.status} ${text}`);
  }

  const data = await response.json();
  const text = extractChatCompletionText(data);
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error('模型返回内容无法解析为JSON');
  }
  return parsed;
}

async function callOpenRouterChatCompletion(messages, model = OPENROUTER_MODEL, extraBody = {}) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('未配置 OPENROUTER_API_KEY');
  }

  const response = await fetchFn(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-Title': OPENROUTER_APP_NAME
    },
    body: JSON.stringify({
      model,
      messages,
      ...extraBody
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenRouter Chat Completions失败: ${response.status} ${text}`);
  }

  const data = await response.json();
  const text = extractChatCompletionText(data);
  if (!text) {
    throw new Error('OpenRouter Chat Completions返回内容为空');
  }
  return text;
}

async function callOpenRouterAudioChatCompletion(messages, model = OPENROUTER_MODEL, extraBody = {}) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('未配置 OPENROUTER_API_KEY');
  }

  const response = await fetchFn(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-Title': OPENROUTER_APP_NAME
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      modalities: ['text', 'audio'],
      audio: {
        voice: OPENROUTER_AUDIO_VOICE,
        format: OPENROUTER_AUDIO_FORMAT
      },
      ...extraBody
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenRouter Audio Chat失败: ${response.status} ${text}`);
  }

  const data = await response.json();
  const audio = extractChatCompletionAudio(data);
  if (!audio) {
    const text = extractChatCompletionText(data);
    if (!text) {
      throw new Error('OpenRouter Audio Chat返回内容为空');
    }
    return {
      audio_base64: '',
      format: OPENROUTER_AUDIO_FORMAT || 'wav',
      transcript: text
    };
  }
  return audio;
}

function shouldUseOpenRouterAudioOutput() {
  if (!OPENROUTER_API_KEY) return false;
  if (!OPENROUTER_AUDIO_OUTPUT) return false;
  return /audio/i.test(OPENROUTER_MODEL);
}

function inferBoardDomain(goalText = '', locale = 'zh-CN') {
  const text = (goalText || '').toString();
  const lower = text.toLowerCase();

  // 领域判断：避免 “对话式讲解数学” 被误判为语言学习
  const mathHits = (text.match(/(数学|代数|几何|解析几何|圆锥曲线|双曲线|椭圆|抛物线|圆|函数|方程|不等式|导数|积分|向量|数列|概率|统计|三角函数|立体几何|参数方程|平面向量|高一|高二|高三)/g) || []).length;
  const languageHits = (text.match(/(英语|法语|日语|韩语|德语|西班牙语|意大利语|俄语|葡萄牙语|阿拉伯语|情景对话|课文|阅读|听力|口语|写作|翻译|词汇|语法|发音|cefr|a1|a2|b1|b2|c1|c2)/ig) || []).length
    + ((lower.match(/\b(cefr|a1|a2|b1|b2|c1|c2)\b/g) || []).length);

  if (mathHits > 0 && mathHits >= languageHits) return 'math';
  if (languageHits > 0) return 'language';

  return 'general';
}

function deriveBoardTitleFromGoal(goal, locale = 'zh-CN') {
  const text = (goal || '').toString().replace(/\r\n?/g, '\n').trim();
  if (!text) return locale === 'en' ? 'Blackboard' : '板书';
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return locale === 'en' ? 'Blackboard' : '板书';

  const key = locale === 'en' ? /^learning\s*goal\s*:/i : /^学习目标\s*：/;
  const picked = lines.find(line => key.test(line)) || lines[0];
  const stripped = locale === 'en'
    ? picked.replace(/^learning\s*goal\s*:\s*/i, '')
    : picked.replace(/^学习目标\s*：\s*/, '');
  const clean = stripped.trim() || picked.trim();
  return clipText(clean, 80) || (locale === 'en' ? 'Blackboard' : '板书');
}

function sanitizePreferenceText(text = '', locale = 'zh-CN') {
  const raw = (text || '').toString().trim();
  if (!raw) return '';
  const withoutLLMWords = raw
    .replace(/(gemini|chatgpt|openai|prompt|schema|json|model|llm)/ig, '')
    .replace(/(提示词|模型|大模型|json|schema|prompt)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!withoutLLMWords) {
    return locale === 'en'
      ? 'Concise, textbook-style blackboard notes.'
      : '板书要简洁，像教辅讲义式笔记。';
  }
  return withoutLLMWords;
}

function parseGoalSpec(goalText = '', locale = 'zh-CN') {
  const text = (goalText || '').toString().replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map(line => (line || '').toString().trim());
  let topic = '';
  let level = '';
  const notes = [];
  let inNotes = false;

  for (const line of lines) {
    if (!line) continue;

    const mTopic = line.match(/^(学习目标|topic|learning\s*goal)\s*[:：]\s*(.+)$/i);
    if (mTopic && mTopic[2]) {
      topic = mTopic[2].trim();
      inNotes = false;
      continue;
    }
    const mLevel = line.match(/^(当前水平|level)\s*[:：]\s*(.+)$/i);
    if (mLevel && mLevel[2]) {
      level = mLevel[2].trim();
      inNotes = false;
      continue;
    }
    if (/^(补充信息|constraints|preferences)\s*[:：]/i.test(line)) {
      inNotes = true;
      continue;
    }
    if (inNotes) {
      const bullet = line.replace(/^[-*]\s*/, '').trim();
      if (bullet) notes.push(sanitizePreferenceText(bullet, locale));
    }
  }

  if (!topic) {
    const first = lines.find(Boolean) || '';
    topic = first.replace(/^[-*]\s*/, '').trim();
  }

  return {
    topic: clipText(topic, 200),
    level: clipText(level, 80),
    notes: notes.filter(Boolean).slice(0, 10)
  };
}

function buildMathTopicRequirements(goalText = '', locale = 'zh-CN') {
  const text = (goalText || '').toString();
  const isHyperbola = /双曲线|hyperbola/i.test(text);
  if (!isHyperbola) return '';

  if (locale === 'en') {
    return [
      'Topic-specific MUST (Hyperbola):',
      '- Definition: |PF1 - PF2| = 2a (0 < 2a < |F1F2|).',
      '- Parameters: c^2 = a^2 + b^2, e = c/a > 1.',
      '- Standard equations:',
      '  - Foci on x-axis: x^2/a^2 - y^2/b^2 = 1 (a>0,b>0). Vertex (±a,0), Focus (±c,0), Asymptotes y = ±(b/a)x.',
      '  - Foci on y-axis: y^2/a^2 - x^2/b^2 = 1. Vertex (0,±a), Focus (0,±c), Asymptotes y = ±(a/b)x.',
      '- Include 1–2 short worked examples (problem + final answer lines).',
      '- Include 3–5 common mistakes checklist items.',
      'Node title requirement (use these exact titles, 5 nodes):',
      '1) Core definition & parameters  2) Standard equations  3) Geometric properties  4) Typical problems + examples  5) Mistakes / checklist'
    ].join('\n');
  }

  return [
    '【双曲线】内容强制要求（必须写进板书内容，不要写“怎么写板书/格式要求”）：',
    '- 定义：到两定点 F1、F2 的距离差的绝对值为常数 2a：|PF1 - PF2| = 2a（0 < 2a < |F1F2|）。',
    '- 参数关系：c^2 = a^2 + b^2；离心率 e = c/a > 1。',
    '- 标准方程（两种朝向都要给）：',
    '  - 焦点在 x 轴：x^2/a^2 - y^2/b^2 = 1 (a>0,b>0)',
    '    顶点：(±a,0)  焦点：(±c,0)  渐近线：y = ±(b/a)x',
    '  - 焦点在 y 轴：y^2/a^2 - x^2/b^2 = 1 (a>0,b>0)',
    '    顶点：(0,±a)  焦点：(0,±c)  渐近线：y = ±(a/b)x',
    '- 例题：给 1–2 个“短而典型”的例题（题目 + 关键步骤 + 最终答案），例如：已知方程求顶点/焦点/渐近线；已知渐近线/焦距求方程。',
    '- 易错点：给 3–5 条速记清单（短句分行）。',
    '节点标题强制（必须用这 5 个标题）：',
    'n1 核心定义与参数（teaching）',
    'n2 标准方程与图像特征',
    'n3 几何性质（顶点/焦点/渐近线/离心率）',
    'n4 常见题型 + 例题',
    'n5 易错点/速记清单'
  ].join('\n');
}

function collectBoardPayloadText(rawBoard) {
  const safe = rawBoard && typeof rawBoard === 'object' ? rawBoard : {};
  const outline = Array.isArray(safe.outline) ? safe.outline : [];
  const nodes = safe.nodes && typeof safe.nodes === 'object' ? safe.nodes : {};
  const parts = [];
  if (safe.goal) parts.push(String(safe.goal));
  outline.forEach((node) => {
    parts.push(`${node?.id || ''} ${node?.title || ''}`.trim());
    const nodeData = node?.id && nodes[node.id] && typeof nodes[node.id] === 'object' ? nodes[node.id] : null;
    if (nodeData?.content) parts.push(String(nodeData.content));
    if (Array.isArray(nodeData?.examples) && nodeData.examples.length) {
      parts.push(nodeData.examples.map(x => String(x || '')).join('\n'));
    }
  });
  return parts.join('\n').trim();
}

function looksLikeBadBoardPayload(rawBoard, goalText, domain, locale = 'zh-CN') {
  const text = collectBoardPayloadText(rawBoard);
  if (!text) return true;
  const lower = text.toLowerCase();

  // 统一拒绝：明显跑题/免责声明/外链
  if (/(https?:\/\/|example\.com)/i.test(text)) return true;

  if (domain === 'math') {
    // 明显元内容：提示词/模型/JSON/schema 等
    if (/(prompt|schema|json|model|llm|openai|chatgpt|gemini)/i.test(text)) return true;
    if (/(提示词|模型|大模型|json|schema|格式|模板|领域)/.test(text)) return true;

    // 对话体/课文体明显错误
    if (/(^|\n)\s*[a-d]:\s+/i.test(text)) return true;
    if (/\b(nice to meet|colleague|meeting|how's it going|good afternoon)\b/i.test(lower)) return true;
    // 语言学习内容混入
    if (/(词汇|语法|口语|听力|阅读|写作|翻译)/.test(text)) return true;

    // 不要出现“物理思考/雷达定位”等跨学科发散（除非目标明确要物理）
    const allowPhysics = /物理|physics/i.test(goalText || '');
    if (!allowPhysics && /(物理思考|雷达|信号|定位)/.test(text)) return true;

    // 元信息（教怎么写板书）过多
    const metaHits = (text.match(/(板书用|板书要|硬规则|强约束|模板|领域|排版|格式|短句|分段|怎么写|写板书)/g) || []).length;
    const mathSignalHits = (text.match(/(双曲线|方程|焦点|渐近线|离心率|顶点|实轴|虚轴|x\^2|y\^2|a\^2|b\^2|c\^2|=|±)/ig) || []).length;
    if (metaHits >= 2 && mathSignalHits <= 2) return true;

    // 双曲线：必须有标准方程/渐近线等关键词
    if (/双曲线|hyperbola/i.test(goalText || '')) {
      const required = /(x\^2\/a\^2\s*-\s*y\^2\/b\^2\s*=\s*1|y\s*=\s*±|\|\s*pf1\s*-\s*pf2\s*\||c\^2\s*=\s*a\^2\s*\+\s*b\^2|离心率|渐近线)/i;
      if (!required.test(text)) return true;
    }
  }

  return false;
}

function normalizeBoardPayload(rawBoard, goal, locale = 'zh-CN') {
  const fallback = buildFallbackBoard(goal, locale);
  const safe = rawBoard && typeof rawBoard === 'object' ? rawBoard : {};
  const outline = Array.isArray(safe.outline) ? safe.outline : [];
  const nodes = safe.nodes && typeof safe.nodes === 'object' ? safe.nodes : {};
  if (!outline.length) return fallback;

  const normalizedOutline = [];
  const normalizedNodes = {};
  let teachingFound = false;

  outline.slice(0, 20).forEach((item, index) => {
    const nodeId = clipText(item?.id, 20) || String(index + 1);
    const title = clipText(item?.title, 80) || (locale === 'en' ? `Node ${index + 1}` : `节点 ${index + 1}`);
    let status = ALLOWED_NODE_STATUS.has(item?.status) ? item.status : 'pending';
    if (status === 'teaching') {
      if (teachingFound) status = 'pending';
      teachingFound = true;
    }
    normalizedOutline.push({ id: nodeId, title, status });
    const rawNode = nodes[nodeId] && typeof nodes[nodeId] === 'object' ? nodes[nodeId] : {};
    const examples = Array.isArray(rawNode.examples)
      ? rawNode.examples
        .map(ex => clipText(ex, 1600))
        .filter(Boolean)
        .slice(0, 12)
      : [];
    normalizedNodes[nodeId] = {
      content: clipText(rawNode.content, 6000) || `${title}${locale === 'en' ? ' explanation.' : ' 的讲解内容。'}`,
      examples
    };
  });

  if (!teachingFound && normalizedOutline.length) {
    normalizedOutline[0].status = 'teaching';
  }

  const currentNodeId = normalizedOutline.find(node => node.status === 'teaching')?.id || normalizedOutline[0]?.id || '1';
  const masteryScoreRaw = Number(safe?.progress?.mastery_score);
  const masteryScore = Number.isFinite(masteryScoreRaw) ? Math.max(0, Math.min(100, masteryScoreRaw)) : 0;
  const now = new Date().toISOString();

  return {
    board_id: crypto.randomUUID(),
    goal: clipText(safe.goal, 120) || deriveBoardTitleFromGoal(goal, locale) || fallback.goal,
    outline: normalizedOutline,
    nodes: normalizedNodes,
    progress: { current_node_id: currentNodeId, mastery_score: masteryScore },
    meta: { source: 'model', created_at: now, updated_at: now }
  };
}

function buildBoardSnapshotForDraft(board, locale = 'zh-CN') {
  const safe = board && typeof board === 'object' ? board : {};
  const outline = Array.isArray(safe.outline) ? safe.outline : [];
  const nodes = safe.nodes && typeof safe.nodes === 'object' ? safe.nodes : {};
  const goal = clipText(safe.goal, 200) || '';
  const outlineText = outline.map(node => `[${node.id}] ${node.title}`).join('\n');
  const nodeDetails = outline.map(node => {
    const content = clipText(nodes?.[node.id]?.content, 600);
    const examples = Array.isArray(nodes?.[node.id]?.examples)
      ? nodes[node.id].examples
        .map(ex => clipText(ex, 240))
        .filter(Boolean)
        .slice(0, 2)
      : [];
    if (locale === 'en') {
      return [
        `[${node.id}] ${node.title}`,
        `Content: ${content || 'N/A'}`,
        `Examples: ${examples.length ? examples.join(' | ') : 'N/A'}`
      ].join('\n');
    }
    return [
      `[${node.id}] ${node.title}`,
      `内容：${content || '无'}`,
      `示例：${examples.length ? examples.join(' | ') : '无'}`
    ].join('\n');
  }).join('\n\n');
  return { goal, outlineText, nodeDetails };
}

function buildHiddenDraftPrompts(board, locale = 'zh-CN') {
  const snapshot = buildBoardSnapshotForDraft(board, locale);
  if (locale === 'en') {
    return {
      systemPrompt: 'You are a teaching draft generator for Blackboard AI. Output plain text only.',
      userPrompt: [
        'Create a teaching draft to guide the realtime voice tutor.',
        'Requirements:',
        '- Do NOT mention "draft/hidden/system/prompt".',
        '- Follow the board order; each section must start with [Node:<id>] from the board.',
        '- Each section includes 1-3 short teaching points (one per line), a tiny example/analogy (omit if not applicable),',
        '  and one check question starting with "Q:".',
        '- Do NOT output LaTeX. Use plain-text math or Unicode symbols.',
        '- Use only board content. Do not add new topics or change structure.',
        '- Keep concise (roughly <= 900 words).',
        'Board:',
        `Goal: ${snapshot.goal || 'N/A'}`,
        'Outline:',
        snapshot.outlineText || 'N/A',
        'Node contents:',
        snapshot.nodeDetails || 'N/A'
      ].join('\n')
    };
  }
  return {
    systemPrompt: '你是 Blackboard AI 的讲解草稿生成器。只输出纯文本。',
    userPrompt: [
      '请根据黑板内容生成一份“讲解草稿”，用于指导实时语音讲师。',
      '要求：',
      '- 不要出现“草稿/隐藏/系统/提示词”等字样。',
      '- 按黑板节点顺序输出，每段必须以 [Node:<id>] 开头（且 id 来自黑板）。',
      '- 每段包含：1-3 条讲解要点（短句分行）+ 1 个微型例子/类比（不适用可省略）+ 1 个检查问题（以“问：”开头）。',
      '- 不要输出 LaTeX/公式源码，用普通文本或 Unicode 数学符号表达。',
      '- 只能使用黑板已有信息，不新增结构或知识点。',
      '- 总长度控制在 900 字以内，保持口语化但简洁。',
      '黑板信息：',
      `学习目标：${snapshot.goal || '无'}`,
      '黑板大纲：',
      snapshot.outlineText || '无',
      '节点内容：',
      snapshot.nodeDetails || '无'
    ].join('\n')
  };
}

async function generateHiddenDraft(board, locale = 'zh-CN') {
  const outline = Array.isArray(board?.outline) ? board.outline : [];
  if (!outline.length) return '';
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) return '';
  try {
    const prompts = buildHiddenDraftPrompts(board, locale);
    const text = await callResponsesApiForText(prompts.systemPrompt, prompts.userPrompt, {
      model: OPENAI_STRUCTURE_MODEL,
      temperature: 0.3,
      max_output_tokens: 900
    });
    const trimmed = (text || '').toString().trim();
    return trimmed ? clipText(trimmed, 2400) : '';
  } catch (error) {
    console.warn('⚠️ 生成隐藏草稿失败:', error.message);
    return '';
  }
}

function stripHiddenDraft(board) {
  if (!board || typeof board !== 'object') return board;
  const { hidden_draft, ...rest } = board;
  return rest;
}

function buildTeachingInstructionsFromBoard(board, locale = 'zh-CN') {
  const outlineText = board.outline.map(node => `[${node.id}] ${node.title} (${node.status})`).join(' | ');
  const nodeDetails = board.outline.map(node => {
    const content = board.nodes?.[node.id]?.content || '';
    return `${node.id}: ${clipText(content, 240)}`;
  }).join('\n');
  const hiddenDraft = clipText(board?.hidden_draft, 2400);
  const hiddenDraftBlock = hiddenDraft
    ? (locale === 'en'
      ? [
        'Hidden teaching draft (use as your script in chat; do NOT mention it is a draft):',
        hiddenDraft,
        'Usage:',
        '- Follow the draft sequence, but only teach the CURRENT node per turn.',
        '- Each reply must start with [Node:<id>] from the board.'
      ]
      : [
        '隐藏草稿（用于聊天讲解脚本，勿提“草稿”字样）：',
        hiddenDraft,
        '使用要求：',
        '- 按草稿顺序推进，但每轮只讲当前节点。',
        '- 每次回答必须以 [Node:<id>] 开头。'
      ])
    : [];

  if (locale === 'en') {
    return [
      'You are Blackboard AI Realtime Teaching Agent.',
      `Learning goal: ${board.goal}`,
      `Current node: ${board.progress.current_node_id}`,
      `Board outline: ${outlineText}`,
      'Hard rules:',
      '- You cannot change board structure or add/remove nodes.',
      '- If user wants structure changes, ask them to clarify so backend can update.',
      '- Every reply must start with [Node:<id>] from the board outline.',
      '- Teaching content must stay aligned with the current node.',
      '- Ask 1-3 short questions per turn (check understanding / guided practice).',
      '- Teaching style: do NOT read the board verbatim. Use it as outline, explain naturally.',
      '- Each turn focus on ONE key point: meaning/why, a tiny example or a step, then one short question.',
      '- If user is wrong: point out the issue, give a hint, let them retry (no full answer dump).',
      '- You may cite key formulas/keywords but avoid long verbatim board text.',
      '- Do NOT output LaTeX (no $$, \\(...\\), \\frac, \\int). Use plain-text math or Unicode symbols.',
      '- Do not output full lesson passages; if user asks, refer to the board or ask to regenerate.',
      'Board key points (do not read verbatim):',
      nodeDetails,
      ...hiddenDraftBlock
    ].join('\n');
  }

  return [
    '你是 Blackboard AI 的 Realtime Teaching Agent。',
    `学习目标：${board.goal}`,
    `当前进度节点：${board.progress.current_node_id}`,
    `黑板结构：${outlineText}`,
    '硬约束：',
    '- 你不能修改黑板结构，不能新增或删除节点。',
    '- 若用户想改结构，只能建议其明确表达，再由后端更新。',
    '- 每次回答必须以 [Node:<id>] 开头，且 id 必须来自黑板 outline。',
    '- 讲解内容必须引用对应节点，不得脱离黑板。',
    '- 教学阶段每轮最多提出 1–3 个问题（用于检查理解/引导练习）。',
    '- 教学风格：不要逐字念板书。把板书当成“提纲”，用更口语、更解释性的方式讲清楚。',
    '- 每轮尽量只讲 1 个关键点：解释含义/为什么、给一个微型例子或一步推导/解题思路，然后提出 1 个简短问题等待用户回答。',
    '- 若用户回答不对：先指出错在何处，再给提示让他重试，而不是直接抛出完整答案。',
    '- 你可以引用板书中的关键公式/词汇，但不要大段复述板书正文。',
    '- 不要输出 LaTeX/公式源码（如 $$、\\(\\)、\\frac、\\int），用普通文本或 Unicode 数学符号表达。',
    '- 不要在对话区输出“完整课文/长对话原文”。若用户要原文，提示其看左侧黑板或触发“生成课文/生成板书”更新后呈现。',
    '黑板要点（不要逐字朗读，仅用于对齐讲解）：',
    nodeDetails,
    ...hiddenDraftBlock
  ].join('\n');
}

async function callTextTutorModel(userText, instructions = DEFAULT_INSTRUCTIONS) {
  const safeText = clipText(userText, 3000);
  if (!safeText) {
    throw new Error('用户输入为空');
  }

  const messages = [];
  const safeInstructions = clipText(instructions, 2000);
  if (safeInstructions) {
    messages.push({ role: 'system', content: safeInstructions });
  }
  messages.push({ role: 'user', content: safeText });

  if (OPENROUTER_API_KEY) {
    return callOpenRouterChatCompletion(messages, OPENROUTER_MODEL, {
      temperature: 0.7,
      max_tokens: 900
    });
  }
  if (OPENAI_API_KEY) {
    return callOpenAIChatCompletion(messages, OPENAI_TEXT_MODEL, {
      temperature: 0.7,
      max_tokens: 900
    });
  }
  throw new Error('未配置可用的模型密钥（OPENAI_API_KEY / OPENROUTER_API_KEY）');
}

async function callResponsesApiForJson(systemPrompt, userPrompt, options = {}) {
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) {
    throw new Error('未配置 OPENAI_API_KEY 或 OPENROUTER_API_KEY');
  }

  let text = '';

  if (OPENAI_API_KEY) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const { model: modelOverride, ...restOptions } = safeOptions;
    const model = clipText(modelOverride, 80) || OPENAI_STRUCTURE_MODEL;

    const finalOptions = {};
    Object.entries(restOptions).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      finalOptions[key] = value;
    });

    const resp = await fetchFn(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        ...finalOptions
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Responses API失败: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    text = extractResponseText(data);
  } else {
    // OpenRouter: options 仅透传 temperature 等常见字段
    const safeOptions = options && typeof options === 'object' ? options : {};
    const { temperature } = safeOptions;
    text = await callOpenRouterChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      OPENROUTER_STRUCTURE_MODEL,
      {
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2
      }
    );
  }

  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error('模型返回内容无法解析为JSON');
  }
  return parsed;
}

async function callStructuredJsonWithFallback(systemPrompt, userPrompt, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const { model: _ignoredModel, ...restOptions } = safeOptions;
  const primaryModel = clipText(safeOptions.model, 80) || OPENAI_STRUCTURE_MODEL;
  const fallbackModel = clipText(OPENAI_TEXT_MODEL, 80);
  const modelsToTry = [primaryModel];
  if (fallbackModel && fallbackModel !== primaryModel) modelsToTry.push(fallbackModel);

  let lastError = null;
  for (let idx = 0; idx < modelsToTry.length; idx += 1) {
    const model = modelsToTry[idx];
    try {
      const raw = await callResponsesApiForJson(systemPrompt, userPrompt, {
        ...restOptions,
        model
      });
      return { raw, model, fallback: idx > 0, error: lastError?.message || '' };
    } catch (error) {
      lastError = error;
      if (OPENAI_API_KEY) {
        try {
          const raw = await callOpenAIChatCompletionForJson(systemPrompt, userPrompt, model, restOptions);
          return { raw, model, fallback: true, error: error.message || '' };
        } catch (innerError) {
          lastError = innerError;
        }
      }
    }
  }

  throw lastError || new Error('模型调用失败');
}

async function callResponsesApiForText(systemPrompt, userPrompt, options = {}) {
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) {
    throw new Error('未配置 OPENAI_API_KEY 或 OPENROUTER_API_KEY');
  }

  let text = '';

  if (OPENAI_API_KEY) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const { model: modelOverride, ...restOptions } = safeOptions;
    const model = clipText(modelOverride, 80) || OPENAI_STRUCTURE_MODEL;

    const finalOptions = {};
    Object.entries(restOptions).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      finalOptions[key] = value;
    });

    const resp = await fetchFn(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        ...finalOptions
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Responses API失败: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    text = extractResponseText(data);
  } else {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const { temperature } = safeOptions;
    text = await callOpenRouterChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      OPENROUTER_STRUCTURE_MODEL,
      {
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.4
      }
    );
  }

  return (text || '').toString().trim();
}

async function generateBoard(goal, locale = 'zh-CN') {
  const fallback = buildFallbackBoard(goal, locale);
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) return fallback;

  const spec = parseGoalSpec(goal, locale);
  const domain = inferBoardDomain(goal, locale);
  const systemPrompt = locale === 'en'
    ? 'You are Blackboard Architect Agent. Return strict JSON only.'
    : '你是 Blackboard Architect Agent。只返回严格JSON。';
  const userPrompt = locale === 'en'
    ? `Generate a board JSON by schema:
{
  "goal":"string",
  "outline":[{"id":"string","title":"string","status":"pending|teaching|done|skipped"}],
  "nodes":{"id":{"content":"string","examples":["string"]}},
  "progress":{"current_node_id":"string","mastery_score":0}
}
Rules: 4~6 nodes, exactly one teaching node.
Content rules:
- This is a classroom blackboard. Node content must be teachable material, not just meta descriptions.
- If the goal implies dialogue/reading text/example problems/code/exercises/summary, include the actual text in node.content or node.examples (use \\n for line breaks).
- Formatting: Use clear paragraphs and line breaks. Prefer headings + numbered/bulleted lists. Put each key point on its own line. Avoid one huge wall of text.
Blackboard style hard rules:
- This is a blackboard note, NOT a teacher speech. Avoid greetings, roleplay ("teacher/student:"), and chatty filler.
- Keep content concise and structured. Prefer short lines; each key point on its own line.
- Put worked examples / reading passages into node.examples when possible (one example per item). Keep node.content as key points + formulas.
- Do NOT output LaTeX (no $$, \\(...\\), \\frac, \\int, etc). Use plain-text math or Unicode symbols.
- No unrelated tangents (e.g., physics analogies) unless the goal explicitly asks.
- No external links or placeholder URLs.
Domain (hard): ${domain.toUpperCase()}
Domain hard rules:
- If domain is MATH: do NOT generate any dialogues / vocabulary lists. Use math board template below.
- If domain is LANGUAGE: include one node titled "Lesson text / Full dialogue" and put the full text in node.content with clear line breaks (roles/paragraphs). Other nodes: vocab, grammar, drills.
- If domain is GENERAL: use concise conceptual outline + example + checklist.
Templates:
- Math / geometry / conic sections: use nodes like (1) Core definitions & parameters (2) Standard equations (3) Key geometric properties (4) Common problem types + 1-3 examples (5) Common mistakes / quick checklist.
Math board requirement:
- Your output MUST look like concise textbook-style blackboard notes: short bullets, headings, compact formulas.
- No tangents. No "physics thoughts". No long paragraphs. No story.
${buildMathTopicRequirements(goal, 'en')}
Goal (topic + level + constraints):
Topic: ${spec.topic}
Level: ${spec.level || 'unknown'}
Constraints:
${(spec.notes || []).map(x => `- ${x}`).join('\n') || '- none'}`
    : `按 schema 生成黑板 JSON：
{
  "goal":"string",
  "outline":[{"id":"string","title":"string","status":"pending|teaching|done|skipped"}],
  "nodes":{"id":{"content":"string","examples":["string"]}},
  "progress":{"current_node_id":"string","mastery_score":0}
}
要求：4~6 个节点，且仅一个 teaching 节点。
内容要求：
- 这是课堂板书。节点 content 必须写“可直接教学的正文”，不要只写概述。
- 若目标包含/暗示：对话、课文、例题、代码、练习题、总结等，请在对应节点的 content 或 examples 中给出实际文本（用 \\n 换行）。
- 排版要求：自然段清晰分隔，适当使用标题行 + 编号/要点列表；每个要点尽量单独一行；避免一整段超长不换行的“墙状文字”。
板书风格硬规则：
- 这是“板书笔记”，不是老师讲话：不要出现「同学们好/我们来/请你/老师/学生」等口语，也不要输出免责声明/客套话。
- 内容要精炼、结构化：多用短句、要点列表；尽量“一行一个要点”。
- 演示/例题/对话原文/阅读课文，优先放进 node.examples（每条一个）；node.content 只写要点+公式+结论。
- 不要输出 LaTeX/公式源码（如 $$、\\(\\)、\\frac、\\int），用普通文本或 Unicode 数学符号表达。
- 不要跨学科发散（例如“物理思考/雷达定位”），除非目标明确要求。
- 不要放外链或占位链接。
领域（强约束）：${domain === 'math' ? '数学' : (domain === 'language' ? '语言学习' : '通用')}
领域硬规则：
- 若为【数学】：严禁输出对话/词汇表/课文；按“教辅讲义式板书笔记”编排：标题 + 要点 + 公式；禁止“物理思考”之类发散；每个节点最多 8–12 行短要点。
- 若为【语言学习】：必须包含一个节点标题含「课文原文/完整对话」，把完整原文写在 node.content（分角色/分段换行）；其他节点写词汇/语法/练习。
- 若为【通用】：用精炼大纲 + 例子 + checklist。
模板建议：
- 数学/几何/圆锥曲线：建议节点为「核心定义与参数」「标准方程」「几何性质（顶点/焦点/渐近线等）」「常见题型+例题」「易错点/速记清单」。
- 语言课文/对话：必须包含一个节点标题含「课文原文/完整对话」，把完整原文写在 node.content（分角色/分段换行），其余节点写词汇/语法/练习。
目标（主题 + 水平 + 约束）：
主题：${spec.topic}
水平：${spec.level || '不详'}
约束/偏好：
${(spec.notes || []).map(x => `- ${x}`).join('\n') || '- 无'}`;

  try {
    // 默认用结构化更强的模型生成板书，避免跑题
    const result1 = await callStructuredJsonWithFallback(systemPrompt, userPrompt, {
      model: OPENAI_STRUCTURE_MODEL,
      temperature: 0.2
    });
    const raw1 = result1.raw;
    let modelUsed = result1.model;
    let fallbackUsed = result1.fallback;
    let fallbackError = result1.error;
    if (looksLikeBadBoardPayload(raw1, goal, domain, locale)) {
      const retrySystem = locale === 'en'
        ? 'You are a strict Blackboard Architect. Return strict JSON only. Follow domain rules precisely.'
        : '你是严格的黑板编排器。只返回严格JSON。必须严格遵守领域硬规则。';
      const retryUser = locale === 'en'
        ? `${userPrompt}\n\nIMPORTANT: Your previous output was off-topic or too chatty. Regenerate a correct MATH blackboard.`
        : `${userPrompt}\n\n重要：上一次输出跑题/口语化/不是板书。请重新生成【正确的】板书。`;
      const result2 = await callStructuredJsonWithFallback(retrySystem, retryUser, {
        model: OPENAI_STRUCTURE_MODEL,
        temperature: 0.15
      });
      const raw2 = result2.raw;
      modelUsed = result2.model;
      fallbackUsed = fallbackUsed || result2.fallback;
      fallbackError = fallbackError || result2.error;
      const board = normalizeBoardPayload(raw2, goal, locale);
      board.meta.source = OPENAI_API_KEY ? modelUsed : OPENROUTER_STRUCTURE_MODEL;
      if (fallbackUsed && OPENAI_API_KEY) {
        board.meta.fallback_from = OPENAI_STRUCTURE_MODEL;
        if (fallbackError) board.meta.fallback_reason = clipText(fallbackError, 240);
      }
      board.meta.regenerated = true;
      return board;
    }
    const board = normalizeBoardPayload(raw1, goal, locale);
    board.meta.source = OPENAI_API_KEY ? modelUsed : OPENROUTER_STRUCTURE_MODEL;
    if (fallbackUsed && OPENAI_API_KEY) {
      board.meta.fallback_from = OPENAI_STRUCTURE_MODEL;
      if (fallbackError) board.meta.fallback_reason = clipText(fallbackError, 240);
    }
    return board;
  } catch (error) {
    console.error('⚠️ 生成黑板失败，fallback:', error.message);
    fallback.meta = fallback.meta || {};
    fallback.meta.fallback_reason = clipText(error.message || 'unknown error', 240);
    return fallback;
  }
}

function getNextNodeId(board, fromNodeId) {
  const idx = board.outline.findIndex(node => node.id === fromNodeId);
  if (idx === -1) return board.outline[0]?.id || fromNodeId;
  return board.outline[idx + 1]?.id || board.outline[idx]?.id;
}

function buildFallbackPatch(board, userInput, locale = 'zh-CN') {
  const text = (userInput || '').toLowerCase();
  const currentNodeId = board.progress.current_node_id;
  const nextNodeId = getNextNodeId(board, currentNodeId);
  const ops = [];

  if (/下一章|下一节|next|move on/.test(text)) {
    ops.push({ op: 'set_current_node', node_id: nextNodeId });
    return { operations: ops, rationale: locale === 'en' ? 'User requests next section.' : '用户要求进入下一章节。' };
  }
  if (/跳过|skip/.test(text)) {
    ops.push({ op: 'set_status', node_id: currentNodeId, status: 'skipped' });
    ops.push({ op: 'set_current_node', node_id: nextNodeId });
    return { operations: ops, rationale: locale === 'en' ? 'User requests skipping current node.' : '用户要求跳过当前节点。' };
  }
  if (/更细|细一点|展开|detail|deeper|more/.test(text)) {
    const node = board.nodes[currentNodeId];
    ops.push({ op: 'update_node', node_id: currentNodeId, content: `${node?.content || ''}${locale === 'en' ? ' Add deeper explanation with one extra example.' : ' 增加更细化解释并补充一个示例。'}` });
    return { operations: ops, rationale: locale === 'en' ? 'User asks for deeper explanation.' : '用户希望讲解更细。' };
  }
  if (/增加|新增|补充|add/.test(text)) {
    const newId = String(board.outline.length + 1);
    ops.push({ op: 'add_node', node_id: newId, title: locale === 'en' ? 'User Requested Extension' : '用户新增学习点', content: clipText(userInput, 300) });
    return { operations: ops, rationale: locale === 'en' ? 'User requests adding a new structure node.' : '用户要求新增结构节点。' };
  }

  return { operations: [], rationale: locale === 'en' ? 'No structural change required.' : '无需结构更新。' };
}

function normalizePatch(rawPatch) {
  const safe = rawPatch && typeof rawPatch === 'object' ? rawPatch : {};
  const operations = Array.isArray(safe.operations) ? safe.operations : [];
  return {
    operations: operations.slice(0, 20).map((op) => {
      const obj = op && typeof op === 'object' ? op : {};
      const hasTitle = Object.prototype.hasOwnProperty.call(obj, 'title');
      const hasContent = Object.prototype.hasOwnProperty.call(obj, 'content');
      const hasStatus = Object.prototype.hasOwnProperty.call(obj, 'status');
      return {
        op: clipText(obj?.op, 40),
        node_id: clipText(obj?.node_id, 20),
        title: hasTitle ? clipText(obj?.title, 80) : undefined,
        content: hasContent ? clipText(obj?.content, 6000) : undefined,
        status: hasStatus ? clipText(obj?.status, 20) : undefined
      };
    }).filter(op => op.op),
    rationale: clipText(safe.rationale, 240)
  };
}

async function generateBoardPatch(board, userInput, locale = 'zh-CN') {
  const fallback = buildFallbackPatch(board, userInput, locale);
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) return fallback;

  const systemPrompt = locale === 'en'
    ? 'You are Blackboard Architect Agent for board updates. Return strict JSON only.'
    : '你是黑板更新代理 Blackboard Architect Agent。只返回严格JSON。';
  const userPrompt = locale === 'en'
    ? `Current board:
${JSON.stringify(stripHiddenDraft(board))}
User input:
${userInput}
Return:
{
  "rationale":"string",
  "operations":[
    {"op":"add_node|update_node|remove_node|set_status|set_current_node","node_id":"string","title":"string","content":"string","status":"pending|teaching|done|skipped"}
  ]
}
Rules:
- Minimal operations, no unrelated nodes.
- Keep "blackboard note" style: concise bullets, short lines, clear paragraphs.
- Do NOT add tangents (e.g., physics analogies) unless user explicitly asks.
- Do NOT add greetings / teacher speeches / disclaimers.
- Do NOT output LaTeX. Use plain-text math or Unicode symbols.
- If user asks to "generate lesson text / full dialogue / reading passage", create a dedicated node and put the full text into node.content with clear line breaks.
- If you add a new "lesson text" node, set it as current node (set_current_node) and status teaching.`
    : `当前黑板：
${JSON.stringify(stripHiddenDraft(board))}
用户输入：
${userInput}
返回：
{
  "rationale":"string",
  "operations":[
    {"op":"add_node|update_node|remove_node|set_status|set_current_node","node_id":"string","title":"string","content":"string","status":"pending|teaching|done|skipped"}
  ]
}
规则：
- 尽量最少操作，不引入无关节点。
- 保持“板书笔记”风格：要点精炼、短句分行、自然段清晰。
- 不要跨学科发散（例如物理类类比）除非用户明确要求。
- 不要写同学们好/老师讲话/免责声明等口语与套话。
- 不要输出 LaTeX/公式源码，用普通文本或 Unicode 数学符号表达。
- 若用户要求“生成课文/完整对话/阅读原文”，请新增一个专门节点，把完整原文写进 node.content（分角色/分段换行）。
- 若新增“课文原文”节点，请把它设为当前讲解节点（set_current_node）并置为 teaching。`;
  try {
    const raw = await callResponsesApiForJson(systemPrompt, userPrompt);
    const patch = normalizePatch(raw);
    return patch.operations.length ? patch : fallback;
  } catch (error) {
    console.error('⚠️ 生成黑板patch失败，fallback:', error.message);
    return fallback;
  }
}

function applyPatchToBoard(board, patch) {
  const next = JSON.parse(JSON.stringify(board));
  const outlineById = new Map(next.outline.map(item => [item.id, item]));
  const applied = [];

  patch.operations.forEach((op) => {
    if (op.op === 'add_node') {
      const nodeId = op.node_id || String(next.outline.length + 1);
      if (outlineById.has(nodeId)) return;
      const nodeTitle = op.title || `节点 ${nodeId}`;
      next.outline.push({ id: nodeId, title: nodeTitle, status: 'pending' });
      const content = op.content !== undefined ? op.content : `${nodeTitle} 的补充内容。`;
      next.nodes[nodeId] = { content, examples: [] };
      outlineById.set(nodeId, next.outline[next.outline.length - 1]);
      applied.push({ ...op, node_id: nodeId });
      return;
    }

    if (op.op === 'remove_node') {
      if (!outlineById.has(op.node_id)) return;
      next.outline = next.outline.filter(item => item.id !== op.node_id);
      delete next.nodes[op.node_id];
      outlineById.delete(op.node_id);
      if (next.progress.current_node_id === op.node_id) {
        next.progress.current_node_id = next.outline[0]?.id || '';
      }
      applied.push(op);
      return;
    }

    if (op.op === 'update_node') {
      if (!outlineById.has(op.node_id)) return;
      if (!next.nodes[op.node_id]) next.nodes[op.node_id] = { content: '', examples: [] };
      if (op.content !== undefined) {
        next.nodes[op.node_id].content = op.content;
      }
      if (op.title) outlineById.get(op.node_id).title = op.title;
      applied.push(op);
      return;
    }

    if (op.op === 'set_status') {
      if (!outlineById.has(op.node_id)) return;
      if (op.status === undefined) return;
      const status = ALLOWED_NODE_STATUS.has(op.status) ? op.status : 'pending';
      outlineById.get(op.node_id).status = status;
      applied.push({ ...op, status });
      return;
    }

    if (op.op === 'set_current_node') {
      if (!outlineById.has(op.node_id)) return;
      next.progress.current_node_id = op.node_id;
      next.outline.forEach((node) => {
        if (node.id === op.node_id) {
          if (node.status === 'pending') node.status = 'teaching';
        } else if (node.status === 'teaching') {
          node.status = 'done';
        }
      });
      applied.push(op);
    }
  });

  if (!next.outline.some(item => item.status === 'teaching') && next.progress.current_node_id) {
    const active = next.outline.find(item => item.id === next.progress.current_node_id);
    if (active) active.status = 'teaching';
  }

  if (!next.meta || typeof next.meta !== 'object') next.meta = {};
  next.meta.updated_at = new Date().toISOString();
  return { board: next, applied };
}

function toPublicBoard(board) {
  return {
    board_id: board.board_id,
    goal: board.goal,
    outline: board.outline,
    nodes: board.nodes,
    progress: board.progress,
    meta: board.meta
  };
}

async function handleHttpRequest(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const locale = url.searchParams.get('lang') === 'en' ? 'en' : 'zh-CN';

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'blackboard-ai-realtime',
      boards: BOARD_STORE.size,
      has_openai_key: !!OPENAI_API_KEY,
      has_openrouter_key: !!OPENROUTER_API_KEY,
      openrouter_audio_output: shouldUseOpenRouterAudioOutput(),
      openrouter_audio_voice: OPENROUTER_AUDIO_VOICE,
      openrouter_audio_format: OPENROUTER_AUDIO_FORMAT,
      realtime_model: OPENAI_REALTIME_MODEL,
      structure_model: OPENAI_API_KEY ? OPENAI_STRUCTURE_MODEL : OPENROUTER_STRUCTURE_MODEL,
      text_model: OPENROUTER_API_KEY ? OPENROUTER_MODEL : OPENAI_TEXT_MODEL
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/board/')) {
    const boardId = decodeURIComponent(url.pathname.replace('/board/', ''));
    const board = BOARD_STORE.get(boardId);
    if (!board) {
      sendJson(res, 404, { ok: false, message: 'board 不存在' });
      return;
    }
    sendJson(res, 200, { ok: true, board: toPublicBoard(board) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/create-board') {
    const body = await parseBody(req);
    // 允许更长的澄清信息（学习目标 + 水平 + 约束），避免过早截断影响板书生成质量
    const goal = clipText(body.goal || body.user_input, 2400);
    const bodyLocale = body.locale === 'en' ? 'en' : locale;
    if (!goal) {
      sendJson(res, 400, { ok: false, message: 'goal 不能为空' });
      return;
    }
    const board = await generateBoard(goal, bodyLocale);
    const hiddenDraft = await generateHiddenDraft(board, bodyLocale);
    if (hiddenDraft) {
      board.hidden_draft = hiddenDraft;
    }
    BOARD_STORE.set(board.board_id, board);
    BOARD_AUDIT_LOG.push({
      ts: new Date().toISOString(),
      type: 'create_board',
      source: 'user_input',
      board_id: board.board_id,
      goal: clipText(goal, 120)
    });
    sendJson(res, 200, { ok: true, board: toPublicBoard(board) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/update-board') {
    const body = await parseBody(req);
    const boardId = clipText(body.board_id, 80);
    // 允许更长的“把课文写进黑板”等复杂指令
    const userInput = clipText(body.user_input, 5000);
    const triggerSource = clipText(body.trigger_source, 40) || 'user_input';
    const confirmed = body.confirmed === true;
    const bodyLocale = body.locale === 'en' ? 'en' : locale;

    if (!boardId || !userInput) {
      sendJson(res, 400, { ok: false, message: 'board_id 与 user_input 必填' });
      return;
    }
    if (triggerSource !== 'user_input') {
      sendJson(res, 403, {
        ok: false,
        code: 'VOICE_AGENT_FORBIDDEN',
        message: '语音Agent无权修改黑板结构，必须由用户输入触发。'
      });
      return;
    }
    if (!confirmed) {
      sendJson(res, 400, {
        ok: false,
        code: 'USER_CONFIRMATION_REQUIRED',
        requires_confirmation: true,
        message: '黑板更新必须经过用户确认。'
      });
      return;
    }

    const board = BOARD_STORE.get(boardId);
    if (!board) {
      sendJson(res, 404, { ok: false, message: 'board 不存在' });
      return;
    }

    const patch = await generateBoardPatch(board, userInput, bodyLocale);
    const { board: updatedBoard, applied } = applyPatchToBoard(board, patch);
    const hiddenDraft = await generateHiddenDraft(updatedBoard, bodyLocale);
    if (hiddenDraft) {
      updatedBoard.hidden_draft = hiddenDraft;
    }
    BOARD_STORE.set(boardId, updatedBoard);
    BOARD_AUDIT_LOG.push({
      ts: new Date().toISOString(),
      type: 'update_board',
      source: triggerSource,
      board_id: boardId,
      user_input: clipText(userInput, 180),
      rationale: patch.rationale,
      operations: applied
    });

    sendJson(res, 200, {
      ok: true,
      board: toPublicBoard(updatedBoard),
      patch: {
        rationale: patch.rationale,
        operations: applied
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/user-edit-board') {
    const body = await parseBody(req);
    const boardId = clipText(body.board_id, 80);
    const nodeId = clipText(body.node_id, 40);
    const bodyLocale = body.locale === 'en' ? 'en' : locale;

    if (!boardId || !nodeId) {
      sendJson(res, 400, { ok: false, message: 'board_id 与 node_id 必填' });
      return;
    }

    const board = BOARD_STORE.get(boardId);
    if (!board) {
      sendJson(res, 404, { ok: false, message: 'board 不存在' });
      return;
    }

    const outline = Array.isArray(board.outline) ? board.outline : [];
    const hasNode = outline.some(item => item && item.id === nodeId);
    if (!hasNode) {
      sendJson(res, 404, { ok: false, message: 'node 不存在' });
      return;
    }

    const rawContent = (body.content ?? '').toString();
    const content = clipText(rawContent, 6000);
    const rawExamples = Array.isArray(body.examples) ? body.examples : [];
    const examples = rawExamples
      .map(x => (x ?? '').toString().trim())
      .filter(Boolean)
      .slice(0, 40)
      .map(text => clipText(text, 1600));

    const patch = {
      rationale: bodyLocale === 'en' ? 'User edited blackboard content.' : '用户手动编辑了板书内容。',
      operations: [
        {
          op: 'update_node',
          node_id: nodeId,
          content,
          title: ''
        }
      ]
    };

    const { board: updatedBoard, applied } = applyPatchToBoard(board, patch);
    if (!updatedBoard.nodes[nodeId]) updatedBoard.nodes[nodeId] = { content: '', examples: [] };
    updatedBoard.nodes[nodeId].examples = examples;
    const hiddenDraft = await generateHiddenDraft(updatedBoard, bodyLocale);
    if (hiddenDraft) {
      updatedBoard.hidden_draft = hiddenDraft;
    }

    BOARD_STORE.set(boardId, updatedBoard);
    BOARD_AUDIT_LOG.push({
      ts: new Date().toISOString(),
      type: 'user_edit_board',
      source: 'user_input',
      board_id: boardId,
      node_id: nodeId,
      content_len: content.length,
      examples_count: examples.length
    });

    sendJson(res, 200, {
      ok: true,
      board: toPublicBoard(updatedBoard),
      patch: {
        rationale: patch.rationale,
        operations: applied
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/chat-text') {
    const body = await parseBody(req);
    const userText = clipText(body.text || body.user_input, 3000);
    const boardId = clipText(body.board_id, 80);
    const board = boardId ? BOARD_STORE.get(boardId) : null;
    const instructions = board ? buildTeachingInstructionsFromBoard(board, locale) : DEFAULT_INSTRUCTIONS;

    if (!userText) {
      sendJson(res, 400, { ok: false, message: 'text 不能为空' });
      return;
    }

    try {
      let text = '';
      let audioBase64 = '';
      let audioFormat = OPENROUTER_AUDIO_FORMAT || 'wav';

      if (shouldUseOpenRouterAudioOutput()) {
        try {
          const messages = [];
          const safeInstructions = clipText(instructions, 2000);
          if (safeInstructions) messages.push({ role: 'system', content: safeInstructions });
          messages.push({ role: 'user', content: userText });

          const audioResult = await callOpenRouterAudioChatCompletion(messages, OPENROUTER_MODEL, {
            temperature: 0.7,
            max_tokens: 900
          });
          text = (audioResult?.transcript || '').toString().trim();
          audioBase64 = (audioResult?.audio_base64 || '').toString();
          audioFormat = (audioResult?.format || audioFormat).toString();
        } catch (audioError) {
          console.warn(`⚠️ /chat-text 音频输出失败，自动回退文本输出: ${audioError.message}`);
        }
      }

      if (!text) {
        text = await callTextTutorModel(userText, instructions);
      }

      sendJson(res, 200, {
        ok: true,
        text,
        audio_base64: audioBase64,
        format: audioFormat
      });
    } catch (error) {
      console.error('/chat-text 调用失败:', error);
      sendJson(res, 502, { ok: false, message: `模型调用失败: ${error.message}` });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/get-realtime-token') {
    const body = await parseBody(req);
    if (!OPENAI_API_KEY) {
      if (OPENROUTER_API_KEY) {
        sendJson(res, 400, {
          ok: false,
          message: '已配置 OPENROUTER_API_KEY，但 Realtime 语音令牌仅支持 OPENAI_API_KEY'
        });
      } else {
        sendJson(res, 500, { ok: false, message: '未配置 OPENAI_API_KEY' });
      }
      return;
    }
    const boardId = clipText(body.board_id, 80);
    const board = boardId ? BOARD_STORE.get(boardId) : null;
    const instructions = board ? buildTeachingInstructionsFromBoard(board, locale) : DEFAULT_INSTRUCTIONS;

    try {
      const response = await fetchFn(`${OPENAI_API_BASE}/v1/realtime/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_REALTIME_MODEL,
          voice: DEFAULT_VOICE,
          instructions
        })
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`${response.status} ${errText}`);
      }
      const data = await response.json();
      sendJson(res, 200, {
        ok: true,
        token: data?.client_secret?.value || '',
        expires_at: data?.expires_at || null,
        model: OPENAI_REALTIME_MODEL
      });
    } catch (error) {
      console.error('获取Realtime token失败:', error);
      sendJson(res, 502, { ok: false, message: `获取Realtime token失败: ${error.message}` });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/board-audit-log') {
    sendJson(res, 200, {
      ok: true,
      logs: BOARD_AUDIT_LOG.slice(-200)
    });
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not Found' });
}

// 会话管理：客户端WebSocket -> OpenAI Realtime WebSocket
const sessions = new Map();

wss.on('connection', (clientWs, req) => {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[${sessionId}] 新客户端连接`);
  const locale = req?.url && req.url.includes('lang=en') ? 'en' : 'zh-CN';
  
  let openAIWs = null;
  let openAIConnectPromise = null;
  const sessionConfig = {
    voice: DEFAULT_VOICE,
    instructions: process.env.OPENAI_REALTIME_INSTRUCTIONS || buildClarificationInstructions(locale),
    turnDetection: DEFAULT_TURN_DETECTION,
    apiKey: OPENAI_API_KEY,
    board_id: null
  };
  
  const sendToClient = (payload) => {
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  };
  
  // 创建到 OpenAI Realtime API 的连接
  function connectToOpenAI(apiKey = sessionConfig.apiKey || OPENAI_API_KEY) {
    const finalApiKey = apiKey || OPENAI_API_KEY;
    if (!finalApiKey) {
      const err = new Error('未配置 OPENAI_API_KEY，请在 backend/.env 文件中设置');
      console.error(`[${sessionId}] ❌ ${err.message}`);
      sendToClient({
        type: 'error',
        message: err.message
      });
      return Promise.reject(err);
    }

    if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
      return Promise.resolve(openAIWs);
    }
    if (openAIConnectPromise) {
      return openAIConnectPromise;
    }

    console.log(`[${sessionId}] 正在连接到 OpenAI Realtime API...`);

    openAIConnectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
          'Authorization': `Bearer ${finalApiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });
      openAIWs = ws;

      ws.on('unexpected-response', (request, response) => {
        const statusCode = response?.statusCode;
        const statusMessage = response?.statusMessage || '';
        const statusText = statusCode ? `${statusCode} ${statusMessage}`.trim() : '未知响应';
        console.error(`[${sessionId}] ❌ OpenAI 异常响应: ${statusText}`);
        sendToClient({
          type: 'error',
          message: `无法连接到 OpenAI（${statusText}）。可能是网络/代理问题或服务暂时不可用，请稍后重试。`
        });
      });

      const clearConnecting = () => {
        openAIConnectPromise = null;
      };

      ws.on('open', () => {
        console.log(`[${sessionId}] ✅ 已连接到 OpenAI Realtime API`);

        // 配置会话
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(buildSessionUpdatePayload(sessionConfig)));
        } else {
          console.warn(`[${sessionId}] ⚠️ OpenAI WebSocket 未就绪，跳过会话配置`);
        }

        sessions.set(sessionId, { clientWs, openAIWs: ws });
        clearConnecting();
        resolve(ws);
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());

          // 转发所有事件到客户端
          if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'realtime_event',
              event: event
            }));
          }

          // 处理特定事件
          if (event.type === 'response.audio.delta') {
            // 音频数据
            console.log(`[${sessionId}] 📢 收到音频数据`);
          } else if (event.type === 'response.audio_transcript.delta') {
            // 文本转录（可选显示）
            console.log(`[${sessionId}] 📝 转录: ${event.delta}`);
          } else if (event.type === 'response.done') {
            console.log(`[${sessionId}] ✅ 响应完成`);
          }
        } catch (error) {
          console.error(`[${sessionId}] 解析OpenAI消息错误:`, error);
        }
      });

      ws.on('error', (error) => {
        clearConnecting();
        if (openAIWs === ws) {
          openAIWs = null;
        }
        console.error(`[${sessionId}] ❌ OpenAI连接错误:`, error);
        sendToClient({
          type: 'error',
          message: 'OpenAI连接错误: ' + error.message
        });
        reject(error);
      });

      ws.on('close', () => {
        clearConnecting();
        if (openAIWs === ws) {
          openAIWs = null;
        }
        console.log(`[${sessionId}] 🔌 OpenAI连接已关闭`);
        sessions.delete(sessionId);
      });
    });

    return openAIConnectPromise;
  }
  
  // 立即连接 OpenAI（使用全局 API key 或会话配置的 key）
  const initialApiKey = OPENAI_API_KEY || sessionConfig.apiKey;
  if (initialApiKey) {
    sessionConfig.apiKey = initialApiKey;
    connectToOpenAI(initialApiKey).catch(error => {
      console.error(`[${sessionId}] 连接OpenAI失败:`, error);
      sendToClient({
        type: 'error',
        message: '无法连接到OpenAI: ' + error.message
      });
    });
  } else if (OPENROUTER_API_KEY) {
    console.log(`[${sessionId}] ℹ️ 未配置 OPENAI_API_KEY，将使用 OpenRouter 文本模式`);
  } else {
    console.error(`[${sessionId}] ❌ 未配置 OPENAI_API_KEY / OPENROUTER_API_KEY`);
    sendToClient({
      type: 'error',
      message: '未配置可用密钥，请在 backend/.env 设置 OPENAI_API_KEY 或 OPENROUTER_API_KEY'
    });
  }
  
  // 接收客户端消息
  clientWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      const syncSessionToOpenAI = () => {
        if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
          openAIWs.send(JSON.stringify(buildSessionUpdatePayload(sessionConfig)));
          return true;
        }
        return false;
      };

      const sendTextToOpenAI = (text) => {
        if (!openAIWs || openAIWs.readyState !== WebSocket.OPEN) return false;
        openAIWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }]
          }
        }));
        openAIWs.send(JSON.stringify({ type: 'response.create' }));
        return true;
      };

      const sendTextByFallbackModel = async (text) => {
        try {
          if (shouldUseOpenRouterAudioOutput()) {
            try {
              const messages = [];
              const safeInstructions = clipText(sessionConfig.instructions || DEFAULT_INSTRUCTIONS, 2000);
              if (safeInstructions) messages.push({ role: 'system', content: safeInstructions });
              messages.push({ role: 'user', content: clipText(text, 3000) });

              const audioResult = await callOpenRouterAudioChatCompletion(messages, OPENROUTER_MODEL, {
                temperature: 0.7,
                max_tokens: 900
              });

              if (audioResult?.audio_base64) {
                sendToClient({
                  type: 'audio_output',
                  format: audioResult.format || 'wav',
                  audio_base64: audioResult.audio_base64,
                  transcript: audioResult.transcript || ''
                });
              }

              const transcript = (audioResult?.transcript || '').toString();
              if (transcript) {
                sendToClient({
                  type: 'realtime_event',
                  event: {
                    type: 'response.audio_transcript.delta',
                    delta: transcript
                  }
                });
              }

              sendToClient({
                type: 'realtime_event',
                event: {
                  type: 'response.done'
                }
              });
              return true;
            } catch (audioError) {
              console.warn(`[${sessionId}] OpenRouter音频输出失败，自动回退文本输出: ${audioError.message}`);
            }
          }

          const reply = await callTextTutorModel(text, sessionConfig.instructions || DEFAULT_INSTRUCTIONS);
          sendToClient({
            type: 'realtime_event',
            event: {
              type: 'response.audio_transcript.delta',
              delta: reply
            }
          });
          sendToClient({
            type: 'realtime_event',
            event: {
              type: 'response.done'
            }
          });
          return true;
        } catch (error) {
          sendToClient({
            type: 'error',
            message: `文本消息发送失败: ${error.message}`
          });
          return false;
        }
      };
      
      if (data.type === 'audio_data') {
        if (!openAIWs || openAIWs.readyState !== WebSocket.OPEN) {
          if (OPENAI_API_KEY || sessionConfig.apiKey) {
            connectToOpenAI().catch(() => {});
          } else {
            sendToClient({
              type: 'error',
              message: '当前为文本模型模式，音频流需要配置 OPENAI_API_KEY 才可使用'
            });
          }
          return;
        }
        // 转发音频数据到OpenAI
        if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
          // 发送音频缓冲区
          openAIWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.audio // base64编码的PCM16音频
          }));
        }
      } else if (data.type === 'audio_end') {
        if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
          openAIWs.send(JSON.stringify({
            type: 'input_audio_buffer.commit'
          }));
          openAIWs.send(JSON.stringify({
            type: 'response.create'
          }));
        }
      } else if (data.type === 'text_message') {
        const text = clipText(data.text, 3000);
        if (!text) return;
        if (sendTextToOpenAI(text)) return;
        if (!OPENAI_API_KEY && OPENROUTER_API_KEY) {
          sendTextByFallbackModel(text);
          return;
        }
        connectToOpenAI()
          .then(() => {
            if (!sendTextToOpenAI(text)) {
              return sendTextByFallbackModel(text);
            }
            return null;
          })
          .catch((error) => {
            if (OPENROUTER_API_KEY) {
              sendTextByFallbackModel(text);
              return;
            }
            sendToClient({
              type: 'error',
              message: `文本消息发送失败: ${error.message}`
            });
          });
      } else if (data.type === 'bind_board_context') {
        const boardId = clipText(data.board_id, 80);
        const board = BOARD_STORE.get(boardId);
        if (!board) {
          sendToClient({
            type: 'error',
            message: '绑定黑板失败：board 不存在'
          });
          return;
        }
        sessionConfig.board_id = boardId;
        sessionConfig.instructions = buildTeachingInstructionsFromBoard(board, locale);
        if (!syncSessionToOpenAI() && (OPENAI_API_KEY || sessionConfig.apiKey)) {
          connectToOpenAI().then(syncSessionToOpenAI).catch(() => {});
        }
        sendToClient({
          type: 'board_context_bound',
          board_id: boardId,
          board: toPublicBoard(board)
        });
      } else if (data.type === 'set_current_node') {
        const boardId = clipText(data.board_id, 80);
        const nodeId = clipText(data.node_id, 20);
        const board = BOARD_STORE.get(boardId);
        if (!board || !nodeId) return;
        if (!Array.isArray(board.outline) || !board.outline.some(node => node.id === nodeId)) return;
        board.progress.current_node_id = nodeId;
        board.outline.forEach((node) => {
          if (node.id === nodeId) {
            if (node.status === 'pending') node.status = 'teaching';
          } else if (node.status === 'teaching') {
            node.status = 'done';
          }
        });
        board.meta.updated_at = new Date().toISOString();
        BOARD_STORE.set(boardId, board);
        if (sessionConfig.board_id === boardId) {
          sessionConfig.instructions = buildTeachingInstructionsFromBoard(board, locale);
          if (!syncSessionToOpenAI() && (OPENAI_API_KEY || sessionConfig.apiKey)) {
            connectToOpenAI().then(syncSessionToOpenAI).catch(() => {});
          }
        }
        sendToClient({
          type: 'current_node_updated',
          board_id: boardId,
          node_id: nodeId
        });
      } else if (data.type === 'update_session') {
        if (data.voice) sessionConfig.voice = data.voice;
        if (data.instructions) {
          if (sessionConfig.board_id) {
            const board = BOARD_STORE.get(sessionConfig.board_id);
            if (board) {
              sessionConfig.instructions = `${clipText(data.instructions, 1200)}\n\n${buildTeachingInstructionsFromBoard(board, locale)}`;
            } else {
              sessionConfig.instructions = data.instructions;
            }
          } else {
            sessionConfig.instructions = data.instructions;
          }
        }
        if (data.turnDetection) sessionConfig.turnDetection = data.turnDetection;

        if (!openAIWs || openAIWs.readyState !== WebSocket.OPEN) {
          if (!(OPENAI_API_KEY || sessionConfig.apiKey)) {
            return;
          }
          connectToOpenAI().then(syncSessionToOpenAI).catch(() => {});
          return;
        }
        syncSessionToOpenAI();
      } else if (data.type === 'update_api_key') {
        // 更新API密钥（重新连接）
        if (data.apiKey && typeof data.apiKey === 'string') {
          sessionConfig.apiKey = data.apiKey;
          if (openAIWs) {
            openAIWs.close();
          }
          connectToOpenAI(data.apiKey).catch(console.error);
        } else {
          sendToClient({
            type: 'error',
          message: 'OPENAI_API_KEY 为空，无法连接 Realtime API'
          });
        }
      }
    } catch (error) {
      console.error(`[${sessionId}] 处理客户端消息错误:`, error);
    }
  });
  
  clientWs.on('close', () => {
    console.log(`[${sessionId}] 客户端连接已关闭`);
    if (openAIWs) {
      openAIWs.close();
    }
    sessions.delete(sessionId);
  });
  
  clientWs.on('error', (error) => {
    console.error(`[${sessionId}] 客户端连接错误:`, error);
  });
  
  // 发送连接成功消息
  clientWs.send(JSON.stringify({
    type: 'connected',
    sessionId: sessionId,
    message: '已连接到音频流服务器'
  }));
});

// 捕获未处理的异常
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error);
  console.error('错误堆栈:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason);
  process.exit(1);
});

// 启动服务器
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用！`);
    console.error(`   请关闭占用该端口的程序，或修改 PORT 配置`);
    console.error(`   可以使用命令检查: netstat -ano | findstr :${PORT}`);
    process.exit(1);
  } else {
    console.error('❌ 服务器启动错误:', error);
    console.error('错误详情:', error.message);
    console.error('错误堆栈:', error.stack);
    process.exit(1);
  }
});

try {
  server.listen(PORT, () => {
  console.log(`✅ Realtime 音频流服务器运行在 ws://localhost:${PORT}`);
  console.log(`📝 前端应连接到: ws://localhost:${PORT}`);
  console.log(`🤖 Realtime: OpenAI，文本兜底: OpenAI / OpenRouter`);
  console.log(`📚 Blackboard API:`);
  console.log(`   POST http://localhost:${PORT}/create-board`);
  console.log(`   POST http://localhost:${PORT}/update-board`);
  console.log(`   POST http://localhost:${PORT}/get-realtime-token`);
  console.log(`   GET  http://localhost:${PORT}/board/:id`);
  console.log(`   GET  http://localhost:${PORT}/board-audit-log`);

  if (OPENAI_API_KEY) {
    console.log(`✅ 已加载 OPENAI_API_KEY (前10位: ${OPENAI_API_KEY.substring(0, 10)}...)`);
  } else {
    console.warn('⚠️ 未检测到 OPENAI_API_KEY（语音 Realtime 不可用）');
  }

  if (OPENROUTER_API_KEY) {
    console.log(`✅ 已加载 OPENROUTER_API_KEY (前10位: ${OPENROUTER_API_KEY.substring(0, 10)}...)`);
    console.log(`✅ OpenRouter 文本模型: ${OPENROUTER_MODEL}`);
  } else {
    console.warn('⚠️ 未检测到 OPENROUTER_API_KEY（OpenRouter 文本模式不可用）');
  }

  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) {
    console.warn('⚠️ 请在 backend/.env 中至少配置一个密钥: OPENAI_API_KEY 或 OPENROUTER_API_KEY');
    console.warn('   或运行"设置API密钥.bat"脚本');
  }
    console.log('');
    console.log('服务器已就绪，等待客户端连接...');
  });
} catch (error) {
  console.error('❌ 启动服务器时发生错误:', error);
  console.error('错误详情:', error.message);
  console.error('错误堆栈:', error.stack);
  process.exit(1);
}

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  wss.close(() => {
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });
});
