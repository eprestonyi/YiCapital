import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('all three home routes mount the market entry before the existing dashboard', async () => {
  for (const path of ['index.html', 'cn/index.html', 'en/index.html']) {
    const html = await read(path);
    assert.match(html, /YC_ENTRY_MODE='gate'/);
    assert.match(html, /yc-entry\.css/);
    assert.match(html, /yc-entry\.js/);
    assert.match(html, /yc-entry-pending/);
    assert.match(html, /yc-entry-fallback/);
    assert.match(html, /yc-token/);
    assert.match(html, /yc-user/);
    assert.match(html, /yc-guest/);
    assert.match(html, /yc-dashboard-requested/);
    assert.match(html, /location\.hostname==='yicapital\.co'/);
  }
});

test('all direct login routes use the same entry experience', async () => {
  for (const path of ['login.html', 'cn/login.html', 'en/login.html']) {
    const html = await read(path);
    assert.match(html, /YC_ENTRY_MODE='login'/);
    assert.match(html, /yc-entry\.css/);
    assert.match(html, /yc-entry\.js/);
    assert.match(html, /yc-entry-fallback/);
    assert.match(html, /location\.hostname==='yicapital\.co'/);
    assert.doesNotMatch(html, /id="p"|id="u"/);
  }
});

test('the shared portal config canonicalizes apex pages before auth state is reused', async () => {
  const config = await read('assets/portal-config.js');
  assert.match(config, /window\.location\.hostname === 'yicapital\.co'/);
  assert.match(config, /window\.location\.replace\('https:\/\/www\.yicapital\.co'/);
});

test('anonymous Guest never receives an authentication token', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /localStorage\.setItem\('yc-guest', '1'\)/);
  assert.match(entry, /\['yc-token', 'yc-role', 'yc-user'\]/);
  assert.doesNotMatch(entry, /\/api\/guest/);
});

test('public research and portfolios do not pretend that a browser soft wall is authorization', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /訪客也可閱讀全部公開研究與組合/);
  assert.match(entry, /signing in or browsing as Guest does not record consent/);
  for (const page of [
    'forum.html', 'fund-a.html', 'fund-hk.html', 'fund-us.html', 'portfolios.html',
    'cn/forum.html', 'cn/fund-a.html', 'cn/fund-hk.html', 'cn/fund-us.html', 'cn/portfolios.html',
    'en/forum.html', 'en/fund-a.html', 'en/fund-hk.html', 'en/fund-us.html', 'en/portfolios.html',
  ]) assert.doesNotMatch(await read(page), /yc-gate\.js/);
});

test('entry chart uses all common closes from the privacy-minimized market snapshot', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /\/api\/entry-market/);
  assert.match(entry, /compact\.points/);
  assert.match(entry, /buildEntryPointSeries/);
  assert.match(entry, /fullHistory/);
  assert.match(entry, /commonDates/);
  assert.match(entry, /DATA REVIEW/);
  assert.doesNotMatch(entry, /setUTCMonth/);
  assert.doesNotMatch(entry, /\/api\/nav\//);
  assert.doesNotMatch(entry, /\/api\/benchmark\?set=/);
});

