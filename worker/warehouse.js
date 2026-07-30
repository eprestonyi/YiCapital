/*
 * YiCapital Terminal — read-only Atlas snapshot bridge.
 *
 * This bridge is deliberately separate from Tushare. It exposes only a
 * validated, versioned warehouse snapshot stored in YC_KV. Missing or partial
 * warehouse data stays missing/partial; it is never converted to zero.
 */

export const TERMINAL_WAREHOUSE_KEY = 'terminal:warehouse:atlas-seed';

export class TerminalWarehouseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TerminalWarehouseError';
    this.code = code;
  }
}

const warehouseError = (code, message) =>
  new TerminalWarehouseError(code, message);

function localizedText(value) {
  if (!value || typeof value !== 'object') return '';
  return [value.tw, value.cn, value.en].filter(Boolean).join(' ');
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw warehouseError('WAREHOUSE_SNAPSHOT_INVALID', 'Warehouse snapshot is invalid');
  }
  if (snapshot.schemaVersion !== 'atlas-seed-v1' ||
      typeof snapshot.snapshotId !== 'string' ||
      !Array.isArray(snapshot.entities) ||
      !Array.isArray(snapshot.relationships) ||
      !snapshot.financials || typeof snapshot.financials !== 'object') {
    throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse snapshot schema is invalid');
  }
  const entityIds = new Set();
  for (const entity of snapshot.entities) {
    if (!entity || typeof entity.id !== 'string' || typeof entity.name !== 'string') {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse entity schema is invalid');
    }
    if (entityIds.has(entity.id)) {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse entity ids are not unique');
    }
    entityIds.add(entity.id);
  }
  for (const edge of snapshot.relationships) {
    if (!edge || typeof edge.id !== 'string' ||
        typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse relationship schema is invalid');
    }
  }
  return snapshot;
}

async function readSnapshot(env) {
  const kv = env?.YC_KV;
  if (!kv || typeof kv.get !== 'function') {
    throw warehouseError('WAREHOUSE_NOT_CONFIGURED', 'Warehouse storage is unavailable');
  }
  let value;
  try {
    value = await kv.get(TERMINAL_WAREHOUSE_KEY, 'json');
    if (typeof value === 'string') value = JSON.parse(value);
  } catch (_) {
    throw warehouseError('WAREHOUSE_READ_FAILED', 'Warehouse snapshot could not be read');
  }
  if (!value) {
    throw warehouseError('WAREHOUSE_SNAPSHOT_MISSING', 'Warehouse snapshot is not published');
  }
  return validateSnapshot(value);
}

function snapshotWarnings(snapshot) {
  const warnings = [];
  if (snapshot.status !== 'complete') warnings.push('warehouse_snapshot_partial');
  if (snapshot.scope?.universeStatus &&
      snapshot.scope.universeStatus !== 'complete') {
    warnings.push(String(snapshot.scope.universeStatus));
  }
  return warnings;
}

function envelope(snapshot, data, freshnessClass = 'disclosure') {
  const warnings = snapshotWarnings(snapshot);
  return {
    ok: true,
    data,
    source_endpoint: 'warehouse.kv.atlas-seed',
    fetched_at: snapshot.snapshotAt || null,
    retrieved_at: new Date().toISOString(),
    as_of: snapshot.knowledgeCutoff || snapshot.snapshotAt || null,
    freshness_class: freshnessClass,
    is_complete: snapshot.status === 'complete' && warnings.length === 0,
    warnings,
    cache_status: 'warehouse',
  };
}

