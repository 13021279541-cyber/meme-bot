/**
 * 热梗自动化 API 中间层
 * 部署在 DevCloud CVM，连接内网 MySQL
 * 供前端页面 + 企微智能机器人调用
 */
try { require('dotenv').config(); } catch (e) { /* dotenv 非必须，CVM 可通过 PM2 env 配置 */ }
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');

const path = require('path');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ===== 静态文件托管（前端页面） =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== MySQL 连接池 =====
if (!process.env.DB_PASS) {
  console.error('[FATAL] 环境变量 DB_PASS 未设置，请配置 .env 文件');
  process.exit(1);
}
const pool = mysql.createPool({
  host: process.env.DB_HOST || '9.134.177.112',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'meme_bot',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ===== 健康检查 =====
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ===== GET /memes - 获取梗列表 =====
app.get('/memes', async (req, res) => {
  try {
    const { include_deleted, category, priority, start_date, end_date } = req.query;
    
    let sql = 'SELECT * FROM memes';
    const conditions = [];
    const params = [];

    // 默认不返回已删除的
    if (include_deleted !== 'true') {
      conditions.push('deleted_at IS NULL');
    }

    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }

    if (priority) {
      conditions.push('priority = ?');
      params.push(priority);
    }

    if (start_date) {
      conditions.push('created_at >= ?');
      params.push(start_date);
    }

    if (end_date) {
      conditions.push('created_at <= ?');
      params.push(end_date + ' 23:59:59');
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC';

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GET /memes/:id - 获取单条 =====
app.get('/memes/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM memes WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== POST /memes - 新增梗 =====
app.post('/memes', async (req, res) => {
  try {
    const { name, summary, source_url, category, priority, image_path } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = crypto.randomUUID();
    const now = new Date();
    const weekNumber = getWeekNumber(now);
    const year = now.getFullYear();

    await pool.query(
      `INSERT INTO memes (id, name, summary, source_url, category, priority, image_path, created_at, week_number, year)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [id, name, summary || null, source_url || null, category || 'public', priority || 'blue', image_path || null, weekNumber, year]
    );

    const [rows] = await pool.query('SELECT * FROM memes WHERE id = ?', [id]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PATCH /memes/:id - 更新梗 =====
app.patch('/memes/:id', async (req, res) => {
  try {
    const allowedFields = [
      'name', 'summary', 'source_url', 'category', 'priority', 'image_path',
      'official_title', 'official_link', 'official_image',
      'incentive_topic', 'incentive_link'
    ];

    const updates = [];
    const params = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    await pool.query(`UPDATE memes SET ${updates.join(', ')} WHERE id = ?`, params);

    const [rows] = await pool.query('SELECT * FROM memes WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== DELETE /memes/:id - 软删除 =====
app.delete('/memes/:id', async (req, res) => {
  try {
    // 软删除
    await pool.query('UPDATE memes SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== POST /memes/:id/restore - 恢复 =====
app.post('/memes/:id/restore', async (req, res) => {
  try {
    await pool.query('UPDATE memes SET deleted_at = NULL WHERE id = ?', [req.params.id]);
    const [rows] = await pool.query('SELECT * FROM memes WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GET /memes/deleted - 回收站 =====
app.get('/deleted', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM memes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== POST /memes/:id/hard-delete - 永久删除 =====
app.delete('/memes/:id/permanent', async (req, res) => {
  try {
    await pool.query('DELETE FROM memes WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 企微智能机器人推送代理 =====
// 将推送请求转发给 aibot-client.js 进程（127.0.0.1:4001）
const AIBOT_HTTP_PORT = parseInt(process.env.AIBOT_HTTP_PORT || '4001');

async function callAibotClient(path, body) {
  const http = require('http');
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: AIBOT_HTTP_PORT,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, error: data }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}


// POST /screenshot-report - 对报告页面截图并推送图片消息
app.post('/screenshot-report', async (req, res) => {
  try {
    const { startDate, endDate, chatid, chat_type } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: 'startDate 和 endDate 不能为空' });
    }

    const puppeteer = require('puppeteer-core');
    const crypto = require('crypto');

    const reportUrl = `http://127.0.0.1:3000/?report=${startDate}_${endDate}`;
    console.log('[screenshot] 截图 URL:', reportUrl);

    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/ungoogled-chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--font-render-hinting=none'
      ],
      headless: true
    });

    const page = await browser.newPage();
    // 16:9 宽屏匹配周报布局（1920x1080，1.5x 清晰度）
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1.5 });
    await page.goto(reportUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // 等待报告内容+图片渲染完成
    await new Promise(r => setTimeout(r, 3500));

    // 截取完整页面，自动压缩到 2MB 以内（企微限制）
    const MAX_SIZE = 2 * 1024 * 1024; // 2MB
    let quality = 82;
    let screenshotBuffer = await page.screenshot({
      fullPage: true,
      type: 'jpeg',
      quality
    });
    console.log(`[screenshot] 首次截图 quality=${quality}, 大小: ${(screenshotBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    // 如果超 2MB，逐步降低质量重新截图
    while (screenshotBuffer.length > MAX_SIZE && quality > 30) {
      quality -= 10;
      console.log(`[screenshot] 超过2MB，降低质量重试 quality=${quality}`);
      screenshotBuffer = await page.screenshot({
        fullPage: true,
        type: 'jpeg',
        quality
      });
      console.log(`[screenshot] 重试结果 quality=${quality}, 大小: ${(screenshotBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    }

    await browser.close();

    console.log('[screenshot] 截图完成，大小:', screenshotBuffer.length, 'bytes');

    // ===== 保存截图到 public 目录，生成公开 URL =====
    const fs = require('fs');
    const screenshotDir = path.join(__dirname, 'public', 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

    const filename = `report_${startDate}_${endDate}_${Date.now()}.jpg`;
    const filepath = path.join(screenshotDir, filename);
    fs.writeFileSync(filepath, screenshotBuffer);

    const serverHost = process.env.SERVER_HOST || `http://127.0.0.1:${PORT}`;
    const imageUrl = `${serverHost}/screenshots/${filename}`;
    const publicReportUrl = `${serverHost}/?report=${startDate}_${endDate}`;

    console.log('[screenshot] 截图已保存，URL:', imageUrl);

    // ===== 通过 WebSocket 上传素材发真实图片 =====
    const base64 = screenshotBuffer.toString('base64');

    // 支持广播：不传 chatid 时获取群列表，逐群上传发送
    if (!chatid) {
      // 广播到所有群
      const httpLib = require('http');
      const chatsResp = await new Promise((resolve, reject) => {
        httpLib.get({ hostname: '127.0.0.1', port: AIBOT_HTTP_PORT, path: '/chats' }, (r) => {
          let data = '';
          r.on('data', chunk => data += chunk);
          r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ chats: [] }); } });
        }).on('error', () => resolve({ chats: [] }));
      });
      const chats = (chatsResp.chats || []).filter(c => c.authenticated);
      const results = [];
      for (const chat of chats) {
        try {
          const r = await callAibotClient('/upload-and-send', {
            chatid: chat.chatid,
            chat_type: chat_type || 2,
            base64, filename, filetype: 'image'
          });
          results.push({ chatid: chat.chatid, name: chat.name, ok: true, result: r });
          // 间隔 1.5s 防企微丢消息
          if (chats.indexOf(chat) < chats.length - 1) {
            await new Promise(r => setTimeout(r, 1500));
          }
        } catch (e) {
          results.push({ chatid: chat.chatid, name: chat.name, ok: false, error: e.message });
        }
      }
      res.json({ ok: true, broadcast: true, size: screenshotBuffer.length, imageUrl, results });
    } else {
      // 单群发送
      const result = await callAibotClient('/upload-and-send', {
        chatid, chat_type: chat_type || 2, base64, filename, filetype: 'image'
      });
      res.json({ ok: true, size: screenshotBuffer.length, imageUrl, result });
    }
  } catch (e) {
    console.error('[screenshot] 错误:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// POST /upload-only - 只上传素材获取 media_id，不发消息（供前端图文混排用）
app.post('/upload-only', async (req, res) => {
  try {
    const result = await callAibotClient('/upload-only', req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /push-image - 接收手动上传的截图，保存后推送到企微群
const multer = require("multer");
const fs = require("fs");

const screenshotUploadDir = path.join(__dirname, "public", "screenshots");
if (!fs.existsSync(screenshotUploadDir)) fs.mkdirSync(screenshotUploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: screenshotUploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, "manual_" + Date.now() + ext);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.post("/push-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "没有收到图片" });

    const serverHost = process.env.SERVER_HOST || `http://127.0.0.1:${PORT}`;
    const imageUrl = serverHost + "/screenshots/" + req.file.filename;
    const title = req.body.title || "热梗洞察周报";
    const extra = req.body.extra || "";

    let mdContent = `**🔥 ${title}**\n\n${imageUrl}`;
    if (extra && extra.trim()) {
      mdContent += "\n\n" + extra.trim();
    }

    const result = await callAibotClient("/send", {
      msgtype: "markdown",
      content: mdContent
    });

    res.json({ ok: true, imageUrl, result });
  } catch (e) {
    console.error("[push-image] 错误:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /webhook/wecom - 通过智能机器人推送消息（供前端调用）
// 支持 broadcast=true 广播到所有群
app.post('/webhook/wecom', async (req, res) => {
  try {
    const { content, chatid, chat_type, msgtype, template_card, news, image, broadcast } = req.body;
    const resolvedMsgtype = msgtype || 'markdown';

    // news、template_card、image 类型不需要 content
    if (!content && !['template_card', 'news', 'image'].includes(resolvedMsgtype)) {
      return res.status(400).json({ ok: false, error: 'content 不能为空' });
    }

    const payload = { msgtype: resolvedMsgtype };
    if (content) payload.content = content;
    if (chatid) payload.chatid = chatid;
    if (chat_type !== undefined) payload.chat_type = chat_type;
    if (template_card) payload.template_card = template_card;
    if (news) payload.news = news;
    if (image) payload.image = image;
    if (broadcast) payload.broadcast = true;

    const result = await callAibotClient('/send', payload);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /webhook/aibot/chats - 获取所有群列表
app.get('/webhook/aibot/chats', async (req, res) => {
  try {
    const http = require('http');
    const result = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: AIBOT_HTTP_PORT, path: '/chats' }, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); } });
      }).on('error', reject);
    });
    res.json(result);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'aibot-client 未运行: ' + e.message });
  }
});

// GET /webhook/aibot/health - 查看 WebSocket 连接状态
app.get('/webhook/aibot/health', async (req, res) => {
  try {
    const http = require('http');
    const result = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: AIBOT_HTTP_PORT, path: '/health' }, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); } });
      }).on('error', reject);
    });
    res.json(result);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'aibot-client 未运行: ' + e.message });
  }
});

