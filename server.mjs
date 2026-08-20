/**
 * 非油销量预测 - 云端部署服务器
 * 功能：
 * 1. 静态托管 dist/client（前端 SPA）
 * 2. POST /api/apply/submit — 油站填报提交，支持 Kdocs/飞书/腾讯文档
 * 3. GET  /api/stations      — 返回可用站列表
 * 4. GET  /api/feishu/config — 返回飞书配置状态
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

// 加载 .env 文件
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(PROJECT_ROOT, '.env'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist', 'client');
const PORT = Number(process.env.PORT) || 8787;
const SERVE_STATIC = fs.existsSync(DIST); // 有 dist/client 才托管前端

// 文档平台配置
const DOC_PLATFORM = process.env.DOC_PLATFORM || 'kdocs';
const KDOCS_TOKEN = process.env.KDOCS_TOKEN || '';
const KDOCS_FILE_ID = process.env.KDOCS_FILE_ID || 'vMk7j4NSyrMdJM73iujs1xCTiwQgHY66A';
const KDOCS_SHEET_ID = Number(process.env.KDOCS_SHEET_ID) || 3;
const KDOCS_API_BASE = 'https://kdocs.cn/open/api/v1';

// 飞书配置
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_SPREADSHEET_ID = process.env.FEISHU_SPREADSHEET_ID || '';
const FEISHU_BITABLE_APP_ID = process.env.FEISHU_BITABLE_APP_ID || '';
const FEISHU_BITABLE_TABLE_ID = process.env.FEISHU_BITABLE_TABLE_ID || '';
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

// 腾讯文档配置
const TENCENT_APP_ID = process.env.TENCENT_APP_ID || '';
const TENCENT_APP_SECRET = process.env.TENCENT_APP_SECRET || '';
const TENCENT_SPREADSHEET_ID = process.env.TENCENT_SPREADSHEET_ID || '';
const TENCENT_API_BASE = 'https://open.feishu.cn/open-apis';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// 站列表（供多维表格显示用）
const STATIONS = [
  { id: '1', name: '秦岭站' }, { id: '2', name: '宁陕站' }, { id: '3', name: '洋县站' },
  { id: '4', name: '汉中华山站' }, { id: '5', name: '富平站' }, { id: '6', name: '韩城站' },
  { id: '7', name: '富县站' }, { id: '8', name: '南沙站' }, { id: '9', name: '华山站' },
  { id: '10', name: '白河站' }, { id: '11', name: '旬阳站' }, { id: '12', name: '略阳站' },
  { id: '13', name: '王华宫站' }, { id: '14', name: '照金站' }, { id: '15', name: '天汉水城站' },
];

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  let filePath = path.join(DIST, urlPath);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }

  if (filePath.endsWith('index.html')) {
    let html = fs.readFileSync(filePath, 'utf-8');
    if (!html.includes('window.__CLOUD__')) {
      html = html.replace('</head>', '<script>window.__CLOUD__ = true;</script></head>');
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

async function getFeishuAccessToken() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    throw new Error('FEISHU_APP_ID 或 FEISHU_APP_SECRET 未配置');
  }
  const url = `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`获取飞书 Token 失败: ${data.msg}`);
  }
  return data.tenant_access_token;
}

async function feishuAddRow(rowData) {
  const token = await getFeishuAccessToken();

  // 优先走普通表格（sheet）模式 —— 支持 wiki 内的电子表格
  if (FEISHU_SPREADSHEET_ID) {
    const SP = FEISHU_SPREADSHEET_ID;

    // 1. 动态获取第一个工作表的 sheetId（wiki sheet 必须用 worksheetId 寻址）
    const metaRes = await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/metainfo`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const metaData = await metaRes.json();
    if (metaData.code !== 0) throw new Error(`飞书表格元信息失败: ${metaData.msg}`);
    const wsId = metaData.data?.sheets?.[0]?.sheetId;
    if (!wsId) throw new Error('无法获取飞书工作表 ID');

    // 2. 读取 A 列（序号）确定最后有数据的行
    const readRes = await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/values/${wsId}!A1:A200`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const readData = await readRes.json();
    const rows = readData.data?.valueRange?.values || [];
    let lastFilled = 1; // 第1行是表头
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i][0] != null && String(rows[i][0]).trim() !== '') lastFilled = i + 1;
    }
    const nextRow = lastFilled + 1;

    // 序号自动填充（数据行号 = nextRow - 1）
    if (Array.isArray(rowData) && (rowData[0] === '' || rowData[0] == null)) {
      rowData[0] = String(nextRow - 1);
    }

    // 3. PUT 写入下一行（range 放 body，避免 URL 中 : 和 ! 编码问题）
    const writeRes = await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/values`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        valueRange: {
          range: `${wsId}!A${nextRow}:J${nextRow}`,
          values: [rowData],
        },
      }),
    });
    const writeData = await writeRes.json();
    if (writeData.code !== 0) throw new Error(`飞书写入失败: ${writeData.msg}`);
    return writeData;
  }

  // 备选：多维表格模式
  if (FEISHU_BITABLE_APP_ID && FEISHU_BITABLE_TABLE_ID) {
    const url = `${FEISHU_API_BASE}/bitable/v1/apps/${FEISHU_BITABLE_APP_ID}/tables/${FEISHU_BITABLE_TABLE_ID}/records`;
