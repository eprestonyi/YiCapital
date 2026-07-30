const SITE_BASE = String(process.env.YC_SITE_BASE || 'https://www.yicapital.co').replace(/\/+$/, '');
const PORTAL_BASE = String(
  process.env.YC_PORTAL_BASE || 'https://yicapital-portal.eprestonyi.workers.dev',
).replace(/\/+$/, '');
const timeoutMs = Number(process.env.YC_SMOKE_TIMEOUT_MS || 15000);
const failures = [];

async function fetchChecked(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'YiCapital-Live-Monitor/1.0' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response;
}

async function checkPage(pathname, lang) {
  const url = `${SITE_BASE}${pathname}`;
  try {
    const response = await fetchChecked(url);
    const html = await response.text();
    if (!html.includes(`lang="${lang}"`)) throw new Error(`missing lang="${lang}"`);
    if (!html.includes('yc-i18n.js')) throw new Error('feedback loader is missing');
    console.log(`PASS page ${pathname} ${response.status}`);
  } catch (error) {
    failures.push(`${url}: ${error.message}`);
  }
}

async function checkPortal() {
  const url = `${PORTAL_BASE}/api/health`;
  try {
    const response = await fetchChecked(url);
    const health = await response.json();
    if (health.version !== 'v8.4-entry') throw new Error(`unexpected version ${health.version}`);
    if (health.feedback !== true) throw new Error('feedback D1 binding is unavailable');
    if (health.feedback_rate_limit !== true) throw new Error('feedback rate-limit secret is unavailable');
    if (health.kv !== true) throw new Error('KV binding is unavailable');
    if (health.google !== true) throw new Error('Google OAuth is unavailable');
    if (health.admin_google !== true) throw new Error('Google admin allowlist is unavailable');
    if (health.tushare !== true) throw new Error('Tushare market source is unavailable');
    console.log(`PASS portal ${health.version}`);
  } catch (error) {
    failures.push(`${url}: ${error.message}`);
  }
}

await Promise.all([
  checkPage('/', 'zh-Hant'),
  checkPage('/cn/', 'zh-Hans'),
  checkPage('/en/', 'en'),
  checkPortal(),
]);

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('READY YiCapital live smoke checks passed');
}
