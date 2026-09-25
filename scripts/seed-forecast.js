// 生成演示用的「预报」入库流量：按实测值加确定性的相对偏差，可重复执行（幂等）
// 用法：node scripts/seed-forecast.js
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

// 确定性伪随机（固定种子，多次运行结果一致）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 相对偏差循环：大部分落在 ±20% 内，少数超出（用于演示命中/未命中与偏差最大天）
const DEVIATION_PATTERN = [
  0.05, -0.08, 0.12, -0.15, 0.03, 0.22, -0.06, 0.09, -0.18, 0.14,
  -0.04, 0.26, -0.11, 0.07, -0.02, 0.31, -0.24, 0.1, -0.13, 0.45,
];

// 演示「缺预报」：这些实测天故意不生成预报
const SKIP_FORECAST = { 'res-0001': ['2026-06-03', '2026-09-12'] };
// 演示「缺实测」：这一天只有预报没有实测
const FORECAST_ONLY = [{ reservoirId: 'res-0002', date: '2026-05-16', flow: 47.5 }];

function main() {
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const rand = mulberry32(20260924);

  // 幂等：先清掉旧的预报记录
  data.inflows = (data.inflows || []).filter((r) => String(r.type || '实测') !== '预报');

  let maxId = 0;
  for (const r of data.inflows) {
    const m = String(r.id || '').match(/(\d+)$/);
    if (m) maxId = Math.max(maxId, Number(m[1]));
  }

  const actuals = data.inflows
    .filter((r) => r.reservoirId && r.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.reservoirId < b.reservoirId ? -1 : 1));

  let index = 0;
  const made = [];
  for (const rec of actuals) {
    const skip = (SKIP_FORECAST[rec.reservoirId] || []).includes(rec.date);
    if (skip) continue;
    const deviation = DEVIATION_PATTERN[index % DEVIATION_PATTERN.length];
    const jitter = (rand() - 0.5) * 0.04;
    const flow = Math.max(0, Math.round(Number(rec.flow) * (1 + deviation + jitter) * 10) / 10);
    maxId += 1;
    made.push({
      id: 'in-' + String(maxId).padStart(4, '0'),
      reservoirId: rec.reservoirId,
      date: rec.date,
      flow,
      type: '预报',
      operator: '预报员',
      remark: '短期来水预报',
    });
    index += 1;
  }

  for (const extra of FORECAST_ONLY) {
    maxId += 1;
    made.push({
      id: 'in-' + String(maxId).padStart(4, '0'),
      reservoirId: extra.reservoirId,
      date: extra.date,
      flow: extra.flow,
      type: '预报',
      operator: '预报员',
      remark: '短期来水预报',
    });
  }

  data.inflows = data.inflows.concat(made);
  data.settings = Object.assign(
    { forecastTolerancePct: 20, forecastToleranceFlow: 10, forecastPassPct: 80 },
    data.settings || {}
  );

  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
  console.log('已生成预报记录 ' + made.length + ' 条（实测 ' + actuals.length + ' 条，缺预报 ' +
    Object.values(SKIP_FORECAST).reduce((s, list) => s + list.length, 0) + ' 天，仅预报 ' + FORECAST_ONLY.length + ' 天）');
}

main();
