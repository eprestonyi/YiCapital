/* 首頁三組合輕量實時摘要：不下載 Excel，只讀 Worker 的歷史快照 + 日更行。 */
(function () {
  'use strict';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  if (!API) return;
  const set = (id, value, cls) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = value; if (cls) el.className = 'v ' + cls;
  };
  const pct = (v, d, sign) => (sign && v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
  async function update(pf) {
    try {
      const r = await fetch(API + '/api/nav/' + pf, { cache: 'no-store' }), j = await r.json();
      if (!j.ok || !j.enabled || !j.snap) return;
      const rows = j.rows || [], snap = j.snap;
      let liveGrowth = 1, current = Number(snap.endGrowth) || 1, peak = Math.max(Number(snap.peakGrowth) || 1, current);
      let maxDD = Number(snap.maxDD) || 0;
      rows.forEach(row => {
        const g = 1 + (Number(row.ret) || 0);
        liveGrowth *= g; current *= g; peak = Math.max(peak, current);
        maxDD = Math.min(maxDD, current / peak - 1);
      });
      const total = (1 + (Number(snap.totalRet) || 0)) * liveGrowth - 1;
      const days = (Number(snap.days) || 0) + rows.length;
      const ann = days > 5 ? Math.pow(Math.max(.000001, 1 + total), 252 / days) - 1 : Number(snap.annRet) || 0;
      const date = rows.length ? rows[rows.length - 1].date : snap.end || (j.base && j.base.date) || '';
      set('hm-' + pf + '-cum', pct(total, 1, true), total >= 0 ? 'u' : 'd');
      set('hm-' + pf + '-ann', pct(ann, 1, false));
      set('hm-' + pf + '-mdd', pct(maxDD, 1, false), 'd');
      set('hm-' + pf + '-date', date ? 'AUTO · ' + date : 'AUTO');
    } catch (e) {}
  }
  ['hk', 'us', 'a'].forEach(update);
}());
