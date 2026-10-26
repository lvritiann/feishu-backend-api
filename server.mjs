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

// 文档平台路由：显式 DOC_PLATFORM 优先；未设置时按「已配置的凭据」自动判定
// （只要配了飞书表格 ID 就走飞书，避免环境变量缺失时静默误写到 kdocs）
const DOC_PLATFORM = process.env.DOC_PLATFORM || (FEISHU_SPREADSHEET_ID ? 'feishu' : 'kdocs');

// 腾讯文档配置
const TENCENT_APP_ID = process.env.TENCENT_APP_ID || '';
const TENCENT_APP_SECRET = process.env.TENCENT_APP_SECRET || '';
const TENCENT_SPREADSHEET_ID = process.env.TENCENT_SPREADSHEET_ID || '';
const TENCENT_API_BASE = 'https://open.feishu.cn/open-apis';

// 前端入口短链接：/go 或 /apply → 302 跳转到前端页面（前端地址变了只改这个变量）
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://nonoil-forecast-42019.app.workbuddy.host/';

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

// 站列表与站名归一化：抽到 stationName.mjs（可被单测覆盖）
import {
  STATIONS,
  stationKeyOf,
  canonicalStationName,
  locateStationRow,
} from './stationName.mjs';


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

async function feishuAddRow(rowData, opts = {}) {
  const token = await getFeishuAccessToken();
  const authH = { 'Authorization': `Bearer ${token}` };

  // 优先走普通表格（sheet）模式 —— 支持 wiki 内的电子表格
  if (FEISHU_SPREADSHEET_ID) {
    const SP = FEISHU_SPREADSHEET_ID;

    // 1. 取元信息并选定工作表：优先标题含「{declMonth}月」；找不到则自动新建当月工作表
    const readMeta = async () => {
      const r = await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/metainfo`, { headers: authH });
      const j = await r.json();
      if (j.code !== 0) throw new Error(`飞书表格元信息失败: ${j.msg}`);
      return j.data?.sheets || [];
    };

    const kw = opts.monthLabel ? String(opts.monthLabel) : ''; // 例：'10月'
    // 优先精确匹配「{kw}申报」，再回退到「标题含 kw」，避免命中「11月汇总」这类同月别名表
    const exactTitle = `${kw}申报`;
    const pickSheet = (list) =>
      kw
        ? (list.find((s) => String(s.title || '').trim() === exactTitle) ||
           list.find((s) => String(s.title || '').includes(kw)))
        : list[0];
    let sheets = await readMeta();
    let target = pickSheet(sheets);

    // 当月工作表不存在 → 自动新建，并按申报月份写表头（保证列结构与写入顺序一致）
    if (!target && kw) {
      const prevM = (Number(kw.replace(/[^\d]/g, '')) || 1) - 1;
      const title = `${kw}申报`;
      const header = [
        '序号', '站名', `${prevM}月实际(万元)`,
        `${kw}非油申报`, `${kw}烟草申报`, `${kw}去化`,
        '综合毛利率%', '判定', '填报时间', '申报理由',
      ];
      const addRes = await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/sheets_batch_update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title, index: sheets.length } } }] }),
      });
      const addData = await addRes.json();
      if (addData.code !== 0) throw new Error(`飞书新建工作表失败: ${addData.msg}`);
      const newId = addData.data?.replies?.[0]?.addSheet?.properties?.sheetId;
      if (!newId) throw new Error('飞书新建工作表后未取得 sheetId');
      await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/values`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ valueRange: { range: `${newId}!A1:J1`, values: [header] } }),
      });
      console.log(`[apply/submit] 已自动新建工作表「${title}」并写入表头`);
      sheets = await readMeta();
      target = pickSheet(sheets);
    }

    // 有申报月份却选不到工作表 → 直接报错，绝不静默回退到 sheets[0]（否则会把 11 月写进 10 月表）
    if (!target) throw new Error(`未找到/未能创建「${kw}」工作表，为避免写错表已中止`);
    const wsId = target.sheetId;
    if (!wsId) throw new Error('无法获取飞书工作表 ID');

    // 2. 读取 A:J（序号 + 站名 + 数值），按站名定位已存在行
    //    —— 同站重复提交必须「就地更新」，不能再追加新行（10 月表照金站曾被写 3 行）
    const readRes = await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/values/${wsId}!A1:J200`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const readData = await readRes.json();
    const rows = readData.data?.valueRange?.values || [];

    const wantKey = stationKeyOf(rowData[1]);
    const { targetRow, lastFilled } = locateStationRow(rows, wantKey);

    const mode = targetRow > 0 ? 'update' : 'insert';
    const writeRow = targetRow > 0 ? targetRow : lastFilled + 1;
    // 更新时保留原序号（避免与历史行号错位）；新增时按行号自动补
    if (Array.isArray(rowData)) {
      const oldNo = targetRow > 0 ? (rows[targetRow - 1] || [])[0] : null;
      if (oldNo != null && String(oldNo).trim() !== '') {
        rowData[0] = String(oldNo).trim();
      } else if (rowData[0] === '' || rowData[0] == null) {
        rowData[0] = String(writeRow - 1);
      }
    }

    // 3. PUT 写入目标行（range 放 body，避免 URL 中 : 和 ! 编码问题）
    const writeRes = await fetch(`${FEISHU_API_BASE}/sheets/v2/spreadsheets/${SP}/values`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        valueRange: {
          range: `${wsId}!A${writeRow}:J${writeRow}`,
          values: [rowData],
        },
      }),
    });
    const writeData = await writeRes.json();
    if (writeData.code !== 0) throw new Error(`飞书写入失败: ${writeData.msg}`);
    console.log(`[apply/submit] ${mode === 'update' ? '就地更新' : '新增'}「${target.title}」第 ${writeRow} 行（站名键 ${wantKey}）`);
    return { mode, row: writeRow, sheet: target.title };
  }

  // 备选：多维表格模式
  if (FEISHU_BITABLE_APP_ID && FEISHU_BITABLE_TABLE_ID) {
    const url = `${FEISHU_API_BASE}/bitable/v1/apps/${FEISHU_BITABLE_APP_ID}/tables/${FEISHU_BITABLE_TABLE_ID}/records`;
    const writeRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ fields: rowData }),
    });
    const writeData = await writeRes.json();
    if (writeData.code !== 0) throw new Error(`飞书多维表格写入失败: ${writeData.msg}`);
    return writeData;
  }

  throw new Error('未配置飞书写入目标（FEISHU_SPREADSHEET_ID 或 FEISHU_BITABLE_APP_ID）');
}

async function kdocsAddRow(rowData) {
  if (!KDOCS_TOKEN) throw new Error('KDOCS_TOKEN 未配置');
  const url = `${KDOCS_API_BASE}/sheet/add_row`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KDOCS_TOKEN}` },
    body: JSON.stringify({ file_id: KDOCS_FILE_ID, worksheet_id: KDOCS_SHEET_ID, range_data: rowData }),
  });
  const result = await response.json();
  if (!result.success && result.code !== 0) throw new Error(result.message || 'Kdocs API 错误');
  return result;
}

