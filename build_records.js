const fs = require('fs');
const d = JSON.parse(fs.readFileSync('F:/meme-bot/memes_dump.json', 'utf8'));

const categoryMap = { wangzhe: '🎮 王者相关', public: '🌍 大众热点' };
const priorityMap = { red: '🔴 必上', orange: '🟠 推荐', blue: '🔵 可选' };

// 注意：灰色不在单选选项里，之前add_fields只加了红橙蓝，需要跳过或加灰色
// 先不传灰色等级

const records = d.map(m => {
  const fv = {
    '标题': [{ text: m.name, type: 'text' }],
    '分类': [{ text: categoryMap[m.category] || '' }],
    '来源链接': [{ text: m.name, type: 'url', link: m.source_url }],
    '一句话概括': [{ text: m.summary || '', type: 'text' }],
    '录入日期': String(new Date(m.created_at).getTime())
  };

  // 等级：只有红橙蓝才填，灰色跳过
  const pri = priorityMap[m.priority];
  if (pri) {
    fv['等级'] = [{ text: pri }];
  }

  if (m.official_title || m.official_link) {
    const parts = [];
    if (m.official_title) parts.push(m.official_title);
    if (m.official_link) parts.push(m.official_link);
    fv['官号跟进'] = [{ text: parts.join(' '), type: 'text' }];
  }

  if (m.incentive_topic || m.incentive_link) {
    const parts = [];
    if (m.incentive_topic) parts.push(m.incentive_topic);
    if (m.incentive_link) parts.push(m.incentive_link);
    fv['作者激励'] = [{ text: parts.join(' '), type: 'text' }];
  }

  return { field_values: fv };
});

// 分批，每批10条
const batchSize = 10;
for (let i = 0; i < records.length; i += batchSize) {
  const batch = records.slice(i, i + batchSize);
  const filename = `F:/meme-bot/batch_${Math.floor(i / batchSize)}.json`;
  fs.writeFileSync(filename, JSON.stringify(batch, null, 2));
  console.log(`Batch ${Math.floor(i / batchSize)}: ${batch.length} records -> ${filename}`);
}

console.log(`Total: ${records.length} records in ${Math.ceil(records.length / batchSize)} batches`);
