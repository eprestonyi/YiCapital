/* ═══════════════════════════════════════════════════════
   Yi Capital 全站會話組件
   已登入 → 導航右上角顯示頭像（用戶名首字母）＋下拉菜單（登出等）
   未登入 → 保持 LOGIN 鏈接原樣
   依賴：assets/portal-config.js（提供 window.YC_API）
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const API = (window.YC_API || '').replace(/\/+$/, '');
  const locale = window.YC_LANG === 'cn' ? 'cn' : window.YC_LANG === 'en' ? 'en' : 'tw';
  const homePath = locale === 'cn' ? '/cn/' : locale === 'en' ? '/en/' : '/';
  const portfolioPath = homePath + 'portfolios';
  const loginPath = homePath + 'login';
  // 兼容舊 sessionStorage 會話（遷移到 localStorage）
  ['yc-token', 'yc-role', 'yc-user'].forEach(k => {
    if (!localStorage.getItem(k) && sessionStorage.getItem(k)) localStorage.setItem(k, sessionStorage.getItem(k));
  });
  const tok = localStorage.getItem('yc-token') || '';
  const user = localStorage.getItem('yc-user') || '';
  const role = localStorage.getItem('yc-role') || '';
  const isMember = /^[a-f0-9]{64}$/i.test(tok) && Boolean(user);
  const isGuest = !isMember && localStorage.getItem('yc-guest') === '1';
  if (!isMember && !isGuest) return;
  const labels = {
    tw: { guest: 'Guest 訪客', guestRole: '訪客模式', signIn: '登入 / 註冊', exit: '退出 Guest', logout: '登出 Logout', portfolio: '組合實錄', admin: '管理後台' },
    cn: { guest: 'Guest 访客', guestRole: '访客模式', signIn: '登录 / 注册', exit: '退出 Guest', logout: '登出 Logout', portfolio: '组合实录', admin: '管理后台' },
    en: { guest: 'Guest', guestRole: 'Guest access', signIn: 'Sign in / Register', exit: 'Exit Guest', logout: 'Sign out', portfolio: 'Portfolios', admin: 'Administration' },
  }[locale];
  const displayUser = isGuest ? labels.guest : user;
  const roleLabel = isGuest
    ? labels.guestRole
    : role === 'admin'
      ? (locale === 'en' ? 'Administrator' : locale === 'cn' ? '管理员' : '管理員')
      : (locale === 'en' ? 'Member' : locale === 'cn' ? '注册用户' : '註冊用戶');
  const safeUser = displayUser.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function clearSession() {
    ['yc-token', 'yc-role', 'yc-user', 'yc-guest'].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
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
    // 會員已登入時隱藏 LOGIN；Guest 保留升級登入入口。
    if (isMember) {
      document.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href') || '';
        if (/login(\.html)?$/.test(href)) a.style.display = 'none';
      });
      document.querySelectorAll('.yc-authcta').forEach(el => { el.style.display = 'none'; });
    }
    const nav = document.querySelector('header .nav') || document.querySelector('header .wrap');
    if (!nav || document.querySelector('.yc-ava-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'yc-ava-wrap';
    const initial = displayUser.trim().charAt(0).toUpperCase();
    wrap.innerHTML = `
      <div class="yc-ava" id="ycAva" title="${safeUser}">${initial}</div>
      <div class="yc-menu" id="ycMenu">
        <div class="yc-id"><b>${safeUser}</b><span>${roleLabel}</span></div>
        ${isGuest ? `<a href="${loginPath}">${labels.signIn}</a>` : `
          ${role === 'admin' ? `<a href="/admin">${labels.admin}</a>` : ''}
          <a href="${portfolioPath}">${labels.portfolio}</a>`}
        <button class="yc-out" id="ycLogout">${isGuest ? labels.exit : labels.logout}</button>
      </div>`;
    nav.appendChild(wrap);

    const ava = wrap.querySelector('#ycAva'), menu = wrap.querySelector('#ycMenu');
    ava.addEventListener('click', e => {
      e.stopPropagation();
      const rect = wrap.getBoundingClientRect();
      if (rect.left < window.innerWidth / 2) {
        menu.style.left = '0'; menu.style.right = 'auto';
      } else {
        menu.style.right = '0'; menu.style.left = 'auto';
      }
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));
    wrap.querySelector('#ycLogout').addEventListener('click', () => {
      if (isMember && API) {
        fetch(API + '/api/logout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + tok },
          keepalive: true,
        }).catch(() => {});
      }
      clearSession();
      location.replace(homePath);
    });
  }

  // 靜默校驗會話：過期則清除並還原 LOGIN 鏈接
  if (isMember && API) {
    fetch(API + '/api/me', { headers: { 'Authorization': 'Bearer ' + tok } })
      .then(r => {
        if (r.status === 401) {
          clearSession();
          location.replace(homePath);
        }
      })
      .catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
