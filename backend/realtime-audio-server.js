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
// Board model routing (PM subject_type -> board model)
// - science (理科) => prefer o3 for structured reasoning
// - humanities (文科) => prefer GPT-5.2 for richer narration/organization
const OPENAI_BOARD_MODEL_SCIENCE = process.env.OPENAI_BOARD_MODEL_SCIENCE || process.env.OPENAI_BOARD_MODEL_SCI || 'o3';
const OPENAI_BOARD_MODEL_HUMANITIES = process.env.OPENAI_BOARD_MODEL_HUMANITIES || process.env.OPENAI_BOARD_MODEL_ART || 'gpt-5.2';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_TEXT_MODEL || 'gpt-4o-mini';
const WEB_SEARCH_PROVIDER = (process.env.WEB_SEARCH_PROVIDER || 'duckduckgo').toString().trim().toLowerCase();
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

function stripHtmlTags(html = '') {
  const text = (html || '').toString();
  if (!text) return '';
  return text
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeSourcesInput(rawSources) {
  if (!rawSources) return [];
  if (typeof rawSources === 'string') {
    const text = rawSources.trim();
    if (!text) return [];
    return [{ source_id: 'materials', title: '材料', text }];
  }
  const list = Array.isArray(rawSources) ? rawSources : [];
  return list
    .map((item, idx) => {
      if (!item || typeof item !== 'object') return null;
      const sourceId = clipText(item.source_id || item.id || `source_${idx + 1}`, 80) || `source_${idx + 1}`;
      const title = clipText(item.title || item.name || sourceId, 120) || sourceId;
      const text = (item.text || item.content || '').toString();
      const clean = text.replace(/\r\n?/g, '\n').trim();
      if (!clean) return null;
      return { source_id: sourceId, title, text: clean };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function chunkSourceText(text, chunkCharLimit = 900) {
  const clean = (text || '').toString().replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  let idx = 0;
  const pushBuffer = () => {
    const t = buffer.trim();
    if (!t) return;
    idx += 1;
    chunks.push({ index: idx, text: t });
    buffer = '';
  };
  for (const p of paras) {
    if (!buffer) {
      buffer = p;
      if (buffer.length >= chunkCharLimit) pushBuffer();
      continue;
    }
    if ((buffer.length + 2 + p.length) <= chunkCharLimit) {
      buffer = `${buffer}\n\n${p}`;
    } else {
      pushBuffer();
      buffer = p;
      if (buffer.length >= chunkCharLimit) pushBuffer();
    }
  }
  pushBuffer();
  return chunks;
}

function buildSourceChunks(sources, locale = 'zh-CN') {
  const list = normalizeSourcesInput(sources);
  const chunks = [];
  list.forEach((src) => {
    const parts = chunkSourceText(src.text, 900);
    parts.forEach((part) => {
      const chunkId = `${src.source_id}:${part.index}`;
      chunks.push({
        chunk_id: chunkId,
        source_id: src.source_id,
        source_title: src.title,
        index: part.index,
        text: clipText(part.text, 6000),
        preview: clipText(part.text, locale === 'en' ? 220 : 160)
      });
    });
  });
  return { sources: list, chunks };
}

function buildFallbackTeachingGuide(board, chunkIds = [], locale = 'zh-CN') {
  const now = new Date().toISOString();
  if (locale === 'en') {
    return {
      version: 1,
      created_at: now,
      overview: 'Teach strictly based on the blackboard. Only cite allowed source chunks.',
      rules: [
        'Only cite from Allowed Sources below. If more context is needed, ask user to select text and expand attention scope.',
        'Follow board order. One key point per turn + one short check question.'
      ],
      allowed_chunk_ids: chunkIds.slice(0, 12),
      teacher_script: []
    };
  }
  return {
    version: 1,
    created_at: now,
    overview: '严格围绕黑板讲解，只能引用允许的材料片段。',
    rules: [
      '只能引用“允许引用范围”内的材料片段。需要更多内容时，引导用户框选并点击“增加讲师注意力篇幅”。',
      '按黑板节点顺序推进：每轮只讲 1 个关键点 + 1 个简短检查问题。'
    ],
    allowed_chunk_ids: chunkIds.slice(0, 12),
    teacher_script: []
  };
}

async function selectInitialAttentionChunks(goalText, chunks, locale = 'zh-CN') {
  const safeChunks = Array.isArray(chunks) ? chunks.slice(0, 80) : [];
  if (!safeChunks.length) return { chunk_ids: [], rationale: '' };
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) {
    return { chunk_ids: safeChunks.slice(0, 4).map(x => x.chunk_id), rationale: 'fallback' };
  }

  const systemPrompt = locale === 'en'
    ? 'You are AttentionScope selector. Return strict JSON only.'
    : '你是 AttentionScope 选择器。只返回严格JSON。';
  const userPrompt = locale === 'en'
    ? [
      'Pick the MINIMAL set of source chunks needed for the user goal.',
      'Return JSON schema:',
      '{"chunk_ids":["string"],"rationale":"string"}',
      'Rules:',
      '- Prefer 3-8 chunks.',
      '- Choose only chunk_ids from the list.',
      '- Do NOT include unrelated chunks.',
      `User goal:\n${clipText(goalText, 1200)}`,
      'Chunks:',
      safeChunks.map(c => `${c.chunk_id} | ${c.source_title} | ${c.preview}`).join('\n')
    ].join('\n')
    : [
      '请为“讲师可引用范围”挑选最小必要材料片段集合（AttentionScope）。',
      '只返回 JSON，schema：',
      '{"chunk_ids":["string"],"rationale":"string"}',
      '规则：',
      '- 优先选 3–8 个 chunk。',
      '- 只能从下方列表选择 chunk_id。',
      '- 只选与目标直接相关的片段，避免讲全文。',
      `用户目标：\n${clipText(goalText, 1200)}`,
      '材料片段列表：',
      safeChunks.map(c => `${c.chunk_id}｜${c.source_title}｜${c.preview}`).join('\n')
    ].join('\n');

  try {
    const result = await callStructuredJsonWithFallback(systemPrompt, userPrompt, {
      model: OPENAI_STRUCTURE_MODEL,
      temperature: 0.1,
      max_output_tokens: 420
    });
    const raw = result.raw || {};
    const idsRaw = Array.isArray(raw.chunk_ids) ? raw.chunk_ids : [];
    const ids = idsRaw
      .map((x) => (x ?? '').toString().trim())
      .filter(Boolean)
      .slice(0, 30);
    const allowSet = new Set(safeChunks.map(c => c.chunk_id));
    const mapped = [];
    ids.forEach((id) => {
      // 允许模型用 “1/2/3” 表示第几个 chunk
      if (/^\d{1,3}$/.test(id)) {
        const idx = Number(id);
        if (Number.isFinite(idx) && idx >= 1 && idx <= safeChunks.length) {
          mapped.push(safeChunks[idx - 1].chunk_id);
        }
        return;
      }
      // 常见分隔符纠错：materials-1 -> materials:1
      const normalized = id.replace(/-/g, ':');
      mapped.push(normalized);
    });
    const filtered = mapped.filter(id => allowSet.has(id)).slice(0, 12);
    const finalIds = filtered.length ? filtered : safeChunks.slice(0, 4).map(x => x.chunk_id);
    return { chunk_ids: finalIds, rationale: clipText(raw.rationale, 300) };
  } catch (error) {
    console.warn('⚠️ selectInitialAttentionChunks failed, fallback:', error.message);
    return { chunk_ids: safeChunks.slice(0, 4).map(x => x.chunk_id), rationale: 'fallback' };
  }
}

async function generateTeachingGuide(goalText, board, chunks, allowedChunkIds, locale = 'zh-CN') {
  const safeAllowed = Array.isArray(allowedChunkIds) ? allowedChunkIds.slice(0, 12) : [];
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) {
    return buildFallbackTeachingGuide(board, safeAllowed, locale);
  }
  const outline = Array.isArray(board?.outline) ? board.outline : [];
  const allowedNodeIds = outline.map(n => String(n?.id || '').trim()).filter(Boolean);
  const allowedNodeSet = new Set(allowedNodeIds);
  const outlineText = outline.map(n => `[${n.id}] ${n.title}`).join('\n');
  const allowedPreview = (Array.isArray(chunks) ? chunks : [])
    .filter(c => safeAllowed.includes(c.chunk_id))
    .slice(0, 10)
    .map(c => `${c.chunk_id}｜${c.source_title}｜${c.preview}`)
    .join('\n');

  const systemPrompt = locale === 'en'
    ? 'You are a TeachingGuide writer for a classroom blackboard system. Return strict JSON only.'
    : '你是课堂式黑板系统的 TeachingGuide（教案/讲义）编写者。只返回严格JSON。';
  const userPrompt = locale === 'en'
    ? [
      'Write a TeachingGuide that strictly constrains the realtime teacher attention.',
      'Return JSON schema:',
      '{"version":1,"overview":"string","rules":["string"],"allowed_chunk_ids":["string"],"teacher_script":[{"node_id":"string","focus_points":["string"],"questions":["string"]}]}',
      'Hard rules:',
      '- The teacher must ONLY cite from allowed_chunk_ids.',
      '- The guide must tell teacher to ask user to expand scope when needed.',
      '- Keep concise.',
      `teacher_script.node_id MUST be one of these board node ids: ${allowedNodeIds.join(', ') || 'N/A'}`,
      `User goal:\n${clipText(goalText, 1200)}`,
      `Blackboard goal:\n${clipText(board?.goal, 200)}`,
      'Board outline:',
      outlineText || 'N/A',
      'Allowed source chunks (preview):',
      allowedPreview || 'N/A',
      'Allowed chunk ids:',
      safeAllowed.join(', ')
    ].join('\n')
    : [
      '请编写一份 TeachingGuide（教案讲义），用来严格约束实时语音讲师的注意力与讲解范围。',
      '只返回 JSON，schema：',
      '{"version":1,"overview":"string","rules":["string"],"allowed_chunk_ids":["string"],"teacher_script":[{"node_id":"string","focus_points":["string"],"questions":["string"]}]}',
      '硬规则：',
      '- 讲师只能引用 allowed_chunk_ids 对应的材料片段；禁止引用未允许的全文其他部分。',
      '- 若用户问题超出范围，讲师必须引导用户通过“框选文本→增加讲师注意力篇幅”来扩展引用范围。',
      '- 输出要精炼，像课堂备课提纲，不要长篇大论。',
      `teacher_script.node_id 必须是黑板节点 id 之一：${allowedNodeIds.join('，') || '无'}`,
      `用户目标：\n${clipText(goalText, 1200)}`,
      `黑板目标：\n${clipText(board?.goal, 200)}`,
      '黑板大纲：',
      outlineText || '无',
      '允许引用的材料片段预览：',
      allowedPreview || '无',
      '允许 chunk ids：',
      safeAllowed.join('，')
    ].join('\n');

  try {
    const result = await callStructuredJsonWithFallback(systemPrompt, userPrompt, {
      model: OPENAI_STRUCTURE_MODEL,
      temperature: 0.2,
      max_output_tokens: 900
    });
    const raw = result.raw || {};
    const rules = Array.isArray(raw.rules) ? raw.rules.map(x => clipText(x, 220)).filter(Boolean).slice(0, 10) : [];
    const script = Array.isArray(raw.teacher_script) ? raw.teacher_script.slice(0, 12).map((x) => {
      const obj = x && typeof x === 'object' ? x : {};
      return {
        node_id: clipText(obj.node_id, 20),
        focus_points: Array.isArray(obj.focus_points) ? obj.focus_points.map(p => clipText(p, 140)).filter(Boolean).slice(0, 6) : [],
        questions: Array.isArray(obj.questions) ? obj.questions.map(q => clipText(q, 140)).filter(Boolean).slice(0, 4) : []
      };
    }).filter(x => x.node_id && allowedNodeSet.has(String(x.node_id))) : [];
    const guide = {
      version: 1,
      created_at: new Date().toISOString(),
      overview: clipText(raw.overview, 360) || (locale === 'en' ? 'Teaching guide generated.' : '已生成教案讲义。'),
      rules: rules.length ? rules : buildFallbackTeachingGuide(board, safeAllowed, locale).rules,
      allowed_chunk_ids: safeAllowed,
      teacher_script: script
    };
    return guide;
  } catch (error) {
    console.warn('⚠️ generateTeachingGuide failed, fallback:', error.message);
    return buildFallbackTeachingGuide(board, safeAllowed, locale);
  }
}

function buildClippedSourcesTextFromBoard(board, maxChars = 6200) {
  const chunks = Array.isArray(board?.sources_chunks) ? board.sources_chunks : [];
  const allowed = Array.isArray(board?.attention_scope?.allowed_chunk_ids) ? board.attention_scope.allowed_chunk_ids : [];
  const extraSnippets = Array.isArray(board?.attention_scope?.extra_snippets) ? board.attention_scope.extra_snippets : [];
  const parts = [];
  const chunkById = new Map(chunks.map(c => [c.chunk_id, c]));

  allowed.forEach((id) => {
    const chunk = chunkById.get(id);
    if (!chunk) return;
    parts.push(`[SourceChunk:${chunk.chunk_id}] ${chunk.source_title}\n${chunk.text}`.trim());
  });
  extraSnippets.forEach((snip) => {
    const text = (snip?.text || '').toString().trim();
    if (!text) return;
    const tag = clipText(snip?.id || 'user', 80) || 'user';
    parts.push(`[Extra:${tag}]\n${clipText(text, 2000)}`.trim());
  });

  const merged = parts.join('\n\n---\n\n').trim();
  return clipText(merged, maxChars);
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

function jsonEscapeForPrompt(value) {
  return (value || '').toString().replace(/[\\]/g, '\\\\').replace(/`/g, '\\`');
}

function normalizeBase64Input(data) {
  const raw = (data || '').toString().trim();
  if (!raw) return '';
  const m = raw.match(/^data:([a-z0-9+.-]+\/[a-z0-9+.-]+);base64,(.+)$/i);
  if (m && m[2]) return m[2].trim();
  return raw;
}

function looksLikeBase64(value) {
  const raw = (value || '').toString().trim();
  if (!raw) return false;
  if (raw.length < 64) return false;
  if (/[^a-z0-9+/=]/i.test(raw)) return false;
  return true;
}

async function callOpenAIResponsesForVisionJson(systemPrompt, imageBase64, mimeType = 'image/png', locale = 'zh-CN') {
  if (!OPENAI_API_KEY) {
    throw new Error('未配置 OPENAI_API_KEY');
  }
  const safeB64 = normalizeBase64Input(imageBase64);
  if (!safeB64 || !looksLikeBase64(safeB64)) {
    throw new Error('图片 base64 数据无效');
  }

  const prompt = (systemPrompt || '').toString().trim();
  const resp = await fetchFn(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      input: [
        {
          role: 'system',
          content: prompt
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: locale === 'en'
                ? 'Please extract the text content from this image and summarize it for learning.'
                : '请从图片中提取文字内容，并为学习目的做结构化总结。'
            },
            {
              type: 'input_image',
              image_url: `data:${mimeType || 'image/png'};base64,${safeB64}`
            }
          ]
        }
      ],
      max_output_tokens: 900
    })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Responses API(vision)失败: ${resp.status} ${errText}`);
  }
  const data = await resp.json();
  const text = extractResponseText(data);
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error('模型返回内容无法解析为JSON');
  }
  return parsed;
}

async function extractTextFromImage(imageBase64, mimeType = 'image/png', filename = '', locale = 'zh-CN') {
  const systemPrompt = locale === 'en'
    ? [
      'You are an image-to-text extractor for a classroom blackboard app.',
      'Return strict JSON only, schema:',
      '{"title":"string","extracted_text":"string","summary":"string","key_points":["string"]}',
      'Rules:',
      '- Focus on text in the image (OCR). Preserve line breaks.',
      '- Do NOT identify any real people in the image.',
      '- If the image has no text, set extracted_text to empty string.',
      '- Keep summary concise.'
    ].join('\n')
    : [
      '你是课堂式黑板AI应用的图片识别（OCR）与学习摘要助手。',
      '只返回严格 JSON，schema：',
      '{"title":"string","extracted_text":"string","summary":"string","key_points":["string"]}',
      '规则：',
      '- 以图片中的文字为主（OCR），尽量保留换行。',
      '- 不要识别/推断图片中真实人物身份。',
      '- 如果图片中几乎没有文字，extracted_text 置空字符串。',
      '- summary 要简短、可用于学习。',
      `文件名（可选）：${clipText(filename, 80)}`
    ].join('\n');

  const raw = await callOpenAIResponsesForVisionJson(systemPrompt, imageBase64, mimeType, locale);
  const title = clipText(raw?.title, 120) || (filename ? clipText(filename, 120) : (locale === 'en' ? 'Image' : '图片'));
  const extracted = (raw?.extracted_text || '').toString().replace(/\r\n?/g, '\n').trim();
  const summary = (raw?.summary || '').toString().trim();
  const keyPoints = Array.isArray(raw?.key_points)
    ? raw.key_points.map(x => clipText(x, 200)).filter(Boolean).slice(0, 12)
    : [];
  return {
    title,
    extracted_text: clipText(extracted, 12000),
    summary: clipText(summary, 1200),
    key_points: keyPoints
  };
}

async function analyzePmLearningSpec(userText, attachments = [], previousSpec = null, locale = 'zh-CN') {
  const safeUser = clipText(userText, 3000);
  const attList = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
  const attText = attList.map((a, idx) => {
    const title = clipText(a?.title || a?.name || a?.filename || `附件${idx + 1}`, 120);
    const type = clipText(a?.type || a?.kind || 'attachment', 40);
    const extracted = clipText(a?.extracted_text || a?.text || '', 1800);
    const summary = clipText(a?.summary || '', 600);
    const points = Array.isArray(a?.key_points) ? a.key_points.map(x => clipText(x, 160)).filter(Boolean).slice(0, 6) : [];
    const parts = [];
    parts.push(`- [${idx + 1}] ${title} (${type})`);
    if (summary) parts.push(`  摘要：${summary}`);
    if (points.length) parts.push(`  要点：${points.join('；')}`);
    if (extracted) parts.push(`  提取文本：${extracted}`);
    return parts.join('\n');
  }).join('\n');

  const systemPrompt = locale === 'en'
    ? 'You are the Realtime PM (project manager) analyzer. Return strict JSON only.'
    : '你是 Realtime PM（项目经理）分析器。只返回严格 JSON。';
  const userPrompt = locale === 'en'
    ? [
      'Given the latest user message and available attachments, produce a structured LearningSpec and readiness signal.',
      'Return JSON schema:',
      '{"learning_spec":{"topic":"string","goal":"string","level":"string","time_budget_min":0,"preferred_style":"string","constraints":["string"],"materials_summary":"string","subject_type":"science|humanities|mixed"},"pm_summary_bullets":["string"],"clarity_score":0,"ready_for_board":false,"goal_text":"string"}',
      'Rules:',
      '- subject_type: science for STEM (math/physics/chemistry/biology/engineering/programming/statistics); humanities for languages/history/literature/philosophy/law/politics; mixed if both.',
      '- clarity_score is 0-100.',
      '- ready_for_board should be true only when topic+goal+level are clear enough and constraints are sufficient.',
      '- goal_text should be a compact text block used for board generation (Chinese OK even when locale=en).',
      `User message:\n${safeUser}`,
      previousSpec ? `Previous spec:\n${JSON.stringify(previousSpec)}` : '',
      attText ? `Attachments:\n${attText}` : 'Attachments: (none)'
    ].filter(Boolean).join('\n')
    : [
      '请根据用户最新一句话 + 用户提供的附件资料，给出结构化 LearningSpec，并判断是否已经“清晰到可以生成板书”。',
      '只返回 JSON，schema：',
      '{"learning_spec":{"topic":"string","goal":"string","level":"string","time_budget_min":0,"preferred_style":"string","constraints":["string"],"materials_summary":"string","subject_type":"science|humanities|mixed"},"pm_summary_bullets":["string"],"clarity_score":0,"ready_for_board":false,"goal_text":"string"}',
      '规则：',
      '- subject_type 学科类型：理科/STEM 归为 science（数学/物理/化学/生物/工程/编程/统计等）；文科/人文社科/语言 归为 humanities（语文/英语/历史/文学/哲学/法学/政治等）；两者都有选 mixed。',
      '- clarity_score 取 0-100。',
      '- ready_for_board 只有在“主题+目标+水平/困难点+关键约束”都足够明确时才为 true。',
      '- goal_text 用于后续板书生成：建议按“学习目标/当前水平/约束/材料摘要”组织成短文本。',
      `用户最新输入：\n${safeUser}`,
      previousSpec ? `上一轮 LearningSpec：\n${JSON.stringify(previousSpec)}` : '',
      attText ? `用户附件资料：\n${attText}` : '用户附件资料：无'
    ].filter(Boolean).join('\n');

  const result = await callStructuredJsonWithFallback(systemPrompt, userPrompt, {
    model: OPENAI_STRUCTURE_MODEL,
    temperature: 0.2,
    max_output_tokens: 900
  });
  const raw = result.raw || {};
  const spec = raw.learning_spec && typeof raw.learning_spec === 'object' ? raw.learning_spec : {};
  const bullets = Array.isArray(raw.pm_summary_bullets) ? raw.pm_summary_bullets.map(x => clipText(x, 160)).filter(Boolean).slice(0, 8) : [];
  const clarity = Number(raw.clarity_score);
  const clarityScore = Number.isFinite(clarity) ? Math.max(0, Math.min(100, Math.round(clarity))) : 0;
  const ready = raw.ready_for_board === true && clarityScore >= 70;
  const goalText = clipText(raw.goal_text, 2600);
  const rawSubjectType = (spec.subject_type || raw.subject_type || '').toString().trim().toLowerCase();
  const subjectType = (rawSubjectType === 'science' || rawSubjectType === 'humanities' || rawSubjectType === 'mixed')
    ? rawSubjectType
    : 'mixed';
  const normalizedSpec = {
    topic: clipText(spec.topic, 220),
    goal: clipText(spec.goal, 420),
    level: clipText(spec.level, 120),
    time_budget_min: Number.isFinite(Number(spec.time_budget_min)) ? Math.max(0, Math.min(600, Number(spec.time_budget_min))) : 0,
    preferred_style: clipText(spec.preferred_style, 120),
    constraints: Array.isArray(spec.constraints) ? spec.constraints.map(x => clipText(x, 160)).filter(Boolean).slice(0, 10) : [],
    materials_summary: clipText(spec.materials_summary, 900),
    subject_type: subjectType
  };
  const pmSummary = bullets.length
    ? bullets
    : [
      normalizedSpec.topic ? `学习主题：${normalizedSpec.topic}` : '',
      normalizedSpec.goal ? `学习目标：${normalizedSpec.goal}` : '',
      normalizedSpec.level ? `当前水平：${normalizedSpec.level}` : ''
    ].filter(Boolean).slice(0, 6);

  return {
    learning_spec: normalizedSpec,
    pm_summary_bullets: pmSummary,
    clarity_score: clarityScore,
    ready_for_board: !!ready,
    goal_text: goalText || ''
  };
}

async function webSearchDuckDuckGoHtml(query, maxResults = 6) {
  const q = (query || '').toString().trim();
  if (!q) return [];
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const resp = await fetchFn(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BlackboardAI/1.0',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      'Referer': 'https://duckduckgo.com/',
      'Origin': 'https://duckduckgo.com'
    }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DuckDuckGo 搜索失败: ${resp.status} ${clipText(text, 240)}`);
  }
  const html = await resp.text();
  const results = [];

  const normalizeResultUrl = (href) => {
    let finalUrl = (href || '').toString().trim();
    if (!finalUrl) return '';
    try {
      const normalizedHref = finalUrl.startsWith('//') ? `https:${finalUrl}` : finalUrl;
      const parsed = new URL(normalizedHref);
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) finalUrl = decodeURIComponent(uddg);
      if (finalUrl.startsWith('//')) finalUrl = `https:${finalUrl}`;
    } catch (_) {
      // ignore
    }
    return finalUrl;
  };

  // Robust extraction: pair title + snippet when possible
  const paired = html.matchAll(/class=['"]result__a['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>[\s\S]{0,2400}?class=['"]result__snippet['"][^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of paired) {
    if (results.length >= maxResults) break;
    const href = normalizeResultUrl(m[1] || '');
    const title = stripHtmlTags(m[2] || '');
    const snippet = stripHtmlTags(m[3] || '');
    if (!href || !title) continue;
    results.push({
      title: clipText(title, 160),
      url: clipText(href, 800),
      snippet: clipText(snippet, 360)
    });
  }

  // Fallback: title-only extraction
  if (results.length < maxResults) {
    const existing = new Set(results.map(r => r.url));
    const titlesOnly = html.matchAll(/class=['"]result__a['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi);
    for (const m of titlesOnly) {
      if (results.length >= maxResults) break;
      const href = normalizeResultUrl(m[1] || '');
      const title = stripHtmlTags(m[2] || '');
      if (!href || !title) continue;
      if (existing.has(href)) continue;
      existing.add(href);
      results.push({
        title: clipText(title, 160),
        url: clipText(href, 800),
        snippet: ''
      });
    }
  }
  return results;
}

function buildWebSearchMaterialText(query, results, locale = 'zh-CN') {
  const q = (query || '').toString().trim();
  const list = Array.isArray(results) ? results : [];
  const lines = [];
  lines.push(locale === 'en' ? `[Web search] ${q}` : `[网络搜索] ${q}`);
  if (!list.length) {
    lines.push(locale === 'en' ? '(No results)' : '（无结果）');
    return lines.join('\n');
  }
  list.slice(0, 10).forEach((r, idx) => {
    lines.push(`${idx + 1}. ${r.title}`);
    if (r.url) lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join('\n');
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
    const content = stripHtmlTags(board.nodes?.[node.id]?.content || '');
    return `${node.id}: ${clipText(content, 420)}`;
  }).join('\n');
  const currentNodeId = (board?.progress?.current_node_id || '').toString().trim();
  const currentNodeTitle = board?.outline?.find?.(n => String(n?.id || '') === currentNodeId)?.title || '';
  const currentNodeRaw = currentNodeId ? stripHtmlTags(board?.nodes?.[currentNodeId]?.content || '') : '';
  const currentNodeFull = currentNodeRaw ? clipText(currentNodeRaw, 1800) : '';
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

  const guide = board?.teaching_guide && typeof board.teaching_guide === 'object' ? board.teaching_guide : null;
  const clippedSources = buildClippedSourcesTextFromBoard(board, 5200);
  const guideOverview = clipText(guide?.overview, 360);
  const guideRules = Array.isArray(guide?.rules) ? guide.rules.map(r => clipText(r, 220)).filter(Boolean).slice(0, 8) : [];
  const guideScript = Array.isArray(guide?.teacher_script) ? guide.teacher_script.slice(0, 6) : [];
  const guideScriptText = guideScript.length
    ? guideScript.map((s) => {
      const focus = Array.isArray(s.focus_points) ? s.focus_points.filter(Boolean).slice(0, 4) : [];
      const qs = Array.isArray(s.questions) ? s.questions.filter(Boolean).slice(0, 2) : [];
      const header = locale === 'en' ? `Node ${s.node_id}` : `节点 ${s.node_id}`;
      return [
        `${header}`,
        ...(focus.length ? focus.map(x => `- ${x}`) : []),
        ...(qs.length ? qs.map(x => `${locale === 'en' ? 'Q:' : '问：'} ${x}`) : [])
      ].join('\n');
    }).join('\n\n')
    : '';

  if (locale === 'en') {
    return [
      'You are Blackboard AI Realtime Teaching Agent.',
      (Array.isArray(board?.pm_summary_bullets) && board.pm_summary_bullets.length)
        ? `PM summary (user goal & constraints):\n${board.pm_summary_bullets.map(x => `- ${x}`).join('\n')}`
        : '',
      board?.learning_spec ? `LearningSpec:\n${JSON.stringify(board.learning_spec)}` : '',
      `Learning goal: ${board.goal}`,
      `Current node: ${board.progress.current_node_id}`,
      (currentNodeFull ? `Current node content (latest, prioritize this):\n[${currentNodeId}] ${currentNodeTitle}\n${currentNodeFull}` : ''),
      `Board outline: ${outlineText}`,
      guideOverview ? `Teaching guide overview: ${guideOverview}` : '',
      'Hard rules:',
      '- You cannot change board structure or add/remove nodes.',
      '- If user wants structure changes, ask them to clarify so backend can update.',
      '- Every reply must start with [Node:<id>] from the board outline.',
      '- Teaching content must stay aligned with the current node.',
      '- You MAY quote from the Blackboard (current node content / board key points).',
      '- Attention constraint applies to external materials only: you MUST ONLY cite from the provided "Allowed Sources" when quoting the user\'s uploaded documents. If more context is needed, ask the user to select text and expand attention scope.',
      '- If the learner asks whether you can see their latest blackboard edits, answer clearly: yes, you can see the latest current node content provided above, then teach based on it.',
      '- Ask 1-3 short questions per turn (check understanding / guided practice).',
      '- Teaching style: do NOT read the board verbatim. Use it as outline, explain naturally.',
      '- Each turn focus on ONE key point: meaning/why, a tiny example or a step, then one short question.',
      '- If user is wrong: point out the issue, give a hint, let them retry (no full answer dump).',
      '- You may cite key formulas/keywords but avoid long verbatim board text.',
      '- Do NOT output LaTeX (no $$, \\(...\\), \\frac, \\int). Use plain-text math or Unicode symbols.',
      '- You MAY quote short sentences from "Allowed Sources" when needed (1-3 lines). Do NOT paste long passages or the entire document.',
      guideRules.length ? 'Teaching guide rules:' : '',
      guideRules.length ? guideRules.map(r => `- ${r}`).join('\n') : '',
      clippedSources ? 'Allowed Sources (ONLY cite these):' : '',
      clippedSources || '',
      guideScriptText ? 'Teaching script (follow but keep natural):' : '',
      guideScriptText || '',
      'Board key points (do not read verbatim):',
      nodeDetails,
      ...hiddenDraftBlock
    ].filter(Boolean).join('\n');
  }

  return [
    '你是 Blackboard AI 的 Realtime Teaching Agent。',
    (Array.isArray(board?.pm_summary_bullets) && board.pm_summary_bullets.length)
      ? `项目经理总结（用户目标与约束）：\n${board.pm_summary_bullets.map(x => `- ${x}`).join('\n')}`
      : '',
    board?.learning_spec ? `LearningSpec：\n${JSON.stringify(board.learning_spec)}` : '',
    `学习目标：${board.goal}`,
    `当前进度节点：${board.progress.current_node_id}`,
    (currentNodeFull ? `当前节点最新正文（优先参考这一段）：\n[${currentNodeId}] ${currentNodeTitle}\n${currentNodeFull}` : ''),
    `黑板结构：${outlineText}`,
    guideOverview ? `教案摘要：${guideOverview}` : '',
    '硬约束：',
    '- 你不能修改黑板结构，不能新增或删除节点。',
    '- 若用户想改结构，只能建议其明确表达，再由后端更新。',
    '- 每次回答必须以 [Node:<id>] 开头，且 id 必须来自黑板 outline。',
    '- 讲解内容必须引用对应节点，不得脱离黑板。',
    '- 你可以引用黑板内容（当前节点最新正文 / 黑板要点）。',
    '- 注意力约束只针对“材料/原文”：你只能引用“允许引用范围（Allowed Sources）”里的材料片段。若用户需要更多原文，请引导其在材料区框选并点击“增加讲师注意力篇幅”，下一轮才可引用新增片段。',
    '- 若学习者问“你能否看到我刚编辑/新增的黑板内容”，请明确回答：能看到（你已获得当前节点最新正文），然后围绕新增内容继续讲解。',
    '- 教学阶段每轮最多提出 1–3 个问题（用于检查理解/引导练习）。',
    '- 教学风格：不要逐字念板书。把板书当成“提纲”，用更口语、更解释性的方式讲清楚。',
    '- 每轮尽量只讲 1 个关键点：解释含义/为什么、给一个微型例子或一步推导/解题思路，然后提出 1 个简短问题等待用户回答。',
    '- 若用户回答不对：先指出错在何处，再给提示让他重试，而不是直接抛出完整答案。',
    '- 你可以引用板书中的关键公式/词汇，但不要大段复述板书正文。',
    '- 不要输出 LaTeX/公式源码（如 $$、\\(\\)、\\frac、\\int），用普通文本或 Unicode 数学符号表达。',
    '- 允许在需要时引用“允许引用范围（Allowed Sources）”内的短句（1–3 行），但禁止粘贴整段长文/全文。',
    guideRules.length ? '教案规则：' : '',
    guideRules.length ? guideRules.map(r => `- ${r}`).join('\n') : '',
    clippedSources ? '允许引用范围（只能引用以下材料片段）：' : '',
    clippedSources || '',
    guideScriptText ? '讲解脚本（按节点推进，保持自然口语）：' : '',
    guideScriptText || '',
    '黑板要点（不要逐字朗读，仅用于对齐讲解）：',
    nodeDetails,
    ...hiddenDraftBlock
  ].filter(Boolean).join('\n');
}

async function callTextTutorModel(userText, instructions = DEFAULT_INSTRUCTIONS) {
  const safeText = clipText(userText, 3000);
  if (!safeText) {
    throw new Error('用户输入为空');
  }

  const messages = [];
  // 板书课堂需要更长的系统指令（含当前节点正文、Allowed Sources 等）
  const safeInstructions = clipText(instructions, 12000);
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
    const supportsTemperature = !/^o\d/i.test(model) && !/^gpt-5/i.test(model);

    const finalOptions = {};
    Object.entries(restOptions).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (key === 'temperature' && !supportsTemperature) return;
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
    const supportsTemperature = !/^o\d/i.test(model) && !/^gpt-5/i.test(model);

    const finalOptions = {};
    Object.entries(restOptions).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (key === 'temperature' && !supportsTemperature) return;
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

async function generateBoard(goal, locale = 'zh-CN', modelOverride = null) {
  const fallback = buildFallbackBoard(goal, locale);
  if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) return fallback;

  const spec = parseGoalSpec(goal, locale);
  const domain = inferBoardDomain(goal, locale);
  const boardModel = clipText(modelOverride, 80) || OPENAI_STRUCTURE_MODEL;
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
      model: boardModel,
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
        model: boardModel,
        temperature: 0.15
      });
      const raw2 = result2.raw;
      modelUsed = result2.model;
      fallbackUsed = fallbackUsed || result2.fallback;
      fallbackError = fallbackError || result2.error;
      const board = normalizeBoardPayload(raw2, goal, locale);
      board.meta.source = OPENAI_API_KEY ? modelUsed : OPENROUTER_STRUCTURE_MODEL;
      if (fallbackUsed && OPENAI_API_KEY) {
        board.meta.fallback_from = boardModel;
        if (fallbackError) board.meta.fallback_reason = clipText(fallbackError, 240);
      }
      board.meta.regenerated = true;
      return board;
    }
    const board = normalizeBoardPayload(raw1, goal, locale);
    board.meta.source = OPENAI_API_KEY ? modelUsed : OPENROUTER_STRUCTURE_MODEL;
    if (fallbackUsed && OPENAI_API_KEY) {
      board.meta.fallback_from = boardModel;
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

  // Prefer appending exercises/examples to current node
  if (/例题|练习|题目|出题|做几道|再来几道|quiz|exercise|problems?/.test(text)) {
    const seed = clipText(userInput, 320);
    ops.push({ op: 'append_examples', node_id: currentNodeId, examples: [seed] });
    return { operations: ops, rationale: locale === 'en' ? 'User requests more exercises; append to current node examples.' : '用户要求补充例题/练习，追加到当前节点示例中。' };
  }

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
      const hasExamples = Object.prototype.hasOwnProperty.call(obj, 'examples');
      return {
        op: clipText(obj?.op, 40),
        node_id: clipText(obj?.node_id, 20),
        title: hasTitle ? clipText(obj?.title, 80) : undefined,
        content: hasContent ? clipText(obj?.content, 6000) : undefined,
        examples: hasExamples && Array.isArray(obj?.examples)
          ? obj.examples.map(x => clipText(x, 1200)).filter(Boolean).slice(0, 12)
          : undefined,
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
    {"op":"add_node|update_node|append_examples|remove_node|set_status|set_current_node","node_id":"string","title":"string","content":"string","examples":["string"],"status":"pending|teaching|done|skipped"}
  ]
}
Rules:
- Minimal operations, no unrelated nodes.
- Never rewrite the whole board. Prefer small incremental edits to the CURRENT board.
- Do NOT use remove_node unless the user explicitly asks to delete something.
- When user asks for more exercises/examples, use append_examples on the most relevant node (usually current node).
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
    {"op":"add_node|update_node|append_examples|remove_node|set_status|set_current_node","node_id":"string","title":"string","content":"string","examples":["string"],"status":"pending|teaching|done|skipped"}
  ]
}
规则：
- 尽量最少操作，不引入无关节点。
- 严禁“整板重写/看起来像新生成一张板书”：必须在【当前板书】基础上做增量修改。
- 除非用户明确要求删除，否则不要使用 remove_node。
- 当用户要“再出几道例题/练习/题目”：优先对最相关节点（通常是当前节点）使用 append_examples 追加题目，而不是重写正文。
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
      if (Array.isArray(op.examples)) {
        next.nodes[op.node_id].examples = op.examples.slice(0, 40);
      }
      if (op.title) outlineById.get(op.node_id).title = op.title;
      applied.push(op);
      return;
    }

    if (op.op === 'append_examples') {
      if (!outlineById.has(op.node_id)) return;
      if (!next.nodes[op.node_id]) next.nodes[op.node_id] = { content: '', examples: [] };
      if (!Array.isArray(next.nodes[op.node_id].examples)) next.nodes[op.node_id].examples = [];
      const incoming = Array.isArray(op.examples) ? op.examples : [];
      const merged = [...next.nodes[op.node_id].examples, ...incoming]
        .map(x => (x ?? '').toString().trim())
        .filter(Boolean);
      // dedupe + cap
      const seen = new Set();
      const deduped = [];
      for (const item of merged) {
        const key = item.slice(0, 260);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
        if (deduped.length >= 40) break;
      }
      next.nodes[op.node_id].examples = deduped;
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
    meta: board.meta,
    attention_scope: board.attention_scope || null,
    teaching_guide_overview: clipText(board?.teaching_guide?.overview, 420) || '',
    pm_summary_bullets: Array.isArray(board?.pm_summary_bullets) ? board.pm_summary_bullets : [],
    learning_spec: board?.learning_spec || null,
    sources: Array.isArray(board?.sources)
      ? board.sources.map(s => ({ source_id: s.source_id, title: s.title }))
      : []
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

  if (req.method === 'POST' && url.pathname === '/import-board') {
    const body = await parseBody(req);
    const incoming = body.board && typeof body.board === 'object' ? body.board : null;
    if (!incoming) {
      sendJson(res, 400, { ok: false, message: 'board 必填' });
      return;
    }
    const boardId = clipText(incoming.board_id || body.board_id, 80);
    if (!boardId) {
      sendJson(res, 400, { ok: false, message: 'board_id 必填' });
      return;
    }
    const outline = Array.isArray(incoming.outline) ? incoming.outline : [];
    const nodes = (incoming.nodes && typeof incoming.nodes === 'object') ? incoming.nodes : {};
    const progress = (incoming.progress && typeof incoming.progress === 'object') ? incoming.progress : {};
    if (!outline.length || !Object.keys(nodes).length) {
      sendJson(res, 400, { ok: false, message: 'board 数据不完整（outline/nodes）' });
      return;
    }
    const imported = {
      ...incoming,
      board_id: boardId,
      outline,
      nodes,
      progress: {
        current_node_id: clipText(progress.current_node_id || outline[0]?.id || '', 40) || (outline[0]?.id || ''),
        mastery_score: Number.isFinite(Number(progress.mastery_score)) ? Number(progress.mastery_score) : 0
      },
      meta: (incoming.meta && typeof incoming.meta === 'object') ? { ...incoming.meta } : {}
    };
    imported.meta.updated_at = new Date().toISOString();
    imported.meta.imported_from_client = true;
    BOARD_STORE.set(boardId, imported);
    BOARD_AUDIT_LOG.push({
      ts: new Date().toISOString(),
      type: 'import_board',
      source: 'client_snapshot',
      board_id: boardId,
      goal: clipText(imported.goal || '', 120)
    });
    sendJson(res, 200, { ok: true, board: toPublicBoard(imported) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/create-board') {
    const body = await parseBody(req);
    // 允许更长的澄清信息（学习目标 + 水平 + 约束），避免过早截断影响板书生成质量
    const goal = clipText(body.goal || body.user_input, 2400);
    const rawSources = body.sources || body.source || body.materials || null;
    const pmSummaryBullets = Array.isArray(body.pm_summary_bullets) ? body.pm_summary_bullets : [];
    const learningSpec = body.learning_spec && typeof body.learning_spec === 'object' ? body.learning_spec : null;
    const bodyLocale = body.locale === 'en' ? 'en' : locale;
    if (!goal) {
      sendJson(res, 400, { ok: false, message: 'goal 不能为空' });
      return;
    }
    const { sources: normalizedSources, chunks } = buildSourceChunks(rawSources, bodyLocale);
    const rawSubjectType = (learningSpec?.subject_type || body.subject_type || '').toString().trim().toLowerCase();
    const subjectType = (rawSubjectType === 'science' || rawSubjectType === 'humanities' || rawSubjectType === 'mixed')
      ? rawSubjectType
      : '';
    const boardModel = subjectType === 'science'
      ? OPENAI_BOARD_MODEL_SCIENCE
      : (subjectType === 'humanities' || subjectType === 'mixed')
        ? OPENAI_BOARD_MODEL_HUMANITIES
        : null;
    const board = await generateBoard(goal, bodyLocale, boardModel);
    const hiddenDraft = await generateHiddenDraft(board, bodyLocale);
    if (hiddenDraft) {
      board.hidden_draft = hiddenDraft;
    }
    board.sources = normalizedSources;
    board.sources_chunks = chunks;
    board.pm_summary_bullets = pmSummaryBullets
      .map(x => clipText(x, 200))
      .filter(Boolean)
      .slice(0, 10);
    board.learning_spec = learningSpec;
    board.meta = board.meta || {};
    if (subjectType) board.meta.pm_subject_type = subjectType;
    if (boardModel) board.meta.board_model_routed = boardModel;
    const selected = await selectInitialAttentionChunks(goal, chunks, bodyLocale);
    const allowedChunkIds = Array.isArray(selected?.chunk_ids) ? selected.chunk_ids : [];
    board.attention_scope = {
      version: 1,
      created_at: new Date().toISOString(),
      rationale: clipText(selected?.rationale, 240),
      allowed_chunk_ids: allowedChunkIds,
      extra_snippets: []
    };
    board.teaching_guide = await generateTeachingGuide(goal, board, chunks, allowedChunkIds, bodyLocale);
    BOARD_STORE.set(board.board_id, board);
    BOARD_AUDIT_LOG.push({
      ts: new Date().toISOString(),
      type: 'create_board',
      source: 'user_input',
      board_id: board.board_id,
      goal: clipText(goal, 120)
    });
    sendJson(res, 200, {
      ok: true,
      board: toPublicBoard(board),
      teaching_guide: board.teaching_guide,
      attention_scope: board.attention_scope
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/vision-extract') {
    const body = await parseBody(req);
    const imageBase64 = body.image_base64 || body.image || '';
    const mime = clipText(body.mime || body.mime_type || body.type, 80) || 'image/png';
    const filename = clipText(body.filename || body.name, 160) || '';
    const bodyLocale = body.locale === 'en' ? 'en' : locale;
    if (!imageBase64) {
      sendJson(res, 400, { ok: false, message: 'image_base64 必填' });
      return;
    }
    try {
      const result = await extractTextFromImage(imageBase64, mime, filename, bodyLocale);
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      console.error('vision-extract failed:', error);
      sendJson(res, 502, { ok: false, message: `图片识别失败: ${error.message}` });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/web-search') {
    const body = await parseBody(req);
    const query = clipText(body.query || body.q, 300) || '';
    const maxResults = Number.isFinite(Number(body.max_results)) ? Math.max(1, Math.min(10, Number(body.max_results))) : 6;
    const bodyLocale = body.locale === 'en' ? 'en' : locale;
    if (!query) {
      sendJson(res, 400, { ok: false, message: 'query 必填' });
      return;
    }
    try {
      let results = [];
      if (WEB_SEARCH_PROVIDER === 'duckduckgo') {
        results = await webSearchDuckDuckGoHtml(query, maxResults);
      } else {
        results = await webSearchDuckDuckGoHtml(query, maxResults);
      }
      const material_text = buildWebSearchMaterialText(query, results, bodyLocale);
      sendJson(res, 200, { ok: true, provider: WEB_SEARCH_PROVIDER, query, results, material_text });
    } catch (error) {
      console.error('web-search failed:', error);
      sendJson(res, 502, { ok: false, message: `网络搜索失败: ${error.message}` });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pm-analyze') {
    const body = await parseBody(req);
    const userText = clipText(body.user_text || body.text || body.user_input, 3000);
    const bodyLocale = body.locale === 'en' ? 'en' : locale;
    const previousSpec = (body.previous_spec && typeof body.previous_spec === 'object') ? body.previous_spec : null;
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!userText) {
      sendJson(res, 400, { ok: false, message: 'user_text 必填' });
      return;
    }
    try {
      const result = await analyzePmLearningSpec(userText, attachments, previousSpec, bodyLocale);
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      console.error('pm-analyze failed:', error);
      sendJson(res, 502, { ok: false, message: `PM 分析失败: ${error.message}` });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/update-attention-scope') {
    const body = await parseBody(req);
    const boardId = clipText(body.board_id, 80);
    const snippet = clipText(body.snippet || body.text, 6000);
    const sourceId = clipText(body.source_id, 80) || 'user_selection';
    const bodyLocale = body.locale === 'en' ? 'en' : locale;
    if (!boardId || !snippet) {
      sendJson(res, 400, { ok: false, message: 'board_id 与 snippet 必填' });
      return;
    }
    const board = BOARD_STORE.get(boardId);
    if (!board) {
      sendJson(res, 404, { ok: false, message: 'board 不存在' });
      return;
    }
    if (!board.attention_scope || typeof board.attention_scope !== 'object') {
      board.attention_scope = { version: 1, created_at: new Date().toISOString(), rationale: '', allowed_chunk_ids: [], extra_snippets: [] };
    }
    const id = `sel_${crypto.randomUUID()}`;
    const extra = Array.isArray(board.attention_scope.extra_snippets) ? board.attention_scope.extra_snippets : [];
    extra.push({
      id,
      source_id: sourceId,
      text: snippet,
      created_at: new Date().toISOString()
    });
    // 去重：完全相同 snippet 不重复加入
    const deduped = [];
    const seen = new Set();
    extra.forEach((item) => {
      const key = `${item?.source_id || ''}::${(item?.text || '').toString().trim()}`;
      if (!key.trim()) return;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(item);
    });
    board.attention_scope.extra_snippets = deduped.slice(-18);

    if (body.regenerate_guide === true) {
      const allowed = Array.isArray(board.attention_scope.allowed_chunk_ids) ? board.attention_scope.allowed_chunk_ids : [];
      board.teaching_guide = await generateTeachingGuide(board.goal || '', board, board.sources_chunks || [], allowed, bodyLocale);
    }
    if (!board.meta || typeof board.meta !== 'object') board.meta = {};
    board.meta.updated_at = new Date().toISOString();
    BOARD_STORE.set(boardId, board);
    BOARD_AUDIT_LOG.push({
      ts: new Date().toISOString(),
      type: 'update_attention_scope',
      board_id: boardId,
      source_id: sourceId,
      snippet_len: snippet.length
    });
    sendJson(res, 200, {
      ok: true,
      board: toPublicBoard(board),
      attention_scope: board.attention_scope,
      teaching_guide: board.teaching_guide
    });
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
          const safeInstructions = clipText(instructions, 12000);
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
              const safeInstructions = clipText(sessionConfig.instructions || DEFAULT_INSTRUCTIONS, 12000);
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
