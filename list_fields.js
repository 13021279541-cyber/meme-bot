const https = require('https');

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

async function main() {
  // List fields
  console.log('=== Listing fields ===');
  const fieldsResult = await callMCP('smartsheet.list_fields', {
    file_id: FILE_ID,
    sheet_id: SHEET_ID,
    limit: 100,
    offset: 0
  });
  console.log(JSON.stringify(fieldsResult, null, 2));
}

main().catch(console.error);
