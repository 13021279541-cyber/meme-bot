const fs = require('fs');
const d = JSON.parse(fs.readFileSync('F:/meme-bot/memes_dump.json', 'utf8'));

const categoryMap = { wangzhe: '🎮 王者相关', 'public': '🌍 大众热点' };
const priorityMap = { red: '🔴 必上', orange: '🟠 推荐', blue: '🔵 可选' };

function buildRecord(m) {
  const fv = {
    '标题': [{ text: m.name, type: 'text' }],
    '分类': [{ text: categoryMap[m.category] }],
    '来源链接': [{ text: m.name, type: 'url', link: m.source_url }],
    '一句话概括': [{ text: m.summary ? m.summary : '', type: 'text' }],
    '录入日期': String(new Date(m.created_at).getTime())
  };
  const pri = priorityMap[m.priority];
  if (pri) fv['等级'] = [{ text: pri }];
  if (m.official_title || m.official_link) {
    fv['官号跟进'] = [{ text: [m.official_title, m.official_link].filter(Boolean).join(' '), type: 'text' }];
  }
  if (m.incentive_topic || m.incentive_link) {
    fv['作者激励'] = [{ text: [m.incentive_topic, m.incentive_link].filter(Boolean).join(' '), type: 'text' }];
  }
  return { field_values: fv };
}

for (let i = 0; i < d.length; i += 5) {
  const batch = d.slice(i, i + 5).map(buildRecord);
  const args = JSON.stringify({ file_id: 'JnhTgrmgdZGG', sheet_id: 't00i2h', records: batch });
  fs.writeFileSync(`F:/meme-bot/b${i}.json`, args);
  console.log(`b${i}.json: ${batch.length} records, ${args.length} bytes`);
}
