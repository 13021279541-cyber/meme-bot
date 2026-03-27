/**
 * 企微智能机器人 WebSocket 长连接客户端
 *
 * 架构：
 *   1. 本进程与企微服务器建立 WebSocket 长连接（aibot_subscribe 鉴权）
 *   2. HTTP 服务监听 4001 端口，供 index.js 调用 POST /send 来触发推送
 *   3. 收到推送请求后，通过 WebSocket 发送 aibot_send_msg 推送消息
 *
 * 启动方式：
 *   BOT_ID=xxx BOT_SECRET=xxx CHAT_ID=xxx node aibot-client.js
 *
 * 或在 .env 文件中配置后直接 node aibot-client.js
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

// ========== 配置（从环境变量读取） ==========
const BOT_ID     = process.env.BOT_ID     || '';
const BOT_SECRET = process.env.BOT_SECRET || '';
const CHAT_ID    = process.env.CHAT_ID    || '';   // 群聊 chatid（从群聊回调事件中获取）
const CHAT_TYPE  = parseInt(process.env.CHAT_TYPE || '2'); // 1=单聊 2=群聊
const HTTP_PORT  = parseInt(process.env.AIBOT_HTTP_PORT || '4001');

// 企微 WebSocket 地址（官方文档）
const WS_URL = 'wss://openws.work.weixin.qq.com';

// ========== 状态 ==========
let ws = null;
let isAuthenticated = false;
let reconnectDelay = 2000;   // 初始重连延迟 2s
const MAX_RECONNECT_DELAY = 60000;

// 待发送消息队列（连接未就绪时缓存）
const pendingQueue = [];

// 上传素材回调 Map：req_id => { resolve, reject }
const uploadCallbacks = {};

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

// ========== WebSocket 连接 ==========
function connect() {
  if (!BOT_ID || !BOT_SECRET) {
    log('ERROR', '未配置 BOT_ID 或 BOT_SECRET，请检查环境变量！');
    return;
  }

  log('INFO', `正在连接企微智能机器人 WebSocket... BotID=${BOT_ID}`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    log('INFO', 'WebSocket 连接建立，发送 aibot_subscribe 鉴权...');
    reconnectDelay = 2000; // 重置重连延迟

    // 发送订阅请求
    const subscribeMsg = {
      cmd: 'aibot_subscribe',
      headers: { req_id: genReqId() },
      body: {
        bot_id: BOT_ID,
        secret: BOT_SECRET
      }
    };
    ws.send(JSON.stringify(subscribeMsg));
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      log('WARN', '收到非 JSON 消息', data.toString());
      return;
    }

    const cmd = msg.cmd || '';
    const errcode = msg.errcode;

    // ---- 订阅响应 ----
    if (cmd === 'aibot_subscribe' || (errcode !== undefined && !msg.cmd)) {
      // 先检查是否是 upload 操作的错误响应（企微有时用 aibot_subscribe cmd 返回错误）
      const reqId = msg.headers && msg.headers.req_id;
      if (reqId && uploadCallbacks[reqId]) {
        const { resolve, reject } = uploadCallbacks[reqId];
        delete uploadCallbacks[reqId];
        if (errcode === 0) {
          resolve(msg);
        } else {
          reject(new Error(`upload failed: errcode=${errcode} errmsg=${msg.errmsg}`));
        }
        return;
      }

      if (errcode === 0) {
        isAuthenticated = true;
        log('INFO', '✅ aibot_subscribe 鉴权成功！长连接已就绪');

        // 处理排队的消息
        if (pendingQueue.length > 0) {
          log('INFO', `处理 ${pendingQueue.length} 条排队消息...`);
          while (pendingQueue.length > 0) {
            const item = pendingQueue.shift();
            sendMsgViaWS(item);
          }
        }
      } else {
        log('ERROR', `aibot_subscribe 鉴权失败，errcode=${errcode}，errmsg=${msg.errmsg}`);
      }
      return;
    }

    // ---- 收到用户消息（可选：记录 chatid 供推送使用） ----
    if (cmd === 'aibot_msg_callback') {
      const body = msg.body || {};
      log('INFO', `收到用户消息 [${body.chattype}]`, {
        chatid: body.chatid,
        from: body.from,
        msgtype: body.msgtype,
        content: body.text && body.text.content
      });
      // 可在此处扩展：将 chatid 保存到文件/DB，用于后续推送
    }

    // ---- 收到事件回调 ----
    if (cmd === 'aibot_event_callback') {
      log('INFO', '收到事件回调', msg.body);
    }

    // ---- 上传素材响应 ----
    if (cmd === 'aibot_upload_media_init' || cmd === 'aibot_upload_media_chunk' || cmd === 'aibot_upload_media_finish') {
      const reqId = msg.headers && msg.headers.req_id;
      if (reqId && uploadCallbacks[reqId]) {
        const { resolve, reject } = uploadCallbacks[reqId];
        delete uploadCallbacks[reqId];
        if (errcode === 0) {
          resolve(msg);
        } else {
          reject(new Error(`${cmd} failed: errcode=${errcode} errmsg=${msg.errmsg}`));
        }
      }
      return;
    }

    // ---- 推送消息的响应 ----
    if (cmd === 'aibot_send_msg') {
      if (errcode === 0) {
        log('INFO', '✅ 消息推送成功');
      } else {
        log('ERROR', `消息推送失败，errcode=${errcode}，errmsg=${msg.errmsg}`);
      }
    }
  });

  ws.on('close', (code, reason) => {
    isAuthenticated = false;
    log('WARN', `WebSocket 断开 code=${code}，${reconnectDelay / 1000}s 后重连...`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log('ERROR', `WebSocket 错误: ${err.message}`);
    isAuthenticated = false;
  });

  // 心跳保活（每 30s 发一次 ping）
  const heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(heartbeatTimer);
    }
  }, 30000);
}

function scheduleReconnect() {
  // 指数退避 + 随机抖动
  const jitter = Math.floor(Math.random() * 1000);
  setTimeout(() => {
    if (ws) {
      try { ws.terminate(); } catch (e) {}
    }
    connect();
  }, reconnectDelay + jitter);

  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ========== 通过 WebSocket 发送消息 ==========
function sendMsgViaWS(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !isAuthenticated) {
    log('WARN', '连接未就绪，消息加入排队');
    pendingQueue.push(payload);
    return false;
  }

  const msg = {
    cmd: 'aibot_send_msg',
    headers: { req_id: genReqId() },
    body: payload
  };

  ws.send(JSON.stringify(msg));
  log('INFO', '已发送消息', { chatid: payload.chatid, msgtype: payload.msgtype });
  return true;
}

// ========== 通过 WebSocket 上传素材，获取 media_id ==========
function sendWsCmd(cmd, body) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !isAuthenticated) {
      return reject(new Error('WebSocket 未连接'));
    }
    const reqId = genReqId();
    const msg = { cmd, headers: { req_id: reqId }, body };
    uploadCallbacks[reqId] = { resolve, reject };
    // 超时 30s
    setTimeout(() => {
      if (uploadCallbacks[reqId]) {
        delete uploadCallbacks[reqId];
        reject(new Error(`${cmd} timeout`));
      }
    }, 30000);
    ws.send(JSON.stringify(msg));
  });
}

async function uploadMediaViaWS(fileBuffer, filename, fileType) {
  const CHUNK_SIZE = 64 * 1024; // 64KB per chunk
  const totalSize = fileBuffer.length;
  const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');

  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

  log('INFO', `[upload] 开始上传素材 ${filename}, size=${totalSize}, md5=${md5}, chunks=${totalChunks}`);

  // 1. 初始化
  const initResp = await sendWsCmd('aibot_upload_media_init', {
    filename,
    total_size: totalSize,
    total_chunks: totalChunks,
    md5,
    type: fileType  // image / voice / video / file
  });
  const uploadId = initResp.body && initResp.body.upload_id;
  if (!uploadId) throw new Error('未获取到 upload_id');
  log('INFO', `[upload] 初始化成功, upload_id=${uploadId}`);

  // 2. 分片上传
  let chunkSeq = 0;
  for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
    const chunk = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    await sendWsCmd('aibot_upload_media_chunk', {
      upload_id: uploadId,
      chunk_index: chunkSeq,
      base64_data: chunk.toString('base64')
    });
    chunkSeq++;
  }
  log('INFO', `[upload] 分片上传完成，共 ${chunkSeq} 片`);

  // 3. 完成
  const finishResp = await sendWsCmd('aibot_upload_media_finish', {
    upload_id: uploadId
  });
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

// ========== HTTP 内部接口（供 index.js 调用） ==========
const httpServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({
      status: 'ok',
      ws_connected: ws && ws.readyState === WebSocket.OPEN,
      authenticated: isAuthenticated,
      pending_queue: pendingQueue.length
    }));
    return;
  }

  // 发送消息接口
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const chatid   = data.chatid   || CHAT_ID;
        const chatType = data.chat_type !== undefined ? data.chat_type : CHAT_TYPE;
        const content  = data.content  || '';
        const msgtype  = data.msgtype  || 'markdown';

        if (!chatid) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: '未配置 chatid，请传入 chatid 参数或设置 CHAT_ID 环境变量' }));
          return;
        }

        // news、template_card、image 类型不需要 content
        if (!content && !['template_card', 'news', 'image'].includes(msgtype)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'content 不能为空' }));
          return;
        }

        let payload;
        if (msgtype === 'template_card') {
          payload = {
            chatid,
            chat_type: chatType,
            msgtype: 'template_card',
            template_card: data.template_card
          };
        } else if (msgtype === 'news') {
          payload = {
            chatid,
            chat_type: chatType,
            msgtype: 'news',
            news: data.news
          };
        } else if (msgtype === 'image') {
          payload = {
            chatid,
            chat_type: chatType,
            msgtype: 'image',
            image: data.image  // { base64, md5 }
          };
        } else {
          // 默认 markdown
          payload = buildMarkdownMsg(chatid, chatType, content);
        }

        const queued = !isAuthenticated;
        sendMsgViaWS(payload);

        res.end(JSON.stringify({
          ok: true,
          queued,
          message: queued ? '连接中，消息已排队' : '已发送'
        }));
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
        const chatid   = data.chatid   || CHAT_ID;
        const chatType = data.chat_type !== undefined ? data.chat_type : CHAT_TYPE;
        const { base64, filename, filetype } = data;

        if (!base64 || !filename) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'base64 和 filename 不能为空' }));
          return;
        }

        const fileBuffer = Buffer.from(base64, 'base64');
        const mediaId = await uploadMediaViaWS(fileBuffer, filename, filetype || 'image');

        const payload = {
          chatid,
          chat_type: chatType,
          msgtype: 'image',
          image: { media_id: mediaId }
        };
        sendMsgViaWS(payload);
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

// ========== 启动 ==========
httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  log('INFO', `[aibot-client] HTTP 内部接口监听 127.0.0.1:${HTTP_PORT}`);
  log('INFO', `[aibot-client] BOT_ID=${BOT_ID || '(未设置)'}`);
  log('INFO', `[aibot-client] CHAT_ID=${CHAT_ID || '(未设置，需在推送时传入)'}`);
});

// 建立 WebSocket 连接
connect();

// 优雅退出
process.on('SIGINT', () => {
  log('INFO', '收到 SIGINT，正在关闭...');
  if (ws) ws.close();
  httpServer.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('INFO', '收到 SIGTERM，正在关闭...');
  if (ws) ws.close();
  httpServer.close();
  process.exit(0);
});
