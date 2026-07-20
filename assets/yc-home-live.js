/* 首頁三組合摘要：只讀 Worker 已持久化的快照，不下載或解析 Excel。 */
(function () {
  'use strict';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  if (!API) return;
  const lang = document.documentElement.lang === 'en' ? 'en' : document.documentElement.lang === 'zh-Hans' ? 'cn' : 'tw';
  const copy = {
    tw: {
      wait: 'AUTO · 等待後台快照', fail: 'AUTO · 數據暫不可用', chart: '後台曲線同步中',
      fund: 'HK Fund', benchWait: 'Benchmark 等待同步',
      hscei: '國企 ETF', hsi: '恒生 ETF', hstech: '恒科 ETF',
    },
    cn: {
      wait: 'AUTO · 等待后台快照', fail: 'AUTO · 数据暂不可用', chart: '后台曲线同步中',
      fund: 'HK Fund', benchWait: 'Benchmark 等待同步',
      hscei: '国企 ETF', hsi: '恒生 ETF', hstech: '恒科 ETF',
    },
    en: {
      wait: 'AUTO · awaiting backend snapshot', fail: 'AUTO · data unavailable', chart: 'Backend curve is syncing',
      fund: 'HK Fund', benchWait: 'Benchmarks awaiting sync',
      hscei: 'HSCEI ETF', hsi: 'Hang Seng ETF', hstech: 'Hang Seng TECH ETF',
    },
  }[lang];
  const hkBenchmarks = [
    { key: 'HSCEI ETF', label: copy.hscei, color: '#60a5fa' },
    { key: 'HSI ETF', label: copy.hsi, color: '#a78bfa' },
    { key: 'HSTECH ETF', label: copy.hstech, color: '#fb923c' },
  ];
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
  function comparisonSeries(curve, benchmarkData) {
    const fund = (Array.isArray(curve) ? curve : [])
      .filter(p => p && p.date && Number.isFinite(Number(p.v)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (fund.length < 2) return [];
    const available = hkBenchmarks.map(spec => {
      const prices = benchmarkData && benchmarkData[spec.key];
      const rows = (Array.isArray(prices) ? prices : [])
        .filter(p => p && p.date && Number.isFinite(Number(p.close)) && Number(p.close) > 0)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return { ...spec, rows, byDate: new Map(rows.map(p => [String(p.date), Number(p.close)])) };
    }).filter(item => item.rows.length > 1);
    const fundMap = new Map(fund.map(p => [String(p.date), Number(p.v)]));
    let dates = fund.map(p => String(p.date));
    available.forEach(item => { dates = dates.filter(date => item.byDate.has(date)); });
    if (dates.length < 2) {
      dates = fund.map(p => String(p.date));
      return [{
        name: copy.fund, color: '#22d3ee',
        values: dates.map(date => fundMap.get(date) / fundMap.get(dates[0]) * 10000),
      }];
    }
    const firstFund = fundMap.get(dates[0]);
    const series = [{
      name: copy.fund, color: '#22d3ee',
      values: dates.map(date => fundMap.get(date) / firstFund * 10000),
    }];
    available.forEach(item => {
      const first = item.byDate.get(dates[0]);
      series.push({
        name: item.label, color: item.color,
        values: dates.map(date => item.byDate.get(date) / first * 10000),
      });
    });
    series.dates = dates;
    return series;
  }
  function renderChart(curve, benchmarkData) {
    const el = document.getElementById('hm-hk-chart'); if (!el) return;
    const series = comparisonSeries(curve, benchmarkData);
    if (!series.length || series[0].values.length < 2) { emptyChart(); return; }
    const dates = series.dates || (Array.isArray(curve) ? curve.map(p => String(p.date)) : []);
    const W = 520, H = 130, top = 14, bottom = 18;
    const allValues = series.flatMap(item => item.values);
    const lo0 = Math.min(...allValues, 10000), hi0 = Math.max(...allValues, 10000);
    const pad = (hi0 - lo0) * .08 || 1, lo = lo0 - pad, hi = hi0 + pad;
    const X = i => i / (series[0].values.length - 1) * W;
    const Y = v => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);
    const baseY = Y(10000).toFixed(1);
    const fundPoints = series[0].values.map((value, i) => `${X(i).toFixed(1)},${Y(value).toFixed(1)}`).join(' ');
    const lines = series.map((item, index) => {
      const points = item.values.map((value, i) => `${X(i).toFixed(1)},${Y(value).toFixed(1)}`).join(' ');
      return `<polyline fill="none" stroke="${item.color}" stroke-width="${index ? '1.45' : '2.6'}" opacity="${index ? '.82' : '1'}" points="${points}"/>`;
    }).join('');
    const legend = series.map(item =>
      `<span><i style="background:${item.color}"></i>${item.name}</span>`
    ).join('') + (series.length === 1 ? `<span class="pending">${copy.benchWait}</span>` : '');
    const end = series[0].values[series[0].values.length - 1];
    el.className = 'yc-home-chart';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Yi Capital HK NAV">
      <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="#1a2436" stroke-dasharray="3 4"/>
      <polygon fill="#22d3ee" opacity=".06" points="0,${baseY} ${fundPoints} ${W},${baseY}"/>
      ${lines}
      <text x="6" y="12" fill="#22d3ee" font-size="10.5" font-family="IBM Plex Mono">${(end / 1000).toFixed(1)}K</text>
      <text x="${W - 6}" y="${H - 3}" fill="#5f6f85" font-size="9.5" text-anchor="end" font-family="IBM Plex Mono">${dates[dates.length - 1] || ''}</text>
    </svg><div class="yc-home-benchmark-legend">${legend}</div>`;
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
      const benchRequest = pf === 'hk'
        ? fetch(API + '/api/benchmark?set=hk', { cache: 'no-store' })
          .then(r => r.json()).then(j => j && j.data || {}).catch(() => ({}))
        : Promise.resolve({});
      const [r, benchmarkData] = await Promise.all([
        fetch(API + '/api/nav/' + pf, { cache: 'no-store' }),
        benchRequest,
      ]);
      const j = await r.json();
      const M = j && (j.metrics || j.statistics);
      if (!j.ok || !j.enabled || !M) { unavailable(pf, false); return; }
      set('hm-' + pf + '-cum', pct(M.totalRet, 1, true), Number(M.totalRet) >= 0 ? 'u' : 'd');
      set('hm-' + pf + '-ann', pct(M.annRet, 1, false));
      set('hm-' + pf + '-mdd', pct(M.maxDD, 1, false), 'd');
      const date = j.end || (j.summary && j.summary.end) || j.marketDate || '';
      set('hm-' + pf + '-date', date ? 'AUTO · CACHE · ' + date : 'AUTO · CACHE');
      if (pf === 'hk') renderChart(j.curve, benchmarkData);
    } catch (e) { unavailable(pf, true); }
  }
  ['hk', 'us', 'a'].forEach(update);
}());
