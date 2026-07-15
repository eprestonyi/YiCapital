/* ═══════════════════════════════════════════════════════════
   Yi Capital i18n — 繁體 / 简体 / English 三語切換
   · 導航右側注入切換器（繁｜简｜EN），選擇存 localStorage
   · 帶 data-i18n="key" 的元素自動翻譯
   · JS 渲染內容用 YCI.t('key')；指標標籤用 YCI.lbl('key')
     （中文模式下自動附小號英文注釋，英文模式直接顯示英文）
   · 研報/長文暫僅繁體：简/EN 模式在 insights/forum 顯示「敬請期待」
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const D = {
    /* 導航與通用 */
    'nav.insights': ['Our Insights', 'Our Insights', 'Our Insights'],
    'coming.title': ['', '简体中文研报即将上线', 'English research coming soon'],
    'coming.body': ['', '目前全部研报以繁体中文提供，简体版本正在整理中，敬请期待。下方列表为繁体原文，欢迎先行阅读。', 'All research is currently published in Traditional Chinese. English editions are in preparation — stay tuned. The list below is available in the original language.'],
    /* 首頁 */
    'home.portfolios.h': ['組合實錄', '组合实录', 'Our Portfolios'],
    'home.portfolios.p': ['三個獨立運作的個人組合，方法論、持倉與申報文件全部公開。', '三个独立运作的个人组合，方法论、持仓与申报文件全部公开。', 'Three independently run portfolios — methodology, holdings and filings fully disclosed.'],
    'home.viewall': ['查看全部組合 →', '查看全部组合 →', 'View all portfolios →'],
    'home.hk.p': ['做港股的週期均值回歸：在情緒與估值的極端處建倉，等待價格向長期均值收斂。標的集中於現金流可驗證、股東回報明確的週期資產。', '做港股的周期均值回归：在情绪与估值的极端处建仓，等待价格向长期均值收敛。标的集中于现金流可验证、股东回报明确的周期资产。', 'Mean-reversion (均值回歸) in HK cyclicals: building positions at sentiment and valuation extremes, concentrated in cash-flow-verifiable assets with clear shareholder returns.'],
    'home.hk.go': ['查看淨值曲線、持倉與風險檔案 →', '查看净值曲线、持仓与风险档案 →', 'View NAV curve, holdings & risk profile →'],
    'home.us.p': ['多資產配置的美金組合：股票、久期（duration）、黃金與短債的風險平衡，以厚尾（fat-tail）與壓力測試框架管理回撤。', '多资产配置的美金组合：股票、久期（duration）、黄金与短债的风险平衡，以厚尾（fat-tail）与压力测试框架管理回撤。', 'A multi-asset USD portfolio: risk-balanced across equities, duration, gold and short-term bonds, with fat-tail and stress-testing frameworks governing drawdowns.'],
    'home.a.p': ['A股優質資產的長期持有：聚焦競爭格局清晰、自由現金流充沛的龍頭，換手極低、以年為單位計倉。', 'A股优质资产的长期持有：聚焦竞争格局清晰、自由现金流充沛的龙头，换手极低、以年为单位计仓。', 'Long-term ownership of quality A-shares: leaders with clear competitive structure and abundant free cash flow; minimal turnover, positions measured in years.'],
    'home.enter': ['進入組合頁 →', '进入组合页 →', 'Enter portfolio →'],
    'home.forum.h': ['研報庫・最新', '研报库・最新', 'Research Library · Latest'],
    'home.insights.h': ['研究觀點', '研究观点', 'Insights'],
    /* 統計標籤（中文模式帶英文小注） */
    'st.cum': ['累計回報', '累计回报', 'Cumulative Return'],
    'st.cum.en': 'Cumulative Return',
    'st.ann': ['年化收益率', '年化收益率', 'Annualized Return'],
    'st.ann.en': 'Annualized Return',
    'st.vol': ['年化波動率', '年化波动率', 'Annualized Volatility'],
    'st.vol.en': 'Annualized Volatility',
    'st.mdd': ['最大回撤', '最大回撤', 'Max Drawdown'],
    'st.mdd.en': 'Max Drawdown',
    'st.var': ['VaR 95%（日，經驗）', 'VaR 95%（日，经验）', 'VaR 95% (daily, empirical)'],
    'st.var.en': 'VaR 95% (daily, empirical)',
    'st.win': ['日勝率', '日胜率', 'Daily Win Rate'],
    'st.win.en': 'Daily Win Rate',
    'st.alpha': ['年化 Alpha', '年化 Alpha', 'Annualized Alpha'],
    'st.alpha.en': 'Annualized Alpha',
    'st.beta': ['Beta', 'Beta', 'Beta'],
    'st.beta.en': 'vs Benchmark',
    'st.sharpe': ['夏普比率', '夏普比率', 'Sharpe Ratio'],
    'st.sharpe.en': 'Sharpe Ratio',
    'st.sortino': ['索提諾比率', '索提诺比率', 'Sortino Ratio'],
    'st.sortino.en': 'Sortino Ratio',
    'st.calmar': ['卡瑪比率', '卡玛比率', 'Calmar Ratio'],
    'st.calmar.en': 'Calmar Ratio',
    'st.pl': ['盈虧比', '盈亏比', 'Payoff Ratio'],
    'st.pl.en': 'Payoff Ratio',
    'st.cvar': ['CVaR 95%（日）', 'CVaR 95%（日）', 'CVaR 95% (daily)'],
    'st.cvar.en': 'Expected Shortfall',
    'st.skew': ['偏度', '偏度', 'Skewness'],
    'st.skew.en': 'Skewness',
    'st.kurt': ['超額峰度', '超额峰度', 'Excess Kurtosis'],
    'st.kurt.en': 'Excess Kurtosis',
    'st.ir': ['信息比率', '信息比率', 'Information Ratio'],
    'st.ir.en': 'Information Ratio',
    /* 組合頁 / 檔案頁面板標題 */
    'pn.equity': ['淨值曲線（模擬 $10,000 投入）', '净值曲线（模拟 $10,000 投入）', 'NAV Curve (hypothetical $10,000)'],
    'pn.equity.en': 'NAV Curve',
    'pn.underwater': ['水下圖（回撤路徑）', '水下图（回撤路径）', 'Underwater Chart (drawdown path)'],
    'pn.underwater.en': 'Underwater / Drawdown',
    'pn.heatmap': ['月度收益率熱力圖', '月度收益率热力图', 'Monthly Returns Heatmap'],
    'pn.heatmap.en': 'Monthly Returns Heatmap',
    'pn.monthly': ['月度收益柱狀圖', '月度收益柱状图', 'Monthly Returns'],
    'pn.monthly.en': 'Monthly Returns',
    'pn.rollvol': ['滾動年化波動率（20日窗口）', '滚动年化波动率（20日窗口）', 'Rolling Annualized Volatility (20d)'],
    'pn.rollvol.en': 'Rolling Volatility (20d)',
    'pn.rollsharpe': ['滾動夏普比率（20日窗口）', '滚动夏普比率（20日窗口）', 'Rolling Sharpe Ratio (20d)'],
    'pn.rollsharpe.en': 'Rolling Sharpe (20d)',
    'pn.dist': ['日收益率分佈 vs 正態擬合', '日收益率分布 vs 正态拟合', 'Daily Return Distribution vs Normal Fit'],
    'pn.dist.en': 'Return Distribution vs Normal',
    'pn.metrics': ['完整指標表', '完整指标表', 'Full Metrics Table'],
    'pn.metrics.en': 'Full Metrics',
    'pn.donut': ['持倉市值分佈（環形圖）', '持仓市值分布（环形图）', 'Holdings by Market Value'],
    'pn.donut.en': 'Holdings by Market Value',
    'pn.holdings': ['持倉明細', '持仓明细', 'Holdings Detail'],
    'pn.holdings.en': 'Holdings Detail',
    'pn.stacked': ['資產構成（現金 vs 持倉市值）', '资产构成（现金 vs 持仓市值）', 'Asset Composition (Cash vs Positions)'],
    'pn.stacked.en': 'Cash vs Positions',
    'pn.unitnav': ['每股淨資產走勢（Unit NAV）', '每股净资产走势（Unit NAV）', 'Unit NAV History'],
    'pn.unitnav.en': 'Unit NAV',
    'pn.var': ['VaR 多模型對比（日，95/98/99）', 'VaR 多模型对比（日，95/98/99）', 'VaR Model Comparison (daily, 95/98/99)'],
    'pn.var.en': 'VaR: Normal / Cornish-Fisher / Empirical',
    'pn.stress': ['蒙特卡洛極端壓力測試（10,000 次歷史 bootstrap）', '蒙特卡洛极端压力测试（10,000 次历史 bootstrap）', 'Monte Carlo Stress Tests (10,000 bootstrap paths)'],
    'pn.stress.en': 'Monte Carlo Stress Tests',
    /* 組合頁雜項 */
    'pf.intro': ['三個獨立運作的個人組合，往下滑動依次為', '三个独立运作的个人组合，往下滑动依次为', 'Three independently run portfolios; scroll for'],
    'pf.fullpage': ['完整檔案頁 ↗', '完整档案页 ↗', 'Full Profile ↗'],
    'fund.loading': ['正在從淨值表計算', '正在从净值表计算', 'Computing from NAV workbook'],
  };

  const LANGS = ['tw', 'cn', 'en'];
  let lang = localStorage.getItem('yc-lang') || 'tw';
  if (LANGS.indexOf(lang) < 0) lang = 'tw';
  const idx = { tw: 0, cn: 1, en: 2 }[lang];

  function t(key) {
    const v = D[key];
    if (!v) return key;
    if (typeof v === 'string') return v;
    return v[idx] || v[0];
  }
  // 指標標籤：英文模式→英文；中文模式→中文＋小號英文注釋
  function lbl(key) {
    if (lang === 'en') return t(key);
    const en = D[key + '.en'] || (D[key] && D[key][2]) || '';
    return t(key) + (en ? '<span class="lbl-en">' + en + '</span>' : '');
  }

  window.YCI = { lang, t, lbl, set: l => { localStorage.setItem('yc-lang', l); location.reload(); } };

  /* 樣式 + 切換器 */
  const css = document.createElement('style');
  css.textContent = '.lbl-en{display:block;font-size:.82em;opacity:.55;letter-spacing:.4px;font-family:"IBM Plex Mono",monospace;margin-top:2px}'
    + '.yc-lang{display:inline-flex;gap:2px;margin-left:16px;font-family:"IBM Plex Mono",monospace;font-size:11.5px;vertical-align:middle}'
    + '.yc-lang a{color:#5f6f85;text-decoration:none;padding:3px 7px;border-radius:5px;cursor:pointer}'
    + '.yc-lang a:hover{color:#22d3ee}.yc-lang a.on{color:#22d3ee;background:rgba(34,211,238,.1)}'
    + '.yc-coming{border:1px solid #1a2436;border-left:3px solid #22d3ee;border-radius:8px;padding:18px 22px;margin:0 0 26px;background:rgba(34,211,238,.04)}'
    + '.yc-coming b{color:#e8edf5;display:block;margin-bottom:6px;font-size:15.5px}'
    + '.yc-coming p{color:#8b98ab;font-size:13.5px;line-height:1.9;margin:0}';
  document.head.appendChild(css);

  function mount() {
    // 切換器放進頂部導航
    const nav = document.querySelector('header .nav');
    if (nav && !document.querySelector('.yc-lang')) {
      const box = document.createElement('div');
      box.className = 'yc-lang';
      box.innerHTML = [['tw', '繁'], ['cn', '简'], ['en', 'EN']].map(x =>
        '<a data-l="' + x[0] + '" class="' + (x[0] === lang ? 'on' : '') + '">' + x[1] + '</a>').join('');
      box.addEventListener('click', e => { const l = e.target.dataset && e.target.dataset.l; if (l) YCI.set(l); });
      nav.appendChild(box);
    }
    // data-i18n 翻譯
    if (lang !== 'tw') {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const v = t(el.getAttribute('data-i18n'));
        if (v && v !== el.getAttribute('data-i18n')) el.innerHTML = v;
      });
    }
    // 研報區：简/EN 顯示敬請期待
    if (lang !== 'tw') {
      const p = location.pathname;
      if (/insights|forum/.test(p) || document.getElementById('home-reports')) {
        const host = document.querySelector('#posts-list, #reports-list, #home-reports, main .wrap');
        if (host && !document.querySelector('.yc-coming')) {
          const note = document.createElement('div');
          note.className = 'yc-coming';
          note.innerHTML = '<b>' + t('coming.title') + '</b><p>' + t('coming.body') + '</p>';
          host.parentNode.insertBefore(note, host);
        }
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