test('worker exposes a compact entry snapshot and keeps external data credentials server-side', async () => {
  const worker = await read('worker/worker.js');
  const config = await read('assets/portal-config.js');
  assert.match(worker, /\/api\/entry-market/);
  assert.match(worker, /TUSHARE_TOKEN/);
  assert.match(worker, /formatVersion:\s*3/);
  assert.match(worker, /buildEntryMarketPoints/);
  assert.match(worker, /missingCloseCount/);
  assert.match(worker, /coverage/);
  assert.match(worker, /benchmarkSource/);
  assert.match(worker, /sources\[b\.label\]/);
  const entryBranch = worker.slice(
    worker.indexOf("if (path === '/api/entry-market'"),
    worker.indexOf('/* ════ 會話 ════'),
  );
  assert.doesNotMatch(entryBranch, /slice\(-190\)/);
  assert.doesNotMatch(entryBranch, /navRows:/);
  assert.doesNotMatch(entryBranch, /navStatus/);
  assert.doesNotMatch(worker, /ADMIN_GOOGLE_EMAILS|ADMIN_GOOGLE_EMAIL/);
  assert.match(worker, /verificationCode/);
  assert.doesNotMatch(worker, /Math\.random/);
  assert.doesNotMatch(config, /TUSHARE_TOKEN/);
  assert.doesNotMatch(config, /api_name:\s*['"]index_daily/);
  assert.match(config, /YC_GOOGLE_CLIENT_ID\s*=\s*'[^']+\.apps\.googleusercontent\.com'/);
});

test('administrator entry is username-password only', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /const providersVisible = \(authMode === 'login' \|\| authMode === 'signup'\)[\s\S]{0,120}&& !setupToken/);
  assert.doesNotMatch(entry, /provider:\s*['"]google-admin['"]/);
});

test('member registration is progressive and Google sign-up exposes optional Insights consent', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /let signupStep = 1/);
  assert.match(entry, /signupStep === 1 && !setupToken/);
  assert.match(entry, /id="yc-entry-google-newsletter" type="checkbox"/);
  assert.match(entry, /id="yc-entry-google-terms" type="checkbox"/);
  assert.doesNotMatch(entry, /id="yc-entry-google-newsletter" type="checkbox" checked/);
  assert.doesNotMatch(entry, /id="yc-entry-google-terms" type="checkbox" checked/);
  assert.match(entry, /newsletter: googleNewsletter \? googleNewsletter\.checked : false/);
  assert.match(entry, /googleConsent\.style\.display = providersVisible && GCID && authMode === 'signup'/);
  assert.match(entry, /autoCreate: authMode === 'signup'/);
  assert.match(entry, /authMode === 'signup' && \(!googleTerms \|\| !googleTerms\.checked\)/);
  assert.match(entry, /terms: authMode === 'signup' && googleTerms\.checked/);
  assert.match(entry, /locale: locale === 'tw' \? 'zh_TW' : locale === 'cn' \? 'zh_CN' : 'en'/);
  assert.match(entry, /gsi\/client\?hl=/);
  assert.match(entry, /minlength="15" maxlength="128"/);
  assert.doesNotMatch(entry, /id="yc-entry-newsletter" type="checkbox" checked/);
  assert.doesNotMatch(entry, /id="yc-entry-terms" type="checkbox" checked/);
  assert.match(entry, /error\.code !== 'google_keys_unavailable'/);
  assert.match(entry, /googleRetrying/);
  assert.doesNotMatch(entry, /id="yc-entry-password-2"/);
});

test('entry language chrome and visible slogan stay within the selected locale', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /languageNav: '語言'/);
  assert.match(entry, /marketNav: '組合市場'/);
  assert.match(entry, /sloganLead: '成為少數，'/);
  assert.match(entry, /languageNav: '语言'/);
  assert.match(entry, /marketNav: '组合市场'/);
  assert.match(entry, /sloganLead: '成为少数，'/);
  assert.match(entry, /aria-label="\$\{copy\.languageNav\}"/);
  assert.match(entry, /aria-label="\$\{copy\.marketNav\}"/);
  assert.match(entry, /\$\{copy\.sloganLead\} <span>\$\{copy\.sloganAccent\}<\/span>/);
});