function entitySearchText(entity) {
  return [
    entity.id,
    entity.name,
    entity.kind,
    entity.layer,
    entity.cluster,
    localizedText(entity.role),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

function selectYearFinancials(snapshot, entityId, year) {
  const records = snapshot.financials?.[entityId];
  if (!records || typeof records !== 'object') return null;
  if (year != null && year !== '') {
    return records[String(year)] || null;
  }
  const latestYear = Object.keys(records).sort().at(-1);
  return latestYear ? records[latestYear] : null;
}

function graphForEntity(snapshot, entityId, year) {
  const relationships = snapshot.relationships.filter((edge) => {
    if (edge.from !== entityId && edge.to !== entityId) return false;
    if (year == null || year === '') return true;
    return !Array.isArray(edge.validCanonicalYears) ||
      edge.validCanonicalYears.includes(Number(year));
  });
  const connectedIds = new Set([entityId]);
  relationships.forEach((edge) => {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  });
  return {
    entities: snapshot.entities.filter((entity) => connectedIds.has(entity.id)),
    relationships,
  };
}

export function createTerminalWarehouseAdapter(env) {
  return Object.freeze({
    async bootstrap() {
      const snapshot = await readSnapshot(env);
      return envelope(snapshot, {
        snapshot_id: snapshot.snapshotId,
        schema_version: snapshot.schemaVersion,
        status: snapshot.status || 'unknown',
        scope: snapshot.scope || null,
        coverage: snapshot.coverage || null,
        entity_count: snapshot.entities.length,
        relationship_count: snapshot.relationships.length,
        financial_entity_count: Object.keys(snapshot.financials).length,
        layers: snapshot.layers || [],
      }, 'static');
    },

    async search(payload = {}) {
      const snapshot = await readSnapshot(env);
      const query = String(payload.query || '').trim().toLocaleLowerCase();
      const limit = Math.min(50, Math.max(1, Number(payload.limit) || 20));
      const matches = snapshot.entities
        .filter((entity) => entitySearchText(entity).includes(query))
        .slice(0, limit)
        .map((entity) => ({
          id: entity.id,
          name: entity.name,
          kind: entity.kind || null,
          layer: entity.layer || null,
          cluster: entity.cluster || null,
          role: entity.role || null,
        }));
      return envelope(snapshot, matches);
    },

    async market(payload = {}) {
      const snapshot = await readSnapshot(env);
      const entityId = String(payload.entity || '').trim();
      const year = payload.year == null ? null : Number(payload.year);
      const limit = Math.min(1000, Math.max(1, Number(payload.limit) || 100));
      const graph = entityId
        ? graphForEntity(snapshot, entityId, year)
        : {
            entities: snapshot.entities,
            relationships: snapshot.relationships.filter((edge) =>
              year == null || !Array.isArray(edge.validCanonicalYears) ||
              edge.validCanonicalYears.includes(year)),
          };
      return envelope(snapshot, {
        schemaVersion: snapshot.schemaVersion,
        snapshot_id: snapshot.snapshotId,
        snapshotId: snapshot.snapshotId,
        snapshotAt: snapshot.snapshotAt || null,
        knowledgeCutoff: snapshot.knowledgeCutoff || null,
        status: snapshot.status || 'unknown',
        scope: snapshot.scope || null,
        coverage: snapshot.coverage || null,
        layers: snapshot.layers || [],
        sources: snapshot.sources || [],
        entities: graph.entities.slice(0, limit),
        relationships: graph.relationships.slice(0, limit),
        financials: snapshot.financials || {},
      });
    },

    async stockDetail(payload = {}) {
      const snapshot = await readSnapshot(env);
      const symbol = String(payload.symbol || '').trim().toLocaleLowerCase();
      const entity = snapshot.entities.find((candidate) =>
        candidate.id.toLocaleLowerCase() === symbol ||
        candidate.name.toLocaleLowerCase() === symbol);
      if (!entity) {
        return {
          ...envelope(snapshot, {
            entity: null,
            upstream: [],
            downstream: [],
            relationships: [],
            financials: null,
          }),
          is_complete: false,
          warnings: [...snapshotWarnings(snapshot), 'warehouse_entity_not_covered'],
        };
      }
      const year = payload.end_date
        ? Number(String(payload.end_date).slice(0, 4))
        : null;
      const graph = graphForEntity(snapshot, entity.id, year);
      const byId = new Map(graph.entities.map((item) => [item.id, item]));
      const upstream = graph.relationships
        .filter((edge) => edge.to === entity.id)
        .map((edge) => ({ edge, entity: byId.get(edge.from) || null }));
      const downstream = graph.relationships
        .filter((edge) => edge.from === entity.id)
        .map((edge) => ({ edge, entity: byId.get(edge.to) || null }));
      return envelope(snapshot, {
        entity,
        upstream,
        downstream,
        relationships: graph.relationships,
        financials: selectYearFinancials(snapshot, entity.id, year),
      });
    },

    async status() {
      const snapshot = await readSnapshot(env);
      return envelope(snapshot, {
        ready: true,
        snapshot_id: snapshot.snapshotId,
        schema_version: snapshot.schemaVersion,
        status: snapshot.status || 'unknown',
        entity_count: snapshot.entities.length,
        relationship_count: snapshot.relationships.length,
        coverage: snapshot.coverage || null,
      }, 'static');
    },
  });
}
