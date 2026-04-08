/**
 * 企微智能机器人 WebSocket 长连接客户端（多群版）
 *
 * 架构：
 *   1. 支持多个机器人，每个机器人各建一条 WebSocket 长连接
 *   2. HTTP 服务监听 4001 端口，供 index.js 调用 POST /send 来触发推送
 *   3. 推送支持：指定群发 / 广播所有群
 *   4. 收到群消息时自动记录 CHAT_ID
 *
 * 配置方式：
 *   环境变量 BOTS=JSON数组 或 BOT_ID+BOT_SECRET（兼容单机器人旧配置）
 *
 * 启动方式：
 *   BOTS='[{"bot_id":"aib...","secret":"xxx","chat_id":"wrk...","name":"主群"}]' node aibot-client.js
 *   或 BOT_ID=xxx BOT_SECRET=xxx CHAT_ID=xxx node aibot-client.js（向下兼容）
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== 加载 .env（手动解析，不依赖 dotenv 模块） ==========
(function loadEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
    '/root/api-server/.env'
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();
        process.env[key] = val; // .env 为准，覆盖 PM2 ecosystem 注入的值
      }
      console.log(`[env] 已加载 ${envPath}`);
      return;
    }
  }
  console.log('[env] 未找到 .env 文件，使用系统环境变量');
})();


// ========== CHAT_ID 持久化 ==========
const CHAT_IDS_FILE = path.join(__dirname, 'chat_ids.json');

// ========== 多机器人配置 ==========
const CHAT_TYPE  = parseInt(process.env.CHAT_TYPE || '2');
const HTTP_PORT  = parseInt(process.env.AIBOT_HTTP_PORT || '4001');
const WS_URL = 'wss://openws.work.weixin.qq.com';

// 解析机器人列表：优先用 BOTS 环境变量（JSON数组），否则用旧的单机器人配置
let botConfigs = [];
if (process.env.BOTS) {
  try {
    botConfigs = JSON.parse(process.env.BOTS);
  } catch (e) {
    console.error('BOTS 环境变量 JSON 解析失败:', e.message);
  }
}
if (botConfigs.length === 0 && process.env.BOT_ID) {
  // 向下兼容：单机器人配置
  botConfigs.push({
    bot_id: process.env.BOT_ID,
    secret: process.env.BOT_SECRET || '',
    chat_id: process.env.CHAT_ID || '',
    name: '默认群'
  });
}

// ========== 多连接状态管理 ==========
// bots Map: bot_id => { config, ws, isAuthenticated, reconnectDelay, pendingQueue, uploadCallbacks, chatIds }
const bots = new Map();
const MAX_RECONNECT_DELAY = 60000;

// ========== 日志 ==========
function log(level, msg, data) {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}][${level}] ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}][${level}] ${msg}`);
  }
}

// ========== 生成 req_id ==========
function genReqId() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

// ========== CHAT_ID 持久化读写 ==========
function loadPersistedChatIds() {
  try {
    if (fs.existsSync(CHAT_IDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHAT_IDS_FILE, 'utf-8'));
      log('INFO', `从 ${CHAT_IDS_FILE} 恢复 CHAT_ID 缓存`, data);
      return data; // { botId: [chatid1, chatid2, ...] }
    }
  } catch (e) {
    log('WARN', `读取 CHAT_ID 缓存失败: ${e.message}`);
  }
  return {};
}

function savePersistedChatIds() {
  const data = {};
  for (const [botId, bot] of bots) {
    data[botId] = [...bot.chatIds];
  }
  try {
    fs.writeFileSync(CHAT_IDS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    log('INFO', `CHAT_ID 已持久化到 ${CHAT_IDS_FILE}`);
  } catch (e) {
    log('ERROR', `持久化 CHAT_ID 失败: ${e.message}`);
  }
}

// ========== 初始化所有机器人 ==========
function initBots() {
  if (botConfigs.length === 0) {
    log('ERROR', '未配置任何机器人！请设置 BOTS 或 BOT_ID 环境变量');
    return;
  }

  // 先加载持久化的 CHAT_ID
  const persisted = loadPersistedChatIds();

  for (const cfg of botConfigs) {
    const bot = {
      config: cfg,
      ws: null,
      isAuthenticated: false,
      reconnectDelay: 2000,
      pendingQueue: [],
      uploadCallbacks: {},
      chatIds: new Set()  // 自动收集该机器人所在群的 CHAT_ID
    };
    // 如果配置了初始 chat_id，加入集合
    if (cfg.chat_id) bot.chatIds.add(cfg.chat_id);
    // 恢复持久化的 CHAT_ID
    if (persisted[cfg.bot_id]) {
      for (const cid of persisted[cfg.bot_id]) {
        bot.chatIds.add(cid);
      }
      log('INFO', `[${cfg.name || cfg.bot_id}] 从缓存恢复 ${persisted[cfg.bot_id].length} 个 CHAT_ID`);
    }
    bots.set(cfg.bot_id, bot);
    connectBot(cfg.bot_id);
  }

  log('INFO', `已初始化 ${botConfigs.length} 个机器人连接`);
}

// ========== 单个机器人 WebSocket 连接 ==========
function connectBot(botId) {
  const bot = bots.get(botId);
  if (!bot) return;
  const cfg = bot.config;

  if (!cfg.bot_id) {
    log('ERROR', `机器人 ${cfg.name || botId} 未配置 bot_id`);
    return;
  }

  log('INFO', `[${cfg.name || botId}] 正在连接 WebSocket...`);
  const wsConn = new WebSocket(WS_URL);
  bot.ws = wsConn;

  wsConn.on('open', () => {
    log('INFO', `[${cfg.name || botId}] WebSocket 连接建立，发送鉴权...`);
    bot.reconnectDelay = 2000;

    const subscribeMsg = {
      cmd: 'aibot_subscribe',
      headers: { req_id: genReqId() },
      body: { bot_id: cfg.bot_id, secret: cfg.secret }
    };
    wsConn.send(JSON.stringify(subscribeMsg));
  });

  wsConn.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    const cmd = msg.cmd || '';
    const errcode = msg.errcode;

    // ---- 订阅响应 ----
    if (cmd === 'aibot_subscribe' || (errcode !== undefined && !msg.cmd)) {
      const reqId = msg.headers && msg.headers.req_id;
      if (reqId && bot.uploadCallbacks[reqId]) {
        const { resolve, reject } = bot.uploadCallbacks[reqId];
        delete bot.uploadCallbacks[reqId];
        errcode === 0 ? resolve(msg) : reject(new Error(`upload failed: errcode=${errcode}`));
        return;
      }
      if (errcode === 0) {
        bot.isAuthenticated = true;
        log('INFO', `[${cfg.name || botId}] ✅ 鉴权成功！`);
        while (bot.pendingQueue.length > 0) {
          sendMsgViaBot(botId, bot.pendingQueue.shift());
        }
      } else {
        log('ERROR', `[${cfg.name || botId}] 鉴权失败: errcode=${errcode} ${msg.errmsg}`);
      }
      return;
    }

    // ---- 收到用户消息 ----
    if (cmd === 'aibot_msg_callback') {
      const body = msg.body || {};
      log('INFO', `[${cfg.name || botId}][callback] chatid=${body.chatid}, msgtype=${body.msgtype}, from=${body.from}`);
      if (body.text) log('INFO', `[${cfg.name || botId}][callback] text="${body.text.content}"`);
      // 自动收集 CHAT_ID
      if (body.chatid && !bot.chatIds.has(body.chatid)) {
        bot.chatIds.add(body.chatid);
        log('INFO', `[${cfg.name || botId}] 🆕 发现新群 CHAT_ID: ${body.chatid}`);
        savePersistedChatIds(); // 持久化到文件
      }
      // 录入处理（附带 botId 信息）
      handleMemeInput(body, botId).catch(err => {
        log('ERROR', `[${cfg.name || botId}][meme-input] 处理失败: ${err.message}`);
      });
    }

    // ---- 事件回调 ----
    if (cmd === 'aibot_event_callback') {
      log('INFO', `[${cfg.name || botId}] 收到事件回调`, msg.body);
    }

    // ---- 上传素材响应 ----
    if (cmd === 'aibot_upload_media_init' || cmd === 'aibot_upload_media_chunk' || cmd === 'aibot_upload_media_finish') {
      const reqId = msg.headers && msg.headers.req_id;
      if (reqId && bot.uploadCallbacks[reqId]) {
        const { resolve, reject } = bot.uploadCallbacks[reqId];
        delete bot.uploadCallbacks[reqId];
        errcode === 0 ? resolve(msg) : reject(new Error(`${cmd} failed: errcode=${errcode}`));
      }
      return;
    }

    // ---- 推送响应 ----
    if (cmd === 'aibot_send_msg') {
      if (errcode === 0) {
        log('INFO', `[${cfg.name || botId}] ✅ 消息推送成功`);
      } else {
        log('ERROR', `[${cfg.name || botId}] 推送失败: errcode=${errcode} ${msg.errmsg}`);
      }
    }
  });

  wsConn.on('close', (code) => {
    bot.isAuthenticated = false;
    log('WARN', `[${cfg.name || botId}] WebSocket 断开 code=${code}，${bot.reconnectDelay / 1000}s 后重连`);
    scheduleReconnectBot(botId);
  });

  wsConn.on('error', (err) => {
    log('ERROR', `[${cfg.name || botId}] WebSocket 错误: ${err.message}`);
    bot.isAuthenticated = false;
  });

  // 心跳
  const heartbeatTimer = setInterval(() => {
    if (bot.ws && bot.ws.readyState === WebSocket.OPEN) {
      bot.ws.ping();
    } else {
      clearInterval(heartbeatTimer);
    }
  }, 30000);
}

function scheduleReconnectBot(botId) {
  const bot = bots.get(botId);
  if (!bot) return;
  const jitter = Math.floor(Math.random() * 1000);
  setTimeout(() => {
    if (bot.ws) { try { bot.ws.terminate(); } catch (e) {} }
    connectBot(botId);
  }, bot.reconnectDelay + jitter);
  bot.reconnectDelay = Math.min(bot.reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ========== 通过指定机器人发送消息 ==========
function sendMsgViaBot(botId, payload) {
  const bot = bots.get(botId);
  if (!bot || !bot.ws || bot.ws.readyState !== WebSocket.OPEN || !bot.isAuthenticated) {
    if (bot) {
      log('WARN', `[${bot.config.name || botId}] 连接未就绪，消息排队`);
      bot.pendingQueue.push(payload);
    }
    return false;
  }
  const msg = { cmd: 'aibot_send_msg', headers: { req_id: genReqId() }, body: payload };
  bot.ws.send(JSON.stringify(msg));
  log('INFO', `[${bot.config.name || botId}] 已发送消息`, { chatid: payload.chatid, msgtype: payload.msgtype });
  return true;
}

// ========== 找到能发送到指定群的机器人 ==========
function findBotForChat(chatid) {
  for (const [botId, bot] of bots) {
    if (bot.chatIds.has(chatid)) return botId;
  }
  // 找不到就用第一个已连接的
  for (const [botId, bot] of bots) {
    if (bot.isAuthenticated) return botId;
  }
  return null;
}

// ========== 广播到所有群（每个机器人发到自己的所有群）==========
function broadcastToAllChats(buildPayload) {
  const results = [];
  for (const [botId, bot] of bots) {
    for (const chatid of bot.chatIds) {
      const payload = buildPayload(chatid, CHAT_TYPE);
      sendMsgViaBot(botId, payload);
      results.push({ botId, chatid, name: bot.config.name });
    }
  }
  return results;
}

// ========== 获取所有群列表 ==========
function getAllChats() {
  const chats = [];
  for (const [botId, bot] of bots) {
    for (const chatid of bot.chatIds) {
      chats.push({ botId, chatid, name: bot.config.name, authenticated: bot.isAuthenticated });
    }
  }
  return chats;
}

// ========== 通过指定机器人上传素材 ==========
function sendWsCmdViaBot(botId, cmd, body) {
  const bot = bots.get(botId);
  return new Promise((resolve, reject) => {
    if (!bot || !bot.ws || bot.ws.readyState !== WebSocket.OPEN || !bot.isAuthenticated) {
      return reject(new Error('WebSocket 未连接'));
    }
    const reqId = genReqId();
    const msg = { cmd, headers: { req_id: reqId }, body };
    bot.uploadCallbacks[reqId] = { resolve, reject };
    setTimeout(() => {
      if (bot.uploadCallbacks[reqId]) {
        delete bot.uploadCallbacks[reqId];
        reject(new Error(`${cmd} timeout`));
      }
    }, 30000);
    bot.ws.send(JSON.stringify(msg));
  });
}

async function uploadMediaViaBot(botId, fileBuffer, filename, fileType) {
  const CHUNK_SIZE = 64 * 1024;
  const totalSize = fileBuffer.length;
  const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

  log('INFO', `[upload] 开始上传素材 ${filename}, size=${totalSize}, chunks=${totalChunks}`);

  const initResp = await sendWsCmdViaBot(botId, 'aibot_upload_media_init', {
    filename, total_size: totalSize, total_chunks: totalChunks, md5, type: fileType
  });
  const uploadId = initResp.body && initResp.body.upload_id;
  if (!uploadId) throw new Error('未获取到 upload_id');

  let chunkSeq = 0;
  for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
    const chunk = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    await sendWsCmdViaBot(botId, 'aibot_upload_media_chunk', {
      upload_id: uploadId, chunk_index: chunkSeq, base64_data: chunk.toString('base64')
    });
    chunkSeq++;
  }

  const finishResp = await sendWsCmdViaBot(botId, 'aibot_upload_media_finish', { upload_id: uploadId });
  const mediaId = finishResp.body && finishResp.body.media_id;
  if (!mediaId) throw new Error('未获取到 media_id');
  log('INFO', `[upload] 上传完成, media_id=${mediaId}`);
  return mediaId;
}

// ========== 构建 Markdown 消息 ==========
function buildMarkdownMsg(chatid, chatType, content) {
  return {
    chatid: chatid,
    chat_type: chatType,
    msgtype: 'markdown',
    markdown: { content }
  };
}

// ========== 构建通用 payload ==========
function buildPayload(chatid, chatType, data) {
  const msgtype = data.msgtype || 'markdown';
  if (msgtype === 'template_card') {
    return { chatid, chat_type: chatType, msgtype: 'template_card', template_card: data.template_card };
  } else if (msgtype === 'news') {
    return { chatid, chat_type: chatType, msgtype: 'news', news: data.news };
  } else if (msgtype === 'image') {
    return { chatid, chat_type: chatType, msgtype: 'image', image: data.image };
  } else {
    return buildMarkdownMsg(chatid, chatType, data.content || '');
  }
}

// ========== HTTP 内部接口（供 index.js 调用） ==========
const httpServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // 健康检查 + 群列表
  if (req.method === 'GET' && req.url === '/health') {
    const botList = [];
    for (const [botId, bot] of bots) {
      botList.push({
        bot_id: botId,
        name: bot.config.name,
        connected: bot.ws && bot.ws.readyState === WebSocket.OPEN,
        authenticated: bot.isAuthenticated,
        chat_ids: [...bot.chatIds],
        pending_queue: bot.pendingQueue.length
      });
    }
    res.end(JSON.stringify({ status: 'ok', bots: botList }));
    return;
  }

  // 获取所有群列表
  if (req.method === 'GET' && req.url === '/chats') {
    res.end(JSON.stringify({ ok: true, chats: getAllChats() }));
    return;
  }

  // 发送消息接口（支持 broadcast=true 广播到所有群）
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const broadcast = data.broadcast === true;
        const msgtype = data.msgtype || 'markdown';
        const content = data.content || '';

        if (!content && !['template_card', 'news', 'image'].includes(msgtype)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'content 不能为空' }));
          return;
        }

        if (broadcast) {
          // 广播到所有群
          const results = broadcastToAllChats((chatid, chatType) => buildPayload(chatid, chatType, data));
          res.end(JSON.stringify({ ok: true, broadcast: true, sent_to: results }));
        } else {
          // 发到指定群
          const chatid = data.chatid || getDefaultChatId();
          const chatType = data.chat_type !== undefined ? data.chat_type : CHAT_TYPE;

          if (!chatid) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: '未指定 chatid，且无可用群' }));
            return;
          }

          const payload = buildPayload(chatid, chatType, data);
          const botId = findBotForChat(chatid);
          if (botId) {
            sendMsgViaBot(botId, payload);
            res.end(JSON.stringify({ ok: true, chatid, message: '已发送' }));
          } else {
            res.statusCode = 503;
            res.end(JSON.stringify({ ok: false, error: '无可用机器人连接' }));
          }
        }
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 上传素材并发图片接口
  if (req.method === 'POST' && req.url === '/upload-and-send') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const chatid = data.chatid || getDefaultChatId();
        const chatType = data.chat_type !== undefined ? data.chat_type : CHAT_TYPE;
        const { base64, filename, filetype } = data;

        if (!base64 || !filename) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'base64 和 filename 不能为空' }));
          return;
        }

        const botId = findBotForChat(chatid);
        if (!botId) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: '无可用机器人连接' }));
          return;
        }

        const fileBuffer = Buffer.from(base64, 'base64');
        const mediaId = await uploadMediaViaBot(botId, fileBuffer, filename, filetype || 'image');

        const payload = { chatid, chat_type: chatType, msgtype: 'image', image: { media_id: mediaId } };
        sendMsgViaBot(botId, payload);
        res.end(JSON.stringify({ ok: true, media_id: mediaId, message: '图片已发送' }));
      } catch (e) {
        log('ERROR', '[upload-and-send] 失败: ' + e.message);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

// 获取默认 chatid（第一个可用群）
function getDefaultChatId() {
  for (const [, bot] of bots) {
    if (bot.chatIds.size > 0) return [...bot.chatIds][0];
  }
  return '';
}

// ========== 启动 ==========
httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  log('INFO', `[aibot-client] HTTP 内部接口监听 127.0.0.1:${HTTP_PORT}`);
  log('INFO', `[aibot-client] 配置了 ${botConfigs.length} 个机器人`);
  for (const cfg of botConfigs) {
    log('INFO', `  - ${cfg.name || '未命名'}: bot_id=${cfg.bot_id}, chat_id=${cfg.chat_id || '(等待自动获取)'}`);
  }
});

// 启动所有机器人连接
initBots();

// ========== 梗录入模块 ==========

// API 地址（index.js 同机，端口 3000）
const API_PORT = parseInt(process.env.PORT || '3000');

// 最近图片缓存：按 chatid:from 存储，5 分钟有效
const recentImages = {};
const IMAGE_CACHE_TTL = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(recentImages)) {
    if (now - recentImages[key].timestamp > IMAGE_CACHE_TTL) {
      delete recentImages[key];
    }
  }
}, 60000);

// 提取文本中的 URL
function extractUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/i);
  return m ? m[0] : null;
}

// 判断是否为录入指令（@机器人后的文本）
function isMemeCommand(text) {
  if (!text) return false;
  const t = text.trim();
  return /^(录入|录|记录|收录|添加|新增)\s/i.test(t) || extractUrl(t) !== null;
}

// 解析梗名称和链接
function parseMemeText(text) {
  if (!text) return null;
  let t = text.trim();
  // 去掉指令词
  t = t.replace(/^(录入|录|记录|收录|添加|新增)\s+/i, '').trim();
  const url = extractUrl(t);
  let name = url ? t.replace(url, '').trim() : t.trim();
  name = name.replace(/[,，。.、\s]+$/g, '').trim();
  if (!name && !url) return null;
  return { name: name || null, source_url: url || null };
}

// 调用本地 API 创建梗
function createMeme(memeData) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(memeData);
    const req = http.request({
      hostname: '127.0.0.1',
      port: API_PORT,
      path: '/memes',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(result);
          else reject(new Error(result.error || `HTTP ${res.statusCode}`));
        } catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 给群里回复 markdown 消息
function replyToChat(chatid, chatType, content, botId) {
  const payload = buildMarkdownMsg(chatid, chatType || CHAT_TYPE, content);
  const targetBot = botId || findBotForChat(chatid);
  if (targetBot) {
    sendMsgViaBot(targetBot, payload);
  } else {
    log('WARN', `[replyToChat] 找不到能发送到 ${chatid} 的机器人`);
  }
}

// 将企微图片 URL 转存到 Supabase Storage
function uploadImageToSupabase(imageUrl) {
  return new Promise((resolve) => {
    const protocol = imageUrl.startsWith('https') ? https : http;
    protocol.get(imageUrl, { headers: { 'User-Agent': 'MemeBot/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return uploadImageToSupabase(res.headers.location).then(resolve);
      }
      if (res.statusCode !== 200) {
        log('WARN', `[meme-input] 图片下载失败: HTTP ${res.statusCode}`);
        resolve(null);
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'image/png';
        const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
        const filename = `meme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const supabaseUrl = process.env.SUPABASE_URL || 'https://iwmvtizwcibusjjiquwq.supabase.co';
        const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
        if (!supabaseKey) {
          log('WARN', '[meme-input] 未配置 SUPABASE_ANON_KEY，跳过图片上传');
          resolve(null);
          return;
        }

        const uploadPath = `/storage/v1/object/meme-images/${filename}`;
        const uploadUrlObj = new URL(uploadPath, supabaseUrl);
        const uploadReq = https.request({
          hostname: uploadUrlObj.hostname,
          path: uploadUrlObj.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'apikey': supabaseKey,
            'Content-Type': contentType,
            'Content-Length': buffer.length,
            'x-upsert': 'true'
          }
        }, (uploadRes) => {
          let data = '';
          uploadRes.on('data', chunk => data += chunk);
          uploadRes.on('end', () => {
            if (uploadRes.statusCode === 200 || uploadRes.statusCode === 201) {
              const publicUrl = `${supabaseUrl}/storage/v1/object/public/meme-images/${filename}`;
              log('INFO', `[meme-input] 图片上传成功: ${publicUrl}`);
              resolve(publicUrl);
            } else {
              log('ERROR', `[meme-input] Supabase 上传失败: ${uploadRes.statusCode} ${data}`);
              resolve(null);
            }
          });
        });
        uploadReq.on('error', (e) => { log('ERROR', `[meme-input] 上传出错: ${e.message}`); resolve(null); });
        uploadReq.write(buffer);
        uploadReq.end();
      });
    }).on('error', (e) => { log('ERROR', `[meme-input] 图片下载出错: ${e.message}`); resolve(null); });
  });
}

// 主处理函数：解析群消息并录入
async function handleMemeInput(body, botId) {
  const { chatid, from, msgtype } = body;
  const chatType = body.chattype === 'single' ? 1 : 2;
  const cacheKey = `${chatid}:${from}`;

  // 1. 收到图片消息 → 缓存起来等后续文字指令
  if (msgtype === 'image') {
    const imageInfo = body.image || {};
    log('INFO', `[meme-input] 收到图片，缓存 ${cacheKey}`, imageInfo);
    recentImages[cacheKey] = {
      url: imageInfo.url || null,
      media_id: imageInfo.media_id || null,
      timestamp: Date.now()
    };
    return;
  }

  // 2. 只处理文字消息
  if (msgtype !== 'text') return;

  let text = (body.text && body.text.content) || '';
  text = text.replace(/@[\u4e00-\u9fa5\w\-]+\s*/g, '').trim();
  log('INFO', `[meme-input] 清洗后文本: "${text}"`);
  if (!text) return;

  // 3. 判断是否为录入指令
  if (!isMemeCommand(text)) {
    if (/^(帮助|help|用法|怎么用|\?|？)$/i.test(text.trim())) {
      replyToChat(chatid, chatType,
        '**🤖 热梗录入助手**\n\n' +
        '在群里 @我 即可录入热梗：\n' +
        '> **格式1**：`录入 梗名称 链接`\n' +
        '> **格式2**：`梗名称 链接`（只要有链接就行）\n\n' +
        '链接支持抖音、小红书、B站等\n' +
        '💡 截图请在录入后通过回复中的链接上传',
        botId
      );
    }
    return;
  }

  // 4. 解析文本
  const parsed = parseMemeText(text);
  if (!parsed || !parsed.name) {
    replyToChat(chatid, chatType, '❌ 没解析到梗名称，请用格式：`录入 梗名称 链接`', botId);
    return;
  }

  if (!parsed.source_url) {
    replyToChat(chatid, chatType, '❌ 缺少来源链接，请用格式：`录入 梗名称 链接`', botId);
    return;
  }

  // 5. 检查缓存的图片
  let imageUrl = null;
  if (recentImages[cacheKey]) {
    const cached = recentImages[cacheKey];
    if (cached.url) {
      imageUrl = await uploadImageToSupabase(cached.url);
    }
    delete recentImages[cacheKey];
  }

  // 6. 调用 API 录入
  try {
    const memeData = {
      name: parsed.name,
      source_url: parsed.source_url,
      category: 'public',
      priority: '',
    };
    if (imageUrl) memeData.image_path = imageUrl;

    const result = await createMeme(memeData);
    log('INFO', `[meme-input] 录入成功: ${parsed.name}`, result);

    const memeId = result && result.id ? result.id : '';
    let reply = `✅ **已录入**「${parsed.name}」\n`;
    reply += `> 🔗 [来源链接](${parsed.source_url})\n`;
    if (imageUrl) {
      reply += `> 📷 截图已保存\n`;
    } else {
      reply += `> ⚠️ **需补截图**（群聊暂不支持图片识别）\n`;
      reply += `> 👉 [点击上传截图](http://21.6.179.196:3000?edit=${memeId})\n`;
    }
    reply += `> 📝 分类/等级可在[热梗管理页](http://21.6.179.196:3000)调整`;

    replyToChat(chatid, chatType, reply, botId);
  } catch (err) {
    log('ERROR', `[meme-input] 录入失败: ${err.message}`);
    replyToChat(chatid, chatType, `❌ 录入失败：${err.message}`, botId);
  }
}

// 优雅退出
function gracefulShutdown(signal) {
  log('INFO', `收到 ${signal}，正在关闭...`);
  for (const [, bot] of bots) {
    if (bot.ws) bot.ws.close();
  }
  httpServer.close();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
