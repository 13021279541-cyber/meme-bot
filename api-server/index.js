/**
 * 热梗自动化 API 中间层
 * 部署在 DevCloud CVM，连接内网 MySQL
 * 供前端页面 + 企微智能机器人调用
 */
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ===== 静态文件托管（前端页面） =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== MySQL 连接池 =====
const pool = mysql.createPool({
  host: process.env.DB_HOST || '9.134.177.112',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'GEAKV*2543cebw',
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

// ===== 企微 Webhook 代理 =====
app.post('/webhook/wecom', async (req, res) => {
  try {
    const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=348c0b28-1605-47e6-8956-06c81a04d446';
    const https = require('https');
    const url = new URL(webhookUrl);
    
    const postData = JSON.stringify(req.body);
    
    const result = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(JSON.parse(data)));
      });
      request.on('error', reject);
      request.write(postData);
      request.end();
    });
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Meme Bot API running on port ${PORT}`);
  console.log(`[API] MySQL: ${pool.pool.config.connectionConfig.host}:${pool.pool.config.connectionConfig.port}`);
});
