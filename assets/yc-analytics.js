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
  const num = v => { const x = typeof v === 'string' ? parseFloat(v.replace(/[,%$¥￥,\s]/g, '')) : Number(v); return isFinite(x) ? x : null; };
  const headerIndex = (hdr, exact, prefix) => {
    const names = Array.isArray(exact) ? exact : [exact];
    for (const name of names) {
      const i = hdr.findIndex(h => h === name);
      if (i >= 0) return i;
    }
    const prefixes = Array.isArray(prefix) ? prefix : prefix ? [prefix] : [];
    for (const p of prefixes) {
      const i = hdr.findIndex(h => String(h).startsWith(p));
      if (i >= 0) return i;
    }
    return -1;
  };
  const currencyFromHeader = hdr => {
    for (const h of hdr || []) {
      const m = String(h || '').match(/\((USD|HKD|CNY)\)/i);
      if (m) return m[1].toUpperCase();
    }
    return null;
  };

  // NAV Statement（表頭在第1行；USD / HKD / CNY 自動識別）
  function parseNavSheet(rows) {
    if (!rows || !rows.length) return [];
    const hdrIdx = rows.findIndex(r => r && r.some(c => String(c).trim() === 'Date'));
    if (hdrIdx < 0) return [];
    const hdr = rows[hdrIdx].map(c => String(c || '').trim());
    const col = (name, prefix) => headerIndex(hdr, name, prefix);
    const iDate = col('Date'), iTA = col('Total Assets', 'Total Assets ('), iTL = col('Total Liability', 'Total Liability ('),
      iNV = col('Net Value', 'Net Value ('), iU = col('Total Units'), iNAV = col('NAV per Unit', 'NAV per Unit ('),
      iAdj = col('Fund Action Adjustment', 'Fund Action Adjustment ('), iCash = col('Cash Balance', 'Cash Balance ('), iMV = col('Market Value', 'Market Value (');
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
    const col = (...names) => headerIndex(hdr, names);
    const colP = prefix => headerIndex(hdr, [], prefix);
    const F = {
      ticker: col('Ticker'), name: col('Name', 'Asset Name'), qty: col('Quantity'), netCost: colP('Net Cost ('),
      price: colP('Latest Price ('), mv: colP('Market Value ('), w: col('Weight (%)'),
      buyCost: colP('Total Buy Cost ('), sellProceeds: colP('Total Sell Proceeds ('),
      div: colP('Dividend Income ('), pnl: colP('Total P&L ('),
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

  function parseCashSource(rows) {
    if (!rows || !rows.length) return { date: null, cash: 0 };
    const hdrIdx = rows.findIndex(r => r && r.some(c => String(c).trim() === 'Date') && r.some(c => String(c).trim().startsWith('Cash After')));
    if (hdrIdx < 0) return { date: null, cash: 0 };
    const hdr = rows[hdrIdx].map(c => String(c || '').trim());
    const iDate = headerIndex(hdr, 'Date'), iCash = headerIndex(hdr, [], 'Cash After (');
    let latest = { date: null, cash: 0 };
    for (let r = hdrIdx + 1; r < rows.length; r++) {
      const date = excelDate(rows[r] && rows[r][iDate]), cash = num(rows[r] && rows[r][iCash]);
      if (date && cash != null && (!latest.date || date >= latest.date)) latest = { date, cash };
    }
    return latest;
  }

  function parseLiabilitySource(rows) {
    if (!rows || !rows.length) return { date: null, liability: 0 };
    const hdrIdx = rows.findIndex(r => r && r.some(c => String(c).trim() === 'Date') && r.some(c => String(c).trim().startsWith('Closing Liability')));
    if (hdrIdx < 0) return { date: null, liability: 0 };
    const hdr = rows[hdrIdx].map(c => String(c || '').trim());
    const iDate = headerIndex(hdr, 'Date'), iClose = headerIndex(hdr, [], 'Closing Liability (');
    let latest = { date: null, liability: 0 };
    for (let r = hdrIdx + 1; r < rows.length; r++) {
      const date = excelDate(rows[r] && rows[r][iDate]), liability = num(rows[r] && rows[r][iClose]);
      if (date && liability != null && (!latest.date || date >= latest.date)) latest = { date, liability };
    }
    return latest;
  }

  function parseUnitsSource(capitalRows, actionRows) {
    let units = 0, date = null;
    const rows = capitalRows || [];
    const hdrIdx = rows.findIndex(r => r && r.some(c => String(c).trim() === 'Execution Date') && r.some(c => String(c).trim() === 'Quantity'));
    if (hdrIdx >= 0) {
      const hdr = rows[hdrIdx].map(c => String(c || '').trim());
      const iDate = headerIndex(hdr, 'Execution Date'), iQty = headerIndex(hdr, 'Quantity');
      for (let r = hdrIdx + 1; r < rows.length; r++) {
        const q = num(rows[r] && rows[r][iQty]), d = excelDate(rows[r] && rows[r][iDate]);
        if (q != null) units += q;
        if (d && (!date || d > date)) date = d;
      }
    }
    const actions = actionRows || [];
    const ah = actions.findIndex(r => r && r.some(c => String(c).trim() === 'Date') && r.some(c => String(c).trim() === 'Post Quantity'));
    if (ah >= 0) {
      const hdr = actions[ah].map(c => String(c || '').trim());
      const iDate = headerIndex(hdr, 'Date'), iPost = headerIndex(hdr, 'Post Quantity');
      let post = null, postDate = null;
      for (let r = ah + 1; r < actions.length; r++) {
        const q = num(actions[r] && actions[r][iPost]), d = excelDate(actions[r] && actions[r][iDate]);
        if (q != null && (!postDate || (d && d >= postDate))) { post = q; postDate = d || postDate; }
      }
      if (post != null) units = post;
      if (postDate && (!date || postDate > date)) date = postDate;
    }
    return { date, units };
  }

  /* 後台賬本只從交易衍生表取營運基準：持倉、現金、負債、份額。
     NAV Statement 僅保留歷史曲線，不參與每日估值基準。 */
  function extractLedger(workbookSheets, opts = {}) {
    const assetRows = workbookSheets['Asset Position Record'] || [];
    const parsed = parseAssetSheet(assetRows);
    const cash = parseCashSource(workbookSheets['Cash Flow Statement'] || []);
    const liability = parseLiabilitySource(workbookSheets['Liability Statement'] || []);
    const unitInfo = parseUnitsSource(workbookSheets['Capital Record'] || [], workbookSheets['Fund Action Record'] || []);
    if (!parsed.assets.length) return { error: 'Asset Position Record 沒有有效持倉' };
    if (!(unitInfo.units > 0)) return { error: 'Capital Record 無法計算有效總份額' };
    const hdrIdx = assetRows.findIndex(r => r && r.some(c => String(c).trim() === 'Ticker'));
    const hdr = hdrIdx >= 0 ? assetRows[hdrIdx].map(c => String(c || '').trim()) : [];
    const currency = currencyFromHeader(hdr) || ({ us: 'USD', hk: 'HKD', a: 'CNY' }[opts.portfolio] || 'USD');
    const positions = parsed.assets.filter(a => a.ticker && a.qty != null && a.qty !== 0).map(a => ({
      t: a.ticker, n: a.name, q: a.qty, p: a.price || 0, mv: a.marketValue || 0,
      netCost: a.netCost || 0, buyCost: a.buyCost || 0, sellProceeds: a.sellProceeds || 0,
      dividend: a.dividend || 0, pnl: a.pnl || 0,
    }));
    const marketValue = positions.reduce((s, p) => s + (p.mv || (p.q * p.p) || 0), 0);
    const totalAssets = marketValue + cash.cash;
    const netValue = totalAssets - liability.liability;
    const sourceDate = [parsed.asOf, cash.date, liability.date, unitInfo.date].filter(Boolean).sort().pop() || null;
    return {
      portfolio: opts.portfolio || 'us', market: opts.portfolio || 'us', currency, positions,
      cash: cash.cash, liability: liability.liability, units: unitInfo.units,
      sourceDate, lastDate: sourceDate, baseMarketValue: marketValue, baseTotalAssets: totalAssets,
      baseNetValue: netValue, baseMV: netValue, lastUnitNav: netValue / unitInfo.units,
    };
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

  /* ───────────── 壓力測試（Noncentral-t，復刻 Manager 圖17/18/19）───────────── */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function logGamma(z) {
    const c = [
      0.9999999999998099, 676.5203681218851, -1259.1392167224028,
      771.3234287776531, -176.6150291621406, 12.507343278686905,
      -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < c.length; i++) x += c[i] / (z + i);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  function nctShapeMoments(df, nc) {
    if (!(df > 4)) return null;
    const rawNormal = [1, nc, 1 + nc * nc, nc ** 3 + 3 * nc, nc ** 4 + 6 * nc * nc + 3];
    const raw = [1];
    for (let k = 1; k <= 4; k++) {
      const inverseChiMoment = Math.exp(
        0.5 * k * Math.log(df / 2) + logGamma((df - k) / 2) - logGamma(df / 2)
      );
      raw[k] = rawNormal[k] * inverseChiMoment;
    }
    const mu = raw[1], variance = raw[2] - mu * mu;
    if (!(variance > 0) || !isFinite(variance)) return null;
    const central3 = raw[3] - 3 * mu * raw[2] + 2 * mu ** 3;
    const central4 = raw[4] - 4 * mu * raw[3] + 6 * mu * mu * raw[2] - 3 * mu ** 4;
    return {
      mean: mu, variance,
      skew: central3 / variance ** 1.5,
      kurt: central4 / (variance * variance) - 3,
    };
  }
  function populationMoments(values) {
    const m = mean(values);
    const variance = mean(values.map(v => (v - m) ** 2));
    if (!(variance > 0)) return { mean: m, std: 0, skew: 0, kurt: 0 };
    return {
      mean: m,
      std: Math.sqrt(variance),
      skew: mean(values.map(v => (v - m) ** 3)) / variance ** 1.5,
      kurt: mean(values.map(v => (v - m) ** 4)) / (variance * variance) - 3,
    };
  }
  function fitNctMoments(values) {
    const sample = populationMoments(values);
    if (!sample.std || values.length < 5) {
      return {
        df: 200, nc: 0, loc: sample.mean, scale: Math.max(sample.std, 1e-9),
        sampleMean: sample.mean, sampleStd: sample.std,
        targetSkew: sample.skew, targetKurt: sample.kurt,
        fittedSkew: 0, fittedKurt: 6 / 196, objective: 0,
      };
    }
    const objective = shape => {
      const skewScale = 0.25 + Math.abs(sample.skew);
      const kurtScale = 1 + Math.abs(sample.kurt);
      return ((shape.skew - sample.skew) / skewScale) ** 2
        + ((shape.kurt - sample.kurt) / kurtScale) ** 2;
    };
    let best = null;
    for (let di = 0; di <= 64; di++) {
      const df = 4.05 * (200 / 4.05) ** (di / 64);
      for (let ni = -48; ni <= 48; ni++) {
        const nc = ni * 0.25, shape = nctShapeMoments(df, nc);
        if (!shape) continue;
        const score = objective(shape);
        if (!best || score < best.score) best = { df, nc, shape, score };
      }
    }
    let dfStep = Math.max(0.25, (best.df - 4) * 0.18), ncStep = 0.2;
    for (let pass = 0; pass < 7; pass++) {
      const centre = best;
      for (let di = -3; di <= 3; di++) {
        const df = Math.max(4.01, Math.min(300, centre.df + di * dfStep));
        for (let ni = -3; ni <= 3; ni++) {
          const nc = Math.max(-20, Math.min(20, centre.nc + ni * ncStep));
          const shape = nctShapeMoments(df, nc);
          if (!shape) continue;
          const score = objective(shape);
          if (score < best.score) best = { df, nc, shape, score };
        }
      }
      dfStep *= 0.42; ncStep *= 0.42;
    }
    const scale = sample.std / Math.sqrt(best.shape.variance);
    return {
      df: best.df, nc: best.nc,
      loc: sample.mean - scale * best.shape.mean, scale,
      sampleMean: sample.mean, sampleStd: sample.std,
      targetSkew: sample.skew, targetKurt: sample.kurt,
      fittedSkew: best.shape.skew, fittedKurt: best.shape.kurt,
      objective: best.score,
    };
  }
  function standardNormal(random) {
    let u = 0, v = 0;
    while (u <= Number.EPSILON) u = random();
    while (v <= Number.EPSILON) v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function gammaRandom(shape, random) {
    if (shape < 1) {
      let u = 0;
      while (u <= Number.EPSILON) u = random();
      return gammaRandom(shape + 1, random) * u ** (1 / shape);
    }
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = standardNormal(random), base = 1 + c * x;
      if (base <= 0) continue;
      const v = base ** 3, u = random();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v;
      }
    }
  }
  function nctRandom(fit, random) {
    const z = standardNormal(random);
    const chiSquare = 2 * gammaRandom(fit.df / 2, random);
    return fit.loc + fit.scale * (z + fit.nc) / Math.sqrt(chiSquare / fit.df);
  }
  function fittedNctPool(fit, size, seed) {
    const random = mulberry32(seed), pool = new Array(size);
    for (let i = 0; i < size; i++) pool[i] = nctRandom(fit, random);
    return pool;
  }
  function sortedValue(sorted, p) {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
  }
  function maxValue(values) {
    let out = -Infinity;
    for (let i = 0; i < values.length; i++) if (values[i] > out) out = values[i];
    return values.length ? out : null;
  }
  function stressTest(pool, nDays, opts = {}) {
    const { nSims = 10000, pathSims = 1000, seed = 42, detDaily = null } = opts;
    if (!pool.length) return null;
    const random = mulberry32(seed), finals = new Array(nSims), sampledPaths = [];
    for (let sim = 0; sim < nSims; sim++) {
      let value = 1, path = sim < pathSims ? new Float64Array(nDays) : null;
      for (let day = 0; day < nDays; day++) {
        value *= 1 + pool[Math.floor(random() * pool.length)];
        if (path) path[day] = value;
      }
      finals[sim] = value;
      if (path) sampledPaths.push(path);
    }
    const sorted = finals.slice().sort((a, b) => a - b);
    const pathP5 = [], pathP50 = [], pathP95 = [];
    for (let day = 0; day < nDays; day++) {
      const col = sampledPaths.map(path => path[day]).sort((a, b) => a - b);
      pathP5.push(sortedValue(col, 0.05));
      pathP50.push(sortedValue(col, 0.50));
      pathP95.push(sortedValue(col, 0.95));
    }
    const deterministicDaily = detDaily == null ? mean(pool) : detDaily;
    const detNav = (1 + deterministicDaily) ** nDays;
    return {
      nDays, p1: sortedValue(sorted, 0.01), p5: sortedValue(sorted, 0.05),
      p50: sortedValue(sorted, 0.50), p95: sortedValue(sorted, 0.95),
      mean: mean(finals), probLoss: finals.filter(v => v < 1).length / nSims,
      probHalf: finals.filter(v => v < 0.5).length / nSims,
      pathP5, pathP50, pathP95,
      detDaily: deterministicDaily, detNav, detDrawdown: detNav - 1,
      conditionMean: mean(pool), poolSize: pool.length, pathSims,
    };
  }
  function stressScenarios(rp) {
    if (rp.length < 5) return null;
    const fit = fitNctMoments(rp);
    const fittedPool = fittedNctPool(fit, 200000, 0x59494341);
    const sorted = fittedPool.slice().sort((a, b) => a - b);
    const q1 = sortedValue(sorted, 0.01), q5 = sortedValue(sorted, 0.05);
    const crashPool = fittedPool.filter(v => v <= q1);
    const bearPool = fittedPool.filter(v => v <= q5);
    const negativePool = fittedPool.filter(v => v < 0);
    const historicalNegatives = rp.filter(v => v < 0);
    const negMean = historicalNegatives.length ? mean(historicalNegatives) : Math.min(fit.sampleMean, -1e-9);
    const meta = {
      model: 'noncentral-t', method: 'moment-fit-conditional-monte-carlo',
      fit, fittedPoolSize: fittedPool.length, nSims: 10000,
    };
    return {
      model: meta.model, method: meta.method, fit, fittedPoolSize: fittedPool.length,
      crash: {
        label: 'Black Swan Crash（10天，NCT左尾≤1%分位）',
        ...stressTest(crashPool, 10, { seed: 17, detDaily: q1 }),
        ...meta, condition: 'nct<=q0.01', threshold: q1,
        tailPoolMax: maxValue(crashPool),
      },
      bear: {
        label: 'Prolonged Bear（21天，NCT左尾≤5%分位）',
        ...stressTest(bearPool, 21, { seed: 18, detDaily: q5 }),
        ...meta, condition: 'nct<=q0.05', threshold: q5,
        tailPoolMax: maxValue(bearPool),
      },
      grind: {
        label: 'Slow Grind Down（126天，NCT負收益）',
        ...stressTest(negativePool, 126, { seed: 19, detDaily: negMean }),
        ...meta, condition: 'nct<0', threshold: 0,
        historicalNegativeMean: negMean,
        tailPoolMax: maxValue(negativePool),
      },
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

  /* ── 追加後端每日自動更新的實時行到 NAV Statement（就地修改 sheets）──
     rows: [{date:'YYYY-MM-DD', ret, unitNav?}]；只追加晚於表內最後日期的行。 */
  function appendLive(workbookSheets, liveRows) {
    const sheet = workbookSheets['NAV Statement'];
    if (!sheet || !sheet.length || !Array.isArray(liveRows) || !liveRows.length) return 0;
    const hdrIdx = sheet.findIndex(r => r && r.some(c => String(c).trim() === 'Date'));
    if (hdrIdx < 0) return 0;
    const hdr = sheet[hdrIdx].map(c => String(c || '').trim());
    const col = (n, p) => headerIndex(hdr, n, p);
    const iDate = col('Date'), iNAV = col('NAV per Unit', 'NAV per Unit ('), iTA = col('Total Assets', 'Total Assets ('),
      iTL = col('Total Liability', 'Total Liability ('), iNV = col('Net Value', 'Net Value ('),
      iCash = col('Cash Balance', 'Cash Balance ('), iMV = col('Market Value', 'Market Value ('),
      iU = col('Total Units'), iAdj = col('Fund Action Adjustment', 'Fund Action Adjustment (');
    if (iDate < 0 || iNAV < 0) return 0;
    let lastIdx = -1;
    for (let r = sheet.length - 1; r > hdrIdx; r--) { if (sheet[r] && excelDate(sheet[r][iDate]) && num(sheet[r][iNAV]) != null) { lastIdx = r; break; } }
    if (lastIdx < 0) return 0;
    let lastRow = sheet[lastIdx], lastDate = excelDate(lastRow[iDate]);
    let added = 0;
    for (const lr of liveRows) {
      if (!lr || !lr.date || lr.date <= lastDate || !isFinite(lr.ret)) continue;
      const nr = lastRow.slice();
      const g = 1 + lr.ret;
      nr[iDate] = lr.date;
      nr[iNAV] = isFinite(lr.unitNav) ? lr.unitNav : (num(lastRow[iNAV]) || 0) * g;
      if (iTA >= 0) nr[iTA] = isFinite(lr.totalAssets) ? lr.totalAssets : (num(lastRow[iTA]) != null ? num(lastRow[iTA]) * g : null);
      if (iTL >= 0 && isFinite(lr.liability)) nr[iTL] = lr.liability;
      if (iNV >= 0) nr[iNV] = isFinite(lr.netValue) ? lr.netValue : (num(lastRow[iNV]) != null ? num(lastRow[iNV]) * g : null);
      if (iCash >= 0 && isFinite(lr.cash)) nr[iCash] = lr.cash;
      if (iMV >= 0) nr[iMV] = isFinite(lr.marketValue) ? lr.marketValue : (num(lastRow[iMV]) != null ? num(lastRow[iMV]) * g : null);
      if (iU >= 0 && isFinite(lr.units)) nr[iU] = lr.units;
      if (iAdj >= 0) nr[iAdj] = 0;
      sheet.push(nr);
      lastRow = nr; lastDate = lr.date; added++;
    }
    return added;
  }

  function applyLiveHoldings(R, holdings) {
    if (!R || R.error || !Array.isArray(holdings) || !holdings.length) return R;
    const live = new Map(holdings.map(h => [String(h.t || h.ticker || '').toUpperCase(), h]));
    let total = 0;
    R.assets.forEach(a => {
      const h = live.get(String(a.ticker || '').toUpperCase()); if (!h) return;
      const oldMv = a.marketValue || 0;
      a.price = Number(h.price ?? h.p) || a.price;
      a.marketValue = Number(h.marketValue ?? h.mv) || 0;
      a.qty = Number(h.q ?? h.qty) || a.qty;
      if (a.pnl != null) a.pnl += a.marketValue - oldMv;
      if (a.buyCost) a.exposureReturn = a.pnl / a.buyCost * 100;
      total += a.marketValue;
    });
    if (total > 0) R.assets.forEach(a => { a.weight = (a.marketValue || 0) / total * 100; });
    R.asOf = holdings[0] && holdings[0].date ? holdings[0].date : R.asOf;
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
    analyze, appendLive, applyLiveHoldings, extractLedger, attachBenchmarks, parseNavSheet, parseAssetSheet, parseBenchmarkSheet,
    fundReturns, calcMetrics, equityCurve, drawdownSeries, monthlyReturns,
    rollingVol, rollingSharpe, rollingAlphaBeta, histogram, varTable,
    fitNctMoments, stressTest, stressScenarios, align, priceToReturns,
    stats: { mean, std, skewness, excessKurtosis, quantile, normInv },
    TRADING_DAYS, RISK_FREE,
  };
}));
