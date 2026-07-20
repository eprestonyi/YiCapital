/* Yi Capital 三市場組合頁：工作簿保留歷史，Worker 實時行續接至今天。 */
(function () {
  'use strict';
  const own = document.currentScript && document.currentScript.src || '';
  const ASSET_BASE = own ? new URL('./', own).href : 'assets/';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  const F = window.YCC, A = window.YC;
  if (!F || !A) return;

  const cfgs = [
    { pf: 'hk', section: 'hk', panel: 'hk', file: 'Yi_Capital_HK.xlsx', name: 'Yi Capital HK', currency: 'HK$', set: 'hk' },
    { pf: 'us', section: 'us', panel: 'us', file: 'Yi_Capital_US.xlsx', name: 'Yi Capital US', currency: '$', set: 'us' },
    { pf: 'a', section: 'ashare', panel: 'ashare', file: 'Yi_Capital_A.xlsx', name: 'Yi Capital A Share', currency: '¥', set: 'a' },
  ];
  const text = {
    tw: { equity: '淨值曲線（模擬 10,000 投入）', heat: '月度收益率熱力圖', draw: '回撤曲線與尾部風險', stress: '蒙特卡洛極端壓力測試（bootstrap ×10,000）', asof: '數據截至', days: '交易日', holdings: '持倉市值', loading: '正在讀取工作簿與後台日更數據', failed: '數據載入失敗' },
    cn: { equity: '净值曲线（模拟 10,000 投入）', heat: '月度收益率热力图', draw: '回撤曲线与尾部风险', stress: '蒙特卡洛极端压力测试（bootstrap ×10,000）', asof: '数据截至', days: '交易日', holdings: '持仓市值', loading: '正在读取工作簿与后台日更数据', failed: '数据加载失败' },
    en: { equity: 'Growth of 10,000 vs. benchmarks', heat: 'Monthly return heatmap', draw: 'Drawdown and tail risk', stress: 'Monte Carlo stress tests (bootstrap ×10,000)', asof: 'Data through', days: 'trading days', holdings: 'holdings market value', loading: 'Loading workbook and daily backend data', failed: 'Unable to load data' },
  };
  const lang = document.documentElement.lang === 'en' ? 'en' : document.documentElement.lang === 'zh-Hans' ? 'cn' : 'tw';
  const T = text[lang];
  const lbl = k => window.YCI ? YCI.lbl(k) : k;
  const card = (v, k, c) => `<div class="stat"><div class="v ${c || ''}">${v}</div><div class="k">${k}</div></div>`;
  const yFmt = v => (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';

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
    if (!API) return null;
    try {
      const r = await fetch(API + '/api/benchmark?set=' + set, { cache: 'no-store' });
      const j = await r.json();
      return j && j.ok ? j.data : null;
    } catch (e) { return null; }
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
  function render(R, live, cfg) {
    const section = document.getElementById(cfg.section), M = R.metrics;
    if (!section) return;
    periodNode(section).textContent = `${T.asof} ${R.end}（${M.days} ${T.days}）${live && live.updatedAt ? ' · AUTO' : ''}`;

    const stats = section.querySelector('.stats');
    if (stats) stats.innerHTML =
      card(F.pct(M.totalRet, 1, true), lbl('st.cum'), M.totalRet >= 0 ? 'u' : 'd') +
      card(F.pct(M.annRet, 1), lbl('st.ann')) +
      card(F.pct(M.vol, 1), lbl('st.vol')) +
      card(M.sharpe.toFixed(2), 'Sharpe') +
      card(M.sortino.toFixed(2), 'Sortino') +
      card(F.pct(M.maxDD, 1), lbl('st.mdd'), 'd') +
      card(F.pct(M.var95, 2), lbl('st.var'), 'd') +
      card(F.pct(M.winRate, 1), lbl('st.win')) +
      (R.primaryBM ? card(F.pct(M.alpha, 1, true), lbl('st.alpha'), M.alpha >= 0 ? 'u' : 'd') + card(M.beta.toFixed(2), lbl('st.beta')) : '');

    const eq = [{ name: cfg.name, color: F.colors.cyan, width: 3, data: R.curve }];
    Object.entries(R.benchmarks || {}).forEach(([name, b], i) => eq.push({
      name, color: [F.colors.blue, F.colors.violet, F.colors.orange][i % 3],
      width: 1.6, opacity: .78, data: b.curve,
    }));
    const performance = section.querySelector('#' + cfg.panel + '-performance');
    const perfPanels = performance ? performance.querySelectorAll('.panel') : [];
    if (perfPanels[0]) perfPanels[0].innerHTML = `<h4>${T.equity}</h4>${F.lineChart(eq, { yFmt, baseline: 10000 })}`;
    if (perfPanels[1]) perfPanels[1].innerHTML = `<h4>${T.heat}</h4>${F.monthlyHeatmap(R.monthly)}`;

    const holdingPanel = section.querySelector('#' + cfg.panel + '-holdings .panel');
    if (holdingPanel) {
      const total = R.assets.reduce((s, a) => s + (a.marketValue || 0), 0);
      holdingPanel.innerHTML = F.holdingsTableHtml(R.assets, cfg.currency) +
        `<div class="legend" style="margin-top:12px">${T.holdings} ${cfg.currency}${Math.round(total).toLocaleString()} · ${T.asof} ${R.asOf || R.end}</div>`;
    }

    const riskPanels = section.querySelectorAll('#' + cfg.panel + '-risks .panel');
    if (riskPanels[0]) {
      const cf99 = R.varTable.find(r => r.level === .99);
      riskPanels[0].innerHTML = `<h4>${T.draw}</h4>${F.underwaterChart(R.drawdown)}
        <div style="margin-top:20px">${F.varTableHtml(R.varTable)}</div>
        <div class="risk-note">Skew ${M.skew.toFixed(2)} · Excess kurtosis ${M.kurt.toFixed(2)} · 99% CF VaR ${F.pct(cf99.cf, 2)}</div>`;
    }
    if (riskPanels[1]) riskPanels[1].innerHTML = `<h4>${T.stress}</h4>${F.stressTableHtml(R.stress)}`;
    section.removeAttribute('aria-busy');
  }

  async function init(cfg) {
    const section = document.getElementById(cfg.section); if (!section) return;
    section.setAttribute('aria-busy', 'true');
    const stats = section.querySelector('.stats');
    if (stats) stats.innerHTML = card('…', T.loading);
    try {
      const [sheets, live, bench] = await Promise.all([readWorkbook(cfg.file), readLive(cfg.pf), readBench(cfg.set)]);
      if (live && live.rows && live.rows.length) A.appendLive(sheets, live.rows);
      const R = A.analyze(sheets);
      if (R.error) throw new Error(R.error);
      if (live && live.holdings) A.applyLiveHoldings(R, live.holdings);
      if (bench) A.attachBenchmarks(R, bench);
      render(R, live, cfg);
    } catch (e) {
      section.removeAttribute('aria-busy');
      if (stats) stats.innerHTML = card('—', T.failed + ' · ' + cfg.file, 'd');
      console.error('[Yi Capital portfolio]', cfg.pf, e);
    }
  }
  cfgs.forEach(init);
}());