// ===== 同步到腾讯文档智能表格 =====
const https = require('https');
const TDOC_TOKEN = process.env.TDOC_TOKEN || 'f1e30d2488ad48bb97ebde568900cb8f';
const SMARTSHEET_FILE_ID = 'JnhTgrmgdZGG';
const SMARTSHEET_SHEET_ID = 't00i2h';

function callTencentDocMCP(method, params) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: method, arguments: params }
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'docs.qq.com',
      path: '/openapi/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': TDOC_TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// POST /sync-smartsheet - 把一批梗同步到腾讯文档智能表格
app.post('/sync-smartsheet', async (req, res) => {
  try {
    const { memes, pushPeriod } = req.body;
    if (!memes || !Array.isArray(memes) || memes.length === 0) {
      return res.status(400).json({ ok: false, error: '请提供 memes 数组' });
    }

    const categoryMap = { wangzhe: '🎮 王者相关', 'public': '🌍 大众热点' };
    const priorityMap = { red: '🔴 必上', orange: '🟠 推荐', blue: '🔵 可选' };

    const records = memes.map(m => {
      const fv = {
        '梗名称': [{ text: m.name, type: 'text' }],
        '分类': [{ text: categoryMap[m.category] || '' }],
        '来源链接': [{ text: m.name, type: 'url', link: m.source_url || '' }],
        '一句话概括': [{ text: m.summary || '', type: 'text' }],
        '录入日期': String(new Date(m.created_at).getTime())
      };
      const pri = priorityMap[m.priority];
      if (pri) fv['等级'] = [{ text: pri }];
      if (pushPeriod) fv['推送周期'] = [{ text: pushPeriod, type: 'text' }];
      if (m.official_title || m.official_link) {
        fv['官号跟进'] = [{ text: [m.official_title, m.official_link].filter(Boolean).join(' '), type: 'text' }];
      }
      if (m.incentive_topic || m.incentive_link) {
        fv['作者激励'] = [{ text: [m.incentive_topic, m.incentive_link].filter(Boolean).join(' '), type: 'text' }];
      }
      return { field_values: fv };
    });

    console.log(`[sync-smartsheet] 同步 ${records.length} 条到智能表格...`);
    const result = await callTencentDocMCP('smartsheet.add_records', {
      file_id: SMARTSHEET_FILE_ID,
      sheet_id: SMARTSHEET_SHEET_ID,
      records: records
    });

    if (result.error) {
      console.error('[sync-smartsheet] 错误:', result.error);
      return res.json({ ok: false, error: result.error.message || '同步失败' });
    }

    console.log('[sync-smartsheet] 同步成功');
    res.json({ ok: true, synced: records.length });
  } catch (e) {
    console.error('[sync-smartsheet] 异常:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== 工具函数 =====
function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ===== 启动 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Meme Bot API running on port ${PORT}`);
  console.log(`[API] MySQL: ${pool.pool.config.connectionConfig.host}:${pool.pool.config.connectionConfig.port}`);
});
