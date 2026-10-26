/**
 * 站名归一化（飞书申报表写入用）
 *
 * 背景：同一个站在「后端站表 / 前端系统 / 历史申报行」里存在多种写法，
 * 若不归一会导致：① 同站被当成两站；② 重复提交多出新行（10 月表照金站曾被写 3 行）。
 * 已知同站异名：
 *   id4  ：后端「汉中华山站」 = 前端系统「汉中」（历史行两种写法都出现过）
 *   id13 ：后端「王华宫站」   = 前端系统「玉华宫」
 *
 * 约定：**以 stationId 作为唯一匹配键**，站名展示以本文件的 STATIONS 为准（与历史行一致）。
 */

// 站列表（后端权威站表；/api/stations 与写入飞书都用它）
export const STATIONS = [
  { id: '1', name: '秦岭站' }, { id: '2', name: '宁陕站' }, { id: '3', name: '洋县站' },
  { id: '4', name: '汉中华山站' }, { id: '5', name: '富平站' }, { id: '6', name: '韩城站' },
  { id: '7', name: '富县站' }, { id: '8', name: '南沙站' }, { id: '9', name: '华山站' },
  { id: '10', name: '白河站' }, { id: '11', name: '旬阳站' }, { id: '12', name: '略阳站' },
  { id: '13', name: '王华宫站' }, { id: '14', name: '照金站' }, { id: '15', name: '天汉水城站' },
];

export const STATION_NAME_BY_ID = {};
const STATION_KEY_BY_NAME = {};
for (const s of STATIONS) {
  STATION_NAME_BY_ID[s.id] = s.name;
  STATION_KEY_BY_NAME[s.name.replace(/站$/, '')] = s.id;
}

// 前端站名 → 后端站 id（前端 benchmarkdata 的 name 与后端 STATIONS 存在差异）
export const STATION_NAME_ALIASES = {
  '汉中': '4',
  '汉中华山': '4',
  '玉华宫': '13',
  '王华宫': '13',
};

/** 站名 → 稳定匹配键（优先站 id；无法识别时回退到去掉「站」后缀的原名） */
export function stationKeyOf(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, '').replace(/站$/, '');
  if (!n) return '';
  return STATION_NAME_ALIASES[n] || STATION_KEY_BY_NAME[n] || n;
}

/** 写入用的规范站名：以 stationId 查站表为准（与历史行一致），查不到才用传入值补「站」 */
export function canonicalStationName(stationId, fallbackName) {
  if (stationId && STATION_NAME_BY_ID[stationId]) return STATION_NAME_BY_ID[stationId];
  const raw = String(fallbackName || '').trim();
  if (!raw) return `站${stationId ?? ''}`;
  return /站$/.test(raw) ? raw : `${raw}站`;
}

/**
 * 在已有表行里定位同站行
 * @param {any[][]} rows A:J 的二维数组（第 0 行是表头）
 * @param {string} wantKey stationKeyOf() 结果
 * @returns {{targetRow:number,lastFilled:number}} targetRow 为 1-based 行号，0=未命中
 */
export function locateStationRow(rows, wantKey) {
  let targetRow = 0;
  let lastFilled = 1; // 第 1 行是表头
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const a = r[0] == null ? '' : String(r[0]).trim();
    const b = r[1] == null ? '' : String(r[1]).trim();
    if (a !== '' || b !== '') lastFilled = i + 1;
    if (wantKey && b && stationKeyOf(b) === wantKey) targetRow = i + 1; // 同站取最后一条
  }
  return { targetRow, lastFilled };
}
