// 预报入库流量与实测入库流量的对照评估：配对、偏差、旬月汇总、命中判定、内容指纹都集中在这里
const crypto = require('crypto');
const { AppError } = require('./errors');
const store = require('./store');

// 1 m³/s 流一天的水量（万m³）：流量 × 86400 秒 ÷ 10000
const FLOW_TO_WAN = 86400 / 10000;

function toWan(flow) {
  return Number(flow) * FLOW_TO_WAN;
}

function pct(part, whole) {
  return whole ? store.round((part / whole) * 100, 1) : null;
}

// 命中判定（口径四）：|预报 − 实测| ≤ max(允许绝对偏差流量, 实测 × 允许相对偏差%)
function judge(forecast, actual, settings) {
  const absDev = Math.abs(Number(forecast) - Number(actual));
  const limit = Math.max(
    Number(settings.forecastToleranceFlow),
    (Number(actual) * Number(settings.forecastTolerancePct)) / 100
  );
  return { absDev, limit, hit: absDev <= limit };
}

// 按 水库+日期 把「预报」与「实测」入库流量配对；同库同日多条各自求和
function pairDaily(data, reservoirId, from, to) {
  const byDate = new Map();
  for (const r of data.inflows) {
    if (reservoirId && r.reservoirId !== reservoirId) continue;
    if (from && r.date < from) continue;
    if (to && r.date > to) continue;
    const isForecast = String(r.type || '实测') === '预报';
    let bucket = byDate.get(r.date);
    if (!bucket) {
      bucket = { date: r.date, forecast: 0, actual: 0, forecastCount: 0, actualCount: 0 };
      byDate.set(r.date, bucket);
    }
    if (isForecast) {
      bucket.forecast += Number(r.flow);
      bucket.forecastCount += 1;
    } else {
      bucket.actual += Number(r.flow);
      bucket.actualCount += 1;
    }
  }
  const rows = [];
  for (const b of byDate.values()) {
    rows.push({
      date: b.date,
      hasForecast: b.forecastCount > 0,
      hasActual: b.actualCount > 0,
      forecast: store.round(b.forecast, 2),
      actual: store.round(b.actual, 2),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

// 给每日对照行补上偏差与命中判定；只有一边的天数不参与偏差统计
function decorateDaily(rows, settings) {
  return rows.map((r) => {
    const base = Object.assign({}, r, { weightWan: store.round(toWan(r.actual), 3) });
    if (!r.hasForecast || !r.hasActual) {
      return Object.assign(base, {
        paired: false,
        absDev: null,
        relDevPct: null,
        weightedAbsDevWan: null,
        hit: null,
        hitLimit: null,
        note: !r.hasForecast ? '缺预报' : '缺实测',
      });
    }
    const dev = store.round(r.forecast - r.actual, 2);
    const rel = r.actual !== 0 ? store.round((dev / r.actual) * 100, 1) : null;
    const j = judge(r.forecast, r.actual, settings);
    return Object.assign(base, {
      paired: true,
      absDev: dev,
      relDevPct: rel,
      weightedAbsDevWan: store.round(toWan(Math.abs(dev)), 3),
      hit: j.hit,
      hitLimit: store.round(j.limit, 2),
      note: '',
    });
  });
}

// 按量加权相对偏差：Σ(实测水量 × |当日相对偏差|) ÷ Σ实测水量
function weightedAbsRelPct(rows) {
  const relRows = rows.filter((r) => r.paired && r.relDevPct !== null);
  const denom = relRows.reduce((s, r) => s + r.weightWan, 0);
  if (denom <= 0) return null;
  return store.round(relRows.reduce((s, r) => s + r.weightWan * Math.abs(r.relDevPct), 0) / denom, 1);
}

// 日口径评估统计：偏大偏小天数与占比、平均绝对相对偏差、命中率与合格结论
function dailyStats(rows, settings) {
  const paired = rows.filter((r) => r.paired);
  const n = paired.length;
  const over = paired.filter((r) => r.absDev > 0).length;
  const under = paired.filter((r) => r.absDev < 0).length;
  const rels = paired.filter((r) => r.relDevPct !== null).map((r) => Math.abs(r.relDevPct));
  const meanAbsRelPct = rels.length ? store.round(rels.reduce((s, x) => s + x, 0) / rels.length, 1) : null;
  const hitDays = paired.filter((r) => r.hit).length;
  const hitRatePct = pct(hitDays, n);
  const passPct = Number(settings.forecastPassPct);
  const pass = n ? hitRatePct >= passPct : null;
  return {
    days: n,
    forecastOnlyDays: rows.filter((r) => r.hasForecast && !r.hasActual).length,
    actualOnlyDays: rows.filter((r) => r.hasActual && !r.hasForecast).length,
    overDays: over,
    underDays: under,
    equalDays: n - over - under,
    overPct: pct(over, n),
    underPct: pct(under, n),
    meanAbsRelPct,
    weightedAbsRelPct: weightedAbsRelPct(rows),
    hitDays,
    missDays: n - hitDays,
    hitRatePct,
    passPct,
    pass,
    conclusion: n
      ? (pass ? '达到' : '未达到') + '：命中率 ' + hitRatePct + '%' + (pass ? ' ≥ ' : ' < ') + '合格线 ' + passPct + '%'
      : '没有预报与实测都有的天，无法评估',
  };
}

// 旬的划分：1–10 日上旬、11–20 日中旬、21 日至月末下旬
function xunKey(date) {
  const day = Number(date.slice(8, 10));
  return date.slice(0, 7) + (day <= 10 ? '-上旬' : day <= 20 ? '-中旬' : '-下旬');
}

function monthKey(date) {
  return date.slice(0, 7);
}

// 旬/月对照：只统计预报与实测都有的天，流量折成水量（万m³）再比
function periodRows(daily, settings, keyFn) {
  const groups = new Map();
  for (const r of daily) {
    const key = keyFn(r.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rows = [];
  for (const [key, list] of groups) {
    const paired = list.filter((r) => r.paired);
    const forecastWan = store.round(paired.reduce((s, r) => s + toWan(r.forecast), 0), 3);
    const actualWan = store.round(paired.reduce((s, r) => s + toWan(r.actual), 0), 3);
    const devWan = store.round(forecastWan - actualWan, 3);
    const relPct = actualWan !== 0 ? store.round((devWan / actualWan) * 100, 1) : null;
    // 期命中：|偏差水量| ≤ max(允许绝对偏差流量 × 天数折水量, 实测水量 × 允许相对偏差%)
    const limitWan = Math.max(
      toWan(Number(settings.forecastToleranceFlow)) * paired.length,
      (actualWan * Number(settings.forecastTolerancePct)) / 100
    );
    const dates = list.map((r) => r.date).sort();
    rows.push({
      key,
      label: key + '（' + dates[0].slice(5) + '～' + dates[dates.length - 1].slice(5) + '）',
      days: list.length,
      pairedDays: paired.length,
      forecastWan,
      actualWan,
      absDevWan: devWan,
      relDevPct: relPct,
      weightedAbsRelPct: weightedAbsRelPct(paired),
      hit: paired.length ? Math.abs(devWan) <= limitWan : null,
      hitLimitWan: store.round(limitWan, 3),
    });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

// 旬/月口径评估统计：把每个旬/月当作一个样本
function periodStats(rows, settings) {
  const n = rows.length;
  const over = rows.filter((r) => r.absDevWan > 0).length;
  const under = rows.filter((r) => r.absDevWan < 0).length;
  const rels = rows.filter((r) => r.relDevPct !== null).map((r) => Math.abs(r.relDevPct));
  const meanAbsRelPct = rels.length ? store.round(rels.reduce((s, x) => s + x, 0) / rels.length, 1) : null;
  const denom = rows.reduce((s, r) => s + r.actualWan, 0);
  const weighted =
    denom > 0
      ? store.round(
          rows.filter((r) => r.relDevPct !== null).reduce((s, r) => s + r.actualWan * Math.abs(r.relDevPct), 0) / denom,
          1
        )
      : null;
  const hitPeriods = rows.filter((r) => r.hit === true).length;
  const hitRatePct = pct(hitPeriods, n);
  const passPct = Number(settings.forecastPassPct);
  const pass = n ? hitRatePct >= passPct : null;
  return {
    periods: n,
    pairedDays: rows.reduce((s, r) => s + r.pairedDays, 0),
    overPeriods: over,
    underPeriods: under,
    equalPeriods: n - over - under,
    overPct: pct(over, n),
    underPct: pct(under, n),
    meanAbsRelPct,
    weightedAbsRelPct: weighted,
    hitPeriods,
    missPeriods: n - hitPeriods,
    hitRatePct,
    passPct,
    pass,
    conclusion: n
      ? (pass ? '达到' : '未达到') + '：命中率 ' + hitRatePct + '%' + (pass ? ' ≥ ' : ' < ') + '合格线 ' + passPct + '%'
      : '没有可对照的时段，无法评估',
  };
}

// 偏差最大的若干天：按 |绝对偏差| 从大到小，偏差相同按日期从前到后（结果确定）
function topDays(daily, top) {
  return daily
    .filter((r) => r.paired)
    .slice()
    .sort((a, b) => {
      const d = Math.abs(b.absDev) - Math.abs(a.absDev);
      if (d !== 0) return d;
      return a.date < b.date ? -1 : 1;
    })
    .slice(0, top)
    .map((r, index) => ({
      rank: index + 1,
      date: r.date,
      forecast: r.forecast,
      actual: r.actual,
      absDev: r.absDev,
      relDevPct: r.relDevPct,
      hit: r.hit,
    }));
}

// 口径文字：页面逐条展示，判定参数随设置联动
function caliberLines(settings) {
  const tolFlow = Number(settings.forecastToleranceFlow);
  const tolPct = Number(settings.forecastTolerancePct);
  const passPct = Number(settings.forecastPassPct);
  return [
    '配对：按 水库 + 日期 把类型为「预报」与「实测」的入库流量配对，同库同日多条各自求和；只有一边的天数（缺预报 / 缺实测）单独计数，不参与偏差统计。',
    '绝对偏差 = 预报 − 实测（正为预报偏大，负为偏小）；相对偏差 = 绝对偏差 ÷ 实测 × 100%。',
    '按量加权相对偏差 = Σ(实测水量 × |当日相对偏差|) ÷ Σ实测水量；水量按 流量 × 86400 秒 ÷ 10000 折成万m³。',
    '命中判定：|预报 − 实测| ≤ max(允许绝对偏差 ' + tolFlow + ' m³/s，实测 × 允许相对偏差 ' + tolPct + '%)；旬/月按偏差水量判定，允许绝对偏差水量 = ' + tolFlow + ' m³/s × 86400 × 对照天数 ÷ 10000 万m³。',
    '合格结论：命中率 ≥ 合格线 ' + passPct + '% 判「达到」，否则判「未达到」。',
    '旬的划分：1–10 日上旬、11–20 日中旬、21 日至月末下旬；旬/月对照只统计预报与实测都有的天。',
    '同一批数据重复评估结果一致：内容指纹（对评估结果整体算的 SHA-1）不变即一致。',
  ];
}

// 内容指纹：对查询条件、判定参数与全部评估结果算 SHA-1，重复评估可比对
function checksumOf(payload) {
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function parseQuery(data, query) {
  const q = query || {};
  const reservoirId = String(q.reservoirId || '').trim();
  if (reservoirId && !data.reservoirs.some((r) => r.id === reservoirId)) {
    throw new AppError(404, 'RESERVOIR_NOT_FOUND', '这个水库不存在');
  }
  const from = String(q.from || '').trim();
  const to = String(q.to || '').trim();
  const errors = {};
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) errors.from = '起始日期格式不对';
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) errors.to = '结束日期格式不对';
  if (from && to && to < from) errors.to = '结束日期不能早于起始日期';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '评估条件没通过校验，请按提示补齐', errors);
  }
  let top = Number(q.top === undefined || q.top === '' ? 5 : q.top);
  if (!Number.isInteger(top) || top < 1 || top > 20) top = 5;
  return { reservoirId, from, to, top };
}

function runEval(data, q, settings) {
  const daily = decorateDaily(pairDaily(data, q.reservoirId, q.from, q.to), settings);
  const xun = periodRows(daily, settings, xunKey);
  const month = periodRows(daily, settings, monthKey);
  const reservoir = q.reservoirId ? data.reservoirs.find((r) => r.id === q.reservoirId) : null;
  const result = {
    query: { reservoirId: q.reservoirId, reservoirName: reservoir ? reservoir.name : '全部水库', from: q.from, to: q.to, top: q.top },
    rules: {
      forecastTolerancePct: Number(settings.forecastTolerancePct),
      forecastToleranceFlow: Number(settings.forecastToleranceFlow),
      forecastPassPct: Number(settings.forecastPassPct),
    },
    caliber: caliberLines(settings),
    daily: { rows: daily, stats: dailyStats(daily, settings) },
    xun: { rows: xun, stats: periodStats(xun, settings) },
    month: { rows: month, stats: periodStats(month, settings) },
    topDays: topDays(daily, q.top),
  };
  result.checksum = checksumOf(result);
  return result;
}

function evaluate(data, query) {
  return runEval(data, parseQuery(data, query), data.settings);
}

// 试算：同一批数据按改动前后的判定范围各评一次，给出对照与判定翻转清单
function whatif(data, query) {
  const q = parseQuery(data, query);
  const after = Object.assign({}, data.settings);
  const overrides = { forecastTolerancePct: 'tolerancePct', forecastToleranceFlow: 'toleranceFlow', forecastPassPct: 'passPct' };
  const errors = {};
  for (const key of Object.keys(overrides)) {
    const raw = query[overrides[key]];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (key !== 'forecastToleranceFlow' && value > 100)) {
      errors[overrides[key]] = '要填不小于 0 的数字' + (key === 'forecastToleranceFlow' ? '' : '（0～100）');
    } else {
      after[key] = value;
    }
  }
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '试算的判定范围没通过校验，请按提示补齐', errors);
  }
  const before = runEval(data, q, data.settings);
  const next = runEval(data, q, after);

  function flips(beforeRows, afterRows, keyOf) {
    const afterMap = new Map(afterRows.map((r) => [keyOf(r), r.hit]));
    return beforeRows
      .filter((r) => r.hit !== null && afterMap.get(keyOf(r)) !== undefined && afterMap.get(keyOf(r)) !== r.hit)
      .map((r) => ({ key: keyOf(r), from: r.hit ? '命中' : '未命中', to: afterMap.get(keyOf(r)) ? '命中' : '未命中' }));
  }

  return {
    before,
    after: next,
    changes: {
      daily: flips(before.daily.rows, next.daily.rows, (r) => r.date),
      xun: flips(before.xun.rows, next.xun.rows, (r) => r.key),
      month: flips(before.month.rows, next.month.rows, (r) => r.key),
    },
  };
}

module.exports = { evaluate, whatif };
