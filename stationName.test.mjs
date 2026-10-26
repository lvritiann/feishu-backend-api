/**
 * 站名归一化单测：node --test server/stationName.test.mjs
 * 重点验证「同站异名必须归一」且「异站不能被误并」（汉中 vs 华山是两座站）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATIONS, stationKeyOf, canonicalStationName, locateStationRow } from './stationName.mjs';

test('stationKeyOf：站名/去后缀/空值', () => {
  assert.equal(stationKeyOf('秦岭站'), '1');
  assert.equal(stationKeyOf('秦岭'), '1');
  assert.equal(stationKeyOf('  秦岭 站 '), '1');
  assert.equal(stationKeyOf(''), '');
  assert.equal(stationKeyOf(null), '');
  assert.equal(stationKeyOf(undefined), '');
});

test('stationKeyOf：同站异名归一到同一键', () => {
  // id4：后端「汉中华山站」 / 前端「汉中」
  assert.equal(stationKeyOf('汉中华山站'), '4');
  assert.equal(stationKeyOf('汉中华山'), '4');
  assert.equal(stationKeyOf('汉中'), '4');
  assert.equal(stationKeyOf('汉中站'), '4');
  // id13：后端「王华宫站」 / 前端「玉华宫」
  assert.equal(stationKeyOf('王华宫站'), '13');
  assert.equal(stationKeyOf('玉华宫站'), '13');
  assert.equal(stationKeyOf('玉华宫'), '13');
});

test('stationKeyOf：汉中(4) 与 华山(9) 是不同的站，绝不可并', () => {
  assert.equal(stationKeyOf('汉中'), '4');
  assert.equal(stationKeyOf('华山站'), '9');
  assert.notEqual(stationKeyOf('汉中'), stationKeyOf('华山站'));
});

test('stationKeyOf：未收录站名回退为去后缀原名（不丢数据）', () => {
  assert.equal(stationKeyOf('新开服务站'), '新开服务');
});

test('canonicalStationName：以站 id 为准，与历史行一致', () => {
  assert.equal(canonicalStationName('4', '汉中'), '汉中华山站');
  assert.equal(canonicalStationName('13', '玉华宫'), '王华宫站');
  assert.equal(canonicalStationName('1', '秦岭'), '秦岭站');
  // id 无法识别时回退到传入站名并补「站」
  assert.equal(canonicalStationName('99', '某某'), '某某站');
  assert.equal(canonicalStationName('99', '某某站'), '某某站');
  assert.equal(canonicalStationName('', ''), '站');
});

test('locateStationRow：10月表形态（含照金 3 行）', () => {
  // 复刻 10 月申报表 A:J（只留序号/站名，其余用占位）
  const rows = [
    ['序号', '站名', '9月实际(万元)'],
    ['1', '富平站', '8.75'],
    ['2', '洋县站', '5.05'],
    ['6', '华山站', '3.42'],
    ['7', '秦岭站', '8.79'],
    ['9', '王华宫站', '0.93'],
    ['13', '照金站', '0.3'],
    ['14', '汉中华山站', '9.3'],
    ['15', '略阳站', '0.48'],
    ['16', '照金站', '1'],
    ['17', '照金站', '1'],
  ];
  // 照金重复提交 → 命中最后一条（行 11），而不是新增第 12 行
  assert.deepEqual(locateStationRow(rows, stationKeyOf('照金站')), { targetRow: 11, lastFilled: 11 });
  // 前端叫「汉中」→ 命中历史行「汉中华山站」（行 8）
  assert.equal(locateStationRow(rows, stationKeyOf('汉中')).targetRow, 8);
  // 前端叫「玉华宫」→ 命中历史行「王华宫站」（行 6）
  assert.equal(locateStationRow(rows, stationKeyOf('玉华宫')).targetRow, 6);
  // 「华山站」只命中自己的行（行 4），不能串到汉中华山
  assert.equal(locateStationRow(rows, stationKeyOf('华山站')).targetRow, 4);
  // 新站 → 追加到 12 行
  assert.deepEqual(locateStationRow(rows, stationKeyOf('宁陕站')), { targetRow: 0, lastFilled: 11 });
  // 空键不做匹配，避免把空行当同站
  assert.equal(locateStationRow(rows, '').targetRow, 0);
});

test('locateStationRow：空表只有表头 → 追加第 2 行', () => {
  const rows = [['序号', '站名', '10月实际(万元)', '11月非油申报']];
  assert.deepEqual(locateStationRow(rows, stationKeyOf('秦岭站')), { targetRow: 0, lastFilled: 1 });
});

test('STATIONS 完整性：15 站 id 唯一、站名唯一', () => {
  assert.equal(STATIONS.length, 15);
  assert.equal(new Set(STATIONS.map((s) => s.id)).size, 15);
  assert.equal(new Set(STATIONS.map((s) => s.name)).size, 15);
});
