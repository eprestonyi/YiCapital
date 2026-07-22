/* ═══════════════════════════════════════════════════════════
   內容鎖牆：未登入時，研報庫/組合實錄/完整檔案頁
   保留頂部框架可見，主體加漸隱鎖罩 + 登入/註冊 CTA 卡。
   已登入（localStorage yc-token）則完全放開。
   ═══════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  if (localStorage.getItem('yc-token')) return;           // 已登入：不鎖
  var zone = document.querySelector('.yc-lock');
  if (!zone) return;
  zone.classList.add('locked');
  var t = (k,fb)=> (window.YCI ? YCI.t(k) : fb);
  var isPf = /portfolios|fund-(?:us|hk|a)/.test(location.pathname);
  var body = isPf ? t('gate.pf','免費註冊即可查看完整組合檔案。') : t('gate.forum','免費註冊即可閱讀全部深度研報。');
  var card = document.createElement('div');
  card.className = 'yc-gatecard';
  card.innerHTML = '<h3>'+t('gate.title','解鎖完整內容')+'</h3>'
    + '<p>'+body+'</p>'
    + '<div class="row"><a class="p" href="login#signup">'+t('gate.signup','免費註冊 →')+'</a>'
    + '<a class="g" href="login">'+t('gate.login','已有帳號 · 登入')+'</a></div>'
    + '<div class="note">'+t('gate.note','FREE · 30 秒完成')+'</div>';
  zone.parentNode.insertBefore(card, zone.nextSibling);
})();
