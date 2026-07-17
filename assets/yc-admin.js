/* ═══════════════════════════════════════════════════════════
   Yi Capital Admin 共享框架
   · YCAdmin.gate(cb)：驗證管理員會話，通過後顯示 #panel 並回調
   · YCAdmin.api(path, opts)：帶 Bearer token 的 fetch
   · YCAdmin.plog(el, msg, cls)：日誌行
   · 自動注入統一後台導航（#adminnav）與共享樣式
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = (window.YC_API || '').replace(/\/+$/, '');
  const TOK = () => localStorage.getItem('yc-token');

  async function api(path, opts = {}) {
    const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOK(), ...(opts.headers || {}) } });
    const j = await r.json().catch(() => ({ error: '響應解析失敗' }));
    if (r.status === 401) { location.href = 'login'; throw new Error('未登入'); }
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  function plog(el, msg, cls) { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = msg; el.appendChild(d); }

  /* ── 共享樣式 ── */
  const css = document.createElement('style');
  css.textContent = `
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:28px 32px;margin-bottom:24px;overflow-x:auto}
  .card h3{font-family:var(--sans);color:#fff;font-size:18px;margin-bottom:18px}
  .btn{display:inline-block;background:linear-gradient(90deg,var(--cyan),var(--blue));color:#04070d;border:none;border-radius:6px;padding:11px 26px;font-family:var(--sans);font-weight:600;font-size:14.5px;cursor:pointer}
  .btn:disabled{opacity:.35;cursor:not-allowed}
  .btn2{background:none;border:1px solid var(--line);color:var(--txt);border-radius:6px;padding:7px 14px;font-family:var(--mono);font-size:12px;cursor:pointer}
  .btn2:hover{border-color:var(--cyan);color:var(--cyan)}
  .btn2.danger:hover{border-color:var(--down);color:var(--down)}
  .drop2{border:1px dashed var(--line);border-radius:10px;padding:38px;text-align:center;color:var(--muted);font-family:var(--mono);font-size:13px;cursor:pointer;display:block}
  .drop2:hover,.drop2.over{border-color:var(--cyan);color:var(--cyan)}
  .log{font-family:var(--mono);font-size:12.5px;line-height:2;color:#cdd6e3;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px 18px;min-height:52px;white-space:pre-wrap}
  .ok{color:var(--up)} .err{color:var(--down)} .dim{color:var(--muted)}
  .preview{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:18px 0}
  .preview .stat{background:var(--bg)}
  .topbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .who{font-family:var(--mono);font-size:12.5px;color:var(--muted)} .who b{color:var(--cyan)}
  table.m td .btn2{margin-right:6px;margin-bottom:4px}
  .badge{font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:20px;border:1px solid var(--line);white-space:nowrap}
  .badge.on{color:var(--up);border-color:var(--up)} .badge.off{color:var(--down);border-color:var(--down)}
  .adminnav{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 26px}
  .adminnav a{font-family:var(--mono);font-size:12px;letter-spacing:.5px;color:#8b98ab;text-decoration:none;border:1px solid var(--line);border-radius:20px;padding:8px 16px}
  .adminnav a:hover{color:var(--cyan);border-color:var(--cyan)}
  .adminnav a.on{color:#04070d;background:var(--cyan);border-color:var(--cyan);font-weight:600}
  .adminnav a.exit{margin-left:auto;color:var(--down);border-color:rgba(248,113,113,.4)}
  .fldrow{display:grid;grid-template-columns:110px 1fr;gap:10px 14px;align-items:center;margin-bottom:12px}
  .fldrow label{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:1px}
  .fldrow input,.fldrow textarea,.fldrow select{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--txt);padding:10px 12px;font-size:13.5px;font-family:var(--zh)}
  .tri{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
  .tri input,.tri textarea{width:100%}
  .searchline{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
  .searchline input{flex:1;min-width:200px;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:11px 14px;font-size:14px}
  @media (max-width:820px){
    .card{padding:20px 16px}
    .fldrow{grid-template-columns:1fr}
    .tri{grid-template-columns:1fr}
    .adminnav a.exit{margin-left:0}
    table.m{min-width:640px}
  }`;
  document.head.appendChild(css);

  /* ── 後台導航 ── */
  const NAV = [
    ['admin', '總覽'],
    ['admin-publish', '發布淨值表'],
    ['admin-reports', '研報管理'],
    ['admin-insights', '研究觀點管理'],
    ['admin-users', '帳號管理'],
    ['admin-mail', '郵件中心'],
    ['admin-inbox', '收件箱'],
  ];
  function mountNav() {
    const host = $('adminnav');
    if (!host) return;
    const cur = (location.pathname.split('/').pop() || 'admin').replace(/\.html$/, '') || 'admin';
    host.className = 'adminnav';
    host.innerHTML = NAV.map(([p, t]) => `<a href="${p}" class="${cur === p ? 'on' : ''}">${t}</a>`).join('')
      + `<a href="./" target="_blank">前台 ↗</a><a href="#" id="yca-logout" class="exit">登出</a>`;
    $('yca-logout').onclick = async e => {
      e.preventDefault();
      try { await api('/api/logout', { method: 'POST' }); } catch (err) {}
      ['yc-token', 'yc-role', 'yc-user'].forEach(k => localStorage.removeItem(k));
      location.href = 'login';
    };
  }

  /* ── 門禁 ── */
  async function gate(cb) {
    mountNav();
    const gm = $('gatemsg');
    if (!API) { if (gm) gm.textContent = '後端未配置：請先在 assets/portal-config.js 填入 Worker 地址。'; return; }
    if (!TOK()) { location.href = 'login'; return; }
    try {
      const me = await api('/api/me');
      if (me.role !== 'admin') { if (gm) gm.textContent = '此帳號不是管理員。'; setTimeout(() => location.href = 'login', 1500); return; }
      const who = $('who'); if (who) who.innerHTML = '已登入：<b>' + me.username + '</b>（admin）';
      const g = $('gate'); if (g) g.style.display = 'none';
      const p = $('panel'); if (p) p.style.display = 'block';
      if (cb) cb(me);
    } catch (e) { if (gm) gm.textContent = '✗ ' + e.message; }
  }

  window.YCAdmin = { $, api, plog, gate, API, TOK };
})();
