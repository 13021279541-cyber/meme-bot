const https = require('https');
const fs = require('fs');

const TOKEN = 'f1e30d2488ad48bb97ebde568900cb8f';
const FILE_ID = 'JnhTgrmgdZGG';
const SHEET_ID = 't00i2h';

function callMCP(method, params) {
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
        'Authorization': TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Step 1: 重命名「文本」→「梗名称」
  console.log('Step 1: Renaming "文本" to "梗名称"...');
  const renameResult = await callMCP('smartsheet.update_fields', {
    file_id: FILE_ID,
    sheet_id: SHEET_ID,
    fields: [{
      field_id: 'fkfKit',
      field_title: '梗名称',
      field_type: 1
    }]
  });
  console.log('Rename result:', JSON.stringify(renameResult).substring(0, 200));
  await sleep(500);

  // Step 2: 删掉默认无用字段（单选f0JNov、数字f2cnP7、日期fHSMJO、图片fZeyBi）
  console.log('\nStep 2: Deleting default fields...');
  const deleteResult = await callMCP('smartsheet.delete_fields', {
    file_id: FILE_ID,
    sheet_id: SHEET_ID,
    field_ids: ['f0JNov', 'f2cnP7', 'fHSMJO', 'fZeyBi']
  });
  console.log('Delete result:', JSON.stringify(deleteResult).substring(0, 200));
  await sleep(500);

  // Step 3: 删掉默认空行
  console.log('\nStep 3: Listing and deleting default rows...');
  const listResult = await callMCP('smartsheet.list_records', {
    file_id: FILE_ID,
    sheet_id: SHEET_ID,
    limit: 100
  });
  
  let defaultRecords;
  if (listResult.result && listResult.result.structuredContent) {
    defaultRecords = listResult.result.structuredContent.records || [];
  } else {
    const text = listResult.result?.content?.[0]?.text;
    if (text) defaultRecords = JSON.parse(text).records || [];
    else defaultRecords = [];
  }
  
  console.log('Default rows found:', defaultRecords.length);
  if (defaultRecords.length > 0) {
    const idsToDelete = defaultRecords.map(r => r.record_id);
    console.log('Deleting rows:', idsToDelete);
    const delRowResult = await callMCP('smartsheet.delete_records', {
      file_id: FILE_ID,
      sheet_id: SHEET_ID,
      record_ids: idsToDelete
    });
    console.log('Delete rows result:', JSON.stringify(delRowResult).substring(0, 200));
    await sleep(500);
  }

  // Step 4: 插入所有记录（用「梗名称」替代「标题」）
  const allRecords = JSON.parse(fs.readFileSync('F:/meme-bot/all_records.json', 'utf8'));
  
  // 把 field key 从「标题」改为「梗名称」
  const fixedRecords = allRecords.map(r => {
    const fv = {};
    for (const [k, v] of Object.entries(r.field_values)) {
      if (k === '标题') {
        fv['梗名称'] = v;
      } else {
        fv[k] = v;
      }
    }
    return { field_values: fv };
  });

  console.log(`\nStep 4: Inserting ${fixedRecords.length} records in batches...`);
  
  const batchSize = 8;
  for (let i = 0; i < fixedRecords.length; i += batchSize) {
    const batch = fixedRecords.slice(i, i + batchSize);
    console.log(`\n  Batch ${Math.floor(i/batchSize) + 1}: records ${i}-${i + batch.length - 1}`);
    
    try {
      const result = await callMCP('smartsheet.add_records', {
        file_id: FILE_ID,
        sheet_id: SHEET_ID,
        records: batch
      });
      
      // Check for errors
      if (result.error) {
        console.log('  ERROR:', result.error.message);
      } else {
        const content = result.result?.structuredContent || {};
        const records = content.records || [];
        console.log(`  SUCCESS: ${records.length} records inserted`);
      }
    } catch (err) {
      console.error('  Network error:', err.message);
    }
    
    await sleep(1500); // 1.5s between batches
  }

  console.log('\nDone!');
}

main().catch(console.error);
