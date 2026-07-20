/* 首頁三組合摘要：只讀 Worker 已持久化的快照，不下載或解析 Excel。 */
(function () {
  'use strict';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  if (!API) return;
  const lang = document.documentElement.lang === 'en' ? 'en' : document.documentElement.lang === 'zh-Hans' ? 'cn' : 'tw';
  const copy = {
    tw: { wait: 'AUTO · 等待後台快照', fail: 'AUTO · 數據暫不可用', chart: '後台曲線同步中' },
    cn: { wait: 'AUTO · 等待后台快照', fail: 'AUTO · 数据暂不可用', chart: '后台曲线同步中' },
    en: { wait: 'AUTO · awaiting backend snapshot', fail: 'AUTO · data unavailable', chart: 'Backend curve is syncing' },
  }[lang];
  const set = (id, value, cls) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = value;
    if (el.classList.contains('v')) el.className = 'v' + (cls ? ' ' + cls : '');
  };
  const pct = (v, d, sign) => Number.isFinite(Number(v))
    ? (sign && Number(v) >= 0 ? '+' : '') + (Number(v) * 100).toFixed(d) + '%' : '—';
  function emptyChart() {
    const el = document.getElementById('hm-hk-chart'); if (!el) return;
    el.className = 'yc-home-chart-empty'; el.textContent = copy.chart;
    el.removeAttribute('role');
  }
  function renderChart(curve) {
    const el = document.getElementById('hm-hk-chart'); if (!el) return;
    const rows = (Array.isArray(curve) ? curve : []).filter(p => p && p.date && Number.isFinite(Number(p.v)));
    if (rows.length < 2) { emptyChart(); return; }
    const W = 520, H = 130, top = 14, bottom = 18;
    const values = rows.map(p => Number(p.v)), lo0 = Math.min(...values, 10000), hi0 = Math.max(...values, 10000);
    const pad = (hi0 - lo0) * .08 || 1, lo = lo0 - pad, hi = hi0 + pad;
    const X = i => i / (rows.length - 1) * W;
    const Y = v => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);
    const pts = rows.map((p, i) => `${X(i).toFixed(1)},${Y(Number(p.v)).toFixed(1)}`).join(' ');
    const baseY = Y(10000).toFixed(1), end = values[values.length - 1];
    el.className = '';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Yi Capital HK NAV">
      <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="#1a2436" stroke-dasharray="3 4"/>
      <polygon fill="#22d3ee" opacity=".08" points="0,${baseY} ${pts} ${W},${baseY}"/>
      <polyline fill="none" stroke="#22d3ee" stroke-width="2.4" points="${pts}"/>
      <text x="6" y="12" fill="#22d3ee" font-size="10.5" font-family="IBM Plex Mono">${(end / 1000).toFixed(1)}K</text>
      <text x="${W - 6}" y="${H - 3}" fill="#5f6f85" font-size="9.5" text-anchor="end" font-family="IBM Plex Mono">${rows[rows.length - 1].date}</text>
    </svg>`;
    el.removeAttribute('role');
  }
  function unavailable(pf, failed) {
    set('hm-' + pf + '-cum', '—');
    set('hm-' + pf + '-ann', '—');
    set('hm-' + pf + '-mdd', '—');
    set('hm-' + pf + '-date', failed ? copy.fail : copy.wait);
    if (pf === 'hk') emptyChart();
  }
  async function update(pf) {
    try {
      const r = await fetch(API + '/api/nav/' + pf, { cache: 'no-store' });
      const j = await r.json();
      const M = j && (j.metrics || j.statistics);
      if (!j.ok || !j.enabled || !M) { unavailable(pf, false); return; }
      set('hm-' + pf + '-cum', pct(M.totalRet, 1, true), Number(M.totalRet) >= 0 ? 'u' : 'd');
      set('hm-' + pf + '-ann', pct(M.annRet, 1, false));
      set('hm-' + pf + '-mdd', pct(M.maxDD, 1, false), 'd');
      const date = j.end || (j.summary && j.summary.end) || j.marketDate || '';
      set('hm-' + pf + '-date', date ? 'AUTO · CACHE · ' + date : 'AUTO · CACHE');
      if (pf === 'hk') renderChart(j.curve);
    } catch (e) { unavailable(pf, true); }
  }
  ['hk', 'us', 'a'].forEach(update);
}());
