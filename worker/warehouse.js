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

function validYear(value) {
  return Number.isInteger(value) && value >= 2010 && value <= 2026;
}

function validateFinancialRecord(record, canonicalYear) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Number(record.canonicalYear) !== canonicalYear) {
    throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse financial record is invalid');
  }
  for (const family of ['income', 'balance', 'cashflow', 'equity']) {
    if (record[family] == null) continue;
    if (!Array.isArray(record[family])) {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse statement family is invalid');
    }
    for (const fact of record[family]) {
      if (!fact || typeof fact.metric !== 'string' ||
          !['number', 'object'].includes(typeof fact.value) ||
          (typeof fact.value === 'number' && !Number.isFinite(fact.value)) ||
          (fact.value !== null && typeof fact.value !== 'number') ||
          (fact.method != null && typeof fact.method !== 'string')) {
        throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse financial fact is invalid');
      }
    }
  }
  if (record.flow != null) {
    if (typeof record.flow !== 'object' || Array.isArray(record.flow) ||
        Object.values(record.flow).some((value) =>
          value !== null && (typeof value !== 'number' || !Number.isFinite(value)))) {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse financial flow is invalid');
    }
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw warehouseError('WAREHOUSE_SNAPSHOT_INVALID', 'Warehouse snapshot is invalid');
  }
  if (snapshot.schemaVersion !== 'atlas-seed-v1' ||
      typeof snapshot.snapshotId !== 'string' ||
      !Array.isArray(snapshot.layers) ||
      !Array.isArray(snapshot.sources) ||
      !Array.isArray(snapshot.entities) ||
      !Array.isArray(snapshot.relationships) ||
      !snapshot.financials || typeof snapshot.financials !== 'object' ||
      Array.isArray(snapshot.financials)) {
    throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse snapshot schema is invalid');
  }
  const sourceIds = new Set();
  for (const source of snapshot.sources) {
    if (!source || typeof source.id !== 'string' || sourceIds.has(source.id)) {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse source schema is invalid');
    }
    sourceIds.add(source.id);
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
  const edgeIds = new Set();
  for (const edge of snapshot.relationships) {
    if (!edge || typeof edge.id !== 'string' ||
        typeof edge.from !== 'string' || typeof edge.to !== 'string' ||
        edgeIds.has(edge.id) ||
        !entityIds.has(edge.from) || !entityIds.has(edge.to) ||
        !Array.isArray(edge.validCanonicalYears) ||
        edge.validCanonicalYears.some((year) => !validYear(year))) {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse relationship schema is invalid');
    }
    edgeIds.add(edge.id);
    const referencedSources = [
      edge.sourceId,
      ...(Array.isArray(edge.sourceIds) ? edge.sourceIds : []),
      ...Object.values(
        edge.evidenceByCanonicalYear && typeof edge.evidenceByCanonicalYear === 'object'
          ? edge.evidenceByCanonicalYear
          : {},
      ),
    ].filter(Boolean);
    if (referencedSources.some((sourceId) => !sourceIds.has(sourceId))) {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse relationship source is invalid');
    }
  }
  for (const [entityId, records] of Object.entries(snapshot.financials)) {
    if (!entityIds.has(entityId) || !records || typeof records !== 'object' ||
        Array.isArray(records)) {
      throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse financial entity is invalid');
    }
    for (const [yearKey, record] of Object.entries(records)) {
      const year = Number(yearKey);
      if (!validYear(year) || String(year) !== yearKey) {
        throw warehouseError('WAREHOUSE_SCHEMA_INVALID', 'Warehouse financial year is invalid');
      }
      validateFinancialRecord(record, year);
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
    entity.ticker,
    entity.kind,
    entity.layer,
    entity.cluster,
    localizedText(entity.role),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

function entityMatchesSymbol(entity, value) {
  const symbol = String(value || '').trim().toLocaleLowerCase();
  if (!symbol) return false;
  const tickerTokens = String(entity.ticker || '')
    .toLocaleLowerCase()
    .split(/[\s/|,]+/)
    .filter(Boolean);
  return entity.id.toLocaleLowerCase() === symbol ||
    entity.name.toLocaleLowerCase() === symbol ||
    tickerTokens.includes(symbol);
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
      const entities = graph.entities.slice(0, limit);
      const includedIds = new Set(entities.map((entity) => entity.id));
      const closedRelationships = graph.relationships.filter((edge) =>
        includedIds.has(edge.from) && includedIds.has(edge.to));
      const relationships = closedRelationships.slice(0, limit);
      const truncated = entities.length < graph.entities.length ||
        relationships.length < graph.relationships.length;
      const financials = Object.fromEntries(
        entities
          .filter((entity) => snapshot.financials[entity.id])
          .map((entity) => [entity.id, snapshot.financials[entity.id]]),
      );
      const result = envelope(snapshot, {
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
        entities,
        relationships,
        financials,
      });
      if (truncated) {
        result.is_complete = false;
        result.warnings = [...new Set([...result.warnings, 'route_limit_applied'])];
      }
      return result;
    },

    async stockDetail(payload = {}) {
      const snapshot = await readSnapshot(env);
      const symbol = String(payload.symbol || '').trim().toLocaleLowerCase();
      const entity = snapshot.entities.find((candidate) =>
        entityMatchesSymbol(candidate, symbol));
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
