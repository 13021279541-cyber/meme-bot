/**
 * 为 public/uploads/ 下缺失缩略图的梗图批量生成缩略图
 *
 * 背景：2026-11-03 存量图片从 Supabase 迁回本地时为原图直搬（平均约 1.2MB），
 *       未生成缩略图。前端列表虽会按 `xxx_thumb.ext` 约定优先取缩略图，
 *       取不到则 onerror 回落原图 —— 结果列表页仍要加载约 640MB 原图。
 *       本脚本补齐缩略图，使列表加载量降至约 1/50，无需改动数据库。
 *
 * 用法（在 CVM 的 /root/api-server 目录下执行）：
 *   node make-thumbs.js --dry-run   试运行，只统计待处理数量
 *   node make-thumbs.js             正式生成
 *
 * 依赖：优先 sharp；无 sharp 时自动降级调用系统 ImageMagick（convert/magick）。
 *       两者都没有时给出安装提示并退出，不做任何破坏性操作。
 *
 * 特性：可重复执行（已有缩略图自动跳过）；单张失败不中断；只新增 _thumb 文件，
 *       不修改、不删除任何原图，不触碰数据库。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const MAX_EDGE = 400;        // 缩略图最长边
const QUALITY = 80;          // JPEG 质量
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;

const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ===== 选择可用的图片处理后端 =====
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* 降级 ImageMagick */ }

let imCmd = null;
if (!sharp) {
  for (const cmd of ['convert', 'magick']) {
    try {
      execFileSync(cmd, ['-version'], { stdio: 'ignore' });
      imCmd = cmd;
      break;
    } catch (e) { /* 继续试下一个 */ }
  }
}

if (!sharp && !imCmd) {
  console.error('[FATAL] 未找到可用的图片处理工具。');
  console.error('  方案一（推荐）: cd /root/api-server && npm install sharp');
  console.error('  方案二: yum install -y ImageMagick   或   apt-get install -y imagemagick');
  process.exit(1);
}
log(`图片处理后端: ${sharp ? 'sharp' : 'ImageMagick (' + imCmd + ')'}`);

function thumbPathOf(file) {
  const ext = path.extname(file);
  return path.join(UPLOAD_DIR, path.basename(file, ext) + '_thumb' + ext);
}

async function makeThumb(srcAbs, dstAbs) {
  if (sharp) {
    let pipe = sharp(srcAbs)
      .rotate()                                            // 按 EXIF 自动纠正方向
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    // 输出格式必须与扩展名一致：前端按 `xxx_thumb.<原扩展名>` 推导地址，
    // 若内容与扩展名不符，express.static 会返回错误的 Content-Type
    const ext = path.extname(dstAbs).toLowerCase();
    if (ext === '.png') pipe = pipe.png({ compressionLevel: 9, palette: true });
    else if (ext === '.webp') pipe = pipe.webp({ quality: QUALITY });
    else if (ext === '.gif') pipe = pipe.gif();
    else pipe = pipe.jpeg({ quality: QUALITY });
    await pipe.toFile(dstAbs);
  } else {
    // ImageMagick 依据输出扩展名自动选择编码格式，无需显式指定
    execFileSync(imCmd, [
      srcAbs + '[0]',                                      // [0] 只取首帧，兼容 GIF
      '-auto-orient',
      '-resize', `${MAX_EDGE}x${MAX_EDGE}>`,               // '>' 表示只缩不放
      '-quality', String(QUALITY),
      dstAbs,
    ], { stdio: 'ignore', timeout: 60000 });
  }
}

(async () => {
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.error('[FATAL] 目录不存在:', UPLOAD_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => IMG_EXT.test(f) && !/_thumb\.[a-z0-9]+$/i.test(f));

  const todo = files.filter(f => !fs.existsSync(thumbPathOf(f)));

  log(`uploads 内原图 ${files.length} 张 | 已有缩略图 ${files.length - todo.length} 张 | 待生成 ${todo.length} 张`);

  if (!todo.length) { log('没有需要生成的缩略图，全部已就绪。'); return; }
  if (DRY_RUN) { log(`（--dry-run 模式，将生成 ${todo.length} 张，未做任何改动）`); return; }

  let ok = 0, srcBytes = 0, dstBytes = 0;
  const failed = [];

  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    const srcAbs = path.join(UPLOAD_DIR, f);
    const dstAbs = thumbPathOf(f);
    try {
      await makeThumb(srcAbs, dstAbs);
      if (!fs.existsSync(dstAbs) || fs.statSync(dstAbs).size === 0) throw new Error('产物为空');
      srcBytes += fs.statSync(srcAbs).size;
      dstBytes += fs.statSync(dstAbs).size;
      ok++;
      if (ok % 50 === 0 || i === todo.length - 1) log(`进度 ${i + 1}/${todo.length}（成功 ${ok}，失败 ${failed.length}）`);
    } catch (e) {
      failed.push({ file: f, error: e.message });
      try { if (fs.existsSync(dstAbs) && fs.statSync(dstAbs).size === 0) fs.unlinkSync(dstAbs); } catch (_) { }
    }
  }

  log('─'.repeat(50));
  log(`完成：成功 ${ok} 张，失败 ${failed.length} 张`);
  if (ok) {
    log(`原图合计 ${(srcBytes / 1024 / 1024).toFixed(1)}MB → 缩略图合计 ${(dstBytes / 1024 / 1024).toFixed(1)}MB`
      + `（压缩到 ${(dstBytes / srcBytes * 100).toFixed(1)}%）`);
  }
  if (failed.length) {
    const logFile = path.join(__dirname, 'make-thumbs-failed.json');
    fs.writeFileSync(logFile, JSON.stringify(failed, null, 2), 'utf-8');
    log(`失败明细已写入 ${logFile}`);
    failed.slice(0, 5).forEach(f => log(`  ❌ ${f.file} — ${f.error}`));
  }
  log('列表页会自动使用缩略图，无需改动数据库或重启服务。');
})();
