/* Yi Capital 三市場組合頁：API 快照優先；舊後端才回退工作簿。 */
(function () {
  'use strict';
  const own = document.currentScript && document.currentScript.src || '';
  const ASSET_BASE = own ? new URL('./', own).href : 'assets/';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  const F = window.YCC, A = window.YC;
  if (!F || !A) return;

  const cfgs = [
    {
      pf: 'hk', section: 'hk', panel: 'hk', file: 'Yi_Capital_HK.xlsx',
      name: 'Yi Capital HK', currency: 'HK$', set: 'hk',
      benchmarks: [
        { key: 'HSCEI ETF', tw: '國企 ETF（2828.HK）', cn: '国企 ETF（2828.HK）', en: 'HSCEI ETF (2828.HK)' },
        { key: 'HSI ETF', tw: '恒生 ETF（2800.HK）', cn: '恒生 ETF（2800.HK）', en: 'Hang Seng ETF (2800.HK)' },
        { key: 'HSTECH ETF', tw: '恒科 ETF（3032.HK）', cn: '恒科 ETF（3032.HK）', en: 'Hang Seng TECH ETF (3032.HK)' },
      ],
    },
    {
      pf: 'us', section: 'us', panel: 'us', file: 'Yi_Capital_US.xlsx',
      name: 'Yi Capital US', currency: '$', set: 'us',
      benchmarks: [
        { key: 'S&P 500', tw: '標普 500', cn: '标普 500', en: 'S&P 500' },
        { key: 'NASDAQ', tw: '納斯達克綜合', cn: '纳斯达克综合', en: 'NASDAQ Composite' },
        { key: 'DOW', tw: '道瓊斯工業', cn: '道琼斯工业', en: 'Dow Jones Industrial' },
      ],
    },
    {
      pf: 'a', section: 'ashare', panel: 'ashare', file: 'Yi_Capital_A.xlsx',
      name: 'Yi Capital A Share', currency: '¥', set: 'a',
      benchmarks: [
        { key: 'HS300', tw: '滬深 300', cn: '沪深 300', en: 'CSI 300' },
      ],
    },
  ];
  const text = {
    tw: {
      equity: '淨值曲線（模擬 10,000 投入）', heat: '月度收益率熱力圖',
      draw: '回撤曲線與尾部風險', stress: '非中心 t 左尾壓力測試（10,000 條路徑）', asof: '數據截至',
      days: '交易日', holdings: '持倉市值', loading: '正在讀取後台快照',
      failed: '數據載入失敗', syncing: '後台快照尚未包含此項，等待下次同步',
      benchWait: '等待基準快照', fallback: '相容模式：由工作簿載入',
    },
    cn: {
      equity: '净值曲线（模拟 10,000 投入）', heat: '月度收益率热力图',
      draw: '回撤曲线与尾部风险', stress: '非中心 t 左尾压力测试（10,000 条路径）', asof: '数据截至',
      days: '交易日', holdings: '持仓市值', loading: '正在读取后台快照',
      failed: '数据加载失败', syncing: '后台快照尚未包含此项，等待下次同步',
      benchWait: '等待基准快照', fallback: '兼容模式：由工作簿加载',
    },
    en: {
      equity: 'Growth of 10,000 vs. benchmarks', heat: 'Monthly return heatmap',
      draw: 'Drawdown and tail risk', stress: 'Noncentral-t tail stress tests (10,000 paths)', asof: 'Data through',
      days: 'trading days', holdings: 'holdings market value', loading: 'Loading backend snapshot',
      failed: 'Unable to load data', syncing: 'Not yet present in the backend snapshot; awaiting sync',
      benchWait: 'Awaiting benchmark snapshot', fallback: 'Compatibility mode: loaded from workbook',
    },
  };
  const lang = document.documentElement.lang === 'en' ? 'en' : document.documentElement.lang === 'zh-Hans' ? 'cn' : 'tw';
  const T = text[lang];
  const lbl = k => window.YCI ? YCI.lbl(k) : k;
  const card = (v, k, c) => `<div class="stat"><div class="v ${c || ''}">${v}</div><div class="k">${k}</div></div>`;
  const yFmt = v => (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  const finite = v => Number.isFinite(Number(v));
  const fixed = (v, d = 2) => finite(v) ? Number(v).toFixed(d) : '—';
  const pct = (v, d = 1, sign = false) => finite(v) ? F.pct(Number(v), d, sign) : '—';
  const message = value => `<div class="yc-data-message">${value}</div>`;

  function prime(section, cfg) {
    section.setAttribute('aria-busy', 'true');
    const stats = section.querySelector('.stats');
    if (stats) stats.innerHTML = Array.from({ length: 6 }, () => card('—', T.loading)).join('');
    const performance = section.querySelector('#' + cfg.panel + '-performance');
    const perfPanels = performance ? performance.querySelectorAll('.panel') : [];
    if (perfPanels[0]) perfPanels[0].innerHTML = `<h4>${T.equity}</h4><div class="yc-data-loading"></div>`;
    if (perfPanels[1]) perfPanels[1].innerHTML = `<h4>${T.heat}</h4><div class="yc-data-loading"></div>`;
    const holdingPanel = section.querySelector('#' + cfg.panel + '-holdings .panel');
    if (holdingPanel) holdingPanel.innerHTML = `<div class="yc-data-loading"></div>`;
    const riskPanels = section.querySelectorAll('#' + cfg.panel + '-risks .panel');
    riskPanels.forEach((panel, i) => { panel.innerHTML = `<h4>${i ? T.stress : T.draw}</h4><div class="yc-data-loading"></div>`; });
    section.classList.remove('yc-live-pending');
  }

  async function readWorkbook(file) {
    await ensureXLSX();
    const r = await fetch(ASSET_BASE + 'data/' + file + '?v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + file);
    const wb = XLSX.read(await r.arrayBuffer(), { type: 'array' }), sheets = {};
    wb.SheetNames.forEach(n => { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }); });
    return sheets;
  }
  async function readLive(pf) {
    if (!API) return null;
    try {
      const r = await fetch(API + '/api/nav/' + pf, { cache: 'no-store' });
      const j = await r.json();
      return j && j.ok ? j : null;
    } catch (e) { return null; }
  }
  async function readBench(set) {
    if (!API) return { data: {}, missing: [] };
    try {
      const r = await fetch(API + '/api/benchmark?set=' + set, { cache: 'no-store' });
      const j = await r.json();
      return { data: j && j.data && typeof j.data === 'object' ? j.data : {}, missing: (j && j.missing) || [] };
    } catch (e) { return { data: {}, missing: [] }; }
  }
  function normalizeAssets(items) {
    return (Array.isArray(items) ? items : []).map(h => {
      const marketValue = Number(h.marketValue ?? h.mv) || 0;
      const buyCost = finite(h.buyCost) ? Number(h.buyCost) : null;
      const pnl = finite(h.pnl) ? Number(h.pnl) : null;
      return {
        ticker: String(h.ticker || h.t || ''),
        name: String(h.name || h.n || h.ticker || h.t || ''),
        qty: Number(h.qty ?? h.q) || 0, price: Number(h.price ?? h.p) || 0,
        marketValue, weight: finite(h.weight) ? Number(h.weight) : null,
        pnl, exposureReturn: finite(h.exposureReturn) ? Number(h.exposureReturn) : (pnl != null && buyCost ? pnl / buyCost * 100 : null),
      };
    }).filter(h => h.ticker);
  }
  function cachedResult(live) {
    if (!live || !live.enabled || Number(live.cacheVersion) < 2 || live.historyComplete !== true) return null;
    const history = Array.isArray(live.history) ? live.history : Array.isArray(live.rets) ? live.rets : [];
    const curve = Array.isArray(live.curve) ? live.curve : [];
    const metrics = live.metrics || live.statistics;
    if (history.length < 5 || curve.length < 5 || !metrics) return null;
    return {
      source: 'api', metrics, rets: history, rp: Array.isArray(live.rp) ? live.rp : history.map(x => x.ret),
      curve, drawdown: Array.isArray(live.drawdown) ? live.drawdown : [],
      monthly: Array.isArray(live.monthly) ? live.monthly : [],
      assets: normalizeAssets(live.assets || live.holdings), benchmarks: {}, primaryBM: null,
      varTable: Array.isArray(live.varTable) ? live.varTable : null,
      stress: live.stress || null, asOf: live.asOf || live.marketDate || live.end,
      start: (live.summary && live.summary.start) || history[0].date,
      end: live.end || (live.summary && live.summary.end) || history[history.length - 1].date,
    };
  }
  function addBenchmarks(R, payload, cfg) {
    R.benchmarks = {};
    R.primaryBM = null;
    const data = payload && payload.data || {};
    cfg.benchmarks.forEach(spec => {
      const prices = data[spec.key];
      if (!Array.isArray(prices) || prices.length < 6) return;
      const aligned = A.align(R.rets, A.priceToReturns(prices));
      if (aligned.a.length < 5) return;
      R.benchmarks[spec[lang]] = {
        curve: A.equityCurve(aligned.dates.map((date, i) => ({ date, ret: aligned.b[i] }))),
      };
    });
    return cfg.benchmarks.filter(spec => !R.benchmarks[spec[lang]]).map(spec => spec[lang]);
  }
  function periodNode(section) {
    let el = section.querySelector('.yc-live-period');
    if (!el) {
      el = document.createElement('span'); el.className = 'yc-live-period';
      el.style.color = 'var(--muted)'; el.style.marginLeft = '6px';
      const p = section.querySelector('.fund-desc'); if (p) p.appendChild(el);
    }
    return el;
  }
  function render(R, live, cfg, missingBench) {
    const section = document.getElementById(cfg.section), M = R.metrics;
    if (!section) return;
    const source = R.source === 'api' ? ' · AUTO · CACHE' : ' · ' + T.fallback;
    periodNode(section).textContent = `${T.asof} ${R.end}（${fixed(M.days, 0)} ${T.days}）${source}`;

    const stats = section.querySelector('.stats');
    if (stats) stats.innerHTML =
      card(pct(M.totalRet, 1, true), lbl('st.cum'), Number(M.totalRet) >= 0 ? 'u' : 'd') +
      card(pct(M.annRet, 1), lbl('st.ann')) +
      card(pct(M.vol, 1), lbl('st.vol')) +
      card(fixed(M.sharpe), 'Sharpe') +
      card(fixed(M.sortino), 'Sortino') +
      card(pct(M.maxDD, 1), lbl('st.mdd'), 'd') +
      card(pct(M.var95, 2), lbl('st.var'), 'd') +
      card(pct(M.winRate, 1), lbl('st.win'));

    const eq = [{ name: cfg.name, color: F.colors.cyan, width: 3, data: R.curve }];
    Object.entries(R.benchmarks || {}).forEach(([name, b], i) => eq.push({
      name, color: [F.colors.blue, F.colors.violet, F.colors.orange][i % 3],
      width: 1.6, opacity: .78, data: b.curve,
    }));
    const benchmarkNote = missingBench.length
      ? `<div class="legend">${T.benchWait}：${missingBench.join(' · ')}</div>` : '';
    const performance = section.querySelector('#' + cfg.panel + '-performance');
    const perfPanels = performance ? performance.querySelectorAll('.panel') : [];
    if (perfPanels[0]) perfPanels[0].innerHTML = `<h4>${T.equity}</h4>${F.lineChart(eq, { yFmt, baseline: 10000 })}${benchmarkNote}`;
    if (perfPanels[1]) perfPanels[1].innerHTML = `<h4>${T.heat}</h4>${R.monthly.length ? F.monthlyHeatmap(R.monthly) : message(T.syncing)}`;

    const holdingPanel = section.querySelector('#' + cfg.panel + '-holdings .panel');
    if (holdingPanel) {
      const total = R.assets.reduce((s, a) => s + (a.marketValue || 0), 0);
      holdingPanel.innerHTML = R.assets.length ? F.holdingsTableHtml(R.assets, cfg.currency) +
        `<div class="legend" style="margin-top:12px">${T.holdings} ${cfg.currency}${Math.round(total).toLocaleString()} · ${T.asof} ${R.asOf || R.end}</div>` : message(T.syncing);
    }

    const riskPanels = section.querySelectorAll('#' + cfg.panel + '-risks .panel');
    if (riskPanels[0]) {
      const dd = R.drawdown.length ? F.underwaterChart(R.drawdown) : message(T.syncing);
      const riskSummary = `<div class="risk-note">VaR 95% ${pct(M.var95, 2)} · CVaR 95% ${pct(M.cvar95, 2)} · Skew ${fixed(M.skew)} · Excess kurtosis ${fixed(M.kurt)}</div>`;
      const varDetail = R.varTable && R.varTable.length ? `<div style="margin-top:20px">${F.varTableHtml(R.varTable)}</div>` : '';
      riskPanels[0].innerHTML = `<h4>${T.draw}</h4>${dd}${varDetail}${riskSummary}`;
    }
    if (riskPanels[1]) riskPanels[1].innerHTML = `<h4>${T.stress}</h4>${R.stress ? F.stressTableHtml(R.stress) : message(T.syncing)}`;
    section.removeAttribute('aria-busy');
    section.dataset.dataSource = R.source;
  }

  async function init(cfg) {
    const section = document.getElementById(cfg.section); if (!section) return;
    prime(section, cfg);
    const stats = section.querySelector('.stats');
    try {
      const [live, bench] = await Promise.all([readLive(cfg.pf), readBench(cfg.set)]);
      let R = cachedResult(live);
      if (!R) {
        const sheets = await readWorkbook(cfg.file);
        if (live && live.rows && live.rows.length) A.appendLive(sheets, live.rows);
        R = A.analyze(sheets);
        if (R.error) throw new Error(R.error);
        R.source = 'workbook';
        if (live && live.holdings) A.applyLiveHoldings(R, live.holdings);
      }
      const missingBench = addBenchmarks(R, bench, cfg);
      render(R, live, cfg, missingBench);
    } catch (e) {
      section.removeAttribute('aria-busy');
      section.dataset.dataSource = 'error';
      if (stats) stats.innerHTML = card('—', T.failed + ' · ' + cfg.file, 'd');
      section.querySelectorAll('.tab-panel:not([id$="-methodology"]) .panel').forEach(panel => {
        const title = panel.querySelector('h4');
        panel.innerHTML = (title ? title.outerHTML : '') + message(T.failed);
      });
      console.error('[Yi Capital portfolio]', cfg.pf, e);
    }
  }
  cfgs.forEach(init);
}());
