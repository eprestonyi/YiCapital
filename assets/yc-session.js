(function () {
  'use strict';
  if (window.__YC_ACCOUNT_MOUNTED__) return;
  window.__YC_ACCOUNT_MOUNTED__ = true;

  const API = String(window.YC_API || '').replace(/\/+$/, '');
  const locale = window.YC_LANG === 'cn' ? 'cn' : window.YC_LANG === 'en' ? 'en' : 'tw';
  const homePath = locale === 'cn' ? '/cn/' : locale === 'en' ? '/en/' : '/';
  const loginPath = homePath + 'login';
  const portfolioPath = homePath + 'portfolios';

  ['yc-token', 'yc-role', 'yc-user'].forEach(key => {
    if (!localStorage.getItem(key) && sessionStorage.getItem(key)) {
      localStorage.setItem(key, sessionStorage.getItem(key));
    }
  });
  let token = localStorage.getItem('yc-token') || '';
  const storedUser = localStorage.getItem('yc-user') || '';
  const isMember = /^[a-f0-9]{64}$/i.test(token) && Boolean(storedUser);
  const isGuest = !isMember && localStorage.getItem('yc-guest') === '1';
  if (!isMember && !isGuest) return;

  const L = {
    tw: {
      guest: '訪客', guestRole: '訪客模式', signIn: '登入 / 註冊',
      exit: '退出訪客模式', logout: '登出', logoutRetry: '登出失敗，點擊重試',
      portfolio: '組合實錄', admin: '管理後台', account: '帳戶設定',
      unavailable: '暫未開放', close: '關閉', loading: '正在載入帳戶資料…',
      loadError: '暫時無法載入帳戶資料，請稍後重試。',
      accountKicker: '帳戶', accountTitle: '帳戶設定與個人資料',
      accountIntro: '管理你的公開名稱、YiCapital ID、頭像、身份連接與郵件偏好。',
      navAccount: '帳戶設定', navConnect: 'MCP 與 API', navContact: '網站營運者',
      navSocial: '社交媒體', navApp: '應用程式', navHelp: '支援與協助',
      displayName: '顯示名稱', userId: 'YiCapital ID', email: '郵箱',
      immutable: '登入身份已鎖定，不能在此更改。', connectionTitle: '已連接的身份',
      connected: '已連接', notConnected: '未連接', google: 'Google', emailAccount: '電子郵件',
      avatarChange: '更改頭像', avatarRemove: '改用字母頭像', avatarHint: 'JPG、PNG 或 WebP，會自動裁切為正方形。',
      avatarError: '請選擇 6MB 以下的 JPG、PNG 或 WebP 圖片。',
      notifications: '通知', newsletterTitle: 'Yi Capital Insights',
      newsletterBody: '將精選研究、重要新文章與組合更新送到你的收件箱。不發促銷，只發值得打開的內容。',
      inviteTitle: '邀請', inviteBody: '把你的專屬註冊連結分享給同樣重視深度研究的人。',
      copy: '複製連結', copied: '已複製', save: '儲存變更', saving: '正在儲存…',
      saved: '帳戶設定已更新。', genericError: '暫時無法完成操作，請稍後重試。',
      sessionError: '登入已失效，請重新登入。', forbiddenError: '此帳戶目前不可使用。',
      conflictError: '這個 YiCapital ID 已被使用。', rateError: '操作過於頻繁，請稍後再試。',
      connectTitle: '連接 MCP 與 API', connectBody: '未來可在這裡連接研究工具、資料服務與個人工作流。目前正在設計安全授權與權限管理。',
      contactKicker: '網站營運', contactTitle: '聯絡網站營運者', contactRole: '創辦人兼網站營運者 · Yi Capital',
      philosophyTitle: '投資哲學',
      philosophy: '我是基本面投資者，習慣像使用 Bloomberg FA 一樣逐行閱讀財務報表。研究聚焦長期自由現金流、資本配置、護城河與價格紀律；所有判斷都應能被證據追溯，也應能被新事實推翻。',
      welcome: '歡迎就公司、行業、估值或研究方法來信探討。不同觀點沒有關係，最好帶著證據。',
      socialTitle: '社交媒體', socialBody: '小紅書、抖音、Instagram、WeChat 公眾號、Bilibili 與 YouTube 將在內容準備好後逐步開放。',
      socialChannels: ['小紅書', '抖音', 'Instagram', 'WeChat', 'Bilibili', 'YouTube'],
      appTitle: '應用程式', appBody: 'YiCapital 應用程式尚未開放。我們會先把網頁端的研究、組合與帳戶體驗做好。',
      helpKicker: '支援', helpTitle: '支援與協助', helpMore: '仍需要協助？', helpEmail: '傳送電子郵件',
      faqAccount: '註冊帳戶有甚麼用途？',
      faqAccountA: '公開研究與組合毋須帳戶即可閱讀；帳戶用於管理身份、頭像、Insights 與後續個人化功能。',
      faqNews: 'Insights 訂閱會寄甚麼？', faqNewsA: '只寄精選研究、重要文章與有實質內容的組合更新。你可隨時在帳戶設定取消。',
      faqIdentity: '可以更改登入郵箱或 Google 帳號嗎？', faqIdentityA: '目前不可以。為避免帳號被錯誤轉移，已綁定的郵箱與 Google 身份保持鎖定；顯示名稱、ID 與頭像可以修改。',
      faqResearch: '網站內容是投資建議嗎？', faqResearchA: '不是。所有內容僅供研究與學習，不構成任何證券的買賣要約、招攬或投資建議。',
      promptKicker: '只收真正值得讀的研究', promptTitle: '把真正值得讀的研究送到收件箱。',
      promptBody: '精選深度研究、重要新文章與組合更新。不發促銷，隨時可以取消。',
      subscribe: '一鍵訂閱', subscribing: '訂閱中…', subscribed: '已訂閱',
      idHelp: '2–24 位中英文、數字、_ 或 -；全站不可重複。',
      photoReady: '新頭像已準備好，儲存後生效。',
      adminRole: '管理員安全帳號', adminManaged: '這是獨立的管理員安全身份，登入名稱與憑證由安全配置管理。客戶個人資料、Google／郵箱綁定及 Insights 偏好請使用普通會員帳號管理。',
      adminOpen: '開啟管理後台',
    },
    cn: {
      guest: '访客', guestRole: '访客模式', signIn: '登录 / 注册',
      exit: '退出访客模式', logout: '退出登录', logoutRetry: '退出登录失败，点击重试',
      portfolio: '组合实录', admin: '管理后台', account: '账户设置',
      unavailable: '暂未开放', close: '关闭', loading: '正在加载账户资料…',
      loadError: '暂时无法加载账户资料，请稍后重试。',
      accountKicker: '账户', accountTitle: '账户设置与个人资料',
      accountIntro: '管理你的公开名称、YiCapital ID、头像、身份连接与邮件偏好。',
      navAccount: '账户设置', navConnect: 'MCP 与 API', navContact: '网站运营者',
      navSocial: '社交媒体', navApp: '应用程序', navHelp: '支持与帮助',
      displayName: '显示名称', userId: 'YiCapital ID', email: '邮箱',
      immutable: '登录身份已锁定，不能在此更改。', connectionTitle: '已连接的身份',
      connected: '已连接', notConnected: '未连接', google: 'Google', emailAccount: '电子邮件',
      avatarChange: '更改头像', avatarRemove: '改用字母头像', avatarHint: 'JPG、PNG 或 WebP，会自动裁切为正方形。',
      avatarError: '请选择 6MB 以下的 JPG、PNG 或 WebP 图片。',
      notifications: '通知', newsletterTitle: 'Yi Capital Insights',
      newsletterBody: '将精选研究、重要新文章与组合更新送到你的收件箱。不发促销，只发值得打开的内容。',
      inviteTitle: '邀请', inviteBody: '把你的专属注册链接分享给同样重视深度研究的人。',
      copy: '复制链接', copied: '已复制', save: '保存更改', saving: '正在保存…',
      saved: '账户设置已更新。', genericError: '暂时无法完成操作，请稍后重试。',
      sessionError: '登录已失效，请重新登录。', forbiddenError: '此账户目前不可使用。',
      conflictError: '这个 YiCapital ID 已被使用。', rateError: '操作过于频繁，请稍后再试。',
      connectTitle: '连接 MCP 与 API', connectBody: '未来可在这里连接研究工具、数据服务与个人工作流。目前正在设计安全授权与权限管理。',
      contactKicker: '网站运营', contactTitle: '联系网站运营者', contactRole: '创办人兼网站运营者 · Yi Capital',
      philosophyTitle: '投资哲学',
      philosophy: '我是基本面投资者，习惯像使用 Bloomberg FA 一样逐行阅读财务报表。研究聚焦长期自由现金流、资本配置、护城河与价格纪律；所有判断都应能被证据追溯，也应能被新事实推翻。',
      welcome: '欢迎就公司、行业、估值或研究方法来信探讨。不同观点没有关系，最好带着证据。',
      socialTitle: '社交媒体', socialBody: '小红书、抖音、Instagram、微信公众号、Bilibili 与 YouTube 将在内容准备好后逐步开放。',
      socialChannels: ['小红书', '抖音', 'Instagram', '微信', 'Bilibili', 'YouTube'],
      appTitle: '应用程序', appBody: 'YiCapital 应用程序尚未开放。我们会先把网页端的研究、组合与账户体验做好。',
      helpKicker: '支持', helpTitle: '支持与帮助', helpMore: '仍需要帮助？', helpEmail: '发送电子邮件',
      faqAccount: '注册账户有什么用途？',
      faqAccountA: '公开研究与组合无需账户即可阅读；账户用于管理身份、头像、Insights 与后续个性化功能。',
      faqNews: 'Insights 订阅会寄什么？', faqNewsA: '只寄精选研究、重要文章与有实质内容的组合更新。你可随时在账户设置取消。',
      faqIdentity: '可以更改登录邮箱或 Google 账号吗？', faqIdentityA: '目前不可以。为避免账户被错误转移，已绑定的邮箱与 Google 身份保持锁定；显示名称、ID 与头像可以修改。',
      faqResearch: '网站内容是投资建议吗？', faqResearchA: '不是。所有内容仅供研究与学习，不构成任何证券的买卖要约、招揽或投资建议。',
      promptKicker: '只收真正值得读的研究', promptTitle: '把真正值得读的研究送到收件箱。',
      promptBody: '精选深度研究、重要新文章与组合更新。不发促销，随时可以取消。',
      subscribe: '一键订阅', subscribing: '订阅中…', subscribed: '已订阅',
      idHelp: '2–24 位中英文、数字、_ 或 -；全站不可重复。',
      photoReady: '新头像已准备好，保存后生效。',
      adminRole: '管理员安全账号', adminManaged: '这是独立的管理员安全身份，登录名称与凭证由安全配置管理。客户个人资料、Google／邮箱绑定及 Insights 偏好请使用普通会员账号管理。',
      adminOpen: '打开管理后台',
    },
    en: {
      guest: 'Guest', guestRole: 'Guest access', signIn: 'Sign in / Register',
      exit: 'Exit Guest', logout: 'Sign out', logoutRetry: 'Sign-out failed — retry',
      portfolio: 'Portfolios', admin: 'Administration', account: 'Account settings',
      unavailable: 'Coming soon', close: 'Close', loading: 'Loading your account…',
      loadError: 'Your account details are temporarily unavailable. Please try again.',
      accountKicker: 'ACCOUNT', accountTitle: 'Account Settings & Profile',
      accountIntro: 'Manage your public name, YiCapital ID, avatar, connected identities and email preferences.',
      navAccount: 'Account', navConnect: 'MCPs & APIs', navContact: 'Operator',
      navSocial: 'Social Media', navApp: 'App', navHelp: 'Support & Help',
      displayName: 'Display name', userId: 'YiCapital ID', email: 'Email',
      immutable: 'Your sign-in identity is locked and cannot be changed here.', connectionTitle: 'Connected identities',
      connected: 'Connected', notConnected: 'Not connected', google: 'Google', emailAccount: 'Email',
      avatarChange: 'Change avatar', avatarRemove: 'Use initials', avatarHint: 'JPG, PNG or WebP. We crop it to a square.',
      avatarError: 'Choose a JPG, PNG or WebP image under 6MB.',
      notifications: 'Notifications', newsletterTitle: 'Yi Capital Insights',
      newsletterBody: 'Selected research, important new essays and portfolio updates in your inbox. No promotions—only work worth opening.',
      inviteTitle: 'Invite', inviteBody: 'Share your personal registration link with someone who values deep research.',
      copy: 'Copy link', copied: 'Copied', save: 'Save changes', saving: 'Saving…',
      saved: 'Your account settings have been updated.', genericError: 'Unable to complete this action. Please try again.',
      sessionError: 'Your session is no longer valid. Sign in again.', forbiddenError: 'This account is not currently available.',
      conflictError: 'That YiCapital ID is already in use.', rateError: 'Too many attempts. Try again later.',
      connectTitle: 'Connect MCPs & APIs', connectBody: 'Connect research tools, data services and personal workflows here in the future. Secure authorization and permission controls are in development.',
      contactKicker: 'OPERATOR', contactTitle: 'Contact Site Operator', contactRole: 'Founder & Site Operator · Yi Capital',
      philosophyTitle: 'Investment philosophy',
      philosophy: 'I am a fundamental investor who works through financial statements line by line, much like using Bloomberg FA. My research centers on long-term free cash flow, capital allocation, moats and price discipline. Every judgment should be traceable to evidence—and falsifiable by new facts.',
      welcome: 'You are welcome to discuss companies, industries, valuation or research methods. Different views are welcome; evidence makes the conversation better.',
      socialTitle: 'Social Media', socialBody: 'Xiaohongshu, Douyin, Instagram, WeChat Official Account, Bilibili and YouTube will open progressively when the content is ready.',
      socialChannels: ['Xiaohongshu', 'Douyin', 'Instagram', 'WeChat', 'Bilibili', 'YouTube'],
      appTitle: 'App', appBody: 'The YiCapital app is not available yet. We are finishing the web research, portfolio and account experience first.',
      helpKicker: 'SUPPORT', helpTitle: 'Support & Help', helpMore: 'Still need help?', helpEmail: 'Email',
      faqAccount: 'What does a registered account unlock?',
      faqAccountA: 'Public research and portfolios require no account. Accounts manage identity, avatars, Insights and future personalized features.',
      faqNews: 'What will Insights send me?', faqNewsA: 'Only selected research, important essays and meaningful portfolio updates. You can unsubscribe here at any time.',
      faqIdentity: 'Can I change my sign-in email or Google account?', faqIdentityA: 'Not currently. Bound email and Google identities stay locked to prevent an accidental account transfer. You can change your display name, ID and avatar.',
      faqResearch: 'Is this site investment advice?', faqResearchA: 'No. Everything is for research and education only and is not an offer, solicitation or investment advice.',
      promptKicker: 'INSIGHTS, WITHOUT THE NOISE', promptTitle: 'Get the research that is actually worth reading.',
      promptBody: 'Selected deep dives, important new essays and portfolio updates. No promotions, unsubscribe anytime.',
      subscribe: 'Subscribe', subscribing: 'Subscribing…', subscribed: 'Subscribed',
      idHelp: '2–24 Chinese/English characters, numbers, _ or -. Unique across YiCapital.',
      photoReady: 'Your new avatar is ready. Save to apply it.',
      adminRole: 'Administrator security account', adminManaged: 'This is a separate administrator identity managed by secure configuration. Use a regular member account for customer profile details, Google/email connections and Insights preferences.',
      adminOpen: 'Open administration',
    },
  }[locale];

  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let profile = {
    username: storedUser,
    displayName: storedUser,
    email: '',
    avatar: null,
    newsletter: true,
    provider: '',
    connections: { email: false, google: false },
  };
  let profileLoaded = false;
  let activeSection = 'account';
  let returnFocus = null;
  let previousOverflow = '';
  let wrap;
  let menu;
  let identityBox;
  let avatarButton;
  let overlay;
  let main;
  let subscribeCard;
  let externalSyncTimer = 0;

  function initials() {
    const source = String(profile.displayName || profile.username || 'Yi').trim();
    const parts = source.split(/\s+/).filter(Boolean);
    return esc((parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)).toUpperCase());
  }

  function avatarMarkup(className) {
    if (profile.avatar) {
      return '<span class="' + className + '"><img src="' + esc(profile.avatar) + '" alt=""></span>';
    }
    return '<span class="' + className + '">' + initials() + '</span>';
  }

  function clearSession() {
    ['yc-token', 'yc-role', 'yc-user', 'yc-guest'].forEach(key => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
  }

  const css = document.createElement('style');
  css.textContent = `
    .yc-ava-wrap{position:relative;display:inline-flex;align-items:center;margin-left:18px;font-family:var(--sans,"Space Grotesk",sans-serif)}
    .yc-ava-button{width:38px;height:38px;border-radius:50%;border:1px solid rgba(117,167,255,.7);padding:0;background:#0a1424;color:#f5f2ea;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 0 rgba(117,167,255,0);transition:border-color .16s ease,box-shadow .16s ease}
    .yc-ava-button:hover,.yc-ava-button:focus-visible{border-color:#75a7ff;box-shadow:0 0 0 4px rgba(117,167,255,.12);outline:none}
    .yc-guest-button{min-height:38px;border:1px solid #31405a;border-radius:999px;padding:8px 12px;background:#0a1424;color:#cbd5e3;cursor:pointer;display:inline-flex;align-items:center;gap:8px;font:650 12px/1 var(--sans,"Space Grotesk",sans-serif);white-space:nowrap;transition:border-color .16s ease,color .16s ease,box-shadow .16s ease}
    .yc-guest-button:hover,.yc-guest-button:focus-visible{border-color:#75a7ff;color:#fff;box-shadow:0 0 0 4px rgba(117,167,255,.12);outline:none}.yc-guest-chevron{color:#75a7ff;font-size:11px}
    .yc-account-pending{border-style:dashed}.yc-account-dot{width:9px;height:9px;border-radius:50%;background:#75a7ff;box-shadow:0 0 0 4px rgba(117,167,255,.13)}
    .yc-avatar,.yc-avatar-lg{display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:50%;background:#10233e;color:#f5f2ea;font-weight:720;letter-spacing:-.02em}
    .yc-avatar{width:32px;height:32px;font-size:12px;flex:0 0 32px}.yc-avatar-lg{width:66px;height:66px;font-size:19px;flex:0 0 auto}
    .yc-avatar img,.yc-avatar-lg img{width:100%;height:100%;object-fit:cover}
    .yc-account-menu{position:absolute;top:48px;right:0;box-sizing:border-box;width:min(360px,calc(100vw - 28px));max-height:min(690px,calc(100vh - 92px));overflow:auto;background:rgba(7,12,21,.98);border:1px solid #24324a;border-radius:18px;padding:12px;z-index:1290;display:none;color:#e9eef7;box-shadow:0 28px 78px rgba(0,0,0,.66);backdrop-filter:blur(18px)}
    .yc-account-menu.open{display:block;animation:yc-menu-in .14s ease-out}
    .yc-menu-identity{display:flex;gap:12px;align-items:center;padding:12px 10px 16px;border-bottom:1px solid #202b3d;margin-bottom:8px}
    .yc-menu-identity-copy{min-width:0}.yc-menu-identity-copy>b,.yc-menu-identity-copy>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .yc-menu-identity-copy>b{color:#f5f2ea;font-size:16px;font-weight:680}.yc-menu-identity-copy>span{color:#7f8da1;font-size:12.5px;margin-top:4px}
    .yc-menu-item{display:flex!important;align-items:center!important;gap:12px;width:100%;box-sizing:border-box;border:0;background:none;color:#ced7e4!important;text-decoration:none!important;text-align:left;font:600 13.5px/1.3 var(--sans,"Space Grotesk",sans-serif);padding:11px 10px!important;border-radius:9px;cursor:pointer}
    .yc-menu-item:hover,.yc-menu-item:focus-visible{background:#111d30;color:#fff!important;outline:none}
    .yc-menu-icon{display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;color:#8290a3;font:500 17px/1 var(--mono,"IBM Plex Mono",monospace);flex:0 0 auto}
    .yc-menu-label{flex:1;min-width:0}.yc-menu-badge{border:1px solid #31405a;border-radius:999px;padding:3px 7px;color:#76859a;font:600 9px/1 var(--mono,"IBM Plex Mono",monospace);letter-spacing:.5px;text-transform:uppercase}
    .yc-menu-divider{height:1px;background:#202b3d;margin:8px 4px}.yc-menu-item.yc-logout{color:#ff8b7c!important}.yc-menu-item.yc-logout:hover{background:#281612}
    .yc-account-overlay{position:fixed;inset:0;z-index:1300;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(1,5,11,.78);backdrop-filter:blur(9px);font-family:var(--sans,"Space Grotesk",sans-serif)}
    .yc-account-overlay.open{display:flex}
    .yc-account-dialog{position:relative;display:grid;grid-template-columns:250px minmax(0,1fr);width:min(1160px,100%);height:min(790px,calc(100vh - 40px));overflow:hidden;border:1px solid #2a374d;border-radius:20px;background:#111824;color:#e8edf5;box-shadow:0 36px 110px rgba(0,0,0,.72)}
    .yc-account-close{position:absolute;top:16px;right:18px;z-index:3;width:36px;height:36px;border-radius:50%;border:1px solid #2b394f;background:#0a101a;color:#95a2b5;font-size:21px;line-height:1;cursor:pointer}
    .yc-account-close:hover,.yc-account-close:focus-visible{color:#fff;border-color:#75a7ff;outline:none}
    .yc-account-side{display:flex;flex-direction:column;min-width:0;padding:26px 16px 18px;border-right:1px solid #252f40;background:#0d141f}
    .yc-account-brand{color:#f5f2ea;font-weight:760;font-size:17px;padding:0 11px 22px;white-space:nowrap}.yc-account-nav{display:flex;flex-direction:column;gap:4px}
    .yc-account-nav button{display:flex;align-items:center;gap:11px;width:100%;border:0;border-left:3px solid transparent;border-radius:7px;padding:10px 10px;background:none;color:#8e9aac;text-align:left;font:590 13px/1.3 inherit;cursor:pointer}
    .yc-account-nav button:hover,.yc-account-nav button:focus-visible{background:#141e2d;color:#e8edf5;outline:none}.yc-account-nav button.active{border-left-color:#75a7ff;background:#151f2e;color:#fff}
    .yc-account-nav .yc-nav-icon{display:inline-flex;width:20px;justify-content:center;color:#8392a7;font-family:var(--mono,"IBM Plex Mono",monospace)}
    .yc-account-side-spacer{flex:1}.yc-side-admin{margin-top:15px!important}.yc-side-logout{margin-top:6px!important;color:#ff8b7c!important}
    .yc-account-main{overflow:auto;padding:34px clamp(22px,4vw,54px) 46px}
    .yc-section-kicker{margin:0 0 8px;color:#75a7ff;font:650 10px/1 var(--mono,"IBM Plex Mono",monospace);letter-spacing:2px}
    .yc-section-title{margin:0 46px 8px 0;color:#f5f2ea;font-size:26px;line-height:1.22;letter-spacing:-.025em}.yc-section-intro{margin:0 0 25px;color:#8f9bad;font-size:13.5px;line-height:1.7}
    .yc-profile-hero{display:flex;align-items:center;gap:17px;padding:22px;border:1px solid #283448;border-radius:14px;background:#0b111b;margin-bottom:24px}
    .yc-profile-hero-copy{min-width:0;flex:1}.yc-profile-hero-copy b,.yc-profile-hero-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.yc-profile-hero-copy b{font-size:17px;color:#fff}.yc-profile-hero-copy span{color:#7f8b9d;font-size:12.5px;margin-top:4px}
    .yc-avatar-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.yc-avatar-actions button{border:1px solid #30405a;border-radius:7px;background:#111b2a;color:#cdd6e3;padding:7px 10px;font:600 11px inherit;cursor:pointer}.yc-avatar-actions button:hover,.yc-avatar-actions button:focus-visible{border-color:#75a7ff;color:#fff;outline:none}
    .yc-avatar-note{display:block;color:#647188;font-size:10.5px;line-height:1.45;margin-top:8px}
    .yc-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:23px}.yc-field{display:block}.yc-field>span{display:block;color:#cdd6e3;font-size:11.5px;font-weight:650;margin-bottom:7px}
    .yc-field input{width:100%;box-sizing:border-box;border:1px solid #2b394f;border-radius:8px;background:#080e17;color:#f2f5fa;padding:11px 12px;font:500 13px inherit}
    .yc-field input:focus{outline:none;border-color:#75a7ff;box-shadow:0 0 0 3px rgba(117,167,255,.12)}.yc-field input[readonly]{color:#778398;background:#0c121c;cursor:not-allowed}.yc-field small{display:block;color:#647188;font-size:10.5px;line-height:1.5;margin-top:6px}
    .yc-subheading{margin:25px 0 10px;color:#e5ebf4;font-size:13px}.yc-connections{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:25px}
    .yc-connection{display:flex;align-items:center;gap:11px;border:1px solid #29364a;border-radius:10px;padding:13px;background:#0b111b}.yc-connection-mark{display:flex;width:30px;height:30px;align-items:center;justify-content:center;border-radius:8px;background:#151f2e;color:#dbe5f3;font-weight:750}
    .yc-connection-copy{flex:1}.yc-connection-copy b,.yc-connection-copy span{display:block}.yc-connection-copy b{font-size:12.5px;color:#e8edf5}.yc-connection-copy span{font-size:10.5px;color:#6f7d91;margin-top:3px}.yc-connection-state{color:#7fd3a7;font-size:10px;font-weight:650}.yc-connection-state.off{color:#637187}
    .yc-preference{display:flex;align-items:center;gap:18px;border:1px solid #2a374a;border-radius:12px;background:#0b111b;padding:17px 18px;margin-bottom:12px}.yc-preference-copy{flex:1}.yc-preference-copy b{display:block;color:#f2f5f9;font-size:13px;margin-bottom:4px}.yc-preference-copy p{margin:0;color:#788599;font-size:11.5px;line-height:1.55}
    .yc-switch{position:relative;width:45px;height:25px;flex:0 0 auto}.yc-switch input{position:absolute;opacity:0}.yc-switch span{position:absolute;inset:0;border-radius:999px;background:#273248;cursor:pointer;transition:background .16s ease}.yc-switch span::after{content:"";position:absolute;width:19px;height:19px;left:3px;top:3px;border-radius:50%;background:#d6deea;transition:transform .16s ease}.yc-switch input:checked+span{background:#477ee9}.yc-switch input:checked+span::after{transform:translateX(20px);background:#fff}.yc-switch input:focus-visible+span{outline:2px solid #75a7ff;outline-offset:3px}
    .yc-invite{display:flex;align-items:center;gap:13px;border:1px solid #2a374a;border-radius:12px;background:#0b111b;padding:16px 18px;margin:12px 0 23px}.yc-invite-copy{flex:1;min-width:0}.yc-invite-copy b{display:block;color:#eef3fa;font-size:13px}.yc-invite-copy p{margin:4px 0 8px;color:#788599;font-size:11.5px;line-height:1.5}.yc-invite-link{display:block;color:#75a7ff;font:500 10.5px/1.4 var(--mono,"IBM Plex Mono",monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .yc-secondary-button,.yc-primary-button{border-radius:8px;padding:10px 14px;font:680 12px inherit;cursor:pointer}.yc-secondary-button{border:1px solid #35445c;background:#111b2b;color:#e1e8f2}.yc-primary-button{border:0;background:#75a7ff;color:#07101d}.yc-secondary-button:hover,.yc-secondary-button:focus-visible,.yc-primary-button:hover,.yc-primary-button:focus-visible{filter:brightness(1.08);outline:2px solid rgba(117,167,255,.55);outline-offset:2px}
    .yc-save-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.yc-save-status{color:#7fd3a7;font-size:12px}.yc-save-status.error{color:#ff8b7c}
    .yc-empty-panel{display:flex;min-height:420px;align-items:center;justify-content:center;text-align:center}.yc-empty-card{max-width:560px;border:1px solid #2b384d;border-radius:16px;background:#0b111b;padding:42px 34px}.yc-empty-icon{display:flex;width:58px;height:58px;align-items:center;justify-content:center;margin:0 auto 18px;border-radius:15px;background:#14223a;color:#75a7ff;font:600 25px var(--mono,"IBM Plex Mono",monospace)}.yc-empty-card h2{margin:0 0 11px;color:#f5f2ea;font-size:24px}.yc-empty-card p{margin:0;color:#8b98aa;font-size:13.5px;line-height:1.75}.yc-coming{display:inline-block;margin-top:18px;border:1px solid #30425d;border-radius:999px;padding:6px 10px;color:#75a7ff;font:650 9px var(--mono,"IBM Plex Mono",monospace);letter-spacing:1px;text-transform:uppercase}
    .yc-operator{border:1px solid #2b384d;border-radius:16px;background:#0b111b;overflow:hidden}.yc-operator-head{display:flex;align-items:center;gap:16px;padding:24px;border-bottom:1px solid #253044}.yc-operator-mark{display:flex;width:54px;height:54px;align-items:center;justify-content:center;border-radius:50%;background:#173052;color:#f5f2ea;font-weight:750}.yc-operator-head h2{margin:0 0 5px;color:#fff;font-size:19px}.yc-operator-head p{margin:0;color:#7f8da0;font-size:12px}.yc-operator-email{display:inline-block;margin-top:8px;color:#75a7ff;font-size:12px;text-decoration:none}.yc-operator-body{padding:25px}.yc-operator-body h3{margin:0 0 9px;color:#dfe7f2;font-size:13px}.yc-operator-body p{margin:0 0 18px;color:#909daf;font-size:13.5px;line-height:1.8}
    .yc-social-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:22px}.yc-social-item{display:flex;align-items:center;justify-content:space-between;border:1px solid #29364a;border-radius:10px;padding:14px;color:#aeb9c8;background:#0b111b;font-size:12.5px}
    .yc-faq{border-top:1px solid #2b3749}.yc-faq details{border-bottom:1px solid #2b3749;padding:0 2px}.yc-faq summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;color:#e6ecf5;font-size:13.5px;font-weight:650;cursor:pointer}.yc-faq summary::-webkit-details-marker{display:none}.yc-faq summary::after{content:"+";color:#75a7ff;font-size:18px}.yc-faq details[open] summary::after{content:"−"}.yc-faq p{margin:-4px 32px 18px 0;color:#8b98aa;font-size:12.5px;line-height:1.75}
    .yc-subscribe-card{position:fixed;left:max(18px,env(safe-area-inset-left));bottom:max(18px,env(safe-area-inset-bottom));z-index:1170;width:min(340px,calc(100vw - 28px));box-sizing:border-box;border:1px solid rgba(117,167,255,.45);border-radius:14px;padding:17px;background:rgba(8,15,26,.96);color:#e8edf5;box-shadow:0 18px 52px rgba(0,0,0,.5);backdrop-filter:blur(14px)}.yc-subscribe-card.hide{display:none}.yc-subscribe-kicker{color:#75a7ff;font:650 8.5px var(--mono,"IBM Plex Mono",monospace);letter-spacing:1.5px}.yc-subscribe-card h3{margin:7px 0 6px;color:#f5f2ea;font-size:15px;line-height:1.35}.yc-subscribe-card p{margin:0 0 12px;color:#8794a7;font-size:11.5px;line-height:1.55}.yc-subscribe-card button{border:0;border-radius:7px;background:#75a7ff;color:#07101c;padding:8px 12px;font:700 11.5px inherit;cursor:pointer}.yc-subscribe-card button:disabled{opacity:.6;cursor:wait}
    @keyframes yc-menu-in{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
    @media(max-width:760px){.yc-ava-wrap{margin-left:auto}.yc-account-menu{position:fixed;top:74px;left:max(14px,env(safe-area-inset-left));right:max(14px,env(safe-area-inset-right));width:auto;max-height:calc(100vh - 92px)}.yc-account-overlay{padding:0}.yc-account-dialog{display:flex;flex-direction:column;width:100%;height:100%;border:0;border-radius:0}.yc-account-side{display:block;flex:0 0 auto;padding:18px 14px 9px;border-right:0;border-bottom:1px solid #263144;overflow:hidden}.yc-account-brand{padding:0 8px 14px}.yc-account-nav{flex-direction:row;overflow-x:auto;padding-bottom:5px;scrollbar-width:none}.yc-account-nav::-webkit-scrollbar{display:none}.yc-account-nav button{flex:0 0 auto;width:auto;border-left:0;border-bottom:2px solid transparent;padding:8px 10px;white-space:nowrap}.yc-account-nav button.active{border-left:0;border-bottom-color:#75a7ff}.yc-account-side-spacer,.yc-side-admin,.yc-side-logout{display:none!important}.yc-account-main{padding:24px 18px 40px}.yc-section-title{font-size:23px}.yc-form-grid,.yc-connections{grid-template-columns:1fr}.yc-profile-hero{align-items:flex-start;padding:17px}.yc-invite{align-items:stretch;flex-direction:column}.yc-invite-copy{width:100%;max-width:100%}.yc-invite .yc-secondary-button{width:100%}.yc-social-grid{grid-template-columns:1fr}.yc-subscribe-card{bottom:max(70px,calc(env(safe-area-inset-bottom) + 60px));left:14px}}
    @media(max-width:420px){.yc-account-menu{top:66px}.yc-avatar-lg{width:56px;height:56px}.yc-profile-hero{gap:12px}.yc-preference{align-items:flex-start}.yc-empty-card{padding:34px 22px}.yc-account-close{top:14px;right:13px}}
    @media(prefers-reduced-motion:reduce){.yc-account-menu.open{animation:none}.yc-switch span,.yc-switch span::after{transition:none}}
  `;
  document.head.appendChild(css);

  async function api(path, options) {
    if (!API) throw new Error(L.genericError);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const init = Object.assign({}, options || {});
    init.headers = Object.assign({}, init.headers || {}, { Authorization: 'Bearer ' + token });
    init.signal = controller.signal;
    try {
      const response = await fetch(API + path, init);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const localized = response.status === 401 ? L.sessionError
          : response.status === 403 ? L.forbiddenError
          : response.status === 409 ? L.conflictError
          : response.status === 429 ? L.rateError
          : locale === 'tw' && payload.error ? payload.error : L.genericError;
        const error = new Error(localized);
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function updateProfile(payload) {
    profile = { ...profile, ...payload, connections: { ...profile.connections, ...(payload.connections || {}) } };
    profileLoaded = true;
    if (payload.token && /^[a-f0-9]{64}$/i.test(payload.token)) {
      token = payload.token;
      sessionStorage.removeItem('yc-token');
      localStorage.setItem('yc-token', token);
    }
    if (payload.username) {
      sessionStorage.removeItem('yc-user');
      localStorage.setItem('yc-user', payload.username);
    }
    if (payload.role === 'admin' || payload.role === 'guest') {
      sessionStorage.removeItem('yc-role');
      localStorage.setItem('yc-role', payload.role);
    }
    window.__YC_SESSION_VERIFIED__ = { token: token.toLowerCase(), role: profile.role || '' };
    window.dispatchEvent(new CustomEvent('yc:session-valid', { detail: window.__YC_SESSION_VERIFIED__ }));
    refreshIdentity();
    syncSubscribePrompt();
  }

  function refreshIdentity() {
    if (!wrap) return;
    if (isGuest) {
      avatarButton.title = L.guestRole;
      avatarButton.setAttribute('aria-label', L.guestRole);
      identityBox.innerHTML = '<div class="yc-menu-identity-copy"><b>' + esc(L.guest) + '</b><span>' + esc(L.guestRole) + '</span></div>';
      return;
    }
    if (!profileLoaded) {
      avatarButton.innerHTML = '<span class="yc-account-dot" aria-hidden="true"></span>';
      avatarButton.title = L.loading;
      avatarButton.setAttribute('aria-label', L.loading);
      identityBox.innerHTML = '<div class="yc-menu-identity-copy"><b>' + esc(L.loading) + '</b></div>';
      return;
    }
    avatarButton.classList.remove('yc-account-pending');
    avatarButton.innerHTML = avatarMarkup('yc-avatar');
    avatarButton.title = profile.displayName || profile.username;
    avatarButton.setAttribute('aria-label', profile.displayName || profile.username);
    identityBox.innerHTML = avatarMarkup('yc-avatar') +
      '<div class="yc-menu-identity-copy"><b>' + esc(profile.displayName || profile.username) + '</b>' +
      '<span>' + esc(profile.email || (profile.role === 'admin' ? L.adminRole : profile.username)) + '</span></div>';
    syncAdminLinks();
  }

  function menuItem(section, icon, label, future) {
    return '<button class="yc-menu-item" type="button" data-account-section="' + section + '">' +
      '<span class="yc-menu-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="yc-menu-label">' + esc(label) + '</span>' +
      (future ? '<span class="yc-menu-badge">' + esc(L.unavailable) + '</span>' : '') + '</button>';
  }

  function sideItem(section, icon, label) {
    return '<button type="button" data-account-section="' + section + '" class="' +
      (activeSection === section ? 'active' : '') + '"><span class="yc-nav-icon" aria-hidden="true">' +
      icon + '</span><span>' + esc(label) + '</span></button>';
  }

  function adminLink(className) {
    if (!profileLoaded || profile.role !== 'admin') return '';
    return '<a class="yc-menu-item ' + (className || '') + '" href="/admin"><span class="yc-menu-icon" aria-hidden="true">◆</span>' +
      '<span class="yc-menu-label">' + esc(L.admin) + '</span></a>';
  }

  function syncAdminLinks() {
    if (!wrap) return;
    const menuSlot = wrap.querySelector('[data-admin-menu-slot]');
    if (menuSlot) menuSlot.innerHTML = adminLink('yc-menu-admin');
    if (overlay) {
      const sideSlot = overlay.querySelector('[data-admin-side-slot]');
      if (sideSlot) sideSlot.innerHTML = adminLink('yc-side-admin');
    }
  }

  function shell() {
    wrap = document.createElement('div');
    wrap.className = 'yc-ava-wrap';
    const trigger = isGuest
      ? '<button class="yc-guest-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="' + esc(L.guestRole) + '"><span>' + esc(L.guestRole) + '</span><span class="yc-guest-chevron" aria-hidden="true">⌄</span></button>'
      : '<button class="yc-ava-button yc-account-pending" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="' + esc(L.loading) + '"><span class="yc-account-dot" aria-hidden="true"></span></button>';
    wrap.innerHTML = trigger +
      '<div class="yc-account-menu" role="menu"><div class="yc-menu-identity"></div>' +
        (isGuest
          ? '<a class="yc-menu-item" href="' + loginPath + '"><span class="yc-menu-icon">↗</span><span class="yc-menu-label">' + esc(L.signIn) + '</span></a>' +
            '<a class="yc-menu-item" href="' + portfolioPath + '"><span class="yc-menu-icon">⌁</span><span class="yc-menu-label">' + esc(L.portfolio) + '</span></a>'
          : '<span data-admin-menu-slot></span>' +
            menuItem('account', '◎', L.accountTitle, false) +
            menuItem('connect', '⌁', L.connectTitle, true) +
            menuItem('contact', '@', L.contactTitle, false) +
            menuItem('social', '◉', L.socialTitle, true) +
            menuItem('app', '▣', L.appTitle, true) +
            menuItem('help', '?', L.helpTitle, false)) +
        '<div class="yc-menu-divider"></div><button class="yc-menu-item yc-logout" type="button" data-account-logout><span class="yc-menu-icon">↪</span><span class="yc-menu-label">' +
        esc(isGuest ? L.exit : L.logout) + '</span></button></div>';
    avatarButton = wrap.querySelector('.yc-ava-button, .yc-guest-button');
    menu = wrap.querySelector('.yc-account-menu');
    identityBox = wrap.querySelector('.yc-menu-identity');
    refreshIdentity();
    avatarButton.addEventListener('click', event => {
      event.stopPropagation();
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      avatarButton.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', closeMenu);
    wrap.querySelectorAll('[data-account-section]').forEach(button => {
      button.addEventListener('click', () => openAccount(button.dataset.accountSection));
    });
    wrap.querySelector('[data-account-logout]').addEventListener('click', logout);
    return wrap;
  }

  function closeMenu() {
    if (!menu) return;
    menu.classList.remove('open');
    avatarButton.setAttribute('aria-expanded', 'false');
  }

  async function logout() {
    const button = wrap.querySelector('[data-account-logout]');
    if (isMember && API) {
      button.disabled = true;
      try {
        await api('/api/logout', { method: 'POST', keepalive: true });
      } catch (error) {
        button.disabled = false;
        button.querySelector('.yc-menu-label').textContent = L.logoutRetry;
        return;
      }
    }
    clearSession();
    location.replace(homePath);
  }

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'yc-account-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<section class="yc-account-dialog" role="dialog" aria-modal="true" aria-labelledby="yc-account-page-title" tabindex="-1">' +
        '<button class="yc-account-close" type="button" aria-label="' + esc(L.close) + '">×</button>' +
        '<aside class="yc-account-side"><div class="yc-account-brand">YiCapital</div><nav class="yc-account-nav" aria-label="' + esc(L.account) + '"></nav>' +
          '<div class="yc-account-side-spacer"></div><span data-admin-side-slot></span>' +
          '<button class="yc-menu-item yc-logout yc-side-logout" type="button" data-account-logout><span class="yc-menu-icon">↪</span><span class="yc-menu-label">' + esc(L.logout) + '</span></button></aside>' +
        '<main class="yc-account-main"></main></section>';
    main = overlay.querySelector('.yc-account-main');
    overlay.querySelector('.yc-account-close').addEventListener('click', closeAccount);
    overlay.querySelector('[data-account-logout]').addEventListener('click', logout);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) closeAccount(); });
    overlay.addEventListener('keydown', trapDialogKeys);
    document.body.appendChild(overlay);
    syncAdminLinks();
  }

  function renderSide() {
    const nav = overlay.querySelector('.yc-account-nav');
    nav.innerHTML =
      sideItem('account', '◎', L.navAccount) + sideItem('connect', '⌁', L.navConnect) +
      sideItem('contact', '@', L.navContact) + sideItem('social', '◉', L.navSocial) +
      sideItem('app', '▣', L.navApp) + sideItem('help', '?', L.navHelp);
    nav.querySelectorAll('[data-account-section]').forEach(button => {
      button.addEventListener('click', () => {
        activeSection = button.dataset.accountSection;
        renderSide();
        renderSection();
      });
    });
  }

  function openAccount(section) {
    if (!isMember) return;
    closeMenu();
    activeSection = section || 'account';
    returnFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    renderSide();
    renderSection();
    overlay.querySelector('.yc-account-close').focus();
  }

  function closeAccount() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = previousOverflow;
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }

  function trapDialogKeys(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAccount();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),summary')]
      .filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function pageHeading(kicker, title, intro) {
    return '<p class="yc-section-kicker">' + esc(kicker) + '</p><h1 class="yc-section-title" id="yc-account-page-title">' +
      esc(title) + '</h1>' + (intro ? '<p class="yc-section-intro">' + esc(intro) + '</p>' : '');
  }

  function inviteUrl() {
    return location.origin + loginPath + '?ref=' + encodeURIComponent(profile.username) + '#signup';
  }

  function connection(provider, mark, connected) {
    return '<div class="yc-connection"><span class="yc-connection-mark">' + mark + '</span><div class="yc-connection-copy"><b>' +
      esc(provider) + '</b><span>' + esc(L.immutable) + '</span></div><span class="yc-connection-state ' +
      (connected ? '' : 'off') + '">' + esc(connected ? L.connected : L.notConnected) + '</span></div>';
  }

  function renderAccount() {
    if (!profileLoaded) {
      main.innerHTML = pageHeading(L.accountKicker, L.accountTitle, L.accountIntro) +
        '<div class="yc-empty-panel"><div class="yc-empty-card"><p>' + esc(L.loading) + '</p></div></div>';
      return;
    }
    if (profile.role === 'admin') {
      main.innerHTML = pageHeading(L.accountKicker, L.accountTitle, L.accountIntro) +
        '<div class="yc-profile-hero">' + avatarMarkup('yc-avatar-lg') +
        '<div class="yc-profile-hero-copy"><b>' + esc(profile.displayName) + '</b><span>' + esc(L.adminRole) + '</span></div></div>' +
        '<div class="yc-empty-card"><p>' + esc(L.adminManaged) + '</p><a class="yc-primary-button" href="/admin" style="display:inline-block;margin-top:18px;text-decoration:none">' +
        esc(L.adminOpen) + '</a></div>';
      return;
    }
    main.innerHTML =
      pageHeading(L.accountKicker, L.accountTitle, L.accountIntro) +
      '<div class="yc-profile-hero">' + avatarMarkup('yc-avatar-lg') +
        '<div class="yc-profile-hero-copy"><b>' + esc(profile.displayName) + '</b><span>' + esc(profile.email || profile.username) + '</span>' +
          '<div class="yc-avatar-actions"><button type="button" data-avatar-change>' + esc(L.avatarChange) + '</button><button type="button" data-avatar-remove>' + esc(L.avatarRemove) + '</button></div>' +
          '<small class="yc-avatar-note">' + esc(L.avatarHint) + '</small><input type="file" accept="image/jpeg,image/png,image/webp" hidden data-avatar-file></div></div>' +
      '<form class="yc-profile-form" novalidate><div class="yc-form-grid">' +
        '<label class="yc-field"><span>' + esc(L.displayName) + '</span><input name="displayName" maxlength="50" required value="' + esc(profile.displayName) + '"></label>' +
        '<label class="yc-field"><span>' + esc(L.userId) + '</span><input name="username" maxlength="24" required value="' + esc(profile.username) + '"><small>' + esc(L.idHelp) + '</small></label>' +
        '<label class="yc-field"><span>' + esc(L.email) + '</span><input readonly value="' + esc(profile.email || '—') + '"><small>' + esc(L.immutable) + '</small></label></div>' +
        '<h2 class="yc-subheading">' + esc(L.connectionTitle) + '</h2><div class="yc-connections">' +
          connection(L.emailAccount, '@', profile.connections.email) + connection(L.google, 'G', profile.connections.google) + '</div>' +
        '<h2 class="yc-subheading">' + esc(L.notifications) + '</h2><div class="yc-preference"><div class="yc-preference-copy"><b>' +
          esc(L.newsletterTitle) + '</b><p>' + esc(L.newsletterBody) + '</p></div><label class="yc-switch"><input name="newsletter" type="checkbox" ' +
          (profile.newsletter ? 'checked' : '') + ' aria-label="' + esc(L.newsletterTitle) + '"><span></span></label></div>' +
        '<div class="yc-invite"><div class="yc-invite-copy"><b>' + esc(L.inviteTitle) + '</b><p>' + esc(L.inviteBody) +
          '</p><span class="yc-invite-link">' + esc(inviteUrl()) + '</span></div><button class="yc-secondary-button" type="button" data-copy-invite>' +
          esc(L.copy) + '</button></div><div class="yc-save-row"><button class="yc-primary-button" type="submit">' +
          esc(L.save) + '</button><span class="yc-save-status" role="status" aria-live="polite"></span></div></form>';

    const form = main.querySelector('.yc-profile-form');
    const fileInput = main.querySelector('[data-avatar-file]');
    let pendingAvatar = profile.avatar || null;
    main.querySelector('[data-avatar-change]').addEventListener('click', () => fileInput.click());
    main.querySelector('[data-avatar-remove]').addEventListener('click', () => {
      pendingAvatar = null;
      main.querySelector('.yc-profile-hero > .yc-avatar-lg').outerHTML = '<span class="yc-avatar-lg">' + initials() + '</span>';
    });
    fileInput.addEventListener('change', async () => {
      const status = main.querySelector('.yc-save-status');
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        pendingAvatar = await prepareAvatar(file);
        main.querySelector('.yc-profile-hero > .yc-avatar-lg').outerHTML =
          '<span class="yc-avatar-lg"><img src="' + esc(pendingAvatar) + '" alt=""></span>';
        status.className = 'yc-save-status';
        status.textContent = L.photoReady;
      } catch (error) {
        status.className = 'yc-save-status error';
        status.textContent = L.avatarError;
      }
    });
    main.querySelector('[data-copy-invite]').addEventListener('click', async event => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(inviteUrl());
      } catch (error) {
        const temporary = document.createElement('input');
        temporary.value = inviteUrl();
        document.body.appendChild(temporary);
        temporary.select();
        document.execCommand('copy');
        temporary.remove();
      }
      button.textContent = L.copied;
      window.setTimeout(() => { button.textContent = L.copy; }, 1600);
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const status = form.querySelector('.yc-save-status');
      const submit = form.querySelector('button[type="submit"]');
      if (!form.reportValidity()) return;
      status.className = 'yc-save-status';
      status.textContent = '';
      submit.disabled = true;
      submit.textContent = L.saving;
      try {
        const result = await saveProfile({
          displayName: form.elements.displayName.value.trim(),
          username: form.elements.username.value.trim(),
          newsletter: form.elements.newsletter.checked,
          avatarDataUrl: pendingAvatar,
        });
        updateProfile(result);
        renderAccount();
        const nextStatus = main.querySelector('.yc-save-status');
        if (nextStatus) nextStatus.textContent = L.saved;
      } catch (error) {
        status.className = 'yc-save-status error';
        status.textContent = error.message || L.genericError;
        submit.disabled = false;
        submit.textContent = L.save;
      }
    });
  }

  async function prepareAvatar(file) {
    if (!/^image\/(?:jpeg|png|webp)$/.test(file.type) || file.size > 6 * 1024 * 1024) throw new Error('invalid_avatar');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 320;
      const context = canvas.getContext('2d');
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      const sx = (image.naturalWidth - side) / 2;
      const sy = (image.naturalHeight - side) / 2;
      context.fillStyle = '#0b111b';
      context.fillRect(0, 0, 320, 320);
      context.drawImage(image, sx, sy, side, side, 0, 0, 320, 320);
      const data = canvas.toDataURL('image/jpeg', .84);
      if (data.length > 350 * 1024) throw new Error('avatar_too_large');
      return data;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function saveProfile(fields) {
    return api('/api/account/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
  }

  function comingPage(icon, title, body, list) {
    main.innerHTML = pageHeading('YICAPITAL', title, '') +
      '<div class="yc-empty-panel"><div class="yc-empty-card"><div class="yc-empty-icon">' + icon + '</div><h2>' +
      esc(title) + '</h2><p>' + esc(body) + '</p>' +
      (list ? '<div class="yc-social-grid">' + list.map(item => '<div class="yc-social-item"><span>' + esc(item) +
        '</span><span class="yc-menu-badge">' + esc(L.unavailable) + '</span></div>').join('') + '</div>'
        : '<span class="yc-coming">' + esc(L.unavailable) + '</span>') + '</div></div>';
  }

  function renderContact() {
    main.innerHTML = pageHeading(L.contactKicker, L.contactTitle, '') +
      '<section class="yc-operator"><div class="yc-operator-head"><span class="yc-operator-mark">YT</span><div><h2>Yi Tingxun (Preston Yi)</h2><p>' +
      esc(L.contactRole) + '</p><a class="yc-operator-email" href="mailto:eprestonyi@gmail.com">eprestonyi@gmail.com</a></div></div>' +
      '<div class="yc-operator-body"><h3>' + esc(L.philosophyTitle) + '</h3><p>' + esc(L.philosophy) + '</p><p>' +
      esc(L.welcome) + '</p><a class="yc-primary-button" href="mailto:eprestonyi@gmail.com" style="display:inline-block;text-decoration:none">eprestonyi@gmail.com</a></div></section>';
  }

  function renderHelp() {
    const faq = [[L.faqAccount, L.faqAccountA], [L.faqNews, L.faqNewsA], [L.faqIdentity, L.faqIdentityA], [L.faqResearch, L.faqResearchA]];
    main.innerHTML = pageHeading(L.helpKicker, L.helpTitle, '') + '<div class="yc-faq">' +
      faq.map(item => '<details><summary>' + esc(item[0]) + '</summary><p>' + esc(item[1]) + '</p></details>').join('') +
      '</div><div class="yc-preference" style="margin-top:24px"><div class="yc-preference-copy"><b>' + esc(L.helpMore) + '</b><p>eprestonyi@gmail.com</p></div>' +
      '<a class="yc-secondary-button" href="mailto:eprestonyi@gmail.com" style="text-decoration:none">' + esc(L.helpEmail) + '</a></div>';
  }

  function renderSection() {
    main.scrollTop = 0;
    if (activeSection === 'account') renderAccount();
    else if (activeSection === 'connect') comingPage('⌁', L.connectTitle, L.connectBody);
    else if (activeSection === 'contact') renderContact();
    else if (activeSection === 'social') comingPage('◉', L.socialTitle, L.socialBody, L.socialChannels);
    else if (activeSection === 'app') comingPage('▣', L.appTitle, L.appBody);
    else renderHelp();
  }

  function syncSubscribePrompt() {
    if (!isMember || !profileLoaded || profile.role === 'admin') return;
    if (profile.newsletter) {
      if (subscribeCard) subscribeCard.remove();
      subscribeCard = null;
      return;
    }
    if (subscribeCard) return;
    subscribeCard = document.createElement('aside');
    subscribeCard.className = 'yc-subscribe-card';
    subscribeCard.setAttribute('aria-label', L.newsletterTitle);
    subscribeCard.innerHTML =
      '<div class="yc-subscribe-kicker">' + esc(L.promptKicker) + '</div><h3>' + esc(L.promptTitle) + '</h3><p>' +
      esc(L.promptBody) + '</p><button type="button">' + esc(L.subscribe) + '</button>';
    const button = subscribeCard.querySelector('button');
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = L.subscribing;
      try {
        const result = await saveProfile({ newsletter: true });
        updateProfile(result);
      } catch (error) {
        button.disabled = false;
        button.textContent = L.subscribe;
      }
    });
    document.body.appendChild(subscribeCard);
  }

  async function loadProfile(attempt = 0) {
    if (!isMember) return;
    try {
      const result = await api('/api/me', { cache: 'no-store' });
      updateProfile(result);
      if (overlay && overlay.classList.contains('open') && activeSection === 'account') renderAccount();
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        if (attempt < 1) {
          window.setTimeout(() => loadProfile(attempt + 1), 750);
          return;
        }
        clearSession();
        window.__YC_SESSION_VERIFIED__ = null;
        window.dispatchEvent(new CustomEvent('yc:session-invalid', { detail: { status: error.status } }));
        location.replace(loginPath + '?reason=' + (error.status === 403 ? 'disabled' : 'expired'));
        return;
      }
      window.dispatchEvent(new CustomEvent('yc:session-unavailable'));
      if (overlay && overlay.classList.contains('open') && activeSection === 'account') {
        main.innerHTML = pageHeading(L.accountKicker, L.accountTitle, L.accountIntro) +
          '<div class="yc-empty-panel"><div class="yc-empty-card"><p>' + esc(L.loadError) + '</p></div></div>';
      }
    }
  }

  function mount() {
    if (isMember) {
      document.querySelectorAll('a').forEach(anchor => {
        const href = anchor.getAttribute('href') || '';
        if (/login(\.html)?$/.test(href)) anchor.style.display = 'none';
      });
      document.querySelectorAll('.yc-authcta').forEach(element => { element.style.display = 'none'; });
    }
    const nav = document.querySelector('header .nav') || document.querySelector('header .wrap');
    if (!nav || document.querySelector('.yc-ava-wrap')) return;
    nav.appendChild(shell());
    if (isMember) {
      createOverlay();
      loadProfile(0);
    }
  }

  if (isMember && API) {
    const sameToken = () => String(localStorage.getItem('yc-token') || '').toLowerCase() === token.toLowerCase();
    const reconcileStoredIdentity = () => {
      const nextToken = String(localStorage.getItem('yc-token') || '');
      const nextUser = String(localStorage.getItem('yc-user') || '');
      const nextMember = /^[a-f0-9]{64}$/i.test(nextToken) && Boolean(nextUser);
      if (nextMember && nextToken.toLowerCase() === token.toLowerCase() && nextUser === storedUser) return true;
      if (nextMember || localStorage.getItem('yc-guest') === '1') {
        location.reload();
        return false;
      }
      clearSession();
      location.replace(loginPath + '?reason=signedout');
      return false;
    };
    const validate = attempt => {
      if (!sameToken()) return Promise.resolve();
      return fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' }).then(async response => {
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          if (payload && sameToken()) updateProfile(payload);
          return;
        }
        if (response.status >= 500) {
          window.dispatchEvent(new CustomEvent('yc:session-unavailable', { detail: { status: response.status } }));
          return;
        }
        if (response.status !== 401 && response.status !== 403) return;
        if (attempt < 1) {
          window.setTimeout(() => validate(attempt + 1), 750);
          return;
        }
        if (!sameToken()) return;
        clearSession();
        window.__YC_SESSION_VERIFIED__ = null;
        window.dispatchEvent(new CustomEvent('yc:session-invalid', { detail: { status: response.status } }));
        location.replace(loginPath + '?reason=' + (response.status === 403 ? 'disabled' : 'expired'));
      }).catch(() => { window.dispatchEvent(new CustomEvent('yc:session-unavailable')); });
    };
    window.addEventListener('pageshow', event => {
      if (event.persisted && reconcileStoredIdentity()) validate(0);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) validate(0); });
  }

  if (isGuest) {
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      const nextToken = String(localStorage.getItem('yc-token') || '');
      const nextUser = String(localStorage.getItem('yc-user') || '');
      if (/^[a-f0-9]{64}$/i.test(nextToken) && nextUser) {
        location.reload();
        return;
      }
      if (localStorage.getItem('yc-guest') !== '1') location.replace(homePath);
    });
  }

  window.addEventListener('storage', event => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key && !['yc-token', 'yc-user', 'yc-guest'].includes(event.key)) return;
    window.clearTimeout(externalSyncTimer);
    externalSyncTimer = window.setTimeout(() => {
      const nextToken = String(localStorage.getItem('yc-token') || '');
      const nextUser = String(localStorage.getItem('yc-user') || '');
      const nextMember = /^[a-f0-9]{64}$/i.test(nextToken) && Boolean(nextUser);
      const nextGuest = !nextMember && localStorage.getItem('yc-guest') === '1';
      if (nextMember) {
        if (!isMember || nextToken.toLowerCase() !== token.toLowerCase() || nextUser !== storedUser) location.reload();
        return;
      }
      if (nextGuest) {
        if (!isGuest) location.reload();
        return;
      }
      clearSession();
      location.replace(isMember ? loginPath + '?reason=signedout' : homePath);
    }, 0);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