/**
 * 东八区时间字符串（YYYY/M/D HH:mm:ss）
 *
 * ⚠️ 必须显式 +8h，不能用 `new Date().toLocaleString('zh-CN')`：
 * 该方法取「服务器本地时区」，而 Render / 多数云容器默认 TZ=UTC，
 * 会把北京时间减 8 小时写进飞书（如北京 20:37 记成 12:37），
 * 且北京时间 0:00~7:59 的提交会被记成「前一天」，按日期核对时会误判。
 * 这里用 getUTC* + 固定偏移，既不依赖容器 TZ，也不依赖 Node 的 ICU 时区库。
 */
function beijingTimeString(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

// 重复写入拦截：同一油站 + 相同申报数值，60s 内连续重复提交直接拦截（防双击/网络重试造成的飞书重复写入）
const DEDUPE_WINDOW_MS = 60 * 1000;
const recentSubs = [];
const round2 = (v) => Math.round((parseFloat(String(v)) || 0) * 100) / 100;

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 油站填报提交接口
  if (url === '/api/apply/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      console.log('[debug] body length:', body.length, 'raw:', body.slice(0, 100));
      try {
        const data = JSON.parse(body);
        const { stationId, stationName, declMonth, augRef, nonOil, tobacco, offload, reason, marginRate, judgment } = data;

        if (!stationId || nonOil == null) {
          sendJson(res, 400, { ok: false, error: '缺少必填字段' });
          return;
        }

        // 重复写入拦截：同站 + 相同数值，60s 内连续重复提交 → 拦截（不影响修正后重新申报）
        const now = Date.now();
        while (recentSubs.length && now - recentSubs[0].ts > DEDUPE_WINDOW_MS) recentSubs.shift();
        const subKey = `${stationId}|${round2(nonOil)}|${round2(tobacco ?? 0)}|${round2(offload ?? 0)}`;
        if (recentSubs.some((r) => r.key === subKey && now - r.ts < DEDUPE_WINDOW_MS)) {
          console.log('[apply/submit] 拦截重复提交:', subKey);
          sendJson(res, 409, {
            ok: false,
            duplicate: true,
            error: '检测到重复提交（60 秒内相同内容已写入），已拦截。如确需修改请调整数值后重新提交。',
          });
          return;
        }
        recentSubs.push({ key: subKey, ts: now });

        let rowData;
        if (FEISHU_SPREADSHEET_ID) {
          // 普通表格模式（sheet）：10 列，顺序必须与目标工作表表头严格一致——
          // 序号 / 站名 / 上月实际(万元) / 非油申报 / 烟草申报 / 去化 / 综合毛利率% / 判定 / 填报时间 / 申报理由
          const mLabel = declMonth ? `${declMonth}月` : '';
          // 站名以 stationId 查服务端站表为准（stationName 仅作兜底），
          // 保证「汉中/汉中华山」「玉华宫/王华宫」等同站异名始终写成同一个名字，不会分裂成两行
          const stationNameFinal = canonicalStationName(stationId, stationName);
          // 判定：兼容中文直传（正常/偏低/偏高）与英文枚举（ok/low/high）
          const judgmentMap = { 'ok': '正常', 'low': '偏低', 'high': '偏高' };
          const judgmentCn = judgmentMap[String(judgment)] ?? String(judgment ?? '');
          rowData = [
            '',                                          // 序号（服务器自动填充）
            stationNameFinal,                            // 站名
            String(augRef ?? ''),                        // 上月实际(万元)
            String(nonOil),                              // mLabel 非油申报
            String(tobacco ?? 0),                        // mLabel 烟草申报
            String(offload ?? 0),                        // mLabel 去化
            String(marginRate ?? ''),                    // 综合毛利率%
            judgmentCn,                                  // 判定
            beijingTimeString(),                          // 填报时间（东八区，显式 +8h）
            String(reason ?? ''),                        // 申报理由
          ];
          console.log(`[apply/submit] 目标工作表: ${mLabel} / 站: ${stationNameFinal}`);
        } else if (FEISHU_BITABLE_APP_ID && FEISHU_BITABLE_TABLE_ID) {
          const fields = {};
          // 文本字段：存入站名 + 非油申报量 + 判定结果
          const station = STATIONS.find(s => s.id === stationId);
          const stationName = station ? station.name : `站${stationId}`;
          fields['文本'] = `${stationName} | 非油:${nonOil}万 | 烟草:${tobacco??0}万 | 去化:${offload??0}万`;
          // 单选项：normal/low/high → 正常/偏低/偏高
          const judgmentMap = { 'ok': '正常', 'low': '偏低', 'high': '偏高' };
          fields['单选'] = judgmentMap[String(judgment) ?? 'ok'] || '正常';
          // 日期字段：Unix timestamp
          fields['日期'] = Math.floor(Date.now() / 1000);
          rowData = fields;
        } else {
          rowData = [];
        }

        let writeInfo = null;
        if (DOC_PLATFORM === 'feishu') {
          // 按申报月份定位/自动新建对应工作表（如「11月申报」）；同站已有行则就地更新
          writeInfo = await feishuAddRow(rowData, { monthLabel: declMonth ? `${declMonth}月` : '' });
        } else {
          writeInfo = await kdocsAddRow(rowData);
        }
        // 把「更新/新增 + 工作表 + 行号」回传前端，方便站点确认是覆盖还是新建
        sendJson(res, 200, { ok: true, ...(writeInfo && typeof writeInfo === 'object' ? writeInfo : {}) });
      } catch (e) {
        console.error('[apply/submit] error:', e.message);
        sendJson(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // 飞书配置端点
  if (url === '/api/feishu/config' && req.method === 'GET') {
    sendJson(res, 200, {
      enabled: !!(FEISHU_BITABLE_APP_ID || FEISHU_SPREADSHEET_ID),
      spreadsheetId: FEISHU_SPREADSHEET_ID,
      bitableAppId: FEISHU_BITABLE_APP_ID,
      bitableTableId: FEISHU_BITABLE_TABLE_ID,
      platform: DOC_PLATFORM,
    });
    return;
  }

  // 站列表接口
  if (url === '/api/stations' && req.method === 'GET') {
    sendJson(res, 200, {
      stations: [
        { id: '1', name: '秦岭站' }, { id: '2', name: '宁陕站' }, { id: '3', name: '洋县站' },
        { id: '4', name: '汉中华山站' }, { id: '5', name: '富平站' }, { id: '6', name: '韩城站' },
        { id: '7', name: '富县站' }, { id: '8', name: '南沙站' }, { id: '9', name: '华山站' },
        { id: '10', name: '白河站' }, { id: '11', name: '旬阳站' }, { id: '12', name: '略阳站' },
        { id: '13', name: '王华宫站' }, { id: '14', name: '照金站' }, { id: '15', name: '天汉水城站' },
      ],
    });
    return;
  }

  // 前端入口短链接：/go 或 /apply → 302 跳转到前端页面
  if ((url === '/go' || url === '/apply') && req.method === 'GET') {
    res.writeHead(302, { 'Location': FRONTEND_URL });
    res.end();
    return;
  }

  if (SERVE_STATIC) {
    serveStatic(req, res);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`[cloud] NonOil forecast running at http://localhost:${PORT}`);
  console.log(`[cloud] Document platform: ${DOC_PLATFORM}`);
  console.log(`[cloud] Feishu Bitable: ${FEISHU_BITABLE_APP_ID ? '✓' : '✗'} (${FEISHU_BITABLE_APP_ID}/${FEISHU_BITABLE_TABLE_ID})`);
});

server.on('error', (e) => {
  console.error('[server error]', e.code, e.message);
});