test('signed-in account center exposes editable profile, locked identities and opt-in recovery', async () => {
  const [session, worker] = await Promise.all([
    read('assets/yc-session.js'),
    read('worker/worker.js'),
  ]);
  for (const label of [
    'Account Settings & Profile',
    'Connect MCPs & APIs',
    'Contact Site Operator',
    'Social Media',
    'Support & Help',
  ]) assert.match(session, new RegExp(label.replace(/[&]/g, '\\&')));
  assert.match(session, /data-avatar-file/);
  assert.match(session, /name="displayName"/);
  assert.match(session, /name="username"/);
  assert.match(session, /name="newsletter"/);
  assert.match(session, /readonly value=/);
  assert.match(session, /\/api\/account\/profile/);
  assert.match(session, /yc-subscribe-card/);
  assert.match(session, /profile\.newsletter/);
  assert.match(session, /eprestonyi@gmail\.com/);
  assert.match(worker, /usernameOwner/);
  assert.match(worker, /avatarDataUrl/);
  assert.match(worker, /connections:\s*\{/);
  assert.match(worker, /revokeUserSessions\(env, sess\.u\)/);
});

test('account center is trilingual, keeps avatars in-bounds and restores the admin-only portal entry', async () => {
  const session = await read('assets/yc-session.js');

  for (const label of [
    '帳戶設定與個人資料', '連接 MCP 與 API', '聯絡網站營運者', '社交媒體', '應用程式', '支援與協助',
    '账户设置与个人资料', '连接 MCP 与 API', '联系网站运营者', '社交媒体', '应用程序', '支持与帮助',
    'Account Settings & Profile', 'Connect MCPs & APIs', 'Contact Site Operator', 'Social Media', 'Support & Help',
  ]) assert.match(session, new RegExp(label.replace(/[&]/g, '\\&')));

  assert.match(session, /menuItem\('account', '◎', L\.accountTitle/);
  assert.match(session, /sideItem\('account', '◎', L\.navAccount/);
  assert.match(session, /pageHeading\(L\.contactKicker, L\.contactTitle/);
  assert.match(session, /pageHeading\(L\.helpKicker, L\.helpTitle/);
  assert.match(session, /L\.socialChannels/);
  assert.doesNotMatch(session, /logout: '登出'[\s\S]{0,80}logoutRetry: '登出失败/);

  const englishBlock = session.slice(session.indexOf('    en: {'), session.indexOf('  }[locale];'));
  assert.doesNotMatch(englishBlock, /[\u3400-\u9fff]/);

  assert.match(session, /\.yc-menu-identity-copy>b,\.yc-menu-identity-copy>span/);
  assert.doesNotMatch(session, /\.yc-menu-identity b,\.yc-menu-identity span/);
  assert.match(session, /\.yc-account-menu\{[^}]*box-sizing:border-box/);
  assert.match(session, /\.yc-account-menu\{position:fixed;top:74px;left:max\(14px,env\(safe-area-inset-left\)\);right:max\(14px,env\(safe-area-inset-right\)\);width:auto/);
  assert.match(session, /if \(!profileLoaded \|\| profile\.role !== 'admin'\) return ''/);
  assert.match(session, /href="\/admin"/);
  assert.match(session, /data-admin-menu-slot/);
  assert.match(session, /data-admin-side-slot/);
  assert.match(session, /esc\(L\.adminOpen\)/);
});

test('Guest uses an explicit localized trigger and never renders a synthetic member avatar', async () => {
  const session = await read('assets/yc-session.js');
  assert.match(session, /class="yc-guest-button"/);
  assert.match(session, /esc\(L\.guestRole\)/);
  assert.match(session, /const trigger = isGuest[\s\S]{0,500}: '<button class="yc-ava-button yc-account-pending"/);
  const guestIdentity = session.slice(session.indexOf('if (isGuest) {'), session.indexOf('if (!profileLoaded) {'));
  assert.match(guestIdentity, /L\.guest/);
  assert.doesNotMatch(guestIdentity, /avatarMarkup|initials\(/);
});

test('account state clears disabled sessions and synchronizes identity changes across tabs', async () => {
  const session = await read('assets/yc-session.js');
  assert.match(session, /response\.status !== 401 && response\.status !== 403/);
  assert.match(session, /error\.status === 401 \|\| error\.status === 403/);
  assert.match(session, /addEventListener\('storage'/);
  assert.match(session, /nextToken\.toLowerCase\(\) !== token\.toLowerCase\(\)/);
  assert.match(session, /addEventListener\('pageshow'/);
  assert.match(session, /reconcileStoredIdentity\(\)/);
  assert.match(session, /location\.replace\(loginPath \+ '\?reason=signedout'\)/);
  assert.match(session, /visibilitychange/);
  assert.match(session, /async function loadProfile\(attempt = 0\)/);
  assert.match(session, /if \(attempt < 1\) \{[\s\S]{0,120}loadProfile\(attempt \+ 1\)/);
  assert.doesNotMatch(session, /\n    validate\(0\);\n/);
});

test('administrator password copy and shared auth assets match the hardened release', async () => {
  const users = await read('admin-users.html');
  assert.match(users, /15–128 個字元/);
  assert.doesNotMatch(users, /至少 6 位/);
  for (const page of ['admin.html', 'admin-feedback.html', 'admin-inbox.html', 'admin-insights.html', 'admin-ledger.html', 'admin-mail.html', 'admin-reports.html', 'admin-users.html']) {
    assert.match(await read(page), /yc-admin\.js\?v=8\.13/);
  }
  for (const page of ['index.html', 'login.html', 'cn\/index.html', 'cn\/login.html', 'en\/index.html', 'en\/login.html']) {
    assert.match(await read(page), /portal-config\.js\?v=9\.4/);
    assert.match(await read(page), /yc-entry\.js\?v=9\.6/);
  }
});

test('managed research content is escaped and links are restricted to the same origin', async () => {
  const [reports, posts, adminReports, adminInsights] = await Promise.all([
    read('assets/reports.js'), read('assets/posts.js'), read('admin-reports.html'), read('admin-insights.html'),
  ]);
  assert.match(reports, /url\.origin === location\.origin/);
  assert.match(reports, /_RE\(_RF\(r\.title/);
  assert.match(posts, /url\.origin===location\.origin/);
  assert.match(posts, /_PE\(_PF\(p\.excerpt/);
  for (const adminPage of [adminReports, adminInsights]) {
    assert.match(adminPage, /const H=\(v\)=>/);
    assert.match(adminPage, /data-id="\$\{H\(it\.id\)\}"/);
  }
});

test('auth mutations fail closed on origin, body, verification and password boundaries', async () => {
  const [worker, sessions, wrangler] = await Promise.all([
    read('worker/worker.js'), read('worker/auth-sessions.js'), read('wrangler.toml'),
  ]);
  assert.match(worker, /AUTH_MUTATION_PATHS/);
  assert.match(worker, /normalizedCorsOrigin\(request, env\) === null/);
  assert.match(worker, /AUTH_JSON_MAX_BYTES = 16 \* 1024/);
  assert.match(worker, /PASSWORD_MIN_LENGTH = 15/);
  assert.match(worker, /PASSWORD_MAX_LENGTH = 128/);
  assert.match(worker, /PBKDF2_ITERATIONS = 600000/);
  assert.match(worker, /if \(!env\.RESEND_API_KEY\) return J\(env, \{ error: '郵箱驗證服務暫時不可用/);
  assert.match(worker, /remainingCodeTtl\(expiresAt\)/);
  assert.match(worker, /reservedUsername\(username, env\)/);
  assert.doesNotMatch(worker, /subject: [^\n]*\+ code/);
  assert.match(sessions, /ADMIN_PROVIDER_PREFIX = 'admin-password-v1:'/);
  assert.match(sessions, /staleAdminCredential/);
  assert.match(sessions, /ADMIN_SESSION_IDLE_TTL_MS = 12 \* 60 \* 60 \* 1000/);
  assert.match(sessions, /'subject\\u0000' \+ String\(options\.identity\)/);
  assert.match(worker, /authRateAllowed\(request, env, 'login-subject'/);
  assert.match(wrangler, /\[limits\][\s\S]*cpu_ms = 30000/);
});

test('all member surfaces load the current account-center release', async () => {
  const pages = [
    'index.html', 'about.html', 'insights.html', 'forum.html', 'portfolios.html',
    'filings.html', 'fund-us.html', 'fund-hk.html', 'fund-a.html',
    'cn/index.html', 'cn/about.html', 'cn/insights.html', 'cn/forum.html', 'cn/portfolios.html',
    'en/index.html', 'en/about.html', 'en/insights.html', 'en/forum.html', 'en/portfolios.html',
  ];
  for (const page of pages) assert.match(await read(page), /yc-session\.js\?v=10\.4/);
});

test('Google verification uses persistent signing-key resilience', async () => {
  const worker = await read('worker/worker.js');
  const verifier = await read('worker/google-id-token.js');
  assert.match(worker, /verifyGoogleIdToken\(credential, env\.GOOGLE_CLIENT_ID, \{[\s\S]{0,100}keyCache: env\.YC_KV/);
  assert.match(verifier, /PERSISTED_JWKS_CACHE_KEY = 'google:jwks:v1'/);
  assert.match(verifier, /MAX_STALE_SECONDS = 48 \* 60 \* 60/);
  assert.match(verifier, /GoogleJwksUnavailableError && stale/);
});

test('an expired admin session clears browser identity before redirecting', async () => {
  const admin = await read('assets/yc-admin.js');
  assert.match(admin, /if \(r\.status === 401\)[\s\S]*localStorage\.removeItem\(k\)[\s\S]*sessionStorage\.removeItem\(k\)[\s\S]*location\.href = 'login'/);
  for (const page of [
    'admin.html',
    'admin-reports.html',
    'admin-insights.html',
    'admin-users.html',
    'admin-mail.html',
    'admin-inbox.html',
    'admin-feedback.html',
    'admin-ledger.html',
  ]) {
    assert.match(await read(page), /assets\/yc-admin\.js\?v=8\.13/);
  }
});

test('the retired workbook publisher permanently redirects to the event ledger', async () => {
  const publisher = await read('admin-publish.html');
  assert.match(publisher, /http-equiv="refresh" content="0; url=admin-ledger"/);
  assert.match(publisher, /location\.replace\('admin-ledger'\)/);
  assert.doesNotMatch(publisher, /XLSX|\.xlsx|\.xlsm|\/api\/publish|\/api\/ledger|type="file"|dataTransfer/);
});

test('static motion modes stop the loop and persistent Dashboard state preserves the entry route', async () => {
  const entry = await read('assets/yc-entry.js');
  const session = await read('assets/yc-session.js');
  assert.match(entry, /if \(!reduceMotion\) requestAnimationFrame\(animationFrame\)/);
  assert.match(entry, /if \(reduceMotion \|\| manualScene\) return/);
  assert.match(entry, /location\.replace\(paths\.dashboard\)/);
  assert.match(entry, /hasMemberSession/);
  assert.match(entry, /hasGuestPass/);
  assert.match(entry, /MODE === 'gate' && \(hasMemberSession \|\| hasGuestPass\)/);
  assert.match(session, /\['yc-token', 'yc-role', 'yc-user', 'yc-guest'\]/);
  assert.match(session, /location\.replace\(homePath\)/);
  assert.match(session, /isGuest/);
  assert.match(session, /sameToken/);
  const sceneDuration = Number(entry.match(/const sceneDuration = (\d+);/)[1]);
  const drawDuration = Number(entry.match(/const drawDuration = (\d+);/)[1]);
  assert.ok(sceneDuration >= 30000);
  assert.equal(drawDuration, sceneDuration);
  assert.match(entry, /chartTimeline/);
  assert.match(entry, /pointAtPosition/);
  assert.match(entry, /lastMetricsAt < 90/);
  assert.match(entry, /transitionScene\(Number\(button\.dataset\.sceneIndex\), false\)/);
  assert.match(entry, /transitionScene\(sceneIndex \+ 1, false\)/);
  assert.match(entry, /const crossfadeDuration = 2400/);
  assert.match(entry, /outgoingContext\.drawImage\(canvas, 0, 0\)/);
  assert.match(entry, /is-chart-crossfade-armed/);
  assert.match(entry, /is-chart-crossfading/);
  assert.doesNotMatch(entry, /is-scene-fading|contentFadeDuration/);
  assert.match(entry, /sceneStarted = null/);
  assert.match(entry, /sceneVisibleAt = performance\.now\(\) \+ \(sceneTransitioning/);
  const timelineBody = entry.slice(entry.indexOf('function chartTimeline'), entry.indexOf('function updateSceneText'));
  assert.match(timelineBody, /viewportSpan = span \* 0\.56/);
  assert.match(timelineBody, /initialProgress = 0\.50/);
  assert.match(timelineBody, /data\.portfolio\.length - 1/);
  assert.doesNotMatch(timelineBody, /travelEnd|zoom|easedZoom/);
  const historyBody = entry.slice(entry.indexOf('function normalizeHistory'), entry.indexOf('const entrySnapshotPromise'));
  assert.match(historyBody, /Math\.max\(1\.25, \(rawMax - rawMin\) \* 0\.11\)/);
  const pathBody = entry.slice(entry.indexOf('function pathSeries'), entry.indexOf('function drawChart'));
  assert.doesNotMatch(pathBody, /\.filter\(/);
  assert.doesNotMatch(entry, /6 \* 86400000/);
  assert.doesNotMatch(pathBody, /setLineDash|context\.moveTo\(px/);
  assert.match(pathBody, /x\(first\.position\)/);
  assert.doesNotMatch(pathBody, /x\(first\.time\)|lowerBoundTime/);
  const drawBody = entry.slice(entry.indexOf('function drawChart'), entry.indexOf('function activateScene'));
  assert.match(drawBody, /const top = 68/);
  assert.match(drawBody, /const bottom = chartHeight - 26/);
  const frameBody = entry.slice(entry.indexOf('function animationFrame'), entry.indexOf('function handleResize'));
  assert.doesNotMatch(frameBody, /yc-entry-chart-summary/);
});

test('minimal entry styling removes card chrome and crossfades overlapping canvases', async () => {
  const css = await read('assets/yc-entry.css');
  assert.match(css, /\.yc-entry-canvas-outgoing[\s\S]*?position:\s*absolute;/);
  assert.match(css, /\.yc-entry-root\.is-chart-crossfade-armed \.yc-entry-canvas-outgoing[\s\S]*?opacity:\s*1;/);
  assert.match(css, /\.yc-entry-root\.is-chart-crossfading \.yc-entry-canvas-outgoing[\s\S]*?opacity:\s*0;/);
  assert.match(css, /--yc-entry-crossfade-duration,\s*2400ms/);
  assert.match(css, /opacity 1600ms cubic-bezier\(\.45, 0, \.55, 1\)/);
  assert.match(css, /--yc-entry-scene-duration,\s*32000ms/);
  assert.doesNotMatch(css, /scale\(\.995\)|scale\(1\.012\)/);
  assert.match(css, /html\.yc-dashboard-requested body > \.yc-entry-fallback\s*\{\s*display:\s*none;/);
  assert.match(css, /\.yc-entry-chart,[\s\S]*?border:\s*0;/);
  assert.match(css, /\.yc-entry-metrics[\s\S]*?border:\s*0;/);
  assert.match(css, /\.yc-entry-scene-btn[\s\S]*?border:\s*0;/);
  assert.match(css, /\.yc-entry-auth\s*\{[\s\S]*?border:\s*0;/);
  assert.doesNotMatch(css, /transition-duration:\s*170ms/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?transition-duration:\s*1ms/);
});

test('nonlinear-pendulum YiCapital identity stays intact in the entry surface', async () => {
  const entry = await read('assets/yc-entry.js');
  const css = await read('assets/yc-entry.css');
  assert.match(entry, />Yi<b>Capital<\/b>/);
  assert.match(css, /--yc-entry-word:\s*#f5f2ea/);
  assert.match(css, /--yc-entry-accent:\s*#75a7ff/);
  assert.match(css, /yicapital-mark-reverse\.svg/);
  assert.doesNotMatch(css, /--yc-entry-capital-(?:a|b)/);
});
