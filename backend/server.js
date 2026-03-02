// 实时语音对话后端服务器
// EN: Backend server for realtime voice/text dialogue
// 使用 Node.js + WebSocket + AI 模型调用
// EN: Uses Node.js + WebSocket + model provider calls

/*
EN GLOSSARY (Chinese strings used in this file, for handoff only)
- "已加载 .env 文件" => ".env file loaded"
- "需要Node.js 18+或安装node-fetch" => "Need Node.js 18+ or install node-fetch"
- "语言学习专用的系统提示词" => "System prompt for language learning tutor"
- "请用中文回复（除非用户明确要求用其他语言）。" => "Reply in Chinese unless the user explicitly requests another language."
- "未配置 ... API Key" => "... API key not configured"
- "请求过于频繁，请稍后再试" => "Too many requests; please try again later"
- "网络连接失败，请检查网络后重试。" => "Network connection failed; check network and retry."
- "连接成功，可以开始对话了" => "Connected. You can start chatting."
- "模型配置已更新" => "Model config updated."
- "处理消息时发生错误" => "Error while processing message."
- "正在关闭服务器..." / "服务器已关闭" => "Shutting down..." / "Server closed."
*/

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 检查Node.js版本，如果<18需要node-fetch
let fetch;
if (typeof globalThis.fetch === 'function') {
  // Node.js 18+ 内置fetch
  fetch = globalThis.fetch;
} else {
  // Node.js <18 需要使用node-fetch
  try {
    fetch = require('node-fetch');
  } catch (e) {
    console.error('❌ 需要Node.js 18+或安装node-fetch: npm install node-fetch@2');
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

function normalizeApiBase(apiBase) {
  const trimmed = (apiBase || '').trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

// WebSocket 服务器配置
const PORT = 3001;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// 会话管理
const sessions = new Map();

// ==================== AI 模型调用接口 ====================
// API 配置

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_BASE = normalizeApiBase(process.env.OPENAI_API_BASE || 'https://api.openai.com');
const OPENAI_API_URL = `${OPENAI_API_BASE}/v1/chat/completions`;

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1';

// 语言学习专用的系统提示词
// EN: System prompt used for the language tutor behavior (kept in Chinese by default).
const SYSTEM_PROMPT = `你是一位专业、友好、耐心的AI语言学习导师。你的任务是帮助用户练习外语对话。

请遵循以下原则：
1. 用友好、鼓励的语气回复，营造轻松的学习氛围
2. 当用户有语法错误时，温和地指出并给出正确表达
3. 适当扩展话题，引导用户多说多练
4. 回复要简洁自然，不要太长（建议50-150字）
5. 根据用户的水平调整语言难度
6. 可以适当提问，鼓励用户继续对话

请用中文回复（除非用户明确要求用其他语言）。`;

async function callAIModel(userMessage, conversationHistory = [], modelConfig = {}) {
  const provider = modelConfig.provider || 'openai';
  const model = modelConfig.model || 'gpt-4o-mini';
  const apiKey = modelConfig.apiKey;

  if (provider === 'aliyun') {
    return await callAliyunModel(userMessage, conversationHistory, model, apiKey);
  } else if (provider === 'deepseek') {
    return await callDeepSeekModel(userMessage, conversationHistory, model, apiKey);
  } else if (provider === 'google') {
    return await callGoogleModel(userMessage, conversationHistory, model, apiKey);
  } else {
    return await callOpenAIModel(userMessage, conversationHistory, model, apiKey);
  }
}

async function callOpenAIModel(userMessage, conversationHistory = [], model = 'gpt-4o-mini', apiKey = null) {
  try {
    // 构建消息列表（包含系统提示词）
    const messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      // 转换会话历史格式（从我们的格式转为API格式）
      ...conversationHistory.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      })),
      {
        role: 'user',
        content: userMessage
      }
    ];

    const finalApiKey = apiKey || OPENAI_API_KEY;
    if (!finalApiKey) {
      throw new Error('未配置 OpenAI API Key，请在 backend/.env 中设置 OPENAI_API_KEY');
    }
    console.log(`📤 调用 OpenAI API (${model})，消息数量: ${messages.length}`);
    console.log(`📝 用户消息: ${userMessage.substring(0, 50)}...`);

    // 调用 OpenAI Chat Completions API
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalApiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,      // 创造性（0-1，0.7比较平衡）
        max_tokens: 500,       // 最大回复长度
        top_p: 0.8,            // 核采样参数
        frequency_penalty: 0.1, // 频率惩罚（避免重复）
        presence_penalty: 0.1  // 存在惩罚（鼓励新话题）
      })
    });

    // 检查响应状态
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('OpenAI API调用失败:', response.status, errorData);
      
      if (response.status === 401) {
        throw new Error('API密钥验证失败，请检查API密钥是否正确');
      } else if (response.status === 429) {
        throw new Error('请求过于频繁，请稍后再试');
      } else if (response.status === 500) {
        throw new Error('OpenAI服务器错误，请稍后再试');
      } else {
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`);
      }
    }

    // 解析响应
    const data = await response.json();
    
    // 检查API返回的错误
    if (data.error) {
      console.error('OpenAI API返回错误:', data.error);
      throw new Error(data.error.message || 'API返回错误');
    }

    // 提取回复文本
    const aiResponse = data.choices?.[0]?.message?.content;
    
    if (!aiResponse) {
      console.error('无法从API响应中提取文本:', data);
      throw new Error('API响应格式异常');
    }

    console.log('✅ OpenAI回复成功，长度:', aiResponse.length);
    return aiResponse.trim();
    
  } catch (error) {
    console.error('AI模型调用错误:', error);
    
    // 根据错误类型返回不同的提示
    if (error.message.includes('401') || error.message.includes('API密钥')) {
      return '抱歉，API密钥验证失败。请检查API密钥是否正确。';
    } else if (error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('频繁')) {
      return '请求过于频繁，请稍后再试。';
    } else if (error.message.includes('network') || error.message.includes('fetch') || error.message.includes('连接')) {
      return '网络连接失败，请检查网络后重试。';
    } else {
      return `抱歉，AI服务暂时不可用：${error.message}。请稍后再试。`;
    }
  }
}

async function callAliyunModel(userMessage, conversationHistory = [], model = 'qwen-turbo', apiKey = null) {
  try {
    // 构建消息列表（包含系统提示词）
    const messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      // 转换会话历史格式（从我们的格式转为API格式）
      ...conversationHistory.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      })),
      {
        role: 'user',
        content: userMessage
      }
    ];

    const finalApiKey = apiKey || DASHSCOPE_API_KEY;
    if (!finalApiKey) {
      throw new Error('未配置 阿里云 API Key，请在 backend/.env 中设置 DASHSCOPE_API_KEY');
    }
    console.log(`📤 调用 阿里云通义千问 API (${model})，消息数量: ${messages.length}`);
    console.log(`📝 用户消息: ${userMessage.substring(0, 50)}...`);

    // 调用阿里云 DashScope API
    const response = await fetch(DASHSCOPE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalApiKey}`
      },
      body: JSON.stringify({
        model: model,
        input: { messages: messages },
        parameters: {
          temperature: 0.7,
          max_tokens: 500,
          top_p: 0.8,
          repetition_penalty: 1.1
        }
      })
    });

    // 检查响应状态
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('阿里云 API调用失败:', response.status, errorData);
      
      if (response.status === 401) {
        throw new Error('API密钥验证失败，请检查API密钥是否正确');
      } else if (response.status === 429) {
        throw new Error('请求过于频繁，请稍后再试');
      } else if (response.status === 500) {
        throw new Error('阿里云服务器错误，请稍后再试');
      } else {
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`);
      }
    }

    // 解析响应
    const data = await response.json();
    
    // 检查API返回的错误
    if (data.code && data.code !== 'Success') {
      console.error('阿里云 API返回错误:', data);
      throw new Error(data.message || 'API返回错误');
    }

    // 提取回复文本（阿里云格式不同）
    const aiResponse = data.output?.choices?.[0]?.message?.content || data.output?.text;
    
    if (!aiResponse) {
      console.error('无法从API响应中提取文本:', data);
      throw new Error('API响应格式异常');
    }

    console.log('✅ 阿里云回复成功，长度:', aiResponse.length);
    return aiResponse.trim();
    
  } catch (error) {
    console.error('AI模型调用错误:', error);
    
    // 根据错误类型返回不同的提示
    if (error.message.includes('401') || error.message.includes('API密钥')) {
      return '抱歉，API密钥验证失败。请检查API密钥是否正确。';
    } else if (error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('频繁')) {
      return '请求过于频繁，请稍后再试。';
    } else if (error.message.includes('network') || error.message.includes('fetch') || error.message.includes('连接')) {
      return '网络连接失败，请检查网络后重试。';
    } else {
      return `抱歉，AI服务暂时不可用：${error.message}。请稍后再试。`;
    }
  }
}

async function callDeepSeekModel(userMessage, conversationHistory = [], model = 'deepseek-chat', apiKey = null) {
  try {
    // 构建消息列表（包含系统提示词）
    const messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      // 转换会话历史格式（从我们的格式转为API格式）
      ...conversationHistory.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      })),
      {
        role: 'user',
        content: userMessage
      }
    ];

    const finalApiKey = apiKey || DEEPSEEK_API_KEY;
    if (!finalApiKey) {
      throw new Error('未配置 DeepSeek API Key，请在 backend/.env 中设置 DEEPSEEK_API_KEY');
    }
    console.log(`📤 调用 DeepSeek API (${model})，消息数量: ${messages.length}`);
    console.log(`📝 用户消息: ${userMessage.substring(0, 50)}...`);

    // 调用 DeepSeek Chat Completions API（格式与 OpenAI 相同）
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalApiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,      // 创造性（0-1，0.7比较平衡）
        max_tokens: 500,       // 最大回复长度
        top_p: 0.8,            // 核采样参数
        frequency_penalty: 0.1, // 频率惩罚（避免重复）
        presence_penalty: 0.1  // 存在惩罚（鼓励新话题）
      })
    });

    // 检查响应状态
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('DeepSeek API调用失败:', response.status, errorData);
      
      if (response.status === 401) {
        throw new Error('API密钥验证失败，请检查API密钥是否正确');
      } else if (response.status === 429) {
        throw new Error('请求过于频繁，请稍后再试');
      } else if (response.status === 500) {
        throw new Error('DeepSeek服务器错误，请稍后再试');
      } else {
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`);
      }
    }

    // 解析响应
    const data = await response.json();
    
    // 检查API返回的错误
    if (data.error) {
      console.error('DeepSeek API返回错误:', data.error);
      throw new Error(data.error.message || 'API返回错误');
    }

    // 提取回复文本
    const aiResponse = data.choices?.[0]?.message?.content;
    
    if (!aiResponse) {
      console.error('无法从API响应中提取文本:', data);
      throw new Error('API响应格式异常');
    }

    console.log('✅ DeepSeek回复成功，长度:', aiResponse.length);
    return aiResponse.trim();
    
  } catch (error) {
    console.error('AI模型调用错误:', error);
    
    // 根据错误类型返回不同的提示
    if (error.message.includes('401') || error.message.includes('API密钥')) {
      return '抱歉，API密钥验证失败。请检查API密钥是否正确。';
    } else if (error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('频繁')) {
      return '请求过于频繁，请稍后再试。';
    } else if (error.message.includes('network') || error.message.includes('fetch') || error.message.includes('连接')) {
      return '网络连接失败，请检查网络后重试。';
    } else {
      return `抱歉，AI服务暂时不可用：${error.message}。请稍后再试。`;
    }
  }
}

