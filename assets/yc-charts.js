/* ═══════════════════════════════════════════════════════════════
   Yi Capital Charts — 純 SVG/HTML 渲染，風格對齊全站（style.css 變量）
   所有函數返回 HTML 字符串；無外部依賴。
   ═══════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YCC = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = { cyan: '#22d3ee', blue: '#3b82f6', violet: '#8b5cf6', up: '#34d399', down: '#ff5c47', muted: '#5f6f85', line: '#1a2436', gold: '#eab308', orange: '#fb923c' };
  const MONO = 'IBM Plex Mono';
  const T = (k, fb) => (typeof window !== 'undefined' && window.YCI) ? window.YCI.t(k) : fb;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 1, sign = false) => (v == null || !isFinite(v)) ? '—' : (sign && v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
  const money = (v, cur = '$') => (v == null || !isFinite(v)) ? '—' : (v < 0 ? '−' : '') + cur + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

  // 智能刻度
  function niceTicks(lo, hi, n = 5) {
    if (!(hi > lo)) hi = lo + 1;
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const t0 = Math.ceil(lo / step) * step, out = [];
    for (let t = t0; t <= hi + 1e-9; t += step) out.push(t);
    return out;
  }
  function dateTicks(dates, n = 5) {
    if (dates.length <= n) return dates.map((d, i) => ({ i, label: d.slice(2, 7) }));
    const out = [];
    for (let k = 0; k < n; k++) { const i = Math.round(k * (dates.length - 1) / (n - 1)); out.push({ i, label: dates[i].slice(2, 7) }); }
    return out;
  }

  /* ── 多序列折線圖：series=[{name,color,width,data:[{date,v}]}] ── */
  function lineChart(series, opts = {}) {
    const { W = 560, H = 260, padL = 52, padR = 10, padT = 14, padB = 34, yFmt = v => fmt(v, 0), baseline = null, fill = null, yTickN = 5 } = opts;
    const all = series.flatMap(s => s.data.map(p => p.v)).filter(isFinite);
    if (!all.length) return '<div class="legend">'+T('ch.nodata','無數據')+'</div>';
    let lo = Math.min(...all), hi = Math.max(...all);
    if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const iw = W - padL - padR, ih = H - padT - padB;
    const dates = series[0].data.map(p => p.date);
    const X = i => padL + (series[0].data.length > 1 ? i / (series[0].data.length - 1) * iw : iw / 2);
    const Y = v => padT + (1 - (v - lo) / (hi - lo)) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
    niceTicks(lo, hi, yTickN).forEach(t => {
      svg += `<line x1="${padL}" y1="${Y(t).toFixed(1)}" x2="${W - padR}" y2="${Y(t).toFixed(1)}" stroke="${C.line}" stroke-dasharray="3 4"/>`;
      svg += `<text x="${padL - 6}" y="${(Y(t) + 3.5).toFixed(1)}" fill="${C.muted}" font-size="10" font-family="${MONO}" text-anchor="end">${esc(yFmt(t))}</text>`;
    });
    if (baseline != null) svg += `<line x1="${padL}" y1="${Y(baseline).toFixed(1)}" x2="${W - padR}" y2="${Y(baseline).toFixed(1)}" stroke="${C.muted}" stroke-width="1" opacity=".6"/>`;
    dateTicks(dates, opts.xTickN || 5).forEach(t => svg += `<text x="${X(t.i).toFixed(1)}" y="${H - 10}" fill="${C.muted}" font-size="10" font-family="${MONO}" text-anchor="middle">${esc(t.label)}</text>`);
    series.forEach((s, k) => {
      // 序列可短於主序列 → 用自身索引映射到主日期軸
      const idxMap = new Map(dates.map((d, i) => [d, i]));
      const pts = s.data.filter(p => idxMap.has(p.date)).map(p => `${X(idxMap.get(p.date)).toFixed(1)},${Y(p.v).toFixed(1)}`);
      if (!pts.length) return;
      if ((fill === k || s.fill) && pts.length > 1) {
        const first = pts[0].split(','), last = pts[pts.length - 1].split(',');
        svg += `<polygon fill="${s.color}" opacity=".08" points="${first[0]},${Y(baseline ?? lo).toFixed(1)} ${pts.join(' ')} ${last[0]},${Y(baseline ?? lo).toFixed(1)}"/>`;
      }
      svg += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width || 1.5}" opacity="${s.opacity ?? 1}" points="${pts.join(' ')}"/>`;
    });
    svg += '</svg>';
    const legend = `<div class="legend">${series.map(s => `<i style="background:${s.color}"></i>${esc(s.name)}&nbsp;&nbsp;`).join('')}</div>`;
    return svg + legend;
  }

  /* ── 水下圖（回撤面積）── */
  function underwaterChart(dd, opts = {}) {
    const data = dd.map(p => ({ date: p.date, v: p.v * 100 }));
    return lineChart([{ name: opts.name || T('ch.dd','回撤 Drawdown'), color: C.down, width: 1.5, data, fill: true }],
      { ...opts, baseline: 0, yFmt: v => fmt(v, 0) + '%' });
  }

  /* ── 月度熱力圖表格 ── */
  function monthlyHeatmap(monthly) {
    const years = [...new Set(monthly.map(m => m.month.slice(0, 4)))].sort();
    const map = new Map(monthly.map(m => [m.month, m.ret]));
    const maxAbs = Math.max(0.02, ...monthly.map(m => Math.abs(m.ret)));
    let h = '<table class="hm"><thead><tr><th></th>' + Array.from({ length: 12 }, (_, i) => `<th>${(typeof window!=='undefined'&&window.YCI)?window.YCI.f('mon',{n:i+1}):(i+1)+'月'}</th>`).join('') + '</tr></thead><tbody>';
    years.forEach(y => {
      h += `<tr><td class="y">${y}</td>`;
      for (let m = 1; m <= 12; m++) {
        const k = `${y}-${String(m).padStart(2, '0')}`;
        if (!map.has(k)) { h += '<td class="e">·</td>'; continue; }
        const r = map.get(k), a = Math.min(0.92, 0.15 + Math.abs(r) / maxAbs * 0.77);
        const bg = r >= 0 ? `rgba(52,211,153,${a.toFixed(2)})` : `rgba(255,92,71,${a.toFixed(2)})`;
        h += `<td style="background:${bg}">${(r >= 0 ? '+' : '') + (r * 100).toFixed(1)}</td>`;
      }
      h += '</tr>';
    });
    return h + '</tbody></table><div class="legend" style="margin-top:14px">'+T('ch.updown2','綠漲紅跌；色深對應幅度。由淨值表逐日複利計算。')+'</div>';
  }

  /* ── 月度收益柱狀圖 ── */
  function monthlyBars(monthly, opts = {}) {
    const { W = 560, H = 240, padL = 46, padR = 8, padT = 12, padB = 40 } = opts;
    const vals = monthly.map(m => m.ret * 100);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const p = (hi - lo) * 0.1 || 1; lo -= p; hi += p;
    const iw = W - padL - padR, ih = H - padT - padB, bw = Math.min(36, iw / monthly.length * 0.68);
    const X = i => padL + (i + 0.5) / monthly.length * iw, Y = v => padT + (1 - (v - lo) / (hi - lo)) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
    niceTicks(lo, hi, 5).forEach(t => {
      svg += `<line x1="${padL}" y1="${Y(t).toFixed(1)}" x2="${W - padR}" y2="${Y(t).toFixed(1)}" stroke="${C.line}" stroke-dasharray="3 4"/><text x="${padL - 6}" y="${(Y(t) + 3.5).toFixed(1)}" fill="${C.muted}" font-size="10" font-family="${MONO}" text-anchor="end">${fmt(t, 0)}%</text>`;
    });
    monthly.forEach((m, i) => {
      const v = m.ret * 100, y0 = Y(Math.max(0, v)), hgt = Math.abs(Y(v) - Y(0));
      svg += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, hgt).toFixed(1)}" fill="${v >= 0 ? C.up : C.down}" opacity=".85" rx="1.5"/>`;
      svg += `<text x="${X(i).toFixed(1)}" y="${(v >= 0 ? y0 - 4 : y0 + hgt + 11)}" fill="${v >= 0 ? C.up : C.down}" font-size="9" font-family="${MONO}" text-anchor="middle">${(v >= 0 ? '+' : '') + v.toFixed(1)}</text>`;
      if (monthly.length <= 18 || i % 2 === 0) svg += `<text x="${X(i).toFixed(1)}" y="${H - 8}" fill="${C.muted}" font-size="9" font-family="${MONO}" text-anchor="middle">${m.month.slice(2)}</text>`;
    });
    svg += `<line x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${W - padR}" y2="${Y(0).toFixed(1)}" stroke="${C.muted}" stroke-width="1" opacity=".7"/></svg>`;
    return svg;
  }

  /* ── 收益分佈直方圖 + 正態疊加 ── */
  function distributionChart(hist, opts = {}) {
    const { W = 560, H = 250, padL = 40, padR = 10, padT = 12, padB = 34 } = opts;
    const n = hist.counts.length, hiC = Math.max(...hist.counts, ...hist.normal) * 1.08;
    const iw = W - padL - padR, ih = H - padT - padB;
    const X = i => padL + i / n * iw, Y = c => padT + (1 - c / hiC) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
    hist.counts.forEach((c, i) => {
      const xv = hist.lo + (i + 0.5) * hist.width;
      svg += `<rect x="${(X(i) + 1).toFixed(1)}" y="${Y(c).toFixed(1)}" width="${(iw / n - 2).toFixed(1)}" height="${(ih - (Y(c) - padT)).toFixed(1)}" fill="${xv >= 0 ? C.up : C.down}" opacity=".55"/>`;
    });
    const pts = hist.normal.map((c, i) => `${(X(i) + iw / n / 2).toFixed(1)},${Y(c).toFixed(1)}`).join(' ');
    svg += `<polyline fill="none" stroke="${C.cyan}" stroke-width="2" points="${pts}"/>`;
    [0.02, 0.25, 0.5, 0.75, 0.98].forEach(q => {
      const i = q * n, xv = hist.lo + i * hist.width;
      svg += `<text x="${X(i).toFixed(1)}" y="${H - 10}" fill="${C.muted}" font-size="10" font-family="${MONO}" text-anchor="middle">${(xv * 100).toFixed(1)}%</text>`;
    });
    svg += '</svg><div class="legend"><i style="background:' + C.cyan + '"></i>'+T('ch.normfit','正態擬合')+'&nbsp;&nbsp;<i style="background:' + C.up + '"></i>'+T('ch.posday','正收益日')+'&nbsp;&nbsp;<i style="background:' + C.down + '"></i>'+T('ch.negday','負收益日')+'</div>';
    return svg;
  }

  /* ── 環形圖（持倉市值分佈）── */
  function donutChart(assets, opts = {}) {
    const { W = 560, H = 320, cur = '$' } = opts;
    const palette = [C.cyan, C.blue, C.violet, C.up, C.gold, C.orange, '#ec4899', '#14b8a6', '#a3e635', '#f472b6', '#60a5fa', '#facc15'];
    const items = assets.filter(a => (a.marketValue || 0) > 0).sort((a, b) => b.marketValue - a.marketValue);
    const total = items.reduce((s, a) => s + a.marketValue, 0);
    if (!total) return '<div class="legend">'+T('ch.nodata','無持倉數據')+'</div>';
    const cx = 155, cy = H / 2, R = 108, r = 64;
    let a0 = -Math.PI / 2, svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
    items.forEach((it, i) => {
      const frac = it.marketValue / total, a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const xi1 = cx + r * Math.cos(a1), yi1 = cy + r * Math.sin(a1), xi0 = cx + r * Math.cos(a0), yi0 = cy + r * Math.sin(a0);
      svg += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${xi1.toFixed(1)},${yi1.toFixed(1)} A${r},${r} 0 ${large} 0 ${xi0.toFixed(1)},${yi0.toFixed(1)} Z" fill="${palette[i % palette.length]}" opacity=".88" stroke="#04070d" stroke-width="1.5"/>`;
      if (frac > 0.045) {
        const am = (a0 + a1) / 2, lx = cx + (R + 16) * Math.cos(am), ly = cy + (R + 16) * Math.sin(am);
        svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#cdd6e3" font-size="9.5" font-family="${MONO}" text-anchor="${Math.cos(am) > 0.1 ? 'start' : Math.cos(am) < -0.1 ? 'end' : 'middle'}">${esc(it.ticker)} ${(frac * 100).toFixed(1)}%</text>`;
      }
      a0 = a1;
    });
    svg += `<text x="${cx}" y="${cy - 6}" fill="#e8edf5" font-size="12" font-family="${MONO}" text-anchor="middle">${T("ch.total","總市值")}</text><text x="${cx}" y="${cy + 13}" fill="${C.cyan}" font-size="14" font-weight="600" font-family="${MONO}" text-anchor="middle">${money(total, cur)}</text>`;
    // 右側圖例
    const lx = 330; let ly = Math.max(20, cy - items.length * 10);
    items.forEach((it, i) => {
      svg += `<rect x="${lx}" y="${ly - 8}" width="9" height="9" fill="${palette[i % palette.length]}" rx="2"/><text x="${lx + 16}" y="${ly}" fill="#cdd6e3" font-size="10.5" font-family="${MONO}">${esc(it.ticker)}</text><text x="${W - 12}" y="${ly}" fill="${C.muted}" font-size="10.5" font-family="${MONO}" text-anchor="end">${money(it.marketValue, cur)}（${(it.marketValue / total * 100).toFixed(1)}%）</text>`;
      ly += 21;
    });
    return svg + '</svg>';
  }

  /* ── 水平條形圖（個股盈虧 / 敞口收益率）── */
  function hBarChart(items, opts = {}) {
    const { W = 560, valueFmt = v => money(v), title = '' } = opts;
    if (!items || !items.length) return (title ? `<h4>${esc(title)}</h4>` : '') + '<div class="legend">'+T('ch.nodata','無數據')+'</div>';
    const rowH = 26, padT = 8, padB = 8, padL = 96, padR = 90;
    const H = padT + padB + items.length * rowH;
    const vals = items.map(it => it.v);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const iw = W - padL - padR, span = (hi - lo) || 1;
    const X = v => padL + (v - lo) / span * iw;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
    svg += `<line x1="${X(0).toFixed(1)}" y1="${padT}" x2="${X(0).toFixed(1)}" y2="${H - padB}" stroke="${C.muted}" stroke-width="1" opacity=".6"/>`;
    items.forEach((it, i) => {
      const y = padT + i * rowH, v = it.v, x0 = Math.min(X(0), X(v)), w = Math.abs(X(v) - X(0));
      svg += `<text x="${padL - 8}" y="${y + rowH / 2 + 3.5}" fill="#cdd6e3" font-size="10.5" font-family="${MONO}" text-anchor="end">${esc(it.label)}</text>`;
      svg += `<rect x="${x0.toFixed(1)}" y="${y + 5}" width="${Math.max(1, w).toFixed(1)}" height="${rowH - 10}" fill="${v >= 0 ? C.up : C.down}" opacity=".85" rx="2"/>`;
      svg += `<text x="${(v >= 0 ? X(v) + 6 : X(v) - 6).toFixed(1)}" y="${y + rowH / 2 + 3.5}" fill="${v >= 0 ? C.up : C.down}" font-size="10" font-family="${MONO}" text-anchor="${v >= 0 ? 'start' : 'end'}">${esc(valueFmt(v))}</text>`;
    });
    svg += '</svg>';
    return (title ? `<h4>${esc(title)}</h4>` : '') + svg;
  }

  /* ── 堆疊面積圖（現金 vs 持倉市值）── */
  function stackedArea(navRows, opts = {}) {
    const { W = 560, H = 250, padL = 60, padR = 10, padT = 12, padB = 34, cur = '$' } = opts;
    const data = navRows.filter(r => r.cash != null && r.marketValue != null);
    if (data.length < 2) return '<div class="legend">'+T('ch.nodata','無現金/持倉數據')+'</div>';
    const totals = data.map(r => r.cash + r.marketValue);
    const hi = Math.max(...totals, ...data.map(r => r.marketValue)) * 1.06;
    const lo = Math.min(0, ...data.map(r => r.cash)) * 1.06;   // 現金可為負（結算/槓桿）
    const iw = W - padL - padR, ih = H - padT - padB;
    const X = i => padL + i / (data.length - 1) * iw, Y = v => padT + (1 - (v - lo) / (hi - lo)) * ih;
    const cashTop = data.map((r, i) => `${X(i).toFixed(1)},${Y(r.cash).toFixed(1)}`);
    const totTop = data.map((r, i) => `${X(i).toFixed(1)},${Y(r.cash + r.marketValue).toFixed(1)}`);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
    niceTicks(lo, hi, 5).forEach(t => svg += `<line x1="${padL}" y1="${Y(t).toFixed(1)}" x2="${W - padR}" y2="${Y(t).toFixed(1)}" stroke="${C.line}" stroke-dasharray="3 4"/><text x="${padL - 6}" y="${(Y(t) + 3.5).toFixed(1)}" fill="${C.muted}" font-size="9.5" font-family="${MONO}" text-anchor="end">${money(t, cur)}</text>`);
    svg += `<polygon fill="${C.blue}" opacity=".45" points="${X(0).toFixed(1)},${Y(0).toFixed(1)} ${cashTop.join(' ')} ${X(data.length - 1).toFixed(1)},${Y(0).toFixed(1)}"/>`;
    svg += `<polygon fill="${C.cyan}" opacity=".35" points="${cashTop.join(' ')} ${[...totTop].reverse().join(' ')}"/>`;
    svg += `<polyline fill="none" stroke="${C.cyan}" stroke-width="1.5" points="${totTop.join(' ')}"/>`;
    if (lo < 0) svg += `<line x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${W - padR}" y2="${Y(0).toFixed(1)}" stroke="${C.muted}" stroke-width="1" opacity=".7"/>`;
    dateTicks(data.map(r => r.date), 5).forEach(t => svg += `<text x="${X(t.i).toFixed(1)}" y="${H - 10}" fill="${C.muted}" font-size="10" font-family="${MONO}" text-anchor="middle">${t.label}</text>`);
    svg += '</svg>';
    return svg + `<div class="legend"><i style="background:${C.blue}"></i>${T("ch.cash","現金餘額（負值＝結算/融資）")}&nbsp;&nbsp;<i style="background:${C.cyan}"></i>${T("ch.pos","持倉市值（頂線＝總資產）")}</div>`;
  }

  /* ── VaR 表格 ── */
  function varTableHtml(rows, cvar95) {
    let h = '<table class="m"><thead><tr><th>'+T('ch.cl','置信水平')+'</th><th>'+T('ch.varn','VaR 正態')+'</th><th>'+T('ch.varcf','VaR Cornish-Fisher')+'</th><th>'+T('ch.vare','VaR 經驗')+'</th><th>'+T('ch.cvar','CVaR（ES）')+'</th></tr></thead><tbody>';
    rows.forEach(r => {
      h += `<tr><td>${(r.level * 100).toFixed(0)}%</td><td class="d">${pct(r.normal, 2)}</td><td class="d">${pct(r.cf, 2)}</td><td class="d">${pct(r.empirical, 2)}</td><td class="d">${pct(r.cvar, 2)}</td></tr>`;
    });
    return h + '</tbody></table>';
  }

  /* ── 壓力測試表 + 扇形路徑圖 ── */
  function stressTableHtml(stress) {
    let h = '<table class="m"><thead><tr><th>'+T('ch.scen','壓力場景')+'</th><th>'+T('ch.dur','持續')+'</th><th>'+T('ch.p50','P50 終值')+'</th><th>'+T('ch.p5','P5 終值')+'</th><th>'+T('ch.p1','P1 終值')+'</th><th>'+T('ch.half','腰斬概率')+'</th></tr></thead><tbody>';
    [stress.crash, stress.bear, stress.grind].forEach(s => {
      h += `<tr><td>${esc(s.label)}</td><td>${s.nDays}${T('ch.day','天')}</td><td class="${s.p50 >= 1 ? 'u' : 'd'}">${s.p50.toFixed(2)}</td><td class="d">${s.p5.toFixed(2)}（${pct(s.p5 - 1, 1, true)}）</td><td class="d">${s.p1.toFixed(2)}（${pct(s.p1 - 1, 1, true)}）</td><td>${pct(s.probHalf, 1)}</td></tr>`;
    });
    return h + '</tbody></table>';
  }
  function stressFanChart(s, opts = {}) {
    const { W = 560, H = 220, padL = 44, padR = 10, padT = 12, padB = 30 } = opts;
    const n = s.pathP50.length;
    const all = [...s.pathP5, ...s.pathP95, 1];
    let lo = Math.min(...all), hi = Math.max(...all);
    const p = (hi - lo) * 0.08 || 0.05; lo -= p; hi += p;
    const iw = W - padL - padR, ih = H - padT - padB;
    const X = i => padL + i / (n - 1) * iw, Y = v => padT + (1 - (v - lo) / (hi - lo)) * ih;
    const p5 = s.pathP5.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    const p95 = s.pathP95.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    const p50 = s.pathP50.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
    niceTicks(lo, hi, 4).forEach(t => svg += `<line x1="${padL}" y1="${Y(t).toFixed(1)}" x2="${W - padR}" y2="${Y(t).toFixed(1)}" stroke="${C.line}" stroke-dasharray="3 4"/><text x="${padL - 6}" y="${(Y(t) + 3.5).toFixed(1)}" fill="${C.muted}" font-size="10" font-family="${MONO}" text-anchor="end">${t.toFixed(2)}</text>`);
    svg += `<polygon fill="${C.down}" opacity=".12" points="${p5.join(' ')} ${[...p95].reverse().join(' ')}"/>`;
    svg += `<line x1="${padL}" y1="${Y(1).toFixed(1)}" x2="${W - padR}" y2="${Y(1).toFixed(1)}" stroke="${C.muted}" stroke-width="1" opacity=".6"/>`;
    svg += `<polyline fill="none" stroke="${C.down}" stroke-width="1.2" stroke-dasharray="4 3" points="${p5.join(' ')}"/>`;
    svg += `<polyline fill="none" stroke="${C.cyan}" stroke-width="2" points="${p50.join(' ')}"/>`;
    svg += `<polyline fill="none" stroke="${C.up}" stroke-width="1.2" stroke-dasharray="4 3" points="${p95.join(' ')}"/>`;
    [0, Math.floor(n / 2), n - 1].forEach(i => svg += `<text x="${X(i).toFixed(1)}" y="${H - 8}" fill="${C.muted}" font-size="10" font-family="${MONO}" text-anchor="middle">D${i + 1}</text>`);
    svg += '</svg>';
    return svg + `<div class="legend"><i style="background:${C.up}"></i>P95&nbsp;&nbsp;<i style="background:${C.cyan}"></i>P50 中位路徑&nbsp;&nbsp;<i style="background:${C.down}"></i>P5</div>`;
  }

  /* ── 持倉明細表 ── */
  function holdingsTableHtml(assets, cur = '$') {
    const items = [...assets].sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
    const total = items.reduce((s, a) => s + (a.marketValue || 0), 0);
    let h = '<table class="m"><thead><tr><th>'+T('ch.ticker','代號')+'</th><th>'+T('ch.weight','權重')+'</th><th>'+T('ch.mv','市值')+'</th><th>'+T('ch.pnl','總盈虧')+'</th><th>'+T('ch.expret','敞口收益率')+'</th></tr></thead><tbody>';
    items.forEach(a => {
      const w = a.weight != null ? a.weight : (total ? a.marketValue / total * 100 : 0);
      const er = a.exposureReturn, pnl = a.pnl;
      h += `<tr><td>${esc(a.ticker)}</td><td>${fmt(w, 1)}%</td><td>${money(a.marketValue, cur)}</td><td class="${pnl == null ? '' : pnl >= 0 ? 'u' : 'd'}">${pnl == null ? '—' : money(pnl, cur)}</td><td class="${er == null ? '' : er >= 0 ? 'u' : 'd'}">${er == null ? '—' : (er >= 0 ? '+' : '') + fmt(er, 1) + '%'}</td></tr>`;
    });
    return h + '</tbody></table>';
  }

  return { lineChart, underwaterChart, monthlyHeatmap, monthlyBars, distributionChart, donutChart, hBarChart, stackedArea, varTableHtml, stressTableHtml, stressFanChart, holdingsTableHtml, fmt, pct, money, colors: C };
}));
