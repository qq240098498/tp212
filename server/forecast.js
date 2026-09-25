// 预报入库流量与实测入库流量的对照评估，口径集中在这里
// 配对：同一水库、同一天同时有预报与实测才算一个对照日
// 偏差：绝对偏差 = 预报 - 实测；相对偏差 = (预报 - 实测) / 实测 × 100%
// 按量加权偏差：以当天实测流量为权重，对各日相对偏差加权平均
// 命中：|相对偏差| 不超过允许范围 forecastAllowancePct（实测为 0 时，预报也为 0 才算命中）
const crypto = require('crypto');
const store = require('./store');
const { AppError } = require('./errors');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 预报记录的增删查 ----------

function findReservoir(data, reservoirId) {
  const found = data.reservoirs.find((r) => r.id === reservoirId);
  if (!found) throw new AppError(404, 'RESERVOIR_NOT_FOUND', '这个水库不存在');
  return found;
}

function listForecasts(data, query) {
  const q = query || {};
  let rows = data.forecasts.slice();
  if (q.reservoirId) rows = rows.filter((r) => r.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((r) => r.date >= q.from);
  if (q.to) rows = rows.filter((r) => r.date <= q.to);
  return rows
    .map((r) => {
      const reservoir = data.reservoirs.find((x) => x.id === r.reservoirId);
      return Object.assign({}, r, { reservoirName: reservoir ? reservoir.name : '' });
    })
    .sort((a, b) => (a.date === b.date ? (a.reservoirId < b.reservoirId ? -1 : 1) : a.date < b.date ? 1 : -1));
}

// 同一水库同一天的预报只保留一条：重复登记按覆盖处理
function saveForecast(data, payload) {
  const reservoir = findReservoir(data, String(payload.reservoirId || '').trim());
  const date = String(payload.date || '').trim();
  const flow = Number(payload.flow);
  const errors = {};
  if (!DATE_RE.test(date)) errors.date = '日期要按 年-月-日 填';
  if (!Number.isFinite(flow) || flow < 0) errors.flow = '预报流量要填非负数字';
  const leadDays = Number(payload.leadDays);
  if (payload.leadDays !== undefined && (!Number.isFinite(leadDays) || leadDays < 0 || Math.floor(leadDays) !== leadDays)) {
    errors.leadDays = '预见期要填非负整数（天）';
  }
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '预报记录没通过校验，请按提示补齐', errors);
  }
  const existing = data.forecasts.find((r) => r.reservoirId === reservoir.id && r.date === date);
  if (existing) {
    existing.flow = flow;
    existing.leadDays = payload.leadDays === undefined ? existing.leadDays : leadDays;
    existing.source = String(payload.source || existing.source || '短期预报');
    existing.operator = String(payload.operator === undefined ? existing.operator : payload.operator).trim();
    existing.remark = String(payload.remark === undefined ? existing.remark : payload.remark);
    return { updated: true, record: decorateForecast(data, existing) };
  }
  const record = {
    id: store.nextId('fc', data.forecasts),
    reservoirId: reservoir.id,
    date,
    flow,
    leadDays: payload.leadDays === undefined ? 1 : leadDays,
    source: String(payload.source || '短期预报'),
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.forecasts.push(record);
  return { updated: false, record: decorateForecast(data, record) };
}

function decorateForecast(data, record) {
  const reservoir = data.reservoirs.find((x) => x.id === record.reservoirId);
  return Object.assign({}, record, { reservoirName: reservoir ? reservoir.name : '' });
}

function removeForecast(data, id) {
  const found = data.forecasts.find((r) => r.id === id);
  if (!found) throw new AppError(404, 'FORECAST_NOT_FOUND', '这条预报记录不存在');
  data.forecasts = data.forecasts.filter((r) => r.id !== id);
  return { removed: id };
}

// ---------- 配对与评估 ----------

// 同库同日若有多条记录，取算术均值（正常数据一天一条）
function meanByDate(rows, reservoirId) {
  const map = new Map();
  for (const row of rows) {
    if (row.reservoirId !== reservoirId) continue;
    const bucket = map.get(row.date) || { sum: 0, count: 0 };
    bucket.sum += Number(row.flow);
    bucket.count += 1;
    map.set(row.date, bucket);
  }
  const out = new Map();
  for (const [date, bucket] of map) out.set(date, bucket.sum / bucket.count);
  return out;
}

function directionOf(dev) {
  if (dev > 0) return '偏大';
  if (dev < 0) return '偏小';
  return '持平';
}

function decadeOf(dateStr) {
  const day = Number(dateStr.slice(8, 10));
  const month = Number(dateStr.slice(5, 7));
  const index = day <= 10 ? 1 : day <= 20 ? 2 : 3;
  return {
    key: dateStr.slice(0, 7) + '-D' + index,
    index,
    label: dateStr.slice(0, 4) + '年' + month + '月' + (index === 1 ? '上旬' : index === 2 ? '中旬' : '下旬'),
  };
}

