/**
 * 直接调用腾讯文档 SmartSheet OpenAPI 批量插入记录
 * 绕过 MCP，直接 HTTP 调用
 */
const https = require('https');
const fs = require('fs');

const TOKEN = 'f1e30d2488ad48bb97ebde568900cb8f';
const FILE_ID = 'JnhTgrmgdZGG';
const SHEET_ID = 't00i2h';

// 读取所有记录
const allRecords = JSON.parse(fs.readFileSync('F:/meme-bot/all_records.json', 'utf8'));

// MCP over SSE 方式不适合直接 HTTP 调用，用 JSON-RPC over HTTP
// 腾讯文档 MCP endpoint: https://docs.qq.com/openapi/mcp
// 但这是 MCP 协议 (JSON-RPC)，不是 REST API

// 构造 JSON-RPC 请求
async function callMCP(method, params) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: method,
      arguments: params
    }
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
        console.log('Response status:', res.statusCode);
        console.log('Response:', data.substring(0, 500));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`Inserting ${allRecords.length} records into smartsheet...`);
  
  // 分批插入，每批 8 条
  const batchSize = 8;
  for (let i = 0; i < allRecords.length; i += batchSize) {
    const batch = allRecords.slice(i, i + batchSize);
    console.log(`\nBatch ${Math.floor(i/batchSize) + 1}: records ${i} to ${i + batch.length - 1}`);
    
    try {
      const result = await callMCP('smartsheet.add_records', {
        file_id: FILE_ID,
        sheet_id: SHEET_ID,
        records: batch
      });
      console.log('Result:', typeof result === 'string' ? result.substring(0, 300) : JSON.stringify(result).substring(0, 300));
    } catch (err) {
      console.error('Error:', err.message);
    }
    
    // 等 1 秒再下一批
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);
