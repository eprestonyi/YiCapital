import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const readBinary = path => readFile(new URL('../' + path, import.meta.url));

test('the canonical pendulum marks preserve the approved static geometry', async () => {
  for (const path of [
    'assets/brand/yicapital-mark-reverse.svg',
    'assets/brand/yicapital-mark-dark.svg',
  ]) {
    const svg = await read(path);
    assert.match(svg, /viewBox="4 3 124 134"/);
    assert.match(svg, /M42 114C67 132 101 121 116 94C130 69 124 46 105 31/);
    assert.match(svg, /M30 102h24v24H30z/);
    assert.doesNotMatch(svg, /<(?:circle|ellipse|text|script|foreignObject)\b/);
    assert.doesNotMatch(svg, /<(?:linearGradient|radialGradient)\b/);
  }

  const reverse = await read('assets/brand/yicapital-mark-reverse.svg');
  assert.match(reverse, /stroke="#75A7FF"/);
  assert.match(reverse, /fill="#75A7FF" d="M30 102h24v24H30z"/);

  const dark = await read('assets/brand/yicapital-mark-dark.svg');
  assert.match(dark, /stroke="#5F8CFF"/);
  assert.match(dark, /fill="#5F8CFF" d="M30 102h24v24H30z"/);

  const favicon = await read('favicon.svg');
  assert.match(favicon, /aria-label="YiCapital"/);
  assert.match(favicon, /fill="#050912"/);
  assert.match(favicon, /stroke="#75A7FF"/);
  assert.doesNotMatch(favicon, /<(?:circle|ellipse|text|script|foreignObject)\b/);

  const appleIcon = await readBinary('apple-touch-icon.png');
  assert.deepEqual([...appleIcon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const legacyFavicon = await readBinary('favicon.ico');
  assert.deepEqual([...legacyFavicon.subarray(0, 4)], [0, 0, 1, 0]);
});

test('shared webpage lockups use the canonical mark and a solid accessible wordmark', async () => {
  const [site, entry, terminal] = await Promise.all([
    read('assets/style.css'),
    read('assets/yc-entry.css'),
    read('assets/terminal-v2.css'),
  ]);

  for (const css of [site, entry, terminal]) {
    assert.match(css, /yicapital-mark-reverse\.svg/);
  }
  assert.match(site, /\.logo b\{[^}]*color:inherit[^}]*background:none/);
  assert.match(entry, /\.yc-entry-logo b\s*\{[^}]*color:\s*inherit;[^}]*background:\s*none/);
  assert.match(terminal, /\.terminal-home-mark \.logo b\{[^}]*color:inherit[^}]*background:none/);
  assert.match(terminal, /@media\(max-width:760px\)[\s\S]*?\.terminal-home-mark \.logo::before\{display:none\}/);
  assert.doesNotMatch(site, /--brand-(?:yi|capital)/);
  assert.doesNotMatch(entry, /--yc-entry-(?:yi|capital)/);
});

test('entry, terminal and shared styles carry the current cache key', async () => {
  const pages = [
    'index.html', 'cn/index.html', 'en/index.html',
    'login.html', 'cn/login.html', 'en/login.html',
    'terminal.html', 'cn/terminal.html', 'en/terminal.html',
    'about.html', 'cn/about.html', 'en/about.html',
  ];

  for (const path of pages) {
    const html = await read(path);
    assert.match(html, /href="\/favicon\.svg\?v=20260802a" type="image\/svg\+xml"/);
    assert.match(html, /href="\/apple-touch-icon\.png\?v=20260802a"/);
    if (html.includes('assets/style.css')) {
      assert.match(html, /assets\/style\.css\?v=20260802a/);
    }
    if (html.includes('yc-entry.css')) {
      assert.match(html, /yc-entry\.css\?v=20260804b/);
    }
    if (html.includes('terminal-v2.css')) {
      assert.match(html, /terminal-v2\.css\?v=20260802b/);
    }
    if (html.includes('og-entry.png')) {
      assert.doesNotMatch(html, /og-entry\.png["<]/);
    }
    if (html.includes('terminal-og.png')) {
      assert.doesNotMatch(html, /terminal-og\.png["<]/);
    }
  }
});
