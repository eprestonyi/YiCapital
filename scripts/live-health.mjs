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
    if (health.version !== 'v8.5-entry') throw new Error(`unexpected version ${health.version}`);
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

async function checkEntryHistory() {
  const configs = {
    hk: 'HSI ETF',
    us: 'S&P 500',
    a: 'HS300',
  };
  const url = `${PORTAL_BASE}/api/entry-market?smoke=${Date.now()}`;
  try {
    const response = await fetchChecked(url);
    const entry = await response.json();
    if (entry.ok !== true) throw new Error('entry snapshot is unavailable');
    const counts = [];
    for (const [market, benchmarkLabel] of Object.entries(configs)) {
      const [navResponse, benchmarkResponse] = await Promise.all([
        fetchChecked(`${PORTAL_BASE}/api/nav/${market}`),
        fetchChecked(`${PORTAL_BASE}/api/benchmark?set=${market}`),
      ]);
      const [nav, benchmark] = await Promise.all([navResponse.json(), benchmarkResponse.json()]);
      const navDates = new Set((Array.isArray(nav.navRows) ? nav.navRows : []).map(row => row.date));
      const benchmarkRows = benchmark.data && benchmark.data[benchmarkLabel];
      const benchmarkDates = new Set((Array.isArray(benchmarkRows) ? benchmarkRows : []).map(row => row.date));
      const expected = [...navDates].filter(date => benchmarkDates.has(date)).sort();
      const snapshot = entry.markets && entry.markets[market];
      const points = snapshot && Array.isArray(snapshot.points) ? snapshot.points : [];
      if (snapshot && snapshot.formatVersion !== 3) throw new Error(`${market} format is not v3`);
      if (points.length !== expected.length) {
        throw new Error(`${market} has ${points.length}/${expected.length} common closes`);
      }
      if (points[0] && points[0][0] !== expected[0]) throw new Error(`${market} start date is truncated`);
      if (points.at(-1) && points.at(-1)[0] !== expected.at(-1)) throw new Error(`${market} end date is stale`);
      const keys = Object.keys(snapshot || {});
      for (const forbidden of ['navRows', 'navStatus', 'marketValue', 'cash', 'units', 'liability', 'holdings']) {
        if (keys.includes(forbidden)) throw new Error(`${market} entry leaked ${forbidden}`);
      }
      counts.push(`${market.toUpperCase()} ${points.length} (${expected[0]}—${expected.at(-1)})`);
    }
    console.log(`PASS entry history ${counts.join(' · ')}`);
  } catch (error) {
    failures.push(`${url}: ${error.message}`);
  }
}

await Promise.all([
  checkPage('/', 'zh-Hant'),
  checkPage('/cn/', 'zh-Hans'),
  checkPage('/en/', 'en'),
  checkPortal(),
  checkEntryHistory(),
]);

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('READY YiCapital live smoke checks passed');
}
