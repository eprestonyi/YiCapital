import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTerminalWarehouseAdapter,
  TERMINAL_WAREHOUSE_KEY,
} from '../worker/warehouse.js';

const seed = {
  schemaVersion: 'atlas-seed-v1',
  snapshotId: 'test-snapshot',
  snapshotAt: '2026-07-30T00:00:00Z',
  knowledgeCutoff: '2026-07-29',
  status: 'partial',
  scope: {
    canonicalYearStart: 2010,
    canonicalYearEnd: 2026,
    universeStatus: 'candidate-universe-requires-check',
  },
  coverage: { status: 'partial' },
  layers: [{ id: 'physical' }, { id: 'models' }],
  sources: [],
  entities: [
    {
      id: 'tsmc',
      name: 'TSMC',
      ticker: '2330.TW / TSM',
      kind: 'company',
      layer: 'manufacturing',
      cluster: 'foundry',
      role: { tw: '晶圓代工', cn: '晶圆代工', en: 'Foundry' },
    },
    {
      id: 'nvda',
      name: 'NVIDIA',
      kind: 'company',
      layer: 'models',
      cluster: 'accelerators',
      role: { tw: '加速器', cn: '加速器', en: 'Accelerators' },
    },
  ],
  relationships: [
    {
      id: 'tsmc-to-nvda',
      from: 'tsmc',
      to: 'nvda',
      type: 'supplier',
      validCanonicalYears: [2025, 2026],
    },
  ],
  financials: {
    nvda: {
      2025: {
        canonicalYear: 2025,
        income: [{ metric: 'revenue', value: 100, method: 'disclosed' }],
      },
    },
  },
};

class MockKV {
  constructor(value) {
    this.value = value;
    this.keys = [];
  }

  async get(key) {
    this.keys.push(key);
    return this.value;
  }
}

test('warehouse adapter reads only the versioned Atlas KV key', async () => {
  const kv = new MockKV(seed);
  const adapter = createTerminalWarehouseAdapter({ YC_KV: kv });
  const result = await adapter.bootstrap();

  assert.deepEqual(kv.keys, [TERMINAL_WAREHOUSE_KEY]);
  assert.equal(result.ok, true);
  assert.equal(result.data.snapshot_id, 'test-snapshot');
  assert.equal(result.data.entity_count, 2);
  assert.equal(result.is_complete, false);
  assert.ok(result.warnings.includes('warehouse_snapshot_partial'));
});

test('missing or invalid warehouse snapshots fail closed', async () => {
  await assert.rejects(
    createTerminalWarehouseAdapter({ YC_KV: new MockKV(null) }).status(),
    /not published/,
  );
  await assert.rejects(
    createTerminalWarehouseAdapter({
      YC_KV: new MockKV({ ...seed, schemaVersion: 'unknown' }),
    }).status(),
    /schema is invalid/,
  );
  await assert.rejects(
    createTerminalWarehouseAdapter({}).status(),
    /storage is unavailable/,
  );
  await assert.rejects(
    createTerminalWarehouseAdapter({
      YC_KV: new MockKV({
        ...seed,
        relationships: [{
          ...seed.relationships[0],
          from: 'orphan-company',
        }],
      }),
    }).status(),
    /relationship schema is invalid/,
  );
});

test('search covers ids, names, layers, clusters and localized roles', async () => {
  const adapter = createTerminalWarehouseAdapter({
    YC_KV: new MockKV(seed),
  });
  const byName = await adapter.search({ query: 'NVIDIA', limit: 20 });
  const byRole = await adapter.search({ query: '晶圆代工', limit: 20 });

  assert.deepEqual(byName.data.map((item) => item.id), ['nvda']);
  assert.deepEqual(byRole.data.map((item) => item.id), ['tsmc']);
});

test('market graph respects entity and canonical-year filters', async () => {
  const adapter = createTerminalWarehouseAdapter({
    YC_KV: new MockKV(seed),
  });
  const covered = await adapter.market({ entity: 'nvda', year: 2025 });
  const outside = await adapter.market({ entity: 'nvda', year: 2024 });

  assert.deepEqual(
    covered.data.entities.map((item) => item.id).sort(),
    ['nvda', 'tsmc'],
  );
  assert.equal(covered.data.relationships.length, 1);
  assert.equal(outside.data.relationships.length, 0);
});

test('stock detail separates upstream/downstream and preserves missing data', async () => {
  const adapter = createTerminalWarehouseAdapter({
    YC_KV: new MockKV(seed),
  });
  const result = await adapter.stockDetail({
    symbol: 'nvda',
    end_date: '20251231',
  });
  const missing = await adapter.stockDetail({ symbol: 'not-covered' });
  const byTickerAlias = await adapter.stockDetail({ symbol: 'TSM' });

  assert.equal(result.data.entity.id, 'nvda');
  assert.equal(result.data.upstream[0].entity.id, 'tsmc');
  assert.equal(result.data.downstream.length, 0);
  assert.equal(result.data.financials.income[0].value, 100);
  assert.equal(missing.data.entity, null);
  assert.equal(missing.data.financials, null);
  assert.ok(missing.warnings.includes('warehouse_entity_not_covered'));
  assert.equal(byTickerAlias.data.entity.id, 'tsmc');
});

test('market truncation preserves graph closure and is never reported complete', async () => {
  const completeSeed = {
    ...seed,
    status: 'complete',
    scope: { ...seed.scope, universeStatus: 'complete' },
  };
  const adapter = createTerminalWarehouseAdapter({
    YC_KV: new MockKV(completeSeed),
  });
  const result = await adapter.market({ limit: 1 });

  assert.equal(result.data.entities.length, 1);
  assert.equal(result.data.relationships.length, 0);
  assert.equal(result.is_complete, false);
  assert.ok(result.warnings.includes('route_limit_applied'));
});

test('warehouse public results never serialize unrelated environment secrets', async () => {
  const secret = 'must-not-appear-in-output';
  const adapter = createTerminalWarehouseAdapter({
    YC_KV: new MockKV(seed),
    TUSHARE_TOKEN: secret,
    OTHER_SECRET: secret,
  });
  const result = await adapter.status();

  assert.equal(JSON.stringify(result).includes(secret), false);
});
