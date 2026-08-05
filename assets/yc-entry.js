/* YiCapital market-led entry experience.
   Anonymous Guest receives no bearer token. Server APIs remain the only authorization authority. */
(function () {
  'use strict';

  const MODE = window.YC_ENTRY_MODE || 'gate';
  const hasMemberSession = (() => {
    try {
      const token = localStorage.getItem('yc-token') || sessionStorage.getItem('yc-token') || '';
      const user = localStorage.getItem('yc-user') || sessionStorage.getItem('yc-user') || '';
      return /^[a-f0-9]{64}$/i.test(token) && Boolean(user);
    } catch (error) {
      return false;
    }
  })();
  const hasGuestPass = (() => {
    try {
      return localStorage.getItem('yc-guest') === '1';
    } catch (error) {
      return false;
    }
  })();
  const fallbackShell = document.querySelector('.yc-entry-fallback');
  if (MODE === 'gate' && (hasMemberSession || hasGuestPass)) {
    if (fallbackShell) fallbackShell.remove();
    document.documentElement.classList.remove('yc-entry-pending');
    document.documentElement.classList.add('yc-dashboard-requested');
    return;
  }

  const locale = window.YC_LANG === 'cn' ? 'cn' : window.YC_LANG === 'en' ? 'en' : 'tw';
  const API = String(window.YC_API || '').replace(/\/+$/, '');
  const GCID = String(window.YC_GOOGLE_CLIENT_ID || '').trim();
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const copy = {
    tw: {
      language: '繁',
      languageNav: '語言',
      marketNav: '組合市場',
      sloganLead: '成為少數，',
      sloganAccent: '不隨多數',
      intro: '投資市場裡，真正賺錢的只有少數人。',
      fullHistory: '全部可追溯歷史 · 共同收市日',
      closes: '個共同收市日',
      live: '即時 · 已驗證快照',
      review: '即時 · 資料檢查',
      gap: '資料缺口',
      portfolio: '組合',
      benchmark: '基準',
      alpha: '相對收益',
      authKicker: '投資者入口',
      authTitle: '進入工作台',
      authCopy: '登入可管理帳戶、頭像與 Insights；訪客也可閱讀全部公開研究與組合。',
      login: '登入',
      register: '註冊',
      googleWait: 'Google 登入正在配置',
      orEmail: '或使用郵箱',
      identity: '用戶名或郵箱',
      username: '用戶名',
      adminUser: '管理員用戶名',
      email: '郵箱',
      password: '密碼',
      confirmPassword: '確認密碼',
      code: '6 位郵箱驗證碼',
      continueLogin: '登入並進入工作台',
      createAccount: '創建帳號',
      continueEmail: '繼續使用郵箱',
      backOptions: '返回註冊方式',
      verify: '驗證並進入工作台',
      completeGoogle: '完成 Google 註冊',
      guest: '以訪客模式繼續',
      guestNote: '訪客可瀏覽全部公開研究與組合；帳戶設定及管理後台仍需相應身份。',
      forgot: '忘記密碼？',
      resetTitle: '重設密碼',
      sendCode: '發送驗證碼',
      resetPassword: '重設密碼',
      backLogin: '返回登入',
      admin: '管理員入口',
      backMember: '返回用戶登入',
      terms: '我同意《服務條款》',
      newsletter: '訂閱 Yi Capital Insights（可隨時取消）',
      googleNewsletter: '首次以 Google 建立帳號時訂閱 Insights（可隨時取消）',
      legal: '只有建立新帳號時才會要求明確同意服務條款；登入或訪客瀏覽不視為同意。',
      required: '請完整填寫必填欄位。',
      mismatch: '兩次密碼不一致。',
      termsRequired: '必須同意服務條款才能註冊。',
      invalidCode: '請輸入 6 位數字驗證碼。',
      backendMissing: '身份服務暫時不可用。',
      storeUnavailable: '帳號服務暫時繁忙，請稍後再試。',
      requestTimeout: '登入服務回應逾時，請重試。',
      networkError: '暫時無法連接登入服務，請檢查網絡後重試。',
      rateLimited: '登入嘗試過多，請稍後再試。',
      googleUnavailable: 'Google 登入暫時未能完成。請重試，或使用郵箱繼續。',
      googleInvalid: 'Google 憑證無效，請重新登入。',
      googleMismatch: '這個 Google 身份與既有帳號不匹配。',
      googleSetupExpired: 'Google 註冊設定已過期，請重新登入。',
      googleNotConfigured: 'Google 登入尚未配置，請使用郵箱繼續。',
      googleRetrying: 'Google 連線短暫中斷，正在自動重試…',
      googleChecking: '正在驗證 Google 帳號…',
      googleSetup: 'Google 身份已驗證，請設定用戶名。',
      codeSent: '驗證碼已發送，請檢查收件箱與垃圾郵件。',
      signedIn: '登入成功，正在進入工作台…',
      guestEntering: '正在以訪客身份進入工作台…',
      resetSent: '如郵箱已註冊，驗證碼將發送至該地址。',
      resetDone: '密碼已重設，請重新登入。',
      genericError: '暫時無法完成操作，請稍後重試。',
      sessionExpired: '登入已過期，請重新登入。',
      accountDisabled: '此帳號已停用，請聯絡網站營運者。',
      signedOutElsewhere: '你已在另一個分頁登出。',
      signOutFailed: '無法安全退出目前帳號，請重試。',
      adminDenied: '此 Google 帳號沒有管理員權限。',
      dataPending: '市場資料同步中',
      dataUnavailable: '真實資料暫時不可用，未使用模擬數據。',
      scene: {
        hk: { eyebrow: '01 / 03 · 香港', market: 'Yi Capital HK', benchmark: '恒生指數 · HSI' },
        us: { eyebrow: '02 / 03 · 美國', market: 'Yi Capital US', benchmark: '標普 500' },
        a: { eyebrow: '03 / 03 · A 股', market: 'Yi Capital A', benchmark: '滬深 300' },
      },
    },
    cn: {
      language: '简',
      languageNav: '语言',
      marketNav: '组合市场',
      sloganLead: '成为少数，',
      sloganAccent: '不随多数',
      intro: '投资市场里，真正赚钱的只有少数人。',
      fullHistory: '全部可追溯历史 · 共同收市日',
      closes: '个共同收市日',
      live: '实时 · 已验证快照',
      review: '实时 · 数据检查',
      gap: '数据缺口',
      portfolio: '组合',
      benchmark: '基准',
      alpha: '相对收益',
      authKicker: '投资者入口',
      authTitle: '进入工作台',
      authCopy: '登录可管理账户、头像与 Insights；访客也可阅读全部公开研究与组合。',
      login: '登录',
      register: '注册',
      googleWait: 'Google 登录正在配置',
      orEmail: '或使用邮箱',
      identity: '用户名或邮箱',
      username: '用户名',
      adminUser: '管理员用户名',
      email: '邮箱',
      password: '密码',
      confirmPassword: '确认密码',
      code: '6 位邮箱验证码',
      continueLogin: '登录并进入工作台',
      createAccount: '创建账号',
      continueEmail: '继续使用邮箱',
      backOptions: '返回注册方式',
      verify: '验证并进入工作台',
      completeGoogle: '完成 Google 注册',
      guest: '以访客模式继续',
      guestNote: '访客可浏览全部公开研究与组合；账户设置及管理后台仍需相应身份。',
      forgot: '忘记密码？',
      resetTitle: '重设密码',
      sendCode: '发送验证码',
      resetPassword: '重设密码',
      backLogin: '返回登录',
      admin: '管理员入口',
      backMember: '返回用户登录',
      terms: '我同意《服务条款》',
      newsletter: '订阅 Yi Capital Insights（可随时取消）',
      googleNewsletter: '首次以 Google 建立账号时订阅 Insights（可随时取消）',
      legal: '只有创建新账号时才会要求明确同意服务条款；登录或访客浏览不视为同意。',
      required: '请完整填写必填字段。',
      mismatch: '两次密码不一致。',
      termsRequired: '必须同意服务条款才能注册。',
      invalidCode: '请输入 6 位数字验证码。',
      backendMissing: '身份服务暂时不可用。',
      storeUnavailable: '账号服务暂时繁忙，请稍后再试。',
      requestTimeout: '登录服务响应超时，请重试。',
      networkError: '暂时无法连接登录服务，请检查网络后重试。',
      rateLimited: '登录尝试过多，请稍后再试。',
      googleUnavailable: 'Google 登录暂时未能完成。请重试，或使用邮箱继续。',
      googleInvalid: 'Google 凭证无效，请重新登录。',
      googleMismatch: '这个 Google 身份与现有账号不匹配。',
      googleSetupExpired: 'Google 注册设置已过期，请重新登录。',
      googleNotConfigured: 'Google 登录尚未配置，请使用邮箱继续。',
      googleRetrying: 'Google 连接短暂中断，正在自动重试…',
      googleChecking: '正在验证 Google 账号…',
      googleSetup: 'Google 身份已验证，请设置用户名。',
      codeSent: '验证码已发送，请检查收件箱与垃圾邮件。',
      signedIn: '登录成功，正在进入工作台…',
      guestEntering: '正在以访客身份进入工作台…',
      resetSent: '如邮箱已注册，验证码将发送至该地址。',
      resetDone: '密码已重设，请重新登录。',
      genericError: '暂时无法完成操作，请稍后重试。',
      sessionExpired: '登录已过期，请重新登录。',
      accountDisabled: '此账号已停用，请联系网站运营者。',
      signedOutElsewhere: '你已在另一个标签页退出登录。',
      signOutFailed: '无法安全退出当前账号，请重试。',
      adminDenied: '此 Google 账号没有管理员权限。',
      dataPending: '市场数据同步中',
      dataUnavailable: '真实数据暂时不可用，未使用模拟数据。',
      scene: {
        hk: { eyebrow: '01 / 03 · 香港', market: 'Yi Capital HK', benchmark: '恒生指数 · HSI' },
        us: { eyebrow: '02 / 03 · 美国', market: 'Yi Capital US', benchmark: '标普 500' },
        a: { eyebrow: '03 / 03 · A 股', market: 'Yi Capital A', benchmark: '沪深 300' },
      },
    },
    en: {
      language: 'EN',
      languageNav: 'Language',
      marketNav: 'Portfolio market',
      sloganLead: 'Be Like Us,',
      sloganAccent: 'Not Them',
      intro: 'Only a few make money in investing.',
      fullHistory: 'Full trackable history · common closes',
      closes: 'common closes',
      live: 'LIVE · VERIFIED SNAPSHOT',
      review: 'LIVE · DATA REVIEW',
      gap: 'data gap',
      portfolio: 'Portfolio',
      benchmark: 'Benchmark',
      alpha: 'Relative return',
      authKicker: 'INVESTOR ACCESS',
      authTitle: 'Enter the Dashboard',
      authCopy: 'Sign in to manage your account, avatar and Insights. Guests can read all public research and portfolios.',
      login: 'Sign in',
      register: 'Register',
      googleWait: 'Google sign-in is being configured',
      orEmail: 'or continue with email',
      identity: 'Username or email',
      username: 'Username',
      adminUser: 'Admin username',
      email: 'Email',
      password: 'Password',
      confirmPassword: 'Confirm password',
      code: '6-digit email code',
      continueLogin: 'Sign in to Dashboard',
      createAccount: 'Create account',
      continueEmail: 'Continue with email',
      backOptions: 'Back to sign-up options',
      verify: 'Verify and enter Dashboard',
      completeGoogle: 'Complete Google registration',
      guest: 'Continue as Guest',
      guestNote: 'Guests can browse all public research and portfolios. Account settings and administration still require the appropriate identity.',
      forgot: 'Forgot password?',
      resetTitle: 'Reset password',
      sendCode: 'Send verification code',
      resetPassword: 'Reset password',
      backLogin: 'Back to sign in',
      admin: 'Administrator access',
      backMember: 'Back to member sign in',
      terms: 'I agree to the Terms of Service',
      newsletter: 'Subscribe to Yi Capital Insights (unsubscribe anytime)',
      googleNewsletter: 'For a new Google account, subscribe to Insights (unsubscribe anytime)',
      legal: 'Explicit Terms acceptance is required only when creating an account; signing in or browsing as Guest does not record consent.',
      required: 'Please complete all required fields.',
      mismatch: 'The passwords do not match.',
      termsRequired: 'You must accept the Terms of Service to register.',
      invalidCode: 'Enter the 6-digit verification code.',
      backendMissing: 'The identity service is temporarily unavailable.',
      storeUnavailable: 'The account service is temporarily busy. Please try again later.',
      requestTimeout: 'The identity service timed out. Please try again.',
      networkError: 'Unable to reach the identity service. Check your connection and try again.',
      rateLimited: 'Too many sign-in attempts. Please try again later.',
      googleUnavailable: 'Google sign-in could not finish. Try again or continue with email.',
      googleInvalid: 'The Google credential is invalid. Sign in again.',
      googleMismatch: 'This Google identity does not match the existing account.',
      googleSetupExpired: 'Google registration setup expired. Sign in again.',
      googleNotConfigured: 'Google sign-in is not configured. Continue with email.',
      googleRetrying: 'The Google connection was interrupted. Retrying…',
      googleChecking: 'Verifying your Google account…',
      googleSetup: 'Google identity verified. Choose a username.',
      codeSent: 'Verification code sent. Check your inbox and spam folder.',
      signedIn: 'Signed in. Entering the Dashboard…',
      guestEntering: 'Entering the Dashboard as Guest…',
      resetSent: 'If the email is registered, a verification code will be sent.',
      resetDone: 'Password reset. Sign in with the new password.',
      genericError: 'Unable to complete the request. Please try again.',
      sessionExpired: 'Your session expired. Please sign in again.',
      accountDisabled: 'This account is disabled. Contact the site operator.',
      signedOutElsewhere: 'You signed out in another tab.',
      signOutFailed: 'Unable to sign out of the current account safely. Try again.',
      adminDenied: 'This Google account does not have administrator access.',
      dataPending: 'MARKET DATA SYNCHRONIZING',
      dataUnavailable: 'Live data is unavailable. No simulated data is being shown.',
      scene: {
        hk: { eyebrow: '01 / 03 · HONG KONG', market: 'Yi Capital HK', benchmark: 'HANG SENG INDEX · HSI' },
        us: { eyebrow: '02 / 03 · UNITED STATES', market: 'Yi Capital US', benchmark: 'S&P 500' },
        a: { eyebrow: '03 / 03 · A SHARE', market: 'Yi Capital A', benchmark: 'CSI 300' },
      },
    },
  }[locale];

  const homePath = locale === 'tw' ? '/' : '/' + locale + '/';
  const paths = {
    home: homePath,
    dashboard: homePath + '?dashboard=1',
    login: locale === 'tw' ? '/login' : '/' + locale + '/login',
    terms: locale === 'tw' ? '/terms' : '/' + locale + '/terms',
  };
  const termsConsentHtml = copy.terms
    .replace('《服務條款》', `<a href="${paths.terms}" target="_blank" rel="noopener">《服務條款》</a>`)
    .replace('《服务条款》', `<a href="${paths.terms}" target="_blank" rel="noopener">《服务条款》</a>`)
    .replace('Terms of Service', `<a href="${paths.terms}" target="_blank" rel="noopener">Terms of Service</a>`);
  const languageBase = MODE === 'login'
    ? { tw: '/login', cn: '/cn/login', en: '/en/login' }
    : { tw: '/', cn: '/cn/', en: '/en/' };
  const requestedReason = new URLSearchParams(location.search).get('reason');
  const preservedReason = ['expired', 'disabled', 'signedout'].includes(requestedReason) ? requestedReason : '';
  const preservedAuthHash = MODE === 'login' && location.hash === '#signup' ? '#signup' : '';
  const languageHref = target => languageBase[target]
    + (MODE === 'login' && preservedReason ? '?reason=' + encodeURIComponent(preservedReason) : '')
    + preservedAuthHash;

  const root = document.createElement('div');
  root.className = 'yc-entry-root';
  root.dataset.scene = 'hk';
  root.dataset.entryMode = MODE;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', copy.authTitle);
  root.innerHTML = `
    <div class="yc-entry-topbar">
      <a class="yc-entry-logo" href="${paths.home}" aria-label="YiCapital">Yi<b>Capital</b></a>
      <nav class="yc-entry-languages" aria-label="${copy.languageNav}">
        <a href="${languageHref('tw')}" ${locale === 'tw' ? 'aria-current="page"' : ''}>繁</a>
        <a href="${languageHref('cn')}" ${locale === 'cn' ? 'aria-current="page"' : ''}>简</a>
        <a href="${languageHref('en')}" ${locale === 'en' ? 'aria-current="page"' : ''}>EN</a>
      </nav>
    </div>
    <main class="yc-entry-shell">
      <section class="yc-entry-story" aria-labelledby="yc-entry-slogan">
        <div class="yc-entry-intro">
          <div class="yc-entry-eyebrow" id="yc-entry-eyebrow">${copy.scene.hk.eyebrow}</div>
          <h1 class="yc-entry-title" id="yc-entry-slogan">${copy.sloganLead} <span>${copy.sloganAccent}</span></h1>
          <p class="yc-entry-subtitle">${copy.intro}</p>
        </div>
        <div class="yc-entry-chart">
          <div class="yc-entry-chart-meta">
            <div>
              <div class="yc-entry-market-name" id="yc-entry-market">${copy.scene.hk.market}</div>
              <div class="yc-entry-period" id="yc-entry-period">${copy.fullHistory}</div>
            </div>
            <div class="yc-entry-live" id="yc-entry-live">${copy.live}</div>
          </div>
          <canvas class="yc-entry-canvas" id="yc-entry-canvas" role="img"></canvas>
          <div class="yc-entry-sr" id="yc-entry-chart-summary" aria-live="polite"></div>
        </div>
        <div class="yc-entry-story-footer">
          <div class="yc-entry-metrics">
            <div class="yc-entry-metric">
              <div class="yc-entry-metric-label" id="yc-entry-pf-label">${copy.portfolio}</div>
              <div class="yc-entry-metric-value" id="yc-entry-pf-ret">—</div>
            </div>
            <div class="yc-entry-metric">
              <div class="yc-entry-metric-label" id="yc-entry-bm-label">${copy.benchmark}</div>
              <div class="yc-entry-metric-value" id="yc-entry-bm-ret">—</div>
            </div>
            <div class="yc-entry-metric">
              <div class="yc-entry-metric-label">${copy.alpha}</div>
              <div class="yc-entry-metric-value" id="yc-entry-alpha">—</div>
            </div>
          </div>
          <div class="yc-entry-scene-nav" aria-label="${copy.marketNav}">
            <button class="yc-entry-scene-btn" data-scene-index="0" aria-pressed="true">01 · HK</button>
            <button class="yc-entry-scene-btn" data-scene-index="1" aria-pressed="false">02 · US</button>
            <button class="yc-entry-scene-btn" data-scene-index="2" aria-pressed="false">03 · A</button>
          </div>
        </div>
      </section>
      <aside class="yc-entry-auth-column">
        <section class="yc-entry-auth" aria-labelledby="yc-entry-auth-title">
          <div class="yc-entry-auth-kicker">${copy.authKicker}</div>
          <h2 id="yc-entry-auth-title">${copy.authTitle}</h2>
          <p class="yc-entry-auth-copy">${copy.authCopy}</p>
          <div class="yc-entry-tabs" id="yc-entry-tabs" role="tablist">
            <button class="yc-entry-tab" type="button" data-auth-mode="login" role="tab" aria-selected="true">${copy.login}</button>
            <button class="yc-entry-tab" type="button" data-auth-mode="signup" role="tab" aria-selected="false">${copy.register}</button>
          </div>
          <div class="yc-entry-google" id="yc-entry-google"></div>
          <div class="yc-entry-google-note" id="yc-entry-google-note">${copy.googleWait}</div>
          <div class="yc-entry-google-consent" id="yc-entry-google-consent">
            <label class="yc-entry-check"><input id="yc-entry-google-newsletter" type="checkbox"><span>${copy.googleNewsletter}</span></label>
            <label class="yc-entry-check"><input id="yc-entry-google-terms" type="checkbox"><span>${termsConsentHtml}</span></label>
          </div>
          <div class="yc-entry-divider" id="yc-entry-divider">${copy.orEmail}</div>
          <form id="yc-entry-form" novalidate></form>
          <button class="yc-entry-guest" id="yc-entry-guest" type="button">${copy.guest}</button>
          <p class="yc-entry-legal" id="yc-entry-guest-note">${copy.guestNote}</p>
          <div class="yc-entry-message" id="yc-entry-message" role="status" aria-live="polite"></div>
          <div class="yc-entry-admin-row">
            <button class="yc-entry-link-button" id="yc-entry-admin" type="button">${copy.admin}</button>
          </div>
          <p class="yc-entry-legal">${copy.legal}</p>
        </section>
      </aside>
    </main>`;

  document.body.prepend(root);
  if (fallbackShell) fallbackShell.remove();
  document.body.classList.add('yc-entry-open');
  document.documentElement.classList.add('yc-entry-pending');

  const $ = id => root.querySelector('#' + id);
  const form = $('yc-entry-form');
  const message = $('yc-entry-message');
  const tabs = $('yc-entry-tabs');
  const guestButton = $('yc-entry-guest');
  const guestNote = $('yc-entry-guest-note');
  const divider = $('yc-entry-divider');
  const adminButton = $('yc-entry-admin');
  const googleBox = $('yc-entry-google');
  const googleNote = $('yc-entry-google-note');
  const googleConsent = $('yc-entry-google-consent');
  let authMode = location.hash === '#signup' ? 'signup' : 'login';
  let signupStep = 1;
  let signupEmail = '';
  let resetStep = 1;
  let pendingEmail = null;
  let pendingCredentials = null;
  let setupToken = null;
  let googleInitialized = false;

  function setMessage(text, kind) {
    message.textContent = text || '';
    message.className = 'yc-entry-message' + (kind ? ' is-' + kind : '');
  }

  function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function field(id, label, type, autocomplete, wide, extra) {
    return `<div class="yc-entry-field${wide ? ' is-wide' : ''}">
      <label for="${id}">${label}</label>
      <input id="${id}" type="${type || 'text'}" autocomplete="${autocomplete || 'off'}" ${extra || ''}>
    </div>`;
  }

  function focusWithoutPageJump(input) {
    if (!input) return;
    input.focus({ preventScroll: true });
    root.scrollTop = 0;
    const authViewport = root.querySelector('.yc-entry-auth-column');
    if (authViewport) authViewport.scrollTop = 0;
  }

  function renderForm() {
    tabs.style.display = authMode === 'login' || authMode === 'signup' ? 'grid' : 'none';
    root.querySelectorAll('.yc-entry-tab').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.authMode === authMode));
    });
    guestButton.style.display = authMode === 'login' || authMode === 'signup' ? 'block' : 'none';
    guestNote.style.display = authMode === 'login' || authMode === 'signup' ? 'block' : 'none';
    adminButton.textContent = authMode === 'admin' ? copy.backMember : copy.admin;

    if (authMode === 'reset') {
      if (resetStep === 1) {
        form.innerHTML = `
          ${field('yc-entry-reset-email', copy.email, 'email', 'email', true, 'required')}
          <button class="yc-entry-submit" type="submit">${copy.sendCode}</button>
          <div class="yc-entry-admin-row"><button class="yc-entry-link-button" type="button" id="yc-entry-reset-back">${copy.backLogin}</button></div>`;
      } else {
        form.innerHTML = `
          <div class="yc-entry-form-grid">
            ${field('yc-entry-reset-code', copy.code, 'text', 'one-time-code', true, 'inputmode="numeric" maxlength="6" required')}
            ${field('yc-entry-reset-p1', copy.password, 'password', 'new-password', false, 'required minlength="15" maxlength="128"')}
            ${field('yc-entry-reset-p2', copy.confirmPassword, 'password', 'new-password', false, 'required minlength="15" maxlength="128"')}
          </div>
          <button class="yc-entry-submit" type="submit">${copy.resetPassword}</button>
          <div class="yc-entry-admin-row"><button class="yc-entry-link-button" type="button" id="yc-entry-reset-back">${copy.backLogin}</button></div>`;
      }
      const back = $('yc-entry-reset-back');
      if (back) back.onclick = () => switchAuth('login');
      updateProviders();
      return;
    }

    if (pendingEmail && authMode === 'signup') {
      form.innerHTML = `
        ${field('yc-entry-code', copy.code, 'text', 'one-time-code', true, 'inputmode="numeric" maxlength="6" required autofocus')}
        <button class="yc-entry-submit" type="submit">${copy.verify}</button>`;
      updateProviders();
      return;
    }

    const signup = authMode === 'signup';
    const admin = authMode === 'admin';
    if (signup) {
      if (signupStep === 1 && !setupToken) {
        form.innerHTML = `
          ${field('yc-entry-email', copy.email, 'email', 'email', true, 'required autofocus')}
          <button class="yc-entry-submit" type="submit">${copy.continueEmail}</button>`;
      } else {
        form.innerHTML = `
          <div class="yc-entry-form-grid">
            ${field('yc-entry-user', copy.username, 'text', 'username', true, 'required maxlength="24"')}
            ${field('yc-entry-password', copy.password, 'password', 'new-password', true, 'required minlength="15" maxlength="128"')}
          </div>
          <label class="yc-entry-check"><input id="yc-entry-newsletter" type="checkbox"><span>${copy.newsletter}</span></label>
          <label class="yc-entry-check"><input id="yc-entry-terms" type="checkbox"><span>${termsConsentHtml}</span></label>
          <button class="yc-entry-submit" type="submit">${setupToken ? copy.completeGoogle : copy.createAccount}</button>
          ${setupToken ? '' : `<div class="yc-entry-admin-row"><button class="yc-entry-link-button" type="button" id="yc-entry-signup-back">${copy.backOptions}</button></div>`}`;
        const signupBack = $('yc-entry-signup-back');
        if (signupBack) signupBack.onclick = () => {
          signupStep = 1;
          renderForm();
          window.requestAnimationFrame(() => focusWithoutPageJump($('yc-entry-email')));
        };
      }
    } else {
      form.innerHTML = `
        ${field('yc-entry-user', admin ? copy.adminUser : copy.identity, 'text', 'username', true, 'required')}
        ${field('yc-entry-password', copy.password, 'password', 'current-password', true, 'required')}
        ${admin ? '' : `<div class="yc-entry-form-actions"><button class="yc-entry-link-button" id="yc-entry-forgot" type="button">${copy.forgot}</button></div>`}
        <button class="yc-entry-submit" type="submit">${copy.continueLogin}</button>`;
      const forgot = $('yc-entry-forgot');
      if (forgot) forgot.onclick = () => switchAuth('reset');
    }
    updateProviders();
  }

  function switchAuth(next) {
    authMode = next;
    signupStep = 1;
    signupEmail = '';
    resetStep = 1;
    pendingEmail = null;
    pendingCredentials = null;
    setupToken = null;
    setMessage('');
    renderForm();
    if (history && history.replaceState) {
      history.replaceState(null, '', next === 'signup' ? '#signup' : location.pathname + location.search);
    }
    window.requestAnimationFrame(() => {
      const firstInput = form.querySelector('input[autofocus], input');
      focusWithoutPageJump(firstInput);
    });
  }

  root.querySelectorAll('.yc-entry-tab').forEach(button => {
    button.addEventListener('click', () => switchAuth(button.dataset.authMode));
  });
  adminButton.addEventListener('click', () => switchAuth(authMode === 'admin' ? 'login' : 'admin'));

  async function api(path, body) {
    if (!API) throw new Error(copy.backendMissing);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const requestError = new Error(
          response.status === 429
          ? copy.rateLimited
          : payload.code === 'google_keys_unavailable'
            ? copy.googleUnavailable
            : payload.code === 'auth_store_unavailable'
              ? copy.storeUnavailable
            : localizeServerError(payload.error)
        );
        requestError.code = String(payload.code || 'request_failed');
        requestError.status = response.status;
        const retryAfter = Number(response.headers.get('Retry-After') || 0);
        requestError.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
        throw requestError;
      }
      return payload;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error(copy.requestTimeout);
      if (error instanceof TypeError) throw new Error(copy.networkError);
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function localizeServerError(serverError) {
    const raw = String(serverError || '').trim();
    if (!raw) return copy.genericError;
    if (locale === 'tw') return raw;
    const key = raw.toLowerCase();
    if (/帳號或密碼|账号或密码/.test(raw)) return locale === 'en' ? 'Incorrect account or password.' : '账号或密码错误。';
    if (/郵箱.*註冊|邮箱.*注册/.test(raw)) return locale === 'en' ? 'This email is already registered.' : '该邮箱已被注册。';
    if (/用戶名.*存在|用户名.*存在|用戶名.*佔用|用户名.*占用/.test(raw)) return locale === 'en' ? 'That username is unavailable.' : '该用户名不可用。';
    if (/驗證碼|验证码/.test(raw)) return locale === 'en' ? 'The verification code is invalid or expired.' : '验证码无效或已过期。';
    if (/google/i.test(key)) {
      if (/憑證無效|凭证无效/.test(raw)) return copy.googleInvalid;
      if (/身份.*不匹配/.test(raw)) return copy.googleMismatch;
      if (/設置已過期|设置已过期/.test(raw)) return copy.googleSetupExpired;
      if (/未配置/.test(raw)) return copy.googleNotConfigured;
      return copy.googleUnavailable;
    }
    return copy.genericError;
  }

  function validSession(payload) {
    return payload && /^[a-f0-9]{64}$/i.test(String(payload.token || ''))
      && typeof payload.username === 'string' && payload.username.length > 0;
  }

  function enterDashboard(destination) {
    document.documentElement.classList.remove('yc-entry-pending');
    root.classList.add('is-leaving');
    if (destination === 'admin') {
      setTimeout(() => { location.replace('/admin'); }, reduceMotion ? 20 : 820);
      return;
    }
    setTimeout(() => { location.replace(paths.dashboard); }, reduceMotion ? 20 : 820);
  }

  function sessionIn(payload) {
    if (!validSession(payload)) throw new Error(copy.genericError);
    if (authMode === 'admin' && payload.role !== 'admin') throw new Error(copy.adminDenied);
    ['yc-token', 'yc-role', 'yc-user', 'yc-guest'].forEach(key => sessionStorage.removeItem(key));
    localStorage.removeItem('yc-guest');
    localStorage.setItem('yc-token', payload.token);
    localStorage.setItem('yc-role', payload.role || 'guest');
    localStorage.setItem('yc-user', payload.username);
    setMessage(copy.signedIn, 'success');
    enterDashboard(payload.role === 'admin' ? 'admin' : 'dashboard');
  }

  async function revokeCurrentSession() {
    const currentToken = String(localStorage.getItem('yc-token') || sessionStorage.getItem('yc-token') || '');
    if (!/^[a-f0-9]{64}$/i.test(currentToken)) return;
    if (!API) throw new Error(copy.signOutFailed);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(API + '/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + currentToken },
        body: '{}',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(copy.signOutFailed);
    } catch (error) {
      throw new Error(copy.signOutFailed);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  guestButton.addEventListener('click', async () => {
    guestButton.disabled = true;
    setMessage('');
    try {
      await revokeCurrentSession();
    } catch (error) {
      guestButton.disabled = false;
      setMessage(error && error.message ? error.message : copy.signOutFailed, 'error');
      return;
    }
    ['yc-token', 'yc-role', 'yc-user'].forEach(key => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
    localStorage.setItem('yc-guest', '1');
    setMessage(copy.guestEntering, 'success');
    enterDashboard('dashboard');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    setMessage('');
    try {
      if (authMode === 'reset') {
        if (resetStep === 1) {
          const email = $('yc-entry-reset-email').value.trim();
          if (!email) throw new Error(copy.required);
          pendingEmail = email.toLowerCase();
          await api('/api/forgot', { email });
          resetStep = 2;
          setMessage(copy.resetSent, 'success');
          renderForm();
        } else {
          const code = $('yc-entry-reset-code').value.trim();
          const password = $('yc-entry-reset-p1').value;
          const confirm = $('yc-entry-reset-p2').value;
          if (!/^\d{6}$/.test(code)) throw new Error(copy.invalidCode);
          if (!password) throw new Error(copy.required);
          if (password !== confirm) throw new Error(copy.mismatch);
          await api('/api/reset', { email: pendingEmail, code, password });
          switchAuth('login');
          setMessage(copy.resetDone, 'success');
        }
        return;
      }

      if (pendingEmail && authMode === 'signup') {
        const code = $('yc-entry-code').value.trim();
        if (!/^\d{6}$/.test(code)) throw new Error(copy.invalidCode);
        const verified = await api('/api/verify', { email: pendingEmail, code });
        if (validSession(verified)) {
          sessionIn(verified);
          return;
        }
        const signedIn = await api('/api/login', pendingCredentials);
        sessionIn(signedIn);
        return;
      }

      if (authMode === 'signup' && signupStep === 1 && !setupToken) {
        const email = $('yc-entry-email').value.trim().toLowerCase();
        if (!email) throw new Error(copy.required);
        signupEmail = email;
        signupStep = 2;
        renderForm();
        window.requestAnimationFrame(() => {
          const usernameInput = $('yc-entry-user');
          focusWithoutPageJump(usernameInput);
        });
        return;
      }

      const username = $('yc-entry-user').value.trim();
      const password = $('yc-entry-password').value;
      if (!username || !password) throw new Error(copy.required);

      if (authMode === 'signup') {
        const terms = $('yc-entry-terms').checked;
        const newsletter = $('yc-entry-newsletter').checked;
        if (!terms) throw new Error(copy.termsRequired);
        if (setupToken) {
          const payload = await api('/api/google/complete', {
            setupToken, username, password, newsletter, terms: true, locale,
          });
          sessionIn(payload);
          return;
        }
        const email = signupEmail;
        if (!email) throw new Error(copy.required);
        const payload = await api('/api/signup', { username, email, password, newsletter, terms: true, locale });
        if (payload.needCode) {
          pendingEmail = email.toLowerCase();
          pendingCredentials = { username, password };
          setMessage(copy.codeSent, 'success');
          renderForm();
        } else if (validSession(payload)) {
          sessionIn(payload);
        } else {
          const signedIn = await api('/api/login', { username, password });
          sessionIn(signedIn);
        }
        return;
      }

      const payload = await api('/api/login', { username, password });
      sessionIn(payload);
    } catch (error) {
      setMessage(error && error.message ? error.message : copy.genericError, 'error');
    } finally {
      const currentSubmit = form.querySelector('button[type="submit"]');
      if (currentSubmit) currentSubmit.disabled = false;
    }
  });

  async function handleGoogle(response) {
    try {
      const googleNewsletter = $('yc-entry-google-newsletter');
      const googleTerms = $('yc-entry-google-terms');
      if (authMode === 'signup' && (!googleTerms || !googleTerms.checked)) {
        throw new Error(copy.termsRequired);
      }
      setMessage(copy.googleChecking);
      const googleRequest = {
        credential: response && response.credential,
        autoCreate: authMode === 'signup',
        terms: authMode === 'signup' && googleTerms.checked,
        newsletter: googleNewsletter ? googleNewsletter.checked : false,
        locale,
      };
      let payload;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          payload = await api('/api/google', googleRequest);
          break;
        } catch (error) {
          if (attempt > 0 || error.code !== 'google_keys_unavailable') throw error;
          setMessage(copy.googleRetrying);
          const retryDelay = Math.min(2000, Math.max(650, error.retryAfterMs || 1000));
          await new Promise(resolve => window.setTimeout(resolve, retryDelay));
        }
      }
      if (authMode === 'admin' && payload.role !== 'admin') throw new Error(copy.adminDenied);
      if (payload.needSetup) {
        setupToken = payload.setupToken;
        authMode = 'signup';
        signupStep = 2;
        setMessage(copy.googleSetup, 'success');
        renderForm();
        return;
      }
      sessionIn(payload);
    } catch (error) {
      setMessage(error && error.message ? error.message : copy.genericError, 'error');
    }
  }

  function renderGoogleButton() {
    if (!GCID || !window.google || !window.google.accounts || !window.google.accounts.id) return;
    if (!googleInitialized) {
      window.google.accounts.id.initialize({
        client_id: GCID,
        callback: handleGoogle,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      googleInitialized = true;
    }
    googleBox.replaceChildren();
    window.google.accounts.id.renderButton(googleBox, {
      theme: 'filled_black',
      size: 'large',
      shape: 'rectangular',
      text: authMode === 'signup' ? 'signup_with' : 'continue_with',
      locale: locale === 'tw' ? 'zh_TW' : locale === 'cn' ? 'zh_CN' : 'en',
      width: Math.min(340, Math.max(240, Math.round(googleBox.getBoundingClientRect().width || 320))),
    });
  }

  function updateProviders() {
    // Administrator authentication is intentionally username/password only.
    const providersVisible = (authMode === 'login' || authMode === 'signup')
      && !setupToken
      && (authMode !== 'signup' || signupStep === 1);
    divider.style.display = providersVisible ? 'flex' : 'none';
    googleBox.style.display = providersVisible && GCID ? 'flex' : 'none';
    googleNote.style.display = providersVisible && !GCID ? 'block' : 'none';
    googleConsent.style.display = providersVisible && GCID && authMode === 'signup' ? 'block' : 'none';
    if (providersVisible && GCID) {
      if (window.google && window.google.accounts) renderGoogleButton();
      else loadGoogle();
    }
  }

  let googleLoading = false;
  function loadGoogle() {
    if (googleLoading || !GCID) return;
    googleLoading = true;
    const script = document.createElement('script');
    const googleLocale = locale === 'tw' ? 'zh_TW' : locale === 'cn' ? 'zh_CN' : 'en';
    script.src = 'https://accounts.google.com/gsi/client?hl=' + encodeURIComponent(googleLocale);
    script.async = true;
    script.defer = true;
    script.onload = renderGoogleButton;
    script.onerror = () => {
      googleLoading = false;
      script.remove();
      setMessage(copy.networkError, 'error');
    };
    document.head.appendChild(script);
  }

  renderForm();
  const entryReason = new URLSearchParams(location.search).get('reason');
  if (entryReason === 'expired') setMessage(copy.sessionExpired, 'error');
  else if (entryReason === 'disabled') setMessage(copy.accountDisabled, 'error');
  else if (entryReason === 'signedout') setMessage(copy.signedOutElsewhere, 'success');

  /* ── Market data and trailing chart ───────────────────────────── */
  const scenes = [
    { id: 'hk' },
    { id: 'us' },
    { id: 'a' },
  ];
  const marketData = new Map();
  const canvas = $('yc-entry-canvas');
  canvas.classList.add('yc-entry-canvas-live');
  const context = canvas.getContext('2d');
  const outgoingCanvas = document.createElement('canvas');
  outgoingCanvas.className = 'yc-entry-canvas yc-entry-canvas-outgoing';
  outgoingCanvas.setAttribute('aria-hidden', 'true');
  canvas.before(outgoingCanvas);
  const outgoingContext = outgoingCanvas.getContext('2d');
  let sceneIndex = 0;
  let sceneStarted = null;
  let sceneVisibleAt = performance.now();
  let manualScene = false;
  let chartWidth = 0;
  let chartHeight = 0;
  let scenePalette = null;
  let lastMetricsAt = 0;
  const sceneDuration = 32000;
  const drawDuration = 32000;
  const crossfadeDuration = 2400;
  let sceneTransitioning = false;
  let sceneTransitionToken = 0;
  let sceneTransitionTimer = 0;
  let pendingSceneAnnouncement = false;
  root.style.setProperty('--yc-entry-scene-duration', sceneDuration + 'ms');
  root.style.setProperty('--yc-entry-crossfade-duration', crossfadeDuration + 'ms');

  function parseDate(value) {
    const time = Date.parse(String(value || '') + 'T00:00:00Z');
    return Number.isFinite(time) ? time : NaN;
  }

  function buildEntryPointSeries(rows, valueIndex) {
    return (Array.isArray(rows) ? rows : [])
      .map(row => ({
        date: String(Array.isArray(row) ? row[0] : '').slice(0, 10),
        time: parseDate(Array.isArray(row) ? row[0] : ''),
        value: Number(Array.isArray(row) ? row[valueIndex] : NaN),
      }))
      .filter(row => Number.isFinite(row.time) && Number.isFinite(row.value) && row.value > 0)
      .sort((a, b) => a.time - b.time);
  }

  function normalizeHistory(portfolio, benchmark, quality) {
    if (portfolio.length < 20 || benchmark.length < 20) throw new Error('insufficient data');
    const pfByDate = new Map(portfolio.map(point => [point.date, point]));
    const bmByDate = new Map(benchmark.map(point => [point.date, point]));
    const commonDates = [...pfByDate.keys()].filter(date => bmByDate.has(date)).sort();
    if (commonDates.length < 20) throw new Error('insufficient common closes');
    const commonEndDate = commonDates[commonDates.length - 1];
    const commonEnd = parseDate(commonEndDate);
    let pf = commonDates.map((date, position) => ({ ...pfByDate.get(date), position }));
    let bm = commonDates.map((date, position) => ({ ...bmByDate.get(date), position }));
    const commonStart = pf[0].time;
    const pfBase = pf[0].value;
    const bmBase = bm[0].value;
    pf = pf.map(point => ({ ...point, value: point.value / pfBase * 100 }));
    bm = bm.map(point => ({ ...point, value: point.value / bmBase * 100 }));
    const values = pf.concat(bm).map(point => point.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const chartPadding = Math.max(1.25, (rawMax - rawMin) * 0.11);
    const calendarGaps = commonDates.reduce((count, date, index) => {
      if (!index) return count;
      return count + (parseDate(date) - parseDate(commonDates[index - 1]) > 12 * 86400000 ? 1 : 0);
    }, 0);
    const gaps = Math.max(calendarGaps, Number(quality && quality.missingCloseCount || 0));
    const pfHistoryCount = portfolio.filter(point => point.time >= commonStart && point.time <= commonEnd).length;
    const bmHistoryCount = benchmark.filter(point => point.time >= commonStart && point.time <= commonEnd).length;
    const coverage = commonDates.length / Math.max(1, Math.min(pfHistoryCount, bmHistoryCount));
    const review = !!(quality && quality.review) || gaps > 0 || coverage < 0.98;
    return {
      portfolio: pf,
      benchmark: bm,
      start: commonStart,
      end: commonEnd,
      gaps,
      coverage,
      review,
      chartMin: rawMin - chartPadding,
      chartMax: rawMax + chartPadding,
    };
  }

  const entrySnapshotPromise = API
    ? fetch(API + '/api/entry-market', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .catch(() => null)
    : Promise.resolve(null);

  async function loadSceneData(scene) {
    const entrySnapshot = await entrySnapshotPromise;
    const compact = entrySnapshot && entrySnapshot.ok && entrySnapshot.markets && entrySnapshot.markets[scene.id];
    if (!compact || !Array.isArray(compact.points)) throw new Error('market snapshot');
    if (compact.historyComplete !== true || Number(compact.cacheVersion || 0) < 3) {
      throw new Error('incomplete portfolio snapshot');
    }
    const pf = buildEntryPointSeries(compact.points, 1);
    const bm = buildEntryPointSeries(compact.points, 2);
    return normalizeHistory(pf, bm, {
      review: compact.review === true,
      missingCloseCount: Number(compact.missingCloseCount || 0),
    });
  }

  if (API) {
    scenes.forEach(scene => {
      loadSceneData(scene)
        .then(data => {
          marketData.set(scene.id, data);
          if (scenes[sceneIndex].id === scene.id) refreshActiveScene();
        })
        .catch(() => {
          marketData.set(scene.id, { error: true });
          if (scenes[sceneIndex].id === scene.id) refreshActiveScene();
        });
    });
  } else {
    scenes.forEach(scene => marketData.set(scene.id, { error: true }));
  }

  function formatDate(time) {
    const value = new Date(time);
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale === 'cn' ? 'zh-CN' : 'zh-HK', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC',
    }).format(value);
  }

  function formatPct(value) {
    if (!Number.isFinite(value)) return '—';
    return (value >= 0 ? '+' : '') + value.toFixed(1) + '%';
  }

  function pointAtPosition(series, position) {
    if (!series.length) return null;
    if (position <= 0) return series[0];
    const last = series[series.length - 1];
    if (position >= last.position) return last;
    const previousIndex = Math.floor(position);
    const nextIndex = Math.ceil(position);
    const previous = series[previousIndex];
    const next = series[nextIndex];
    const ratio = position - previousIndex;
    return {
      date: ratio < 0.5 ? previous.date : next.date,
      time: previous.time + (next.time - previous.time) * ratio,
      position,
      value: previous.value + (next.value - previous.value) * ratio,
    };
  }

  function chartTimeline(data, progress, overview) {
    const endPosition = Math.max(0, data.portfolio.length - 1);
    if (overview) {
      return { cursor: endPosition, viewStart: 0, viewEnd: endPosition };
    }
    const span = Math.max(1, endPosition);
    const viewportSpan = span * 0.56;
    const initialProgress = 0.50;
    const travel = Math.max(0, Math.min(1, progress));
    const cursor = span * (initialProgress + (1 - initialProgress) * travel);
    const viewEnd = Math.min(endPosition, Math.max(viewportSpan, cursor));
    return {
      cursor,
      viewStart: Math.max(0, viewEnd - viewportSpan),
      viewEnd,
    };
  }

  function updateSceneText(progress, force) {
    const now = performance.now();
    if (!force && now - lastMetricsAt < 90) return;
    lastMetricsAt = now;
    const scene = scenes[sceneIndex];
    const labels = copy.scene[scene.id];
    const data = marketData.get(scene.id);
    if (force) {
      $('yc-entry-eyebrow').textContent = labels.eyebrow;
      $('yc-entry-market').textContent = labels.market;
      $('yc-entry-pf-label').textContent = labels.market;
      $('yc-entry-bm-label').textContent = labels.benchmark;
      root.querySelectorAll('.yc-entry-scene-btn').forEach((button, index) => {
        button.setAttribute('aria-pressed', String(index === sceneIndex));
      });
    }
    if (!data || data.error) {
      $('yc-entry-period').textContent = data && data.error ? copy.dataUnavailable : copy.fullHistory;
      $('yc-entry-live').textContent = copy.dataPending;
      $('yc-entry-pf-ret').textContent = '—';
      $('yc-entry-bm-ret').textContent = '—';
      $('yc-entry-alpha').textContent = '—';
      return;
    }
    const effectiveProgress = Number.isFinite(progress) ? progress : 0;
    const timeline = chartTimeline(data, effectiveProgress, reduceMotion || manualScene);
    const pf = pointAtPosition(data.portfolio, timeline.cursor);
    const bm = pointAtPosition(data.benchmark, timeline.cursor);
    const pfReturn = pf.value - 100;
    const bmReturn = bm.value - 100;
    $('yc-entry-period').textContent = formatDate(data.start) + ' — ' + formatDate(data.end)
      + ' · ' + data.portfolio.length + ' ' + copy.closes;
    $('yc-entry-live').textContent = (data.review ? copy.review : copy.live)
      + (data.gaps ? ' · ' + data.gaps + ' ' + copy.gap : '');
    $('yc-entry-pf-ret').textContent = formatPct(pfReturn);
    $('yc-entry-bm-ret').textContent = formatPct(bmReturn);
    $('yc-entry-alpha').textContent = formatPct(pfReturn - bmReturn);
  }

  function announceScene() {
    const scene = scenes[sceneIndex];
    const labels = copy.scene[scene.id];
    const data = marketData.get(scene.id);
    let summary = copy.dataPending;
    if (data && data.error) summary = copy.dataUnavailable;
    if (data && !data.error) {
      const pf = data.portfolio[data.portfolio.length - 1];
      const bm = data.benchmark[data.benchmark.length - 1];
      summary = labels.market + ' ' + formatPct(pf.value - 100)
        + ', ' + labels.benchmark + ' ' + formatPct(bm.value - 100);
    }
    $('yc-entry-chart-summary').textContent = summary;
    canvas.setAttribute('aria-label', summary);
  }

  function currentProgress() {
    if (reduceMotion || manualScene) return 1;
    if (!Number.isFinite(sceneStarted)) return 0;
    return Math.min(1, Math.max(0, (performance.now() - sceneStarted) / drawDuration));
  }

  function refreshActiveScene() {
    if (!Number.isFinite(sceneStarted) && marketData.has(scenes[sceneIndex].id)) {
      sceneStarted = Math.max(performance.now(), sceneVisibleAt);
    }
    const progress = currentProgress();
    updateSceneText(progress, true);
    drawChart(progress);
    announceScene();
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    chartWidth = Math.max(320, Math.round(rect.width));
    chartHeight = Math.max(250, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(chartWidth * dpr);
    canvas.height = Math.round(chartHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function cssVar(name, fallback) {
    return getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  }

  function readScenePalette() {
    return {
      line: cssVar('--canvas-line-target', '#55d6ff'),
      benchmark: cssVar('--canvas-benchmark-target', '#8b9aae'),
      grid: cssVar('--canvas-grid-target', 'rgba(255,255,255,.1)'),
      muted: cssVar('--canvas-muted-target', '#8291a7'),
    };
  }

  function pathSeries(points, startPosition, endPosition, x, y, color, width, muted) {
    const first = pointAtPosition(points, startPosition);
    const last = pointAtPosition(points, endPosition);
    if (!first || !last || endPosition <= startPosition) return last || first;
    context.save();
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = width;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    if (muted) context.globalAlpha = 0.72;
    if (!muted) {
      context.shadowColor = color;
      context.shadowBlur = 13;
    }
    let previous = first;
    context.moveTo(x(first.position), y(first.value));
    const startIndex = Math.max(0, Math.ceil(startPosition));
    for (let index = startIndex; index < points.length; index += 1) {
      const point = points[index];
      if (point.position <= startPosition) continue;
      if (point.position >= endPosition) break;
      const px = x(point.position);
      const py = y(point.value);
      context.lineTo(px, py);
      previous = point;
    }
    if (last.position > previous.position) {
      context.lineTo(x(last.position), y(last.value));
    }
    context.stroke();
    context.restore();
    return last;
  }

  function drawChart(progress) {
    if (!chartWidth || !chartHeight) resizeCanvas();
    context.clearRect(0, 0, chartWidth, chartHeight);
    const scene = scenes[sceneIndex];
    const data = marketData.get(scene.id);
    const left = 30;
    const right = chartWidth - 24;
    const top = 68;
    const bottom = chartHeight - 26;
    if (!scenePalette) scenePalette = readScenePalette();
    const lineColor = scenePalette.line;
    const benchmarkColor = scenePalette.benchmark;
    const gridColor = scenePalette.grid;
    const muted = scenePalette.muted;

    context.save();
    context.strokeStyle = gridColor;
    context.lineWidth = 1;
    for (let row = 0; row < 3; row += 1) {
      const py = top + (bottom - top) * row / 2;
      context.beginPath();
      context.moveTo(left, py);
      context.lineTo(right, py);
      context.stroke();
    }
    context.restore();

    if (!data || data.error) {
      context.fillStyle = muted;
      context.font = '500 11px "IBM Plex Mono", monospace';
      context.fillText(copy.dataPending, left, top + 42);
      return;
    }

    const min = data.chartMin;
    const max = data.chartMax;
    const timeline = chartTimeline(data, progress, reduceMotion || manualScene);
    const x = position => left + (position - timeline.viewStart)
      / Math.max(1, timeline.viewEnd - timeline.viewStart) * (right - left);
    const y = value => bottom - (value - min) / Math.max(0.0001, max - min) * (bottom - top);

    context.fillStyle = muted;
    context.font = '500 9px "IBM Plex Mono", monospace';
    const viewStartPoint = data.portfolio[Math.max(0, Math.floor(timeline.viewStart))];
    const viewEndPoint = data.portfolio[Math.min(data.portfolio.length - 1, Math.ceil(timeline.viewEnd))];
    context.fillText(formatDate(viewStartPoint.time), left, bottom + 19);
    context.textAlign = 'right';
    context.fillText(formatDate(viewEndPoint.time), right, bottom + 19);
    context.textAlign = 'left';

    pathSeries(data.benchmark, timeline.viewStart, timeline.cursor, x, y, benchmarkColor, 1.25, true);
    const last = pathSeries(data.portfolio, timeline.viewStart, timeline.cursor, x, y, lineColor, 2.4, false);
    const scanX = x(timeline.cursor);
    context.save();
    context.strokeStyle = lineColor;
    context.globalAlpha = 0.28;
    context.beginPath();
    context.moveTo(scanX, top);
    context.lineTo(scanX, bottom);
    context.stroke();
    context.restore();
    if (last) {
      context.save();
      context.fillStyle = lineColor;
      context.shadowColor = lineColor;
      context.shadowBlur = 18;
      context.beginPath();
      context.arc(x(last.position), y(last.value), 4.2, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }

  function activateScene(next, manual, announce) {
    sceneIndex = (next + scenes.length) % scenes.length;
    manualScene = !!manual;
    sceneVisibleAt = performance.now() + (sceneTransitioning && !reduceMotion ? crossfadeDuration : 0);
    sceneStarted = marketData.has(scenes[sceneIndex].id) ? sceneVisibleAt : null;
    scenePalette = null;
    root.classList.toggle('is-manual', manualScene || reduceMotion);
    root.dataset.scene = scenes[sceneIndex].id;
    updateSceneText(reduceMotion || manualScene ? 1 : 0, true);
    drawChart(reduceMotion || manualScene ? 1 : 0);
    if (announce !== false) announceScene();
    else pendingSceneAnnouncement = true;
  }

  function captureOutgoingCanvas() {
    outgoingCanvas.width = canvas.width;
    outgoingCanvas.height = canvas.height;
    outgoingContext.setTransform(1, 0, 0, 1, 0, 0);
    outgoingContext.clearRect(0, 0, outgoingCanvas.width, outgoingCanvas.height);
    outgoingContext.drawImage(canvas, 0, 0);
  }

  function finishSceneTransition(token, immediate) {
    if (token !== sceneTransitionToken) return;
    sceneTransitionToken += 1;
    if (sceneTransitionTimer) window.clearTimeout(sceneTransitionTimer);
    sceneTransitionTimer = 0;
    root.classList.remove('is-chart-crossfade-armed', 'is-chart-crossfading', 'is-scene-copy-armed');
    outgoingContext.setTransform(1, 0, 0, 1, 0, 0);
    outgoingContext.clearRect(0, 0, outgoingCanvas.width, outgoingCanvas.height);
    sceneTransitioning = false;
    scenePalette = readScenePalette();
    if (immediate && Number.isFinite(sceneStarted) && sceneStarted > performance.now()) {
      sceneVisibleAt = performance.now();
      sceneStarted = sceneVisibleAt;
    }
    if (pendingSceneAnnouncement) {
      pendingSceneAnnouncement = false;
      announceScene();
    }
  }

  function transitionScene(next, manual) {
    if (reduceMotion) {
      activateScene(next, manual);
      return;
    }
    if (sceneTransitioning) return;
    const target = (next + scenes.length) % scenes.length;
    if (!marketData.has(scenes[target].id)) return;
    sceneTransitioning = true;
    const token = ++sceneTransitionToken;
    captureOutgoingCanvas();
    root.classList.add('is-chart-crossfade-armed', 'is-scene-copy-armed');
    void outgoingCanvas.offsetWidth;
    activateScene(target, manual, false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (token !== sceneTransitionToken || !root.isConnected) return;
        root.classList.remove('is-chart-crossfade-armed', 'is-scene-copy-armed');
        root.classList.add('is-chart-crossfading');
      });
    });
    sceneTransitionTimer = window.setTimeout(
      () => finishSceneTransition(token, false),
      crossfadeDuration + 80,
    );
  }

  root.querySelectorAll('.yc-entry-scene-btn').forEach(button => {
    button.addEventListener('click', () => transitionScene(Number(button.dataset.sceneIndex), false));
  });

  function animationFrame(now) {
    if (!root.isConnected) return;
    if (reduceMotion || manualScene) return;
    if (!Number.isFinite(sceneStarted)) {
      requestAnimationFrame(animationFrame);
      return;
    }
    const elapsed = now - sceneStarted;
    if (elapsed < 0) {
      requestAnimationFrame(animationFrame);
      return;
    }
    if (elapsed >= sceneDuration) {
      transitionScene(sceneIndex + 1, false);
      requestAnimationFrame(animationFrame);
      return;
    }
    const progress = Math.min(1, Math.max(0, elapsed / drawDuration));
    drawChart(progress);
    updateSceneText(progress, false);
    requestAnimationFrame(animationFrame);
  }

  function handleResize() {
    if (sceneTransitioning) finishSceneTransition(sceneTransitionToken, true);
    resizeCanvas();
    drawChart(currentProgress());
  }

  if (window.ResizeObserver) {
    new ResizeObserver(handleResize).observe(canvas);
  } else {
    window.addEventListener('resize', handleResize);
  }
  resizeCanvas();
  activateScene(0, false);
  const authColumn = root.querySelector('.yc-entry-auth-column');
  const settleMarketWhileAuthenticating = () => {
    if (manualScene || reduceMotion) return;
    manualScene = true;
    sceneStarted = null;
    root.classList.add('is-manual');
    updateSceneText(1, true);
    drawChart(1);
  };
  authColumn.addEventListener('focusin', settleMarketWhileAuthenticating, { once: true });
  authColumn.addEventListener('pointerdown', settleMarketWhileAuthenticating, { once: true });
  if (!reduceMotion) requestAnimationFrame(animationFrame);
})();
