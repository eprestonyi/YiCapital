/* ═══════════════════════════════════════════════════════════════
   Yi Capital Analytics Engine (JS port of Yi_Capital_Manager_V2.py)
   - 解析基金 Excel（NAV Statement / Asset Position Record / Benchmark）
   - 計算與 Python PortfolioAnalyzer.calculate_metrics 完全一致的指標
   - 產出各圖表所需的數據序列（淨值、回撤、月度熱力、分佈、滾動、壓測）
   純函數、無 DOM 依賴；瀏覽器與 Node 皆可運行（Node 用於測試）。
   ═══════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YC = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TRADING_DAYS = 252;
  const RISK_FREE = 0.04;

  /* ───────────── 基礎統計 ───────────── */
  const sum = a => a.reduce((s, x) => s + x, 0);
  const mean = a => a.length ? sum(a) / a.length : 0;
  function std(a, ddof = 1) {            // pandas 默認 ddof=1（樣本標準差）
    const n = a.length; if (n <= ddof) return 0;
    const m = mean(a);
    return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (n - ddof));
  }
  function skewness(a) {                 // pandas/scipy 偏度（樣本校正，同 pd.Series.skew）
    const n = a.length; if (n < 3) return 0;
    const m = mean(a), s = std(a, 1); if (s === 0) return 0;
    const g = sum(a.map(x => ((x - m) / s) ** 3));
    return (n / ((n - 1) * (n - 2))) * g;
  }
  function excessKurtosis(a) {           // 同 pd.Series.kurt（Fisher，樣本校正）
    const n = a.length; if (n < 4) return 0;
    const m = mean(a), s2 = sum(a.map(x => (x - m) ** 2)) / (n - 1);
    if (s2 === 0) return 0;
    const m4 = sum(a.map(x => (x - m) ** 4));
    return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * (m4 / (s2 * s2)) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  }
  function quantile(a, q) {              // 線性插值，同 pandas quantile
    const s = [...a].sort((x, y) => x - y);
    if (!s.length) return NaN;
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  // 標準正態逆CDF（Acklam 算法，精度 ~1e-9）
  function normInv(p) {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425;
    let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const normPdf = x => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  // OLS 一元回歸 rp = α + β·rb（同 statsmodels）
  function ols(rp, rb) {
    const n = Math.min(rp.length, rb.length);
    if (n < 3) return { alpha: 0, beta: 0, r2: 0 };
    const x = rb.slice(0, n), y = rp.slice(0, n);
    const mx = mean(x), my = mean(y);
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const beta = sxx ? sxy / sxx : 0;
    const alpha = my - beta * mx;
    const r2 = (sxx && syy) ? (sxy * sxy) / (sxx * syy) : 0;
    return { alpha: alpha * TRADING_DAYS, beta, r2 };
  }

  /* ───────────── Excel 解析（rows = SheetJS sheet_to_json 的原始行陣列）───────────── */
  // Excel 序列日期 → ISO 字串
  function excelDate(v) {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number') { // Excel 1900 序列
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim().replace(/\//g, '-');
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const num = v => { const x = typeof v === 'string' ? parseFloat(v.replace(/[,%$]/g, '')) : Number(v); return isFinite(x) ? x : null; };

  // NAV Statement（表頭在第1行）: Date / Total Assets (USD) / ... / NAV per Unit (USD) / Fund Action Adjustment (USD) / Total Units / Cash Balance (USD) / Market Value (USD)
  function parseNavSheet(rows) {
    if (!rows || !rows.length) return [];
    const hdrIdx = rows.findIndex(r => r && r.some(c => String(c).trim() === 'Date'));
    if (hdrIdx < 0) return [];
    const hdr = rows[hdrIdx].map(c => String(c || '').trim());
    const col = name => hdr.findIndex(h => h === name);
    const iDate = col('Date'), iTA = col('Total Assets (USD)'), iTL = col('Total Liability (USD)'),
      iNV = col('Net Value (USD)'), iU = col('Total Units'), iNAV = col('NAV per Unit (USD)'),
      iAdj = col('Fund Action Adjustment (USD)'), iCash = col('Cash Balance (USD)'), iMV = col('Market Value (USD)');
    const out = [];
    for (let r = hdrIdx + 1; r < rows.length; r++) {
      const row = rows[r]; if (!row) continue;
      const date = excelDate(row[iDate]); const nav = num(row[iNAV]);
      if (!date || nav == null) continue;
      const units = iU >= 0 ? (num(row[iU]) || 0) : 0;
      const adj = iAdj >= 0 ? (num(row[iAdj]) || 0) : 0;
      const divAmt = Math.max(0, -adj);
      out.push({
        date, nav,
        totalAssets: iTA >= 0 ? num(row[iTA]) : null,
        totalLiability: iTL >= 0 ? num(row[iTL]) : null,
        netValue: iNV >= 0 ? num(row[iNV]) : null,
        units, divPerUnit: units > 0 ? divAmt / units : 0,
        cash: iCash >= 0 ? num(row[iCash]) : null,
        marketValue: iMV >= 0 ? num(row[iMV]) : null,
      });
    }
    out.sort((a, b) => a.date < b.date ? -1 : 1);
    return out;
  }

  // Asset Position Record（第1行為 as-of bar，第2行表頭）
  function parseAssetSheet(rows) {
    if (!rows || !rows.length) return { asOf: null, assets: [] };
    let asOf = null;
    const hdrIdx = rows.findIndex(r => r && r.some(c => String(c).trim() === 'Ticker'));
    if (hdrIdx > 0 && rows[0] && rows[0][1] != null) asOf = excelDate(rows[0][1]);
    if (hdrIdx < 0) return { asOf, assets: [] };
    const hdr = rows[hdrIdx].map(c => String(c || '').trim());
    const col = (...names) => { for (const n of names) { const i = hdr.indexOf(n); if (i >= 0) return i; } return -1; };
    const F = {
      ticker: col('Ticker'), name: col('Name', 'Asset Name'), qty: col('Quantity'), netCost: col('Net Cost (USD)'),
      price: col('Latest Price (USD)'), mv: col('Market Value (USD)'), w: col('Weight (%)'),
      buyCost: col('Total Buy Cost (USD)'), sellProceeds: col('Total Sell Proceeds (USD)'),
      div: col('Dividend Income (USD)'), pnl: col('Total P&L (USD)'),
      nomRet: col('Nominal Return (%)'), expRet: col('Exposure Return (%)'),
    };
    const assets = [];
    for (let r = hdrIdx + 1; r < rows.length; r++) {
      const row = rows[r]; if (!row) continue;
      const t = row[F.ticker]; if (t == null || String(t).trim() === '' || /^total/i.test(String(t))) continue;
      assets.push({
        ticker: String(t).trim(),
        name: F.name >= 0 && row[F.name] != null ? String(row[F.name]).trim() : String(t).trim(),
        qty: num(row[F.qty]), netCost: num(row[F.netCost]), price: num(row[F.price]),
        marketValue: num(row[F.mv]) || 0, weight: num(row[F.w]),
        buyCost: num(row[F.buyCost]), sellProceeds: num(row[F.sellProceeds]),
        dividend: num(row[F.div]), pnl: num(row[F.pnl]),
        nominalReturn: num(row[F.nomRet]), exposureReturn: num(row[F.expRet]),
      });
    }
    // 單位自適應：權重/收益率若以小數存儲（如 0.0356 = 3.56%），統一換算為百分數
    const maxW = Math.max(0, ...assets.map(a => Math.abs(a.weight ?? 0)));
    if (maxW > 0 && maxW <= 1.5) assets.forEach(a => { if (a.weight != null) a.weight *= 100; });
    const maxR = Math.max(0, ...assets.map(a => Math.abs(a.exposureReturn ?? 0)), ...assets.map(a => Math.abs(a.nominalReturn ?? 0)));
    if (maxR > 0 && maxR <= 3) assets.forEach(a => {
      if (a.exposureReturn != null) a.exposureReturn *= 100;
      if (a.nominalReturn != null) a.nominalReturn *= 100;
    });
    return { asOf, assets };
  }

  // 可選 Benchmark sheet: Date | SPY | QQQ | DIA ...（收盤價）
  function parseBenchmarkSheet(rows) {
    if (!rows || !rows.length) return null;
    const hdrIdx = rows.findIndex(r => r && r.some(c => String(c).trim() === 'Date'));
    if (hdrIdx < 0) return null;
    const hdr = rows[hdrIdx].map(c => String(c || '').trim());
    const names = hdr.slice(1).filter(Boolean);
    const series = {}; names.forEach(n => series[n] = []);
    for (let r = hdrIdx + 1; r < rows.length; r++) {
      const row = rows[r]; if (!row) continue;
      const date = excelDate(row[hdr.indexOf('Date')]); if (!date) continue;
      names.forEach(n => { const v = num(row[hdr.indexOf(n)]); if (v != null) series[n].push({ date, close: v }); });
    }
    Object.keys(series).forEach(k => { if (!series[k].length) delete series[k]; else series[k].sort((a, b) => a.date < b.date ? -1 : 1); });
    return Object.keys(series).length ? series : null;
  }

  /* ───────────── 收益率與指標（對齊 Python run_nav_analysis / calculate_metrics）───────────── */
  // fund_ret = (nav_t + div_t) / nav_{t-1} - 1
  function fundReturns(navRows) {
    const out = [];
    for (let i = 1; i < navRows.length; i++) {
      const prev = navRows[i - 1].nav;
      if (prev > 0) out.push({ date: navRows[i].date, ret: (navRows[i].nav + (navRows[i].divPerUnit || 0)) / prev - 1 });
    }
    return out;
  }
  function priceToReturns(priceRows) {
    const out = [];
    for (let i = 1; i < priceRows.length; i++) {
      const prev = priceRows[i - 1].close;
      if (prev > 0) out.push({ date: priceRows[i].date, ret: priceRows[i].close / prev - 1 });
    }
    return out;
  }
  // 按日期交集對齊兩個 {date,ret} 序列
  function align(a, b) {
    const mb = new Map(b.map(x => [x.date, x.ret]));
    const dates = [], ra = [], rb = [];
    a.forEach(x => { if (mb.has(x.date)) { dates.push(x.date); ra.push(x.ret); rb.push(mb.get(x.date)); } });
    return { dates, a: ra, b: rb };
  }

  function calcMetrics(rp, rb) {   // rb 可為 null（無基準）
    const days = rp.length; if (days < 5) return null;
    const totalRet = rp.reduce((c, r) => c * (1 + r), 1) - 1;
    const annRet = Math.pow(1 + totalRet, TRADING_DAYS / days) - 1;
    const s = std(rp, 1);
    const vol = s * Math.sqrt(TRADING_DAYS);
    const excess = rp.map(r => r - RISK_FREE / TRADING_DAYS);
    const sharpe = s !== 0 ? (mean(excess) / s) * Math.sqrt(TRADING_DAYS) : 0;
    const neg = rp.filter(r => r < 0), pos = rp.filter(r => r > 0);
    const downStd = neg.length ? std(neg, 1) * Math.sqrt(TRADING_DAYS) : 0.0001;
    const sortino = downStd !== 0 ? (annRet - RISK_FREE) / downStd : 0;
    // 回撤
    let cum = 1, peak = 1, maxDD = 0;
    const ddSeries = rp.map(r => { cum *= (1 + r); peak = Math.max(peak, cum); const dd = (cum - peak) / peak; maxDD = Math.min(maxDD, dd); return dd; });
    const calmar = maxDD !== 0 ? annRet / Math.abs(maxDD) : 0;
    const winRate = pos.length / days;
    const avgWin = pos.length ? mean(pos) : 0;
    const avgLoss = neg.length ? Math.abs(mean(neg)) : 0.0001;
    const plRatio = avgLoss !== 0 ? avgWin / avgLoss : 0;
    const var95 = quantile(rp, 0.05);
    const tail = rp.filter(r => r <= var95);
    const cvar95 = tail.length ? mean(tail) : var95;
    let alpha = 0, beta = 0, r2 = 0, infoRatio = 0, trackingErr = 0, treynor = 0;
    if (rb && rb.length === rp.length) {
      ({ alpha, beta, r2 } = ols(rp, rb));
      const active = rp.map((r, i) => r - rb[i]);
      const as = std(active, 1);
      infoRatio = as !== 0 ? (mean(active) * TRADING_DAYS) / (as * Math.sqrt(TRADING_DAYS)) : 0;
      trackingErr = as * Math.sqrt(TRADING_DAYS);
      treynor = beta !== 0 ? (annRet - RISK_FREE) / beta : 0;
    }
    return {
      totalRet, annRet, vol, sharpe, sortino, calmar, treynor, maxDD, winRate, plRatio,
      var95, cvar95, alpha, beta, r2, infoRatio, trackingErr,
      skew: skewness(rp), kurt: excessKurtosis(rp), days, ddSeries,
      wins: pos.length,
    };
  }

  /* ───────────── 圖表數據序列 ───────────── */
  const equityCurve = (rets, K = 10000) => { let c = K; return rets.map(x => ({ date: x.date, v: (c *= 1 + x.ret) })); };

  function drawdownSeries(rets) {
    let cum = 1, peak = 1;
    return rets.map(x => { cum *= 1 + x.ret; peak = Math.max(peak, cum); return { date: x.date, v: (cum - peak) / peak }; });
  }

  // 月度收益 {'2026-01': 0.038, ...}
  function monthlyReturns(rets) {
    const m = new Map();
    rets.forEach(x => { const k = x.date.slice(0, 7); m.set(k, (m.get(k) ?? 1) * (1 + x.ret)); });
    const out = [];
    [...m.keys()].sort().forEach(k => out.push({ month: k, ret: m.get(k) - 1 }));
    return out;
  }

  function rolling(rets, window, fn) {
    const out = [];
    for (let i = window; i <= rets.length; i++) {
      const w = rets.slice(i - window, i).map(x => x.ret);
      out.push({ date: rets[i - 1].date, v: fn(w) });
    }
    return out;
  }
  const rollingVol = (rets, w = 20) => rolling(rets, w, a => std(a, 1) * Math.sqrt(TRADING_DAYS));
  const rollingSharpe = (rets, w = 20) => rolling(rets, w, a => { const s = std(a, 1); return s ? (mean(a.map(r => r - RISK_FREE / TRADING_DAYS)) / s) * Math.sqrt(TRADING_DAYS) : 0; });
  function rollingAlphaBeta(fund, bench, w = 15) {
    const { dates, a, b } = align(fund, bench);
    const out = [];
    for (let i = w; i <= a.length; i++) {
      const { alpha, beta } = ols(a.slice(i - w, i), b.slice(i - w, i));
      out.push({ date: dates[i - 1], alpha, beta });
    }
    return out;
  }

  function histogram(rp, bins = 30) {
    const lo = Math.min(...rp), hi = Math.max(...rp), wdt = (hi - lo) / bins || 1e-9;
    const counts = new Array(bins).fill(0);
    rp.forEach(r => counts[Math.min(bins - 1, Math.floor((r - lo) / wdt))]++);
    const m = mean(rp), s = std(rp, 1);
    const normal = counts.map((_, i) => { const x = lo + (i + .5) * wdt; return normPdf((x - m) / s) / s * wdt * rp.length; });
    return { lo, hi, width: wdt, counts, normal };
  }

  /* ───────────── VaR 多模型（正態 / Cornish-Fisher / 經驗）───────────── */
  function cornishFisherZ(z, S, K) {
    return z + (z * z - 1) * S / 6 + (z ** 3 - 3 * z) * K / 24 - (2 * z ** 3 - 5 * z) * S * S / 36;
  }
  function varTable(rp, levels = [0.95, 0.98, 0.99]) {
    const m = mean(rp), s = std(rp, 1), S = skewness(rp), K = excessKurtosis(rp);
    return levels.map(cl => {
      const z = normInv(1 - cl);
      const varN = m + z * s;
      const varCF = m + cornishFisherZ(z, S, K) * s;
      const varE = quantile(rp, 1 - cl);
      const tail = rp.filter(r => r <= varE);
      return { level: cl, normal: varN, cf: varCF, empirical: varE, cvar: tail.length ? mean(tail) : varE };
    });
  }

  /* ───────────── 壓力測試（歷史 bootstrap 蒙特卡洛，對齊 Python 三場景）───────────── */
  function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  function stressTest(rp, nDays, opts = {}) {
    const { nSims = 10000, seed = 42, negShift = false } = opts;
    const rand = mulberry32(seed);
    let pool = rp.slice();
    if (negShift) { // Slow Grind: 收益均值平移至負（對齊 python 'grind' 情景精神）
      const m = mean(pool); pool = pool.map(r => r - m + (-Math.abs(m) - 0.0005));
    }
    const finals = new Float64Array(nSims);
    const pathP5 = [], pathP50 = [], pathP95 = [];
    const paths = []; // 保存分位路徑所需
    for (let s = 0; s < nSims; s++) {
      let v = 1; const p = new Float64Array(nDays);
      for (let d = 0; d < nDays; d++) { v *= 1 + pool[Math.floor(rand() * pool.length)]; p[d] = v; }
      finals[s] = v; if (s < 400) paths.push(p);
    }
    const sorted = [...finals].sort((a, b) => a - b);
    const q = p => sorted[Math.min(nSims - 1, Math.floor(p * nSims))];
    for (let d = 0; d < nDays; d++) {
      const col = paths.map(p => p[d]).sort((a, b) => a - b);
      pathP5.push(col[Math.floor(0.05 * col.length)]);
      pathP50.push(col[Math.floor(0.50 * col.length)]);
      pathP95.push(col[Math.floor(0.95 * col.length)]);
    }
    return { nDays, p1: q(0.01), p5: q(0.05), p50: q(0.50), p95: q(0.95), mean: mean([...finals]), probLoss: [...finals].filter(v => v < 1).length / nSims, probHalf: [...finals].filter(v => v < 0.5).length / nSims, pathP5, pathP50, pathP95 };
  }
  // 三場景（與 Python plot_17/18/19 對齊口徑）
  function stressScenarios(rp) {
    return {
      crash: { label: 'Black Swan Crash（10天，1%分位）', ...stressTest(rp, 10, { seed: 17 }) },
      bear: { label: 'Prolonged Bear（21天，5%分位）', ...stressTest(rp, 21, { seed: 18 }) },
      grind: { label: 'Slow Grind Down（126天，負收益均值）', ...stressTest(rp, 126, { seed: 19, negShift: true }) },
    };
  }

  /* ── 基準掛載：可在 analyze 之後補充（如從後端 API 取得行情）── */
  function attachBenchmarks(R, benchPrices) {
    if (!R || R.error || !benchPrices) return R;
    R.benchmarks = R.benchmarks || {};
    Object.entries(benchPrices).forEach(([name, prices]) => {
      if (R.benchmarks[name]) return;
      const br = priceToReturns(prices);
      const al = align(R.rets, br);
      if (al.a.length >= 5) R.benchmarks[name] = {
        aligned: al, metrics: calcMetrics(al.a, al.b), benchMetrics: calcMetrics(al.b, null),
        curve: equityCurve(al.dates.map((d, i) => ({ date: d, ret: al.b[i] }))),
      };
    });
    const primary = R.primaryBM || Object.keys(R.benchmarks)[0] || null;
    R.primaryBM = primary;
    if (primary) {
      const m = R.benchmarks[primary].metrics;
      Object.assign(R.metrics, { alpha: m.alpha, beta: m.beta, r2: m.r2, infoRatio: m.infoRatio, trackingErr: m.trackingErr, treynor: m.treynor });
    }
    return R;
  }

  /* ───────────── 主入口：workbookSheets = {sheetName: rows[][]} ───────────── */
  function analyze(workbookSheets, opts = {}) {
    const navRows = parseNavSheet(workbookSheets['NAV Statement'] || []);
    const { asOf, assets } = parseAssetSheet(workbookSheets['Asset Position Record'] || []);
    const benchPrices = parseBenchmarkSheet(workbookSheets['Benchmark'] || null);

    if (navRows.length < 6) return { error: 'NAV Statement 數據不足（至少需要 6 個交易日）', navRows, assets };

    const rets = fundReturns(navRows);
    const rp = rets.map(x => x.ret);

    const metrics = calcMetrics(rp, null);

    const R0 = {
      asOf: asOf || navRows[navRows.length - 1].date,
      navRows, assets, rets, rp, metrics,
      curve: equityCurve(rets),
      drawdown: drawdownSeries(rets),
      monthly: monthlyReturns(rets),
      rollVol: rollingVol(rets, opts.volWindow || 20),
      rollSharpe: rollingSharpe(rets, opts.sharpeWindow || 20),
      hist: histogram(rp, opts.bins || 30),
      varTable: varTable(rp),
      stress: stressScenarios(rp),
      start: rets[0].date, end: rets[rets.length - 1].date,
    };
    R0.benchmarks = {}; R0.primaryBM = null;
    if (benchPrices) attachBenchmarks(R0, benchPrices);
    return R0;
  }

  return {
    analyze, attachBenchmarks, parseNavSheet, parseAssetSheet, parseBenchmarkSheet,
    fundReturns, calcMetrics, equityCurve, drawdownSeries, monthlyReturns,
    rollingVol, rollingSharpe, rollingAlphaBeta, histogram, varTable,
    stressTest, stressScenarios, align, priceToReturns,
    stats: { mean, std, skewness, excessKurtosis, quantile, normInv },
    TRADING_DAYS, RISK_FREE,
  };
}));
