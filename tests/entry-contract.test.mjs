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
  const gate = await read('assets/yc-gate.js');
  assert.match(entry, /localStorage\.setItem\('yc-guest', '1'\)/);
  assert.match(entry, /\['yc-token', 'yc-role', 'yc-user'\]/);
  assert.match(gate, /if \(localStorage\.getItem\('yc-token'\)\) return/);
  assert.doesNotMatch(entry, /\/api\/guest/);
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
  assert.match(entry, /id="yc-entry-google-newsletter" type="checkbox" checked/);
  assert.match(entry, /newsletter: googleNewsletter \? googleNewsletter\.checked : false/);
  assert.match(entry, /googleConsent\.style\.display = providersVisible && GCID/);
  assert.match(entry, /error\.code !== 'google_keys_unavailable'/);
  assert.match(entry, /googleRetrying/);
  assert.doesNotMatch(entry, /id="yc-entry-password-2"/);
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

test('all member surfaces load the current account-center release', async () => {
  const pages = [
    'index.html', 'about.html', 'insights.html', 'forum.html', 'portfolios.html',
    'filings.html', 'fund-us.html', 'fund-hk.html', 'fund-a.html',
    'cn/index.html', 'cn/about.html', 'cn/insights.html', 'cn/forum.html', 'cn/portfolios.html',
    'en/index.html', 'en/about.html', 'en/insights.html', 'en/forum.html', 'en/portfolios.html',
  ];
  for (const page of pages) assert.match(await read(page), /yc-session\.js\?v=10\.1/);
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
  ]) {
    assert.match(await read(page), /assets\/yc-admin\.js\?v=8\.12/);
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
