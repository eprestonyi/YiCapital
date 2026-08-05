/* ═══════════════════════════════════════════════════════════
   內容鎖牆：未登入時，研報庫/組合實錄/完整檔案頁
   保留頂部框架可見，主體加漸隱鎖罩 + 登入/註冊 CTA 卡。
   僅在身份服務確認會話有效後放開。這是體驗層軟牆；真正敏感內容仍須由服務端授權後返回。
   ═══════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  var zone = document.querySelector('.yc-lock');
  if (!zone) return;
  zone.classList.add('locked');
  var t = (k,fb)=> (window.YCI ? YCI.t(k) : fb);
  var isPf = /portfolios|fund-(?:us|hk|a)/.test(location.pathname);
  var body = isPf ? t('gate.pf','免費註冊即可查看完整組合檔案。') : t('gate.forum','免費註冊即可閱讀全部深度研報。');
  var card = document.createElement('div');
  card.className = 'yc-gatecard';
  var token = String(localStorage.getItem('yc-token') || '');
  var user = String(localStorage.getItem('yc-user') || '');
  var candidate = /^[a-f0-9]{64}$/i.test(token) && Boolean(user);
  function renderLocked(){
    card.innerHTML = '<h3>'+t('gate.title','解鎖完整內容')+'</h3>'
      + '<p>'+body+'</p>'
      + '<div class="row"><a class="p" href="login#signup">'+t('gate.signup','免費註冊 →')+'</a>'
      + '<a class="g" href="login">'+t('gate.login','已有帳號 · 登入')+'</a></div>'
      + '<div class="note">'+t('gate.note','FREE · 30 秒完成')+'</div>';
  }
  if (candidate) {
    card.innerHTML = '<h3>'+t('gate.checking','正在驗證帳戶')+'</h3><p>'+t('gate.checkingBody','確認登入狀態後即會顯示完整內容。')+'</p>';
  } else renderLocked();
  zone.parentNode.insertBefore(card, zone.nextSibling);
  if (!candidate) return;
  function unlock(event){
    var detail = event && event.detail || window.__YC_SESSION_VERIFIED__ || {};
    if (String(detail.token || '').toLowerCase() !== token.toLowerCase()) return;
    zone.classList.remove('locked');
    card.remove();
  }
  function keepLocked(){
    zone.classList.add('locked');
    renderLocked();
    if (!card.isConnected) zone.parentNode.insertBefore(card, zone.nextSibling);
  }
  window.addEventListener('yc:session-valid', unlock);
  window.addEventListener('yc:session-invalid', keepLocked);
  window.addEventListener('yc:session-unavailable', keepLocked);
  if (window.__YC_SESSION_VERIFIED__) unlock({ detail: window.__YC_SESSION_VERIFIED__ });
})();
