#!/usr/bin/env node
/**
 * Supabase 保活脚本
 *
 * 背景：Supabase 免费版项目连续 7 天无任何数据库活动会被自动暂停（Paused），
 * 长期不恢复则可能被回收删除。2026-08-17 素材库项目即因此失效过一次。
 *
 * 原理：对每个项目发起一次极轻量的真实数据库查询（select id limit 1），
 * 触发 Postgres 活动记录，重置 7 天倒计时。单次请求 < 1KB，无副作用。
 *
 * 用法：
 *   node keepalive.js            正常执行并输出结果
 *   node keepalive.js --quiet    仅在异常时输出（适合定时任务）
 *
 * 退出码：0 = 全部正常；1 = 存在失败项目
 */

const PROJECTS = [
  {
    name: '素材库原型',
    url: 'https://vgvauvfjhgsitwjenjfu.supabase.co',
    key: 'sb_publishable_KERONz0Oc55E1Y_2u3Oh_Q_-2SyD40-',
    table: 'materials',
  },
  {
    name: 'meme-web 热梗中心',
    url: 'https://iwmvtizwcibusjjiquwq.supabase.co',
    key: process.env.MEME_WEB_ANON_KEY || '',
    table: 'memes',
    // key 为空时自动从 meme-web 的 .env.local 读取
    envFile: 'e:/官号流程统筹/meme-web/.env.local',
    envKey: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  },
];

const TIMEOUT_MS = 30000;
const RETRY = 2;
const QUIET = process.argv.includes('--quiet');

function log(...args) {
  if (!QUIET) console.log(...args);
}

function readEnvKey(file, key) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(file)) return '';
    const line = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(key + '='));
    if (!line) return '';
    return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

async function ping(project) {
  let key = project.key;
  if (!key && project.envFile) key = readEnvKey(project.envFile, project.envKey);
  if (!key) return { ok: false, reason: '缺少 API Key，无法探测' };

  const endpoint = `${project.url}/rest/v1/${project.table}?select=id&limit=1`;

  for (let attempt = 1; attempt <= RETRY; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(endpoint, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (res.ok) return { ok: true, ms, status: res.status };
      const body = (await res.text()).slice(0, 200);
      if (attempt === RETRY) return { ok: false, status: res.status, reason: body || `HTTP ${res.status}` };
    } catch (e) {
      clearTimeout(timer);
      // Node fetch 会把真实网络错误包在 cause 里，需一并展开才能准确判因
      const parts = [];
      let cur = e;
      for (let depth = 0; cur && depth < 4; depth++) {
        if (cur.code) parts.push(String(cur.code));
        if (cur.message) parts.push(String(cur.message));
        cur = cur.cause;
      }
      const msg = parts.join(' | ') || String(e);

      // DNS 不存在 → 项目已被删除，重试无意义，立即上报
      if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
        return { ok: false, reason: '域名解析失败，项目可能已被删除或网络异常', fatal: true, detail: msg };
      }
      if (e && e.name === 'AbortError') {
        if (attempt === RETRY) return { ok: false, reason: `请求超时（>${TIMEOUT_MS / 1000}s）` };
      } else if (attempt === RETRY) {
        return { ok: false, reason: msg };
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, reason: '未知失败' };
}

(async () => {
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  log(`[${stamp}] Supabase 保活检查开始`);

  const failures = [];
  for (const p of PROJECTS) {
    const r = await ping(p);
    if (r.ok) {
      log(`  ✅ ${p.name} — 正常（${r.ms}ms）`);
    } else {
      failures.push({ name: p.name, ...r });
      console.error(`  ❌ ${p.name} — ${r.reason}`);
    }
  }

  if (failures.length === 0) {
    log(`[${stamp}] 全部 ${PROJECTS.length} 个项目保活成功`);
    process.exit(0);
  }

  console.error(`[${stamp}] ${failures.length}/${PROJECTS.length} 个项目异常，需人工处理：`);
  failures.forEach((f) => {
    console.error(`  · ${f.name}：${f.reason}`);
    if (f.fatal) console.error('    → 请登录 https://supabase.com/dashboard 检查项目是否被删除');
  });
  process.exit(1);
})();