function monthOf(dateStr) {
  return { key: dateStr.slice(0, 7), label: dateStr.slice(0, 4) + '年' + Number(dateStr.slice(5, 7)) + '月' };
}

// 汇总一批对照日（一旬、一月或一库、或全部）
function summarize(rows, allowancePct) {
  const total = rows.length;
  let highDays = 0;
  let lowDays = 0;
  let evenDays = 0;
  let hitDays = 0;
  let absRelSum = 0; // 绝对相对偏差之和（实测为 0 的日子不参与）
  let relWeightedNum = 0; // Σ实测×相对偏差
  let absRelWeightedNum = 0; // Σ实测×|相对偏差|
  let weightSum = 0;
  let forecastSum = 0;
  let actualSum = 0;

  for (const row of rows) {
    forecastSum += row.forecast;
    actualSum += row.actual;
    if (row.direction === '偏大') highDays += 1;
    else if (row.direction === '偏小') lowDays += 1;
    else evenDays += 1;
    if (row.within) hitDays += 1;
    if (row.actual > 0) {
      absRelSum += row.absRelPct;
      relWeightedNum += row.actual * row.relPct;
      absRelWeightedNum += row.actual * row.absRelPct;
      weightSum += row.actual;
    }
  }

  const dev = store.round(forecastSum - actualSum, 2);
  const devPct = actualSum > 0 ? store.round((dev / actualSum) * 100, 2) : null;
  const mape = total ? store.round(absRelSum / total, 2) : null;
  const weightedApePct = weightSum > 0 ? store.round(absRelWeightedNum / weightSum, 2) : null;
  const weightedDevPct = weightSum > 0 ? store.round(relWeightedNum / weightSum, 2) : null;
  const missDays = total - hitDays;
  const hitRatePct = total ? store.round((hitDays / total) * 100, 1) : null;
  const highPct = total ? store.round((highDays / total) * 100, 1) : 0;
  const lowPct = total ? store.round((lowDays / total) * 100, 1) : 0;
  const evenPct = total ? store.round((evenDays / total) * 100, 1) : 0;
  const within = devPct === null ? null : Math.abs(devPct) <= allowancePct;

  return {
    total,
    highDays,
    lowDays,
    evenDays,
    highPct,
    lowPct,
    evenPct,
    hitDays,
    missDays,
    hitRatePct,
    forecastSum: store.round(forecastSum, 2),
    actualSum: store.round(actualSum, 2),
    dev,
    devPct,
    mape,
    weightedApePct,
    weightedDevPct,
    within,
  };
}

function conclusionText(name, s, allowancePct) {
  if (!s.total) return name + '在本时段没有可对照的天数。';
  const parts = [];
  parts.push('共配对 ' + s.total + ' 天：预报偏大 ' + s.highDays + ' 天（' + s.highPct + '%）、偏小 ' + s.lowDays + ' 天（' + s.lowPct + '%）'
    + (s.evenDays ? '、持平 ' + s.evenDays + ' 天' : ''));
  parts.push('平均绝对相对偏差 ' + s.mape + '%，按量加权平均绝对相对偏差 ' + s.weightedApePct + '%');
  parts.push('允许范围 ±' + allowancePct + '%，命中 ' + s.hitDays + ' 天（命中率 ' + s.hitRatePct + '%），失手 ' + s.missDays + ' 天');
  if (s.within === true) parts.push('时段总量相对偏差 ' + s.devPct + '%，落在允许范围内');
  else if (s.within === false) parts.push('时段总量相对偏差 ' + s.devPct + '%，超出允许范围');
  const bias = s.highDays > s.lowDays ? '系统偏大' : s.lowDays > s.highDays ? '系统偏小' : '偏大偏小各半';
  return name + '：' + parts.join('；') + '。总体' + bias + '。';
}

