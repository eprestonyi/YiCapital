/* ═══════════════════════════════════════════════════════
   Yi Capital 全站會話組件
   已登入 → 導航右上角顯示頭像（用戶名首字母）＋下拉菜單（登出等）
   未登入 → 保持 LOGIN 鏈接原樣
   依賴：assets/portal-config.js（提供 window.YC_API）
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  const _p = location.pathname;
  const ROOT = (/\/(posts|cn|en)\//.test(_p)) ? '../' : '';
  // 兼容舊 sessionStorage 會話（遷移到 localStorage）
  ['yc-token', 'yc-role', 'yc-user'].forEach(k => {
    if (!localStorage.getItem(k) && sessionStorage.getItem(k)) localStorage.setItem(k, sessionStorage.getItem(k));
  });
  const tok = localStorage.getItem('yc-token');
  const user = localStorage.getItem('yc-user');
  const role = localStorage.getItem('yc-role');
  if (!tok || !user) return;

  function clearSession() {
    ['yc-token', 'yc-role', 'yc-user'].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
  }

  // 樣式
  const css = document.createElement('style');
  css.textContent = `
    .yc-ava-wrap{position:relative;display:inline-flex;align-items:center;margin-left:18px}
    .yc-ava{width:34px;height:34px;border-radius:50%;border:1.5px solid var(--cyan,#22d3ee);
      background:linear-gradient(135deg,#0e2233,#123);color:var(--cyan,#22d3ee);
      font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;user-select:none}
    .yc-ava:hover{box-shadow:0 0 10px rgba(34,211,238,.45)}
    .yc-menu{position:absolute;top:44px;right:0;min-width:210px;background:#0a121f;
      border:1px solid #1a2436;border-radius:10px;padding:8px;z-index:999;display:none;
      box-shadow:0 10px 30px rgba(0,0,0,.5)}
    .yc-menu.open{display:block}
    .yc-menu .yc-id{padding:10px 12px;border-bottom:1px solid #1a2436;margin-bottom:6px}
    .yc-menu .yc-id b{display:block;color:#e8edf5;font-size:14px;font-family:'Space Grotesk',sans-serif;word-break:break-all}
    .yc-menu .yc-id span{color:#5f6f85;font-size:11px;font-family:'IBM Plex Mono',monospace;letter-spacing:1px;text-transform:uppercase}
    .yc-menu a,.yc-menu button{display:block;width:100%;text-align:left;background:none;border:none;
      color:#cdd6e3;font-size:13.5px;padding:9px 12px;border-radius:6px;cursor:pointer;text-decoration:none;font-family:inherit}
    .yc-menu a:hover,.yc-menu button:hover{background:#12203a;color:var(--cyan,#22d3ee)}
    .yc-menu .yc-out{color:#ff5c47}
    .yc-menu .yc-out:hover{background:#2a1210;color:#ff5c47}`;
  document.head.appendChild(css);

  function mount() {
    // 隱藏工具欄的 LOGIN 鏈接
    document.querySelectorAll('a').forEach(a => {
      if (a.getAttribute('href') && a.getAttribute('href').indexOf('login.html') !== -1 && a.textContent.trim().toUpperCase() === 'LOGIN') a.style.display = 'none';
    });
    const nav = document.querySelector('header .nav') || document.querySelector('header .wrap');
    if (!nav || document.querySelector('.yc-ava-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'yc-ava-wrap';
    const initial = user.trim().charAt(0).toUpperCase();
    wrap.innerHTML = `
      <div class="yc-ava" id="ycAva" title="${user}">${initial}</div>
      <div class="yc-menu" id="ycMenu">
        <div class="yc-id"><b>${user}</b><span>${role === 'admin' ? 'Administrator' : 'Guest'}</span></div>
        ${role === 'admin' ? `<a href="${ROOT}admin">管理後台</a>` : ''}
        <a href="${ROOT}portfolios">組合實錄</a>
        <button class="yc-out" id="ycLogout">登出 Logout</button>
      </div>`;
    nav.appendChild(wrap);

    const ava = wrap.querySelector('#ycAva'), menu = wrap.querySelector('#ycMenu');
    ava.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    wrap.querySelector('#ycLogout').addEventListener('click', async () => {
      try { if (API) await fetch(API + '/api/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok } }); } catch (e) {}
      clearSession();
      location.href = ROOT + 'index.html';
    });
  }

  // 靜默校驗會話：過期則清除並還原 LOGIN 鏈接
  if (API) {
    fetch(API + '/api/me', { headers: { 'Authorization': 'Bearer ' + tok } })
      .then(r => { if (r.status === 401) { clearSession(); location.reload(); } })
      .catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
