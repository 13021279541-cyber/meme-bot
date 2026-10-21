/**
 * 存量图片迁移脚本：Supabase Storage → CVM 本地磁盘
 *
 * 背景：2026-10-21 Supabase 免费版出站流量配额耗尽（exceed_egress_quota），
 *       Storage 读写全部被限流。新图已改存本地，本脚本负责把存量图片搬回来。
 *
 * 用法（在 CVM 的 /root/api-server 目录下执行）：
 *   node migrate-images.js --check     只探测 Supabase 是否已恢复，不做任何改动
 *   node migrate-images.js --dry-run   试运行，列出待迁移数量但不下载、不改库
 *   node migrate-images.js             正式迁移
 *
 * 特性：
 *   - 可重复执行：已迁移（image_path 以 / 开头）的记录自动跳过，支持断点续传
 *   - 失败不中断：单张失败记入 migrate-images-failed.json，不影响其余记录
 *   - 先落盘再改库：下载成功才更新数据库，避免数据库指向不存在的文件
 */

try { require('dotenv').config(); } catch (e) { /* 可选 */ }
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const FAILED_LOG = path.join(__dirname, 'migrate-images-failed.json');
const CONCURRENCY = 3;          // 并发下载数，别太高以免被限流
const RETRY = 2;                // 单张失败重试次数

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CHECK_ONLY = args.includes('--check');

if (!process.env.DB_PASS) {
  console.error('[FATAL] 环境变量 DB_PASS 未设置，请在 /root/api-server/.env 中配置');
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '9.134.177.112',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'meme_bot',
  charset: 'utf8mb4',
  connectionLimit: 5
});

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// 下载单张图片，返回 Buffer
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers: { 'User-Agent': 'MemeBot-Migrate/1.0' }, timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return download(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode === 402) {
        res.resume();
        return reject(new Error('QUOTA_EXCEEDED'));   // 配额仍未恢复
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    req.on('error', reject);
  });
}

// 探测 Supabase 是否已恢复服务
async function checkQuota(sampleUrl) {
  if (!sampleUrl) return { ok: false, reason: '没有存量 Supabase 图片可供探测' };
  try {
    await download(sampleUrl);
    return { ok: true };
  } catch (e) {
    if (e.message === 'QUOTA_EXCEEDED') return { ok: false, reason: 'Supabase 流量配额仍未恢复（HTTP 402）' };
    return { ok: false, reason: e.message };
  }
}

async function migrateOne(row) {
  const { id, image_path } = row;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    try {
      const { buffer, contentType } = await download(image_path);
      if (!buffer.length) throw new Error('下载内容为空');

      let ext = path.extname(image_path.split('?')[0]).toLowerCase();
      if (!ext || ext.length > 5) ext = contentType.includes('png') ? '.png' : '.jpg';

      const filename = `meme_migrated_${id}_${Date.now()}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);

      const newPath = '/uploads/' + filename;
      await pool.query('UPDATE memes SET image_path = ? WHERE id = ?', [newPath, id]);
      return { id, ok: true, newPath, size: buffer.length };
    } catch (e) {
      lastErr = e;
      if (e.message === 'QUOTA_EXCEEDED') throw e;   // 配额问题直接中止整轮
      if (attempt < RETRY) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { id, ok: false, error: lastErr.message, url: image_path };
}

(async () => {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const [rows] = await pool.query(
      "SELECT id, name, image_path FROM memes WHERE image_path LIKE 'http%' ORDER BY id"
    );
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM memes');
    const [[{ done }]] = await pool.query(
      "SELECT COUNT(*) AS done FROM memes WHERE image_path LIKE '/uploads/%'"
    );

    log(`梗总数 ${total} 条 | 已在本地 ${done} 条 | 待迁移 ${rows.length} 条`);

    if (rows.length === 0) {
      log('没有需要迁移的图片，全部已在本地。');
      await pool.end();
      return;
    }

    const probe = await checkQuota(rows[0].image_path);
    if (!probe.ok) {
      log(`⚠️  Supabase 当前不可用：${probe.reason}`);
      log('   配额恢复后重新执行本脚本即可，已迁移的记录不会重复处理。');
      await pool.end();
      process.exit(2);
    }
    log('✅ Supabase 可访问，开始迁移');

    if (CHECK_ONLY) { log('（--check 模式，不执行迁移）'); await pool.end(); return; }
    if (DRY_RUN) { log(`（--dry-run 模式，将迁移 ${rows.length} 条，未做任何改动）`); await pool.end(); return; }

    const failed = [];
    let okCount = 0, bytes = 0, index = 0;

    async function worker() {
      while (index < rows.length) {
        const row = rows[index++];
        const n = index;
        const r = await migrateOne(row);
        if (r.ok) {
          okCount++; bytes += r.size;
          log(`[${n}/${rows.length}] ✅ #${r.id} → ${r.newPath} (${(r.size / 1024).toFixed(0)}KB)`);
        } else {
          failed.push(r);
          log(`[${n}/${rows.length}] ❌ #${r.id} ${r.error}`);
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } catch (e) {
      if (e.message === 'QUOTA_EXCEEDED') {
        log('⚠️  迁移过程中触发流量配额限制，已中止。稍后重新执行可从断点继续。');
      } else throw e;
    }

    log('─'.repeat(50));
    log(`迁移完成：成功 ${okCount} 条，失败 ${failed.length} 条，共 ${(bytes / 1024 / 1024).toFixed(1)}MB`);
    if (failed.length) {
      fs.writeFileSync(FAILED_LOG, JSON.stringify(failed, null, 2), 'utf-8');
      log(`失败明细已写入 ${FAILED_LOG}`);
    }
    await pool.end();
  } catch (e) {
    console.error('[FATAL]', e.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
