/* Yi Capital 三市場組合頁：只讀服務端持久化快照；工作簿不參與公開頁回退。 */
(function () {
  'use strict';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  const F = window.YCC, A = window.YC;
  if (!F || !A) return;

  const cfgs = [
    {
      pf: 'hk', section: 'hk', panel: 'hk',
      name: 'Yi Capital HK', currency: 'HK$', set: 'hk',
      benchmarks: [
        { key: 'HSI', tw: '恒生指數', cn: '恒生指数', en: 'Hang Seng Index' },
        { key: 'HSTECH', tw: '恒生科技指數', cn: '恒生科技指数', en: 'Hang Seng TECH Index' },
      ],
    },
    {
      pf: 'us', section: 'us', panel: 'us',
      name: 'Yi Capital US', currency: '$', set: 'us',
      benchmarks: [
        { key: 'S&P 500', tw: '標普 500', cn: '标普 500', en: 'S&P 500' },
        { key: 'NASDAQ', tw: '納斯達克綜合', cn: '纳斯达克综合', en: 'NASDAQ Composite' },
        { key: 'DOW', tw: '道瓊斯工業', cn: '道琼斯工业', en: 'Dow Jones Industrial' },
      ],
    },
    {
      pf: 'a', section: 'ashare', panel: 'ashare',
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
      benchWait: '等待基準快照',
    },
    cn: {
      equity: '净值曲线（模拟 10,000 投入）', heat: '月度收益率热力图',
      draw: '回撤曲线与尾部风险', stress: '非中心 t 左尾压力测试（10,000 条路径）', asof: '数据截至',
      days: '交易日', holdings: '持仓市值', loading: '正在读取后台快照',
      failed: '数据加载失败', syncing: '后台快照尚未包含此项，等待下次同步',
      benchWait: '等待基准快照',
    },
    en: {
      equity: 'Growth of 10,000 vs. benchmarks', heat: 'Monthly return heatmap',
      draw: 'Drawdown and tail risk', stress: 'Noncentral-t tail stress tests (10,000 paths)', asof: 'Data through',
      days: 'trading days', holdings: 'holdings market value', loading: 'Loading backend snapshot',
      failed: 'Unable to load data', syncing: 'Not yet present in the backend snapshot; awaiting sync',
      benchWait: 'Awaiting benchmark snapshot',
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

  async function readLive(pf) {
    if (!API) return null;
    try {
      const r = await fetch(API + '/api/nav/' + pf, { cache: 'no-store' });
      const j = await r.json();
      return j && j.ok ? j : null;
    } catch (e) { return null; }
  }
  async function readBench(set) {
    if (!API) return { data: {}, missing: [], freshness: { stale: true } };
    try {
      const r = await fetch(API + '/api/benchmark?set=' + set, { cache: 'no-store' });
      const j = await r.json();
      return {
        ...(j && typeof j === 'object' ? j : {}),
        data: j && j.data && typeof j.data === 'object' ? j.data : {},
        missing: (j && j.missing) || [],
      };
    } catch (e) { return { data: {}, missing: [], freshness: { stale: true } }; }
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
  function normalizeReturns(items, history) {
    const clean = (Array.isArray(items) ? items : []).map(Number).filter(Number.isFinite);
    if (clean.length >= 5) return clean;
    return history.map(x => Number(x.ret)).filter(Number.isFinite);
  }
  function validStress(s) {
    if (!s || s.model !== 'noncentral-t') return false;
    return ['crash', 'bear', 'grind'].every(key => {
      const row = s[key];
      return row && [row.nDays, row.p50, row.p5, row.p1, row.probHalf].every(v => Number.isFinite(Number(v)))
        && ['pathP5', 'pathP50', 'pathP95'].every(path => Array.isArray(row[path])
          && row[path].length >= 2 && row[path].every(v => Number.isFinite(Number(v))));
    });
  }
  function cachedResult(live) {
    if (!live || !live.enabled || Number(live.cacheVersion) < 2 || live.historyComplete !== true) return null;
    const history = Array.isArray(live.history) ? live.history : Array.isArray(live.rets) ? live.rets : [];
    const curve = Array.isArray(live.curve) ? live.curve : [];
    const metrics = live.metrics || live.statistics;
    if (history.length < 5 || curve.length < 5 || !metrics) return null;
    const rp = normalizeReturns(live.rp, history);
    const stress = validStress(live.stress) ? live.stress : null;
    if (!stress) return null;
    const snapshot = A.snapshotMeta(live);
    if (!snapshot) return null;
    return {
      source: 'api', metrics, rets: history, rp,
      curve, drawdown: Array.isArray(live.drawdown) ? live.drawdown : [],
      monthly: Array.isArray(live.monthly) ? live.monthly : [],
      assets: normalizeAssets(live.assets || live.holdings), benchmarks: {}, primaryBM: null,
      varTable: Array.isArray(live.varTable) ? live.varTable : null,
      stress, asOf: live.asOf || live.marketDate || live.end,
      start: (live.summary && live.summary.start) || history[0].date,
      end: live.end || (live.summary && live.summary.end) || history[history.length - 1].date,
      snapshot,
    };
  }
  function addBenchmarks(R, payload, cfg) {
    R.benchmarks = {};
    R.primaryBM = null;
    const data = payload && payload.data || {};
    R.benchmarkSnapshot = A.snapshotMeta(payload);
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
    const navMeta = A.snapshotLabel(R.snapshot, lang);
    const benchmarkMeta = A.snapshotLabel(R.benchmarkSnapshot, lang);
    periodNode(section).textContent =
      `${T.asof} ${R.end}（${fixed(M.days, 0)} ${T.days}）` +
      ` · ${navMeta}` + (benchmarkMeta ? ` · BM ${benchmarkMeta}` : '');

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
      const R = cachedResult(live);
      if (!R) throw new Error('persisted_snapshot_unavailable');
      const missingBench = addBenchmarks(R, bench, cfg);
      render(R, live, cfg, missingBench);
    } catch (e) {
      section.removeAttribute('aria-busy');
      section.dataset.dataSource = 'error';
      if (stats) stats.innerHTML = card('—', T.failed, 'd');
      section.querySelectorAll('.tab-panel:not([id$="-methodology"]) .panel').forEach(panel => {
        const title = panel.querySelector('h4');
        panel.innerHTML = (title ? title.outerHTML : '') + message(T.failed);
      });
      console.error('[Yi Capital portfolio]', cfg.pf, e);
    }
  }
  cfgs.forEach(init);
}());