async function callGoogleModel(userMessage, conversationHistory = [], model = 'gemini-pro', apiKey = null) {
  try {
    const finalApiKey = apiKey || GOOGLE_API_KEY;
    if (!finalApiKey) {
      throw new Error('未配置 Google API Key，请在 backend/.env 中设置 GOOGLE_API_KEY');
    }
    console.log(`📤 调用 Google Gemini API (${model})，消息数量: ${conversationHistory.length + 1}`);
    console.log(`📝 用户消息: ${userMessage.substring(0, 50)}...`);

    // Google Gemini API 格式：需要将对话历史转换为 parts 格式
    // 构建消息内容（Gemini 使用 parts 数组）
    const contents = [];
    
    // 转换会话历史
    for (const msg of conversationHistory) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }
    // 添加当前用户消息
    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    // Google Gemini API 端点
    const apiUrl = `${GOOGLE_API_BASE_URL}/models/${model}:generateContent?key=${finalApiKey}`;

    // 构建请求体（使用 systemInstruction 字段设置系统提示词）
    const requestBody = {
      contents: contents,
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500,
        topP: 0.8,
        topK: 40
      }
    };

    // 调用 Google Gemini API
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    // 检查响应状态
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Google Gemini API调用失败:', response.status, errorData);
      
      if (response.status === 401 || response.status === 403) {
        throw new Error('API密钥验证失败，请检查API密钥是否正确');
      } else if (response.status === 429) {
        throw new Error('请求过于频繁，请稍后再试');
      } else if (response.status === 500) {
        throw new Error('Google服务器错误，请稍后再试');
      } else {
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`);
      }
    }

    // 解析响应
    const data = await response.json();
    
    // 检查API返回的错误
    if (data.error) {
      console.error('Google Gemini API返回错误:', data.error);
      throw new Error(data.error.message || 'API返回错误');
    }

    // 提取回复文本（Gemini 格式不同）
    const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!aiResponse) {
      console.error('无法从API响应中提取文本:', data);
      throw new Error('API响应格式异常');
    }

    console.log('✅ Google Gemini回复成功，长度:', aiResponse.length);
    return aiResponse.trim();
    
  } catch (error) {
    console.error('AI模型调用错误:', error);
    
    // 根据错误类型返回不同的提示
    if (error.message.includes('401') || error.message.includes('403') || error.message.includes('API密钥')) {
      return '抱歉，API密钥验证失败。请检查API密钥是否正确。';
    } else if (error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('频繁')) {
      return '请求过于频繁，请稍后再试。';
    } else if (error.message.includes('network') || error.message.includes('fetch') || error.message.includes('连接')) {
      return '网络连接失败，请检查网络后重试。';
    } else {
      return `抱歉，AI服务暂时不可用：${error.message}。请稍后再试。`;
    }
  }
}

// ==================== WebSocket 连接处理 ====================

wss.on('connection', (ws, req) => {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const session = {
    id: sessionId,
    ws: ws,
    conversationHistory: [],
    createdAt: new Date(),
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: null
    }
  };
  
  sessions.set(sessionId, session);
  console.log(`新连接: ${sessionId}`);
  
  // 发送连接成功消息
  ws.send(JSON.stringify({
    type: 'connected',
    sessionId: sessionId,
    message: '连接成功，可以开始对话了'
  }));
  
  // 接收消息
  let isProcessing = false; // 防止并发处理
  let lastProcessTime = 0; // 上次处理时间
  const PROCESS_COOLDOWN = 1000; // 处理冷却时间（1秒）
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      if (data.type === 'user_message') {
        // 防止频繁请求
        const now = Date.now();
        if (isProcessing) {
          console.log(`[${sessionId}] ⚠️ 正在处理上一条消息，忽略重复请求`);
          return;
        }
        
        if (now - lastProcessTime < PROCESS_COOLDOWN) {
          console.log(`[${sessionId}] ⚠️ 请求过于频繁，忽略（距离上次请求 ${now - lastProcessTime}ms）`);
          ws.send(JSON.stringify({
            type: 'error',
            message: '请求过于频繁，请稍后再试'
          }));
          return;
        }
        
        isProcessing = true;
        lastProcessTime = now;
        
        const userText = data.text;
        console.log(`[${sessionId}] 用户说: ${userText}`);
        
        // 添加到会话历史
        session.conversationHistory.push({
          role: 'user',
          content: userText,
          timestamp: data.timestamp
        });
        
        // 调用AI模型（使用会话的模型配置）
        const aiResponse = await callAIModel(userText, session.conversationHistory, session.modelConfig);
        
        // 添加到会话历史
        session.conversationHistory.push({
          role: 'assistant',
          content: aiResponse,
          timestamp: new Date().toISOString()
        });
        
        // 发送AI回复
        ws.send(JSON.stringify({
          type: 'ai_message',
          text: aiResponse,
          timestamp: new Date().toISOString()
        }));
        
        console.log(`[${sessionId}] AI回复: ${aiResponse}`);
        isProcessing = false;
      } else if (data.type === 'update_model') {
        // 更新模型配置
        if (data.provider) session.modelConfig.provider = data.provider;
        if (data.model) session.modelConfig.model = data.model;
        if (data.apiKey !== undefined) session.modelConfig.apiKey = data.apiKey || null;
        
        console.log(`[${sessionId}] 模型配置已更新:`, session.modelConfig);
        
        // 确认更新
        ws.send(JSON.stringify({
          type: 'model_updated',
          modelConfig: session.modelConfig,
          message: '模型配置已更新'
        }));
      }
      
    } catch (error) {
      console.error('处理消息错误:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: '处理消息时发生错误'
      }));
    }
  });
  
  // 连接关闭
  ws.on('close', () => {
    console.log(`连接关闭: ${sessionId}`);
    sessions.delete(sessionId);
  });
  
  // 错误处理
  ws.on('error', (error) => {
    console.error(`WebSocket错误 [${sessionId}]:`, error);
  });
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`✅ WebSocket服务器运行在 ws://localhost:${PORT}`);
  console.log(`📝 请在前端代码中将 wsUrl 设置为: ws://localhost:${PORT}`);
  console.log(`🤖 AI模型: OpenAI GPT-4o-mini`);
  console.log(`🔑 API提供商: OpenAI (https://api.openai.com)`);
  console.log(`📊 系统提示词已加载，准备接收消息...`);
});

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
