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
  }
});

test('all direct login routes use the same entry experience', async () => {
  for (const path of ['login.html', 'cn/login.html', 'en/login.html']) {
    const html = await read(path);
    assert.match(html, /YC_ENTRY_MODE='login'/);
    assert.match(html, /yc-entry\.css/);
    assert.match(html, /yc-entry\.js/);
    assert.match(html, /yc-entry-fallback/);
    assert.doesNotMatch(html, /id="p"|id="u"/);
  }
});

test('anonymous Guest never receives an authentication token', async () => {
  const entry = await read('assets/yc-entry.js');
  const gate = await read('assets/yc-gate.js');
  assert.match(entry, /localStorage\.setItem\('yc-guest', '1'\)/);
  assert.match(entry, /\['yc-token', 'yc-role', 'yc-user'\]/);
  assert.match(gate, /if \(localStorage\.getItem\('yc-token'\)\) return/);
  assert.doesNotMatch(entry, /\/api\/guest/);
});

test('entry chart uses real portfolio snapshots and explicit market benchmarks', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /\/api\/entry-market/);
  assert.match(entry, /navRows/);
  assert.match(entry, /HSI ETF/);
  assert.match(entry, /S&P 500/);
  assert.match(entry, /HS300/);
  assert.match(entry, /commonDates/);
  assert.match(entry, /DATA REVIEW/);
});

test('worker exposes a compact entry snapshot and keeps external data credentials server-side', async () => {
  const worker = await read('worker/worker.js');
  const config = await read('assets/portal-config.js');
  assert.match(worker, /\/api\/entry-market/);
  assert.match(worker, /TUSHARE_TOKEN/);
  assert.match(worker, /benchmarkSource/);
  assert.match(worker, /sources\[b\.label\]/);
  assert.match(worker, /ADMIN_GOOGLE_EMAILS/);
  assert.match(worker, /verificationCode/);
  assert.doesNotMatch(worker, /Math\.random/);
  assert.doesNotMatch(config, /TUSHARE_TOKEN/);
  assert.doesNotMatch(config, /api_name:\s*['"]index_daily/);
  assert.match(config, /YC_GOOGLE_CLIENT_ID\s*=\s*'[^']+\.apps\.googleusercontent\.com'/);
});

test('static motion modes stop the animation loop and session login refreshes the dashboard shell', async () => {
  const entry = await read('assets/yc-entry.js');
  assert.match(entry, /if \(!reduceMotion\) requestAnimationFrame\(animationFrame\)/);
  assert.match(entry, /if \(reduceMotion \|\| manualScene\) return/);
  assert.match(entry, /location\.reload\(\)/);
  const frameBody = entry.slice(entry.indexOf('function animationFrame'), entry.indexOf('function handleResize'));
  assert.doesNotMatch(frameBody, /yc-entry-chart-summary/);
});

test('locked YiCapital wordmark stays intact in the entry surface', async () => {
  const entry = await read('assets/yc-entry.js');
  const css = await read('assets/yc-entry.css');
  assert.match(entry, />Yi<b>Capital<\/b>/);
  assert.match(css, /--yc-entry-yi:\s*#fff/);
  assert.match(css, /--yc-entry-capital-a:\s*#6e9af4/);
  assert.match(css, /--yc-entry-capital-b:\s*#b54bfa/);
});