function buildPeriodGroups(daily, periodOf, allowancePct, reservoirOrder) {
  const buckets = new Map();
  for (const row of daily) {
    const period = periodOf(row.date);
    const key = row.reservoirId + '|' + period.key;
    if (!buckets.has(key)) {
      buckets.set(key, {
        reservoirId: row.reservoirId,
        reservoirName: row.reservoirName,
        key: period.key,
        label: period.label,
        rows: [],
      });
    }
    buckets.get(key).rows.push(row);
  }
  return Array.from(buckets.values())
    .map((g) => {
      const s = summarize(g.rows, allowancePct);
      const dates = g.rows.map((r) => r.date).sort();
      return Object.assign({
        fromDate: dates[0],
        toDate: dates[dates.length - 1],
      }, s, {
        reservoirId: g.reservoirId,
        reservoirName: g.reservoirName,
        period: g.label,
      });
    })
    .sort((a, b) => {
      const ra = reservoirOrder.indexOf(a.reservoirId);
      const rb = reservoirOrder.indexOf(b.reservoirId);
      if (ra !== rb) return ra - rb;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}

function evaluate(data, options) {
  const opts = options || {};
  const allowancePct = Number(opts.allowancePct !== undefined ? opts.allowancePct : data.settings.forecastAllowancePct);
  if (!Number.isFinite(allowancePct) || allowancePct < 0) {
    throw new AppError(400, 'VALIDATION_FAILED', '允许相对偏差要填不小于 0 的百分数', { allowancePct: '允许范围不对' });
  }
  let topN = Number(opts.topN || 10);
  if (!Number.isFinite(topN) || topN <= 0) topN = 10;
  topN = Math.min(50, Math.floor(topN));

  const from = opts.from || '';
  const to = opts.to || '';
  if (from && !DATE_RE.test(from)) throw new AppError(400, 'VALIDATION_FAILED', '起始日期格式不对', { from: '日期格式不对' });
  if (to && !DATE_RE.test(to)) throw new AppError(400, 'VALIDATION_FAILED', '结束日期格式不对', { to: '日期格式不对' });
  if (from && to && to < from) throw new AppError(400, 'VALIDATION_FAILED', '结束日期不能早于起始日期', { to: '结束日期不能早于起始日期' });

  const reservoirs = data.reservoirs.filter((r) => !opts.reservoirId || r.id === opts.reservoirId);
  const reservoirOrder = reservoirs.map((r) => r.id);

  // 逐日对照行
  const daily = [];
  reservoirs.forEach((reservoir) => {
    const forecastMap = meanByDate(data.forecasts, reservoir.id);
    const actualMap = meanByDate(data.inflows, reservoir.id);
    const dates = Array.from(forecastMap.keys()).filter((d) => actualMap.has(d));
    dates.sort();
    for (const date of dates) {
      if (from && date < from) continue;
      if (to && date > to) continue;
      const forecast = store.round(forecastMap.get(date), 2);
      const actual = store.round(actualMap.get(date), 2);
      const dev = store.round(forecast - actual, 2);
      const relPct = actual > 0 ? store.round((dev / actual) * 100, 2) : null;
      const absRelPct = relPct === null ? null : store.round(Math.abs(relPct), 2);
      const within = actual > 0 ? absRelPct <= allowancePct : forecast === 0;
      daily.push({
        reservoirId: reservoir.id,
        reservoirName: reservoir.name,
        date,
        forecast,
        actual,
        dev,
        absError: store.round(Math.abs(dev), 2),
        relPct,
        absRelPct,
        direction: directionOf(dev),
        within,
        allowancePct,
      });
    }
  });
  daily.sort((a, b) => (a.reservoirId === b.reservoirId
    ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    : reservoirOrder.indexOf(a.reservoirId) - reservoirOrder.indexOf(b.reservoirId)));

  const stats = summarize(daily, allowancePct);
  const perReservoir = reservoirs.map((reservoir) => {
    const rows = daily.filter((r) => r.reservoirId === reservoir.id);
    const s = summarize(rows, allowancePct);
    return Object.assign({}, s, {
      reservoirId: reservoir.id,
      reservoirName: reservoir.name,
      firstDate: rows.length ? rows[0].date : '',
      lastDate: rows.length ? rows[rows.length - 1].date : '',
      conclusion: conclusionText(reservoir.name, s, allowancePct),
    });
  }).filter((r) => r.total > 0);

  // 偏差最大的若干天：实测为 0 的日子不按相对偏差排名，排在最后
  const worst = daily.slice()
    .sort((a, b) => {
      if (a.absRelPct === null && b.absRelPct === null) return b.absError - a.absError;
      if (a.absRelPct === null) return 1;
      if (b.absRelPct === null) return -1;
      if (b.absRelPct !== a.absRelPct) return b.absRelPct - a.absRelPct;
      return b.absError - a.absError;
    })
    .slice(0, topN)
    .map((row, index) => Object.assign({ rank: index + 1 }, row));

  const decades = buildPeriodGroups(daily, decadeOf, allowancePct, reservoirOrder);
  const months = buildPeriodGroups(daily, monthOf, allowancePct, reservoirOrder);

  const result = {
    from: from || (daily.length ? daily[0].date : ''),
    to: to || (daily.length ? daily[daily.length - 1].date : ''),
    allowancePct,
    topN,
    pairedDays: daily.length,
    stats,
    conclusion: conclusionText('全部水库合计', stats, allowancePct),
    perReservoir,
    daily,
    decades,
    months,
    worst,
    fingerprint: '',
  };
  // 指纹覆盖除 fingerprint 外的全部结果：同一批数据、同一口径重复评估，指纹必须一致
  const { fingerprint: _ignored, ...stable } = result;
  result.fingerprint = crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  // 数据指纹只覆盖配对到的原始值（与允许范围无关）：用来判断两次评估是不是同一批数据
  const dataCore = daily.map((d) => [d.reservoirId, d.date, d.forecast, d.actual, d.dev, d.relPct]);
  result.dataFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ from: result.from, to: result.to, pairs: dataCore }))
    .digest('hex');
  return result;
}

module.exports = {
  listForecasts,
  saveForecast,
  removeForecast,
  evaluate,
};
