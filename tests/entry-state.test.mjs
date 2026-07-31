import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function classList() {
  const values = new Set();
  return {
    values,
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
  };
}

async function runEntryGate(mode, local = {}, session = {}) {
  const source = await read('assets/yc-entry.js');
  const prefix = source.slice(0, source.indexOf('  const locale =')) + '\n})();';
  const classes = classList();
  const fallback = { removed: false, remove() { this.removed = true; } };
  vm.runInNewContext(prefix, {
    window: { YC_ENTRY_MODE: mode },
    document: {
      querySelector() { return fallback; },
      documentElement: { classList: classes },
    },
    localStorage: storage(local),
    sessionStorage: storage(session),
  });
  return { classes: classes.values, fallback };
}

function bootstrapSource(html) {
  const match = html.match(/<script>\s*(window\.YC_ENTRY_MODE='gate';[\s\S]*?)<\/script>/);
  assert.ok(match, 'home bootstrap not found');
  return match[1];
}

async function runHomeBootstrap(path, local = {}, session = {}, search = '') {
  const classes = classList();
  const localStore = storage(local);
  vm.runInNewContext(bootstrapSource(await read(path)), {
    window: {},
    location: { search },
    URLSearchParams,
    localStorage: localStore,
    sessionStorage: storage(session),
    document: { documentElement: { classList: classes } },
  });
  return { classes: classes.values, localStore };
}

test('member and Guest sessions keep every localized bare home route on Dashboard', async () => {
  const token = 'a'.repeat(64);
  for (const path of ['index.html', 'cn/index.html', 'en/index.html']) {
    const member = await runHomeBootstrap(path, { 'yc-token': token, 'yc-user': 'investor' });
    assert.equal(member.classes.has('yc-dashboard-requested'), true);
    assert.equal(member.classes.has('yc-entry-pending'), false);

    const guest = await runHomeBootstrap(path, { 'yc-guest': '1' });
    assert.equal(guest.classes.has('yc-dashboard-requested'), true);
    assert.equal(guest.classes.has('yc-entry-pending'), false);

    const migrated = await runHomeBootstrap(path, {}, { 'yc-token': token, 'yc-user': 'legacy' });
    assert.equal(migrated.classes.has('yc-dashboard-requested'), true);
  }
});

test('partial or absent identity cannot bypass the entry and Guest fallback establishes access', async () => {
  for (const path of ['index.html', 'cn/index.html', 'en/index.html']) {
    for (const local of [{}, { 'yc-token': 'a'.repeat(64) }, { 'yc-user': 'orphan' }]) {
      const result = await runHomeBootstrap(path, local, {}, '?dashboard=1');
      assert.equal(result.classes.has('yc-entry-pending'), true);
      assert.equal(result.classes.has('yc-dashboard-requested'), false);
    }
    const fallback = await runHomeBootstrap(path, {}, {}, '?dashboard=1&guest=1');
    assert.equal(fallback.classes.has('yc-dashboard-requested'), true);
    assert.equal(fallback.localStore.getItem('yc-guest'), '1');
  }
});

test('the runtime gate bypasses only home entry mode, never the explicit login route', async () => {
  const token = 'b'.repeat(64);
  const member = await runEntryGate('gate', { 'yc-token': token, 'yc-user': 'member' });
  assert.equal(member.fallback.removed, true);
  assert.equal(member.classes.has('yc-dashboard-requested'), true);

  const guest = await runEntryGate('gate', { 'yc-guest': '1' });
  assert.equal(guest.fallback.removed, true);

  const login = await runEntryGate('login', { 'yc-token': token, 'yc-user': 'member' });
  assert.equal(login.fallback.removed, false);
  assert.equal(login.classes.has('yc-dashboard-requested'), false);
});
