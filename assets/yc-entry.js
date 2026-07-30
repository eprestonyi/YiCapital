/* YiCapital market-led entry experience.
   Anonymous Guest receives no bearer token, so the existing content gate remains authoritative. */
(function () {
  'use strict';

  const MODE = window.YC_ENTRY_MODE || 'gate';
  const hasSession = !!localStorage.getItem('yc-token');
  const hasGuestPass = localStorage.getItem('yc-guest') === '1';
  const fallbackShell = document.querySelector('.yc-entry-fallback');
  if (MODE === 'gate' && (hasSession || hasGuestPass)) {
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
      sixMonths: '最近六個月 · 共同收市日',
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
      sixMonths: '最近六个月 · 共同收市日',
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
      sixMonths: 'Trailing six months · common closes',
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

  const paths = {
    home: locale === 'tw' ? '/' : '/' + locale + '/',
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
              <div class="yc-entry-period" id="yc-entry-period">${copy.sixMonths}</div>
            </div>
            <div class="yc-entry-live" id="yc-entry-live">${copy.live}</div>
          </div>
          <canvas class="yc-entry-canvas" id="yc-entry-canvas" role="img"></canvas>
          <div class="yc-entry-sr" id="yc-entry-chart-summary" aria-live="polite"></div>
        </div>
        <div>
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

  function enterDashboard(destination, refreshSession) {
    document.documentElement.classList.remove('yc-entry-pending');
    root.classList.add('is-leaving');
    if (destination === 'admin') {
      setTimeout(() => { location.href = '/admin'; }, reduceMotion ? 20 : 420);
      return;
    }
    if (MODE === 'gate') {
      if (refreshSession) {
        setTimeout(() => { location.reload(); }, reduceMotion ? 20 : 420);
        return;
      }
      setTimeout(() => {
        root.remove();
        document.body.classList.remove('yc-entry-open');
      }, reduceMotion ? 20 : 560);
    } else {
      setTimeout(() => { location.href = paths.home; }, reduceMotion ? 20 : 420);
    }
  }

  function sessionIn(payload) {
    if (!validSession(payload)) throw new Error(copy.genericError);
    if (authMode === 'admin' && payload.role !== 'admin') throw new Error(copy.adminDenied);
    localStorage.removeItem('yc-guest');
    localStorage.setItem('yc-token', payload.token);
    localStorage.setItem('yc-role', payload.role || 'guest');
    localStorage.setItem('yc-user', payload.username);
    setMessage(copy.signedIn, 'success');
    enterDashboard(payload.role === 'admin' ? 'admin' : 'dashboard', true);
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
    { id: 'hk', benchmarkKey: 'HSI ETF' },
    { id: 'us', benchmarkKey: 'S&P 500' },
    { id: 'a', benchmarkKey: 'HS300' },
  ];
  const marketData = new Map();
  const canvas = $('yc-entry-canvas');
  const context = canvas.getContext('2d');
  let sceneIndex = 0;
  let sceneStarted = performance.now();
  let manualScene = false;
  let chartWidth = 0;
  let chartHeight = 0;
  const sceneDuration = 7000;
  const drawDuration = 5000;

  function parseDate(value) {
    const time = Date.parse(String(value || '') + 'T00:00:00Z');
    return Number.isFinite(time) ? time : NaN;
  }

  function buildPortfolioSeries(rows) {
    const clean = (Array.isArray(rows) ? rows : [])
      .map(row => ({
        date: String(row.date || '').slice(0, 10),
        time: parseDate(row.date),
        unitNav: Number(row.unitNav ?? row.nav),
        dividend: Number(row.divPerUnit || 0),
        ret: Number(row.ret),
      }))
      .filter(row => Number.isFinite(row.time) && Number.isFinite(row.unitNav) && row.unitNav > 0)
      .sort((a, b) => a.time - b.time);
    if (clean.length < 2) return [];
    let value = 100;
    const out = [{ date: clean[0].date, time: clean[0].time, value }];
    for (let index = 1; index < clean.length; index += 1) {
      const current = clean[index];
      const previous = clean[index - 1];
      const dailyReturn = (current.unitNav + current.dividend) / previous.unitNav - 1;
      if (!Number.isFinite(dailyReturn) || dailyReturn <= -1) continue;
      value *= 1 + dailyReturn;
      out.push({ date: current.date, time: current.time, value });
    }
    return out;
  }

  function buildBenchmarkSeries(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map(row => ({
        date: String(row.date || '').slice(0, 10),
        time: parseDate(row.date),
        value: Number(row.close),
      }))
      .filter(row => Number.isFinite(row.time) && Number.isFinite(row.value) && row.value > 0)
      .sort((a, b) => a.time - b.time);
  }

  function normalizeWindow(portfolio, benchmark, quality) {
    if (portfolio.length < 20 || benchmark.length < 20) throw new Error('insufficient data');
    const pfByDate = new Map(portfolio.map(point => [point.date, point]));
    const bmByDate = new Map(benchmark.map(point => [point.date, point]));
    const allCommonDates = [...pfByDate.keys()].filter(date => bmByDate.has(date)).sort();
    if (allCommonDates.length < 20) throw new Error('insufficient common closes');
    const commonEndDate = allCommonDates[allCommonDates.length - 1];
    const commonEnd = parseDate(commonEndDate);
    const cutoffDate = new Date(commonEnd);
    cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - 6);
    const cutoff = cutoffDate.getTime();
    const commonDates = allCommonDates.filter(date => parseDate(date) >= cutoff && parseDate(date) <= commonEnd);
    if (commonDates.length < 20) throw new Error('insufficient six-month data');
    let pf = commonDates.map(date => pfByDate.get(date));
    let bm = commonDates.map(date => bmByDate.get(date));
    const commonStart = pf[0].time;
    const pfBase = pf[0].value;
    const bmBase = bm[0].value;
    pf = pf.map(point => ({ ...point, value: point.value / pfBase * 100 }));
    bm = bm.map(point => ({ ...point, value: point.value / bmBase * 100 }));
    const gaps = commonDates.reduce((count, date, index) => {
      if (!index) return count;
      return count + (parseDate(date) - parseDate(commonDates[index - 1]) > 5 * 86400000 ? 1 : 0);
    }, 0);
    const pfWindowCount = portfolio.filter(point => point.time >= cutoff && point.time <= commonEnd).length;
    const bmWindowCount = benchmark.filter(point => point.time >= cutoff && point.time <= commonEnd).length;
    const coverage = commonDates.length / Math.max(1, Math.min(pfWindowCount, bmWindowCount));
    const review = !!(quality && quality.review) || gaps > 0 || coverage < 0.98;
    return {
      portfolio: pf,
      benchmark: bm,
      start: commonStart,
      end: commonEnd,
      gaps,
      coverage,
      review,
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
    if (compact) {
      const pf = buildPortfolioSeries(compact.navRows);
      const bm = buildBenchmarkSeries(compact.benchmarkRows);
      const benchmarkStatus = compact.benchmarkStatus || {};
      const review = !!(
        compact.navStatus && Array.isArray(compact.navStatus.stale) && compact.navStatus.stale.length
        || benchmarkStatus.stale
        || Array.isArray(benchmarkStatus.missing) && benchmarkStatus.missing.length
        || Array.isArray(benchmarkStatus.unavailable) && benchmarkStatus.unavailable.length
      );
      if (compact.historyComplete !== true || Number(compact.cacheVersion || 0) < 2) throw new Error('incomplete portfolio snapshot');
      return normalizeWindow(pf, bm, { review });
    }
    const [navResponse, benchmarkResponse] = await Promise.all([
      fetch(API + '/api/nav/' + scene.id, { cache: 'no-store' }),
      fetch(API + '/api/benchmark?set=' + scene.id, { cache: 'no-store' }),
    ]);
    if (!navResponse.ok || !benchmarkResponse.ok) throw new Error('market API');
    const [nav, benchmark] = await Promise.all([navResponse.json(), benchmarkResponse.json()]);
    if (!nav.ok || !nav.enabled || !benchmark.ok) throw new Error('market snapshot');
    if (nav.historyComplete !== true || Number(nav.cacheVersion || 0) < 2) throw new Error('incomplete portfolio snapshot');
    const pf = buildPortfolioSeries(nav.navRows);
    const bm = buildBenchmarkSeries(benchmark.data && benchmark.data[scene.benchmarkKey]);
    const review = !!(
      nav.status && Array.isArray(nav.status.stale) && nav.status.stale.length
      || benchmark.stale
      || Array.isArray(benchmark.missing) && benchmark.missing.length
      || Array.isArray(benchmark.unavailable) && benchmark.unavailable.length
    );
    return normalizeWindow(pf, bm, { review });
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

  function currentPoint(series, time) {
    let selected = series[0];
    for (const point of series) {
      if (point.time > time) break;
      selected = point;
    }
    return selected;
  }

  function updateSceneText(progress) {
    const scene = scenes[sceneIndex];
    const labels = copy.scene[scene.id];
    const data = marketData.get(scene.id);
    $('yc-entry-eyebrow').textContent = labels.eyebrow;
    $('yc-entry-market').textContent = labels.market;
    $('yc-entry-pf-label').textContent = labels.market;
    $('yc-entry-bm-label').textContent = labels.benchmark;
    root.querySelectorAll('.yc-entry-scene-btn').forEach((button, index) => {
      button.setAttribute('aria-pressed', String(index === sceneIndex));
    });
    if (!data || data.error) {
      $('yc-entry-period').textContent = data && data.error ? copy.dataUnavailable : copy.sixMonths;
      $('yc-entry-live').textContent = copy.dataPending;
      $('yc-entry-pf-ret').textContent = '—';
      $('yc-entry-bm-ret').textContent = '—';
      $('yc-entry-alpha').textContent = '—';
      return;
    }
    const effectiveProgress = Number.isFinite(progress) ? progress : 0;
    const time = data.start + (data.end - data.start) * effectiveProgress;
    const pf = currentPoint(data.portfolio, time);
    const bm = currentPoint(data.benchmark, time);
    const pfReturn = pf.value - 100;
    const bmReturn = bm.value - 100;
    $('yc-entry-period').textContent = formatDate(data.start) + ' — ' + formatDate(data.end);
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
    return Math.min(1, Math.max(0, (performance.now() - sceneStarted) / drawDuration));
  }

  function refreshActiveScene() {
    const progress = currentProgress();
    updateSceneText(progress);
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

  function pathSeries(points, endTime, x, y, color, width, dashed) {
    const visible = points.filter(point => point.time <= endTime);
    if (visible.length < 2) return visible[0] || null;
    context.save();
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = width;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    if (dashed) context.setLineDash([5, 7]);
    if (!dashed) {
      context.shadowColor = color;
      context.shadowBlur = 13;
    }
    let previous = null;
    for (const point of visible) {
      const px = x(point.time);
      const py = y(point.value);
      if (!previous || point.time - previous.time > 6 * 86400000) context.moveTo(px, py);
      else context.lineTo(px, py);
      previous = point;
    }
    context.stroke();
    context.restore();
    return visible[visible.length - 1];
  }

  function drawChart(progress) {
    if (!chartWidth || !chartHeight) resizeCanvas();
    context.clearRect(0, 0, chartWidth, chartHeight);
    const scene = scenes[sceneIndex];
    const data = marketData.get(scene.id);
    const left = 30;
    const right = chartWidth - 24;
    const top = 78;
    const bottom = chartHeight - 30;
    const lineColor = cssVar('--scene-line', '#55d6ff');
    const benchmarkColor = cssVar('--scene-benchmark', '#8b9aae');
    const gridColor = cssVar('--scene-grid', 'rgba(255,255,255,.1)');
    const muted = cssVar('--scene-muted', '#8291a7');

    context.save();
    context.strokeStyle = gridColor;
    context.lineWidth = 1;
    for (let row = 0; row < 4; row += 1) {
      const py = top + (bottom - top) * row / 3;
      context.beginPath();
      context.moveTo(left, py);
      context.lineTo(right, py);
      context.stroke();
    }
    for (let col = 0; col < 7; col += 1) {
      const px = left + (right - left) * col / 6;
      context.beginPath();
      context.moveTo(px, top);
      context.lineTo(px, bottom);
      context.stroke();
    }
    context.restore();

    if (!data || data.error) {
      context.fillStyle = muted;
      context.font = '500 11px "IBM Plex Mono", monospace';
      context.fillText(copy.dataPending, left, top + 42);
      return;
    }

    const allValues = data.portfolio.concat(data.benchmark).map(point => point.value);
    let min = Math.min(...allValues);
    let max = Math.max(...allValues);
    const padding = Math.max(2, (max - min) * 0.16);
    min -= padding;
    max += padding;
    const x = time => left + (time - data.start) / Math.max(1, data.end - data.start) * (right - left);
    const y = value => bottom - (value - min) / Math.max(0.0001, max - min) * (bottom - top);
    const endTime = data.start + (data.end - data.start) * progress;

    context.fillStyle = muted;
    context.font = '500 9px "IBM Plex Mono", monospace';
    context.fillText(max.toFixed(1), left, top - 8);
    context.fillText(min.toFixed(1), left, bottom + 19);
    context.textAlign = 'right';
    context.fillText(formatDate(data.end), right, bottom + 19);
    context.textAlign = 'left';

    pathSeries(data.benchmark, endTime, x, y, benchmarkColor, 1.25, true);
    const last = pathSeries(data.portfolio, endTime, x, y, lineColor, 2.4, false);
    const scanX = x(endTime);
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

  function setScene(next, manual) {
    sceneIndex = (next + scenes.length) % scenes.length;
    sceneStarted = performance.now();
    manualScene = !!manual;
    root.classList.toggle('is-manual', manualScene || reduceMotion);
    root.dataset.scene = scenes[sceneIndex].id;
    updateSceneText(reduceMotion || manualScene ? 1 : 0);
    drawChart(reduceMotion || manualScene ? 1 : 0);
    announceScene();
  }

  root.querySelectorAll('.yc-entry-scene-btn').forEach(button => {
    button.addEventListener('click', () => setScene(Number(button.dataset.sceneIndex), true));
  });

  function animationFrame(now) {
    if (!root.isConnected) return;
    if (reduceMotion || manualScene) return;
    const elapsed = now - sceneStarted;
    if (elapsed >= sceneDuration) {
      setScene(sceneIndex + 1, false);
      requestAnimationFrame(animationFrame);
      return;
    }
    const progress = Math.min(1, elapsed / drawDuration);
    drawChart(progress);
    updateSceneText(progress);
    requestAnimationFrame(animationFrame);
  }

  function handleResize() {
    resizeCanvas();
    drawChart(currentProgress());
  }

  if (window.ResizeObserver) {
    new ResizeObserver(handleResize).observe(canvas);
  } else {
    window.addEventListener('resize', handleResize);
  }
  resizeCanvas();
  setScene(0, false);
  if (!reduceMotion) requestAnimationFrame(animationFrame);
})();
