/* YiCapital market-led entry experience.
   Anonymous Guest receives no bearer token, so the existing content gate remains authoritative. */
(function () {
  'use strict';

  const MODE = window.YC_ENTRY_MODE || 'gate';
  const dashboardRequested = new URLSearchParams(window.location.search).get('dashboard') === '1';
  const fallbackShell = document.querySelector('.yc-entry-fallback');
  if (MODE === 'gate' && dashboardRequested) {
    if (fallbackShell) fallbackShell.remove();
    document.documentElement.classList.remove('yc-entry-pending');
    return;
  }

  const locale = window.YC_LANG === 'cn' ? 'cn' : window.YC_LANG === 'en' ? 'en' : 'tw';
  const API = String(window.YC_API || '').replace(/\/+$/, '');
  const GCID = String(window.YC_GOOGLE_CLIENT_ID || '').trim();
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const copy = {
    tw: {
      language: '繁',
      intro: '投資市場裡，真正賺錢的只有少數人。',
      fullHistory: '全部可追溯歷史 · 共同收市日',
      closes: '個共同收市日',
      live: 'LIVE · VERIFIED SNAPSHOT',
      review: 'LIVE · DATA REVIEW',
      gap: '資料缺口',
      portfolio: '組合',
      benchmark: '基準',
      alpha: '相對收益',
      authKicker: 'INVESTOR ACCESS',
      authTitle: '進入 Dashboard',
      authCopy: '登入解鎖完整研報與組合；Guest 保留目前的公開預覽權限。',
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
      continueLogin: '登入並進入 Dashboard',
      createAccount: '創建帳號',
      verify: '驗證並進入 Dashboard',
      completeGoogle: '完成 Google 註冊',
      guest: '以 Guest 繼續',
      guestNote: 'Guest 可瀏覽 Dashboard；完整研報、組合頁面與後台功能仍受限制。',
      forgot: '忘記密碼？',
      resetTitle: '重設密碼',
      sendCode: '發送驗證碼',
      resetPassword: '重設密碼',
      backLogin: '返回登入',
      admin: '管理員入口',
      backMember: '返回用戶登入',
      terms: '我同意《服務條款》',
      newsletter: '訂閱 Yi Capital Insights（可隨時取消）',
      legal: '繼續即表示你同意服務條款與私隱政策。',
      required: '請完整填寫必填欄位。',
      mismatch: '兩次密碼不一致。',
      termsRequired: '必須同意服務條款才能註冊。',
      invalidCode: '請輸入 6 位數字驗證碼。',
      backendMissing: '身份服務暫時不可用。',
      googleChecking: '正在驗證 Google 帳號…',
      googleSetup: 'Google 身份已驗證，請設定用戶名。',
      codeSent: '驗證碼已發送，請檢查收件箱與垃圾郵件。',
      signedIn: '登入成功，正在進入 Dashboard…',
      guestEntering: '正在以 Guest 身份進入 Dashboard…',
      resetSent: '如郵箱已註冊，驗證碼將發送至該地址。',
      resetDone: '密碼已重設，請重新登入。',
      genericError: '暫時無法完成操作，請稍後重試。',
      adminDenied: '此 Google 帳號沒有管理員權限。',
      dataPending: 'MARKET DATA SYNCHRONIZING',
      dataUnavailable: '真實資料暫時不可用，未使用模擬數據。',
      scene: {
        hk: { eyebrow: '01 / 03 · HONG KONG', market: 'Yi Capital HK', benchmark: 'HSI ETF · 2800.HK' },
        us: { eyebrow: '02 / 03 · UNITED STATES', market: 'Yi Capital US', benchmark: 'S&P 500' },
        a: { eyebrow: '03 / 03 · A SHARE', market: 'Yi Capital A', benchmark: 'CSI 300' },
      },
    },
    cn: {
      language: '简',
      intro: '投资市场里，真正赚钱的只有少数人。',
      fullHistory: '全部可追溯历史 · 共同收市日',
      closes: '个共同收市日',
      live: 'LIVE · VERIFIED SNAPSHOT',
      review: 'LIVE · DATA REVIEW',
      gap: '数据缺口',
      portfolio: '组合',
      benchmark: '基准',
      alpha: '相对收益',
      authKicker: 'INVESTOR ACCESS',
      authTitle: '进入 Dashboard',
      authCopy: '登录解锁完整研报与组合；Guest 保留目前的公开预览权限。',
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
      continueLogin: '登录并进入 Dashboard',
      createAccount: '创建账号',
      verify: '验证并进入 Dashboard',
      completeGoogle: '完成 Google 注册',
      guest: '以 Guest 继续',
      guestNote: 'Guest 可浏览 Dashboard；完整研报、组合页面与后台功能仍受限制。',
      forgot: '忘记密码？',
      resetTitle: '重设密码',
      sendCode: '发送验证码',
      resetPassword: '重设密码',
      backLogin: '返回登录',
      admin: '管理员入口',
      backMember: '返回用户登录',
      terms: '我同意《服务条款》',
      newsletter: '订阅 Yi Capital Insights（可随时取消）',
      legal: '继续即表示你同意服务条款与隐私政策。',
      required: '请完整填写必填字段。',
      mismatch: '两次密码不一致。',
      termsRequired: '必须同意服务条款才能注册。',
      invalidCode: '请输入 6 位数字验证码。',
      backendMissing: '身份服务暂时不可用。',
      googleChecking: '正在验证 Google 账号…',
      googleSetup: 'Google 身份已验证，请设置用户名。',
      codeSent: '验证码已发送，请检查收件箱与垃圾邮件。',
      signedIn: '登录成功，正在进入 Dashboard…',
      guestEntering: '正在以 Guest 身份进入 Dashboard…',
      resetSent: '如邮箱已注册，验证码将发送至该地址。',
      resetDone: '密码已重设，请重新登录。',
      genericError: '暂时无法完成操作，请稍后重试。',
      adminDenied: '此 Google 账号没有管理员权限。',
      dataPending: 'MARKET DATA SYNCHRONIZING',
      dataUnavailable: '真实数据暂时不可用，未使用模拟数据。',
      scene: {
        hk: { eyebrow: '01 / 03 · HONG KONG', market: 'Yi Capital HK', benchmark: 'HSI ETF · 2800.HK' },
        us: { eyebrow: '02 / 03 · UNITED STATES', market: 'Yi Capital US', benchmark: 'S&P 500' },
        a: { eyebrow: '03 / 03 · A SHARE', market: 'Yi Capital A', benchmark: 'CSI 300' },
      },
    },
    en: {
      language: 'EN',
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
      authCopy: 'Sign in for full research and portfolios. Guest keeps the existing restricted preview.',
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
      verify: 'Verify and enter Dashboard',
      completeGoogle: 'Complete Google registration',
      guest: 'Continue as Guest',
      guestNote: 'Guest can view the Dashboard; full research, portfolio pages and admin functions remain restricted.',
      forgot: 'Forgot password?',
      resetTitle: 'Reset password',
      sendCode: 'Send verification code',
      resetPassword: 'Reset password',
      backLogin: 'Back to sign in',
      admin: 'Administrator access',
      backMember: 'Back to member sign in',
      terms: 'I agree to the Terms of Service',
      newsletter: 'Subscribe to Yi Capital Insights (unsubscribe anytime)',
      legal: 'By continuing, you agree to the Terms of Service and Privacy Policy.',
      required: 'Please complete all required fields.',
      mismatch: 'The passwords do not match.',
      termsRequired: 'You must accept the Terms of Service to register.',
      invalidCode: 'Enter the 6-digit verification code.',
      backendMissing: 'The identity service is temporarily unavailable.',
      googleChecking: 'Verifying your Google account…',
      googleSetup: 'Google identity verified. Choose a username.',
      codeSent: 'Verification code sent. Check your inbox and spam folder.',
      signedIn: 'Signed in. Entering the Dashboard…',
      guestEntering: 'Entering the Dashboard as Guest…',
      resetSent: 'If the email is registered, a verification code will be sent.',
      resetDone: 'Password reset. Sign in with the new password.',
      genericError: 'Unable to complete the request. Please try again.',
      adminDenied: 'This Google account does not have administrator access.',
      dataPending: 'MARKET DATA SYNCHRONIZING',
      dataUnavailable: 'Live data is unavailable. No simulated data is being shown.',
      scene: {
        hk: { eyebrow: '01 / 03 · HONG KONG', market: 'Yi Capital HK', benchmark: 'HSI ETF · 2800.HK' },
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
  const languageBase = MODE === 'login'
    ? { tw: '/login', cn: '/cn/login', en: '/en/login' }
    : { tw: '/', cn: '/cn/', en: '/en/' };

  const root = document.createElement('div');
  root.className = 'yc-entry-root';
  root.dataset.scene = 'hk';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', copy.authTitle);
  root.innerHTML = `
    <div class="yc-entry-topbar">
      <a class="yc-entry-logo" href="${paths.home}" aria-label="YiCapital">Yi<b>Capital</b></a>
      <nav class="yc-entry-languages" aria-label="Language">
        <a href="${languageBase.tw}" ${locale === 'tw' ? 'aria-current="page"' : ''}>繁</a>
        <a href="${languageBase.cn}" ${locale === 'cn' ? 'aria-current="page"' : ''}>简</a>
        <a href="${languageBase.en}" ${locale === 'en' ? 'aria-current="page"' : ''}>EN</a>
      </nav>
    </div>
    <main class="yc-entry-shell">
      <section class="yc-entry-story" aria-labelledby="yc-entry-slogan">
        <div class="yc-entry-intro">
          <div class="yc-entry-eyebrow" id="yc-entry-eyebrow">${copy.scene.hk.eyebrow}</div>
          <h1 class="yc-entry-title" id="yc-entry-slogan">Be Like Us, <span>Not Them</span></h1>
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
          <div class="yc-entry-scene-nav" aria-label="Portfolio market">
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
  let authMode = location.hash === '#signup' ? 'signup' : 'login';
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
            ${field('yc-entry-reset-p1', copy.password, 'password', 'new-password', false, 'required minlength="6"')}
            ${field('yc-entry-reset-p2', copy.confirmPassword, 'password', 'new-password', false, 'required minlength="6"')}
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
      form.innerHTML = `
        <div class="yc-entry-form-grid">
          ${field('yc-entry-user', copy.username, 'text', 'username', true, 'required maxlength="24"')}
          ${setupToken ? '' : field('yc-entry-email', copy.email, 'email', 'email', true, 'required')}
          ${field('yc-entry-password', copy.password, 'password', 'new-password', false, 'required minlength="6"')}
          ${field('yc-entry-password-2', copy.confirmPassword, 'password', 'new-password', false, 'required minlength="6"')}
        </div>
        <label class="yc-entry-check"><input id="yc-entry-newsletter" type="checkbox" checked><span>${copy.newsletter}</span></label>
        <label class="yc-entry-check"><input id="yc-entry-terms" type="checkbox" checked><span>${copy.terms.replace('《服務條款》', `<a href="${paths.terms}" target="_blank" rel="noopener">《服務條款》</a>`).replace('《服务条款》', `<a href="${paths.terms}" target="_blank" rel="noopener">《服务条款》</a>`).replace('Terms of Service', `<a href="${paths.terms}" target="_blank" rel="noopener">Terms of Service</a>`)}</span></label>
        <button class="yc-entry-submit" type="submit">${setupToken ? copy.completeGoogle : copy.createAccount}</button>`;
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
    resetStep = 1;
    pendingEmail = null;
    pendingCredentials = null;
    setupToken = null;
    setMessage('');
    renderForm();
  }

  root.querySelectorAll('.yc-entry-tab').forEach(button => {
    button.addEventListener('click', () => switchAuth(button.dataset.authMode));
  });
  adminButton.addEventListener('click', () => switchAuth(authMode === 'admin' ? 'login' : 'admin'));

  async function api(path, body) {
    if (!API) throw new Error(copy.backendMissing);
    const response = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(payload.error));
    return payload;
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
    if (/google/i.test(key)) return locale === 'en' ? raw.replace(/未配置/, 'is not configured: ') : raw;
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
      setTimeout(() => { location.href = '/admin'; }, reduceMotion ? 20 : 820);
      return;
    }
    setTimeout(() => { location.href = paths.dashboard; }, reduceMotion ? 20 : 820);
  }

  function sessionIn(payload) {
    if (!validSession(payload)) throw new Error(copy.genericError);
    if (authMode === 'admin' && payload.role !== 'admin') throw new Error(copy.adminDenied);
    localStorage.removeItem('yc-guest');
    localStorage.setItem('yc-token', payload.token);
    localStorage.setItem('yc-role', payload.role || 'guest');
    localStorage.setItem('yc-user', payload.username);
    setMessage(copy.signedIn, 'success');
    enterDashboard(payload.role === 'admin' ? 'admin' : 'dashboard');
  }

  guestButton.addEventListener('click', () => {
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
        await api('/api/verify', { email: pendingEmail, code });
        const signedIn = await api('/api/login', pendingCredentials);
        sessionIn(signedIn);
        return;
      }

      const username = $('yc-entry-user').value.trim();
      const password = $('yc-entry-password').value;
      if (!username || !password) throw new Error(copy.required);

      if (authMode === 'signup') {
        const confirm = $('yc-entry-password-2').value;
        const terms = $('yc-entry-terms').checked;
        const newsletter = $('yc-entry-newsletter').checked;
        if (password !== confirm) throw new Error(copy.mismatch);
        if (!terms) throw new Error(copy.termsRequired);
        if (setupToken) {
          const payload = await api('/api/google/complete', {
            setupToken, username, password, newsletter, terms: true, locale,
          });
          sessionIn(payload);
          return;
        }
        const email = $('yc-entry-email').value.trim();
        if (!email) throw new Error(copy.required);
        const payload = await api('/api/signup', { username, email, password, newsletter, terms: true, locale });
        if (payload.needCode) {
          pendingEmail = email.toLowerCase();
          pendingCredentials = { username, password };
          setMessage(copy.codeSent, 'success');
          renderForm();
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
    setMessage(copy.googleChecking);
    try {
      const payload = await api('/api/google', {
        credential: response && response.credential,
        autoCreate: authMode !== 'admin',
        terms: true,
        newsletter: false,
        locale,
      });
      if (authMode === 'admin' && payload.role !== 'admin') throw new Error(copy.adminDenied);
      if (payload.needSetup) {
        setupToken = payload.setupToken;
        authMode = 'signup';
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
      width: Math.min(340, Math.max(240, Math.round(googleBox.getBoundingClientRect().width || 320))),
    });
  }

  function updateProviders() {
    const providersVisible = authMode !== 'reset' && !setupToken;
    divider.style.display = providersVisible ? 'flex' : 'none';
    googleBox.style.display = providersVisible && GCID ? 'flex' : 'none';
    googleNote.style.display = providersVisible && !GCID ? 'block' : 'none';
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
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = renderGoogleButton;
    script.onerror = () => setMessage(copy.genericError, 'error');
    document.head.appendChild(script);
  }

  renderForm();

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
    let pf = commonDates.map(date => pfByDate.get(date));
    let bm = commonDates.map(date => bmByDate.get(date));
    const commonStart = pf[0].time;
    const pfBase = pf[0].value;
    const bmBase = bm[0].value;
    pf = pf.map(point => ({ ...point, value: point.value / pfBase * 100 }));
    bm = bm.map(point => ({ ...point, value: point.value / bmBase * 100 }));
    const values = pf.concat(bm).map(point => point.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const chartPadding = Math.max(1.25, (rawMax - rawMin) * 0.11);
    const gaps = commonDates.reduce((count, date, index) => {
      if (!index) return count;
      return count + (parseDate(date) - parseDate(commonDates[index - 1]) > 12 * 86400000 ? 1 : 0);
    }, 0);
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
    return normalizeHistory(pf, bm, { review: compact.review === true });
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

  function lowerBoundTime(series, time) {
    let low = 0;
    let high = series.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (series[middle].time < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function pointAtTime(series, time) {
    if (!series.length) return null;
    if (time <= series[0].time) return series[0];
    const last = series[series.length - 1];
    if (time >= last.time) return last;
    const index = lowerBoundTime(series, time);
    const next = series[index];
    const previous = series[index - 1];
    const ratio = (time - previous.time) / Math.max(1, next.time - previous.time);
    return {
      date: previous.date,
      time,
      value: previous.value + (next.value - previous.value) * ratio,
    };
  }

  function chartTimeline(data, progress, overview) {
    if (overview) {
      return { cursor: data.end, viewStart: data.start, viewEnd: data.end };
    }
    const span = Math.max(1, data.end - data.start);
    const viewportSpan = span * 0.56;
    const initialProgress = 0.50;
    const travel = Math.max(0, Math.min(1, progress));
    const cursor = data.start + span * (initialProgress + (1 - initialProgress) * travel);
    const viewEnd = Math.min(data.end, Math.max(data.start + viewportSpan, cursor));
    return {
      cursor,
      viewStart: Math.max(data.start, viewEnd - viewportSpan),
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
    const pf = pointAtTime(data.portfolio, timeline.cursor);
    const bm = pointAtTime(data.benchmark, timeline.cursor);
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

  function pathSeries(points, startTime, endTime, x, y, color, width, muted) {
    const first = pointAtTime(points, startTime);
    const last = pointAtTime(points, endTime);
    if (!first || !last || endTime <= startTime) return last || first;
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
    context.moveTo(x(first.time), y(first.value));
    const startIndex = lowerBoundTime(points, startTime);
    for (let index = startIndex; index < points.length; index += 1) {
      const point = points[index];
      if (point.time <= startTime) continue;
      if (point.time >= endTime) break;
      const px = x(point.time);
      const py = y(point.value);
      context.lineTo(px, py);
      previous = point;
    }
    if (last.time > previous.time) {
      context.lineTo(x(last.time), y(last.value));
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
    const x = time => left + (time - timeline.viewStart)
      / Math.max(1, timeline.viewEnd - timeline.viewStart) * (right - left);
    const y = value => bottom - (value - min) / Math.max(0.0001, max - min) * (bottom - top);

    context.fillStyle = muted;
    context.font = '500 9px "IBM Plex Mono", monospace';
    context.fillText(formatDate(timeline.viewStart), left, bottom + 19);
    context.textAlign = 'right';
    context.fillText(formatDate(timeline.viewEnd), right, bottom + 19);
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
      context.arc(x(last.time), y(last.value), 4.2, 0, Math.PI * 2);
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
  if (!reduceMotion) requestAnimationFrame(animationFrame);
})();
