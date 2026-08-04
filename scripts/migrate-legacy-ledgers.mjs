#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIGRATION_SCHEMA_VERSION = 'legacy-ledger-migration-v1';

export const EVENT_SHEETS = Object.freeze([
  Object.freeze({
    name: 'ETF Stock Buy Record',
    eventType: 'BUY',
    columns: 9,
  }),
  Object.freeze({
    name: 'ETF Stock Sell Record',
    eventType: 'SELL',
    columns: 9,
  }),
  Object.freeze({
    name: 'ETF Stock Dividend Record',
    eventType: 'DIVIDEND',
    columns: 8,
  }),
  Object.freeze({
    name: 'Corporate Action Record',
    eventType: 'CORPORATE_ACTION',
    columns: 10,
  }),
  Object.freeze({
    name: 'Liability Record',
    eventType: 'LIABILITY',
    columns: 5,
  }),
  Object.freeze({
    name: 'Capital Record',
    eventType: 'CAPITAL',
    columns: 8,
  }),
  Object.freeze({
    name: 'Fund Action Record',
    eventType: 'FUND_ACTION',
    columns: 7,
  }),
]);

export const DERIVED_SHEETS = Object.freeze([
  'Asset Position Record',
  'Liability Statement',
  'Cash Flow Statement',
  'NAV Statement',
]);

const PORTFOLIOS = Object.freeze({
  us: Object.freeze({ currency: 'USD' }),
  hk: Object.freeze({ currency: 'HKD' }),
  a: Object.freeze({ currency: 'CNY' }),
});

const EVENT_PRIORITY = Object.freeze({
  CAPITAL: 0,
  LIABILITY: 1,
  CORPORATE_ACTION: 2,
  BUY: 3,
  SELL: 3,
  DIVIDEND: 4,
  FUND_ACTION: 5,
});

const SHEET_ORDER = new Map(EVENT_SHEETS.map((sheet, index) => [sheet.name, index]));
const MAX_ZIP_OUTPUT = 64 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function xmlDecode(value) {
  return String(value || '').replace(
    /&(?:#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    entity => {
      const lowered = entity.toLowerCase();
      const named = {
        '&amp;': '&',
        '&apos;': "'",
        '&gt;': '>',
        '&lt;': '<',
        '&quot;': '"',
      };
      if (named[lowered]) return named[lowered];
      const numeric = lowered.startsWith('&#x')
        ? Number.parseInt(lowered.slice(3, -1), 16)
        : Number.parseInt(lowered.slice(2, -1), 10);
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : entity;
    },
  );
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1]] = xmlDecode(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function textNodes(xml) {
  const values = [];
  const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  for (const match of xml.matchAll(pattern)) values.push(xmlDecode(match[1]));
  return values.join('');
}

function unzip(args) {
  const result = spawnSync('unzip', args, {
    encoding: 'utf8',
    maxBuffer: MAX_ZIP_OUTPUT,
  });
  if (result.error) {
    throw new Error(`unable to execute system unzip: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`unable to read XLSX archive${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function listZipEntries(inputPath) {
  return unzip(['-Z1', inputPath])
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function readZipEntry(inputPath, entry) {
  return unzip(['-p', inputPath, entry]);
}

function relationshipTarget(target) {
  const portable = String(target || '').replaceAll('\\', '/');
  const candidate = portable.startsWith('/')
    ? path.posix.normalize(portable.slice(1))
    : path.posix.normalize(path.posix.join('xl', portable));
  if (!candidate.startsWith('xl/') || candidate.includes('/../')) {
    throw new Error(`unsafe XLSX relationship target: ${target}`);
  }
  return candidate;
}

function workbookSheetEntries(inputPath, entries) {
  const workbookEntry = 'xl/workbook.xml';
  const relationshipsEntry = 'xl/_rels/workbook.xml.rels';
  if (!entries.has(workbookEntry) || !entries.has(relationshipsEntry)) {
    throw new Error('input is not an XLSX workbook with workbook relationships');
  }

  const workbookXml = readZipEntry(inputPath, workbookEntry);
  const relationshipsXml = readZipEntry(inputPath, relationshipsEntry);
  const relationships = new Map();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/g)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.Id && attributes.Target && /\/worksheet$/i.test(attributes.Type || '')) {
      relationships.set(attributes.Id, relationshipTarget(attributes.Target));
    }
  }

  const sheets = new Map();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/sheet>)/g)) {
    const attributes = parseAttributes(match[1]);
    const relationshipId = attributes['r:id'];
    const entry = relationships.get(relationshipId);
    if (attributes.name && entry) sheets.set(attributes.name, entry);
  }
  return sheets;
}

function parseSharedStrings(inputPath, entries) {
  const entry = 'xl/sharedStrings.xml';
  if (!entries.has(entry)) return [];
  const xml = readZipEntry(inputPath, entry);
  const strings = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    strings.push(textNodes(match[1]));
  }
  return strings;
}

function columnIndex(reference) {
  const match = /^([A-Za-z]+)\d+$/.exec(String(reference || ''));
  if (!match) return null;
  let index = 0;
  for (const character of match[1].toUpperCase()) {
    index = index * 26 + character.charCodeAt(0) - 64;
  }
  return index - 1;
}

function cellValue(attributes, body, sharedStrings) {
  const type = attributes.t || 'n';
  if (type === 'inlineStr') return textNodes(body);
  const valueMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
  if (!valueMatch) return null;
  const raw = xmlDecode(valueMatch[1]);
  if (type === 's') {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
      throw new Error(`invalid shared string index: ${raw}`);
    }
    return sharedStrings[index];
  }
  if (type === 'str') return raw;
  if (type === 'b') return raw === '1';
  if (type === 'e') throw new Error(`formula error cell encountered: ${raw}`);
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
}

function worksheetRows(xml, sharedStrings) {
  const rows = [];
  let fallbackRow = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttributes = parseAttributes(rowMatch[1]);
    const sourceRow = Number(rowAttributes.r) || fallbackRow + 1;
    fallbackRow = sourceRow;
    const values = [];
    let fallbackColumn = 0;
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const cellMatch of rowMatch[2].matchAll(cellPattern)) {
      const attributes = parseAttributes(cellMatch[1]);
      const index = columnIndex(attributes.r) ?? fallbackColumn;
      fallbackColumn = index + 1;
      values[index] = cellValue(attributes, cellMatch[2] || '', sharedStrings);
    }
    rows.push({ sourceRow, values });
  }
  return rows;
}

function optionalText(value) {
  return value == null ? '' : String(value).trim();
}

function optionalNumber(value, context) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${context} must be numeric`);
  return Object.is(number, -0) ? 0 : number;
}

function requiredNumber(value, context) {
  const number = optionalNumber(value, context);
  if (number == null) throw new Error(`${context} is required`);
  return number;
}

function roundNumber(value, decimals = 12) {
  if (!Number.isFinite(value)) return value;
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeDate(value, context) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.round((value - 25569) * 86400000);
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const source = optionalText(value);
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(source);
  if (match) {
    const normalized = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized) {
      return normalized;
    }
  }
  throw new Error(`${context} must be a valid date`);
}

function parseLegacyList(value, context, mapper) {
  if (value == null || String(value).trim() === '') return [];
  if (typeof value === 'number') return [mapper(value, context)];
  const source = String(value).trim();
  let values;
  try {
    const parsed = JSON.parse(source);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const content = source.startsWith('[') && source.endsWith(']')
      ? source.slice(1, -1)
      : source;
    values = content.split(',').map(item => item.trim()).filter(Boolean).map(item => {
      if ((item.startsWith("'") && item.endsWith("'")) ||
          (item.startsWith('"') && item.endsWith('"'))) return item.slice(1, -1);
      return item;
    });
  }
  return values.map((item, index) => mapper(item, `${context}[${index}]`));
}

function legacyTaxEnvelope(netCash) {
  return {
    tax_status: 'UNKNOWN_LEGACY',
    gross_amount: null,
    tax_amount: null,
    withholding_tax: null,
    fee_amount: null,
    net_cash: netCash,
  };
}

function tradePayload(eventType, values, context) {
  const quantity = requiredNumber(values[4], `${context} quantity`);
  if (!(quantity > 0)) throw new Error(`${context} quantity must be greater than zero`);
  const amount = requiredNumber(values[5], `${context} Amount`);
  const derivedPerShare = roundNumber(amount / quantity);
  const suppliedPrice = eventType === 'DIVIDEND'
    ? null
    : optionalNumber(values[6], `${context} price`);
  const notesIndex = eventType === 'DIVIDEND' ? 7 : 8;
  return {
    legacy_no: requiredNumber(values[0], `${context} No`),
    date: normalizeDate(values[1], `${context} date`),
    ticker: optionalText(values[2]).toUpperCase(),
    name: optionalText(values[3]),
    quantity,
    amount,
    price: suppliedPrice ?? derivedPerShare,
    per_share: derivedPerShare,
    notes: optionalText(values[notesIndex]),
    ...legacyTaxEnvelope(eventType === 'BUY' ? -amount : amount),
  };
}

function corporateActionPayload(values, context) {
  const tickers = parseLegacyList(values[6], `${context} post ticker`, (item, itemContext) => {
    const ticker = optionalText(item).toUpperCase();
    if (!ticker) throw new Error(`${itemContext} is required`);
    return ticker;
  });
  const quantities = parseLegacyList(values[7], `${context} post quantity`, requiredNumber);
  if (tickers.length !== quantities.length) {
    throw new Error(`${context} post ticker and quantity counts must match`);
  }
  const cash = optionalNumber(values[8], `${context} cash`) ?? 0;
  return {
    legacy_no: requiredNumber(values[0], `${context} No`),
    date: normalizeDate(values[1], `${context} date`),
    ticker: optionalText(values[2]).toUpperCase(),
    name: optionalText(values[3]),
    action_type: optionalText(values[4]).toUpperCase(),
    pre_quantity: optionalNumber(values[5], `${context} quantity`),
    outputs: tickers.map((ticker, index) => ({ ticker, quantity: quantities[index] })),
    cash_amount: cash,
    notes: optionalText(values[9]),
    ...legacyTaxEnvelope(cash),
  };
}

function liabilityPayload(values, context) {
  const interest = optionalNumber(values[2], `${context} interest`) ?? 0;
  const change = optionalNumber(values[3], `${context} change`) ?? 0;
  return {
    legacy_no: requiredNumber(values[0], `${context} No`),
    date: normalizeDate(values[1], `${context} date`),
    interest,
    change,
    notes: optionalText(values[4]),
    ...legacyTaxEnvelope(roundNumber(change - interest)),
  };
}

function capitalPayload(values, context) {
  const subscription = optionalNumber(values[3], `${context} subscription`) ?? 0;
  const redemption = optionalNumber(values[4], `${context} redemption`) ?? 0;
  const unitPrice = optionalNumber(values[5], `${context} unit price`) ?? 0;
  const netCash = roundNumber(subscription - redemption);
  if (netCash !== 0 && !(unitPrice > 0)) {
    throw new Error(`${context} unit price must be greater than zero for a capital change`);
  }
  return {
    legacy_no: requiredNumber(values[0], `${context} No`),
    date: normalizeDate(values[1], `${context} date`),
    shareholder: optionalText(values[2]),
    subscription,
    redemption,
    unit_price: unitPrice,
    units_delta: unitPrice > 0 ? roundNumber(netCash / unitPrice, 6) : 0,
    notes: optionalText(values[7]),
    ...legacyTaxEnvelope(netCash),
  };
}

function fundActionPayload(values, context) {
  const cash = optionalNumber(values[5], `${context} cash`) ?? 0;
  return {
    legacy_no: requiredNumber(values[0], `${context} No`),
    date: normalizeDate(values[1], `${context} date`),
    action_type: optionalText(values[2]).toUpperCase(),
    pre_units: optionalNumber(values[3], `${context} quantity`),
    post_units: optionalNumber(values[4], `${context} post quantity`),
    cash_amount: cash,
    notes: optionalText(values[6]),
    ...legacyTaxEnvelope(cash),
  };
}

function canonicalPayload(definition, values, context) {
  if (['BUY', 'SELL', 'DIVIDEND'].includes(definition.eventType)) {
    return tradePayload(definition.eventType, values, context);
  }
  if (definition.eventType === 'CORPORATE_ACTION') {
    return corporateActionPayload(values, context);
  }
  if (definition.eventType === 'LIABILITY') return liabilityPayload(values, context);
  if (definition.eventType === 'CAPITAL') return capitalPayload(values, context);
  if (definition.eventType === 'FUND_ACTION') return fundActionPayload(values, context);
  throw new Error(`unsupported event sheet: ${definition.name}`);
}

function canonicalEvent(portfolio, currency, workbookSha, definition, row) {
  const context = `${definition.name}!${row.sourceRow}`;
  const values = Array.from({ length: definition.columns }, (_, index) => row.values[index] ?? null);
  const payload = canonicalPayload(definition, values, context);
  const digest = sha256(`${definition.name}|${row.sourceRow}|${stableStringify(payload)}`).slice(0, 24);
  return {
    event_id: `legacy_${portfolio}_${digest}`,
    portfolio_id: portfolio,
    event_type: definition.eventType,
    trade_date: payload.date,
    sequence_no: payload.legacy_no,
    currency,
    status: 'CONFIRMED',
    payload,
    tax_status: payload.tax_status,
    gross_amount: null,
    tax_amount: null,
    fee_amount: null,
    net_cash: payload.net_cash,
    source: 'MIGRATION',
    source_ref: `${definition.name}!${row.sourceRow}`,
    source_workbook_sha256: workbookSha,
    sheet: definition.name,
    source_row: row.sourceRow,
  };
}

function duplicateRowKey(definition, row) {
  const businessCells = Array.from(
    { length: Math.max(0, definition.columns - 1) },
    (_, index) => row.values[index + 1] ?? null,
  );
  return stableStringify(businessCells);
}

function eventSort(left, right) {
  return left.trade_date.localeCompare(right.trade_date) ||
    (EVENT_PRIORITY[left.event_type] ?? 99) - (EVENT_PRIORITY[right.event_type] ?? 99) ||
    left.sequence_no - right.sequence_no ||
    (SHEET_ORDER.get(left.sheet) ?? 99) - (SHEET_ORDER.get(right.sheet) ?? 99) ||
    left.source_row - right.source_row ||
    left.event_id.localeCompare(right.event_id);
}

function historicalNavSeed(inputPath, sheets, sharedStrings, currency) {
  const entry = sheets.get('NAV Statement');
  if (!entry) return { rows: [], warnings: [] };
  const rows = worksheetRows(readZipEntry(inputPath, entry), sharedStrings);
  const header = rows.find(row => row.sourceRow === 1) || rows[0];
  if (!header || optionalText(header.values[0]) !== 'Date') return { rows: [], warnings: [] };
  const output = [];
  const warnings = [];
  for (const row of rows) {
    if (row === header || row.values[0] == null || optionalText(row.values[0]) === '') continue;
    const context = `NAV Statement!${row.sourceRow}`;
    const date = normalizeDate(row.values[0], `${context} date`);
    const totalAssets = requiredNumber(row.values[1], `${context} total assets`);
    const liability = requiredNumber(row.values[2], `${context} liability`);
    const ratio = optionalNumber(row.values[3], `${context} liability ratio`) ??
      (totalAssets ? liability / totalAssets : 0);
    const netValue = requiredNumber(row.values[4], `${context} net value`);
    const units = requiredNumber(row.values[5], `${context} units`);
    const unitNav = requiredNumber(row.values[6], `${context} unit nav`);
    const fundActionAdjustment = optionalNumber(row.values[7], `${context} fund action adjustment`) ?? 0;
    const cash = requiredNumber(row.values[8], `${context} cash`);
    const marketValue = requiredNumber(row.values[9], `${context} market value`);
    const totalAssetsGap = Math.abs(totalAssets - (cash + marketValue));
    const netValueGap = Math.abs(netValue - (totalAssets - liability));
    const unitNavGap = units > 0 ? Math.abs(unitNav - netValue / units) : 0;
    if (totalAssetsGap > 0.02 || netValueGap > 0.02 || unitNavGap > 0.000002) {
      warnings.push({
        code: 'NAV_SEED_INVARIANT_MISMATCH', severity: 'warning',
        message: `read-only NAV seed invariant mismatch at ${context}`,
        sheet: 'NAV Statement', source_row: row.sourceRow, date,
        total_assets_gap: totalAssetsGap, net_value_gap: netValueGap, unit_nav_gap: unitNavGap,
      });
    }
    output.push({
      date,
      currency,
      total_assets: roundNumber(totalAssets),
      liability: roundNumber(liability),
      liability_asset_ratio: roundNumber(ratio),
      net_value: roundNumber(netValue),
      units: roundNumber(units),
      unit_nav: roundNumber(unitNav),
      fund_action_adjustment: roundNumber(fundActionAdjustment),
      cash: roundNumber(cash),
      market_value: roundNumber(marketValue),
      source: 'LEGACY_READ_ONLY_PROJECTION',
      source_sheet: 'NAV Statement',
      source_row: row.sourceRow,
    });
  }
  output.sort((left, right) => left.date.localeCompare(right.date));
  return { rows: output, warnings };
}

function historicalPriceSeed(inputPath, sheets, sharedStrings, currency, workbookSha) {
  const sheetName = 'Asset Position Record';
  const entry = sheets.get(sheetName);
  if (!entry) return { rows: [], warnings: [] };
  const rows = worksheetRows(readZipEntry(inputPath, entry), sharedStrings);
  const asOfRow = rows.find(row => optionalText(row.values[0]).toLowerCase() === 'as of date:');
  const header = rows.find(row =>
    optionalText(row.values[0]) === 'No.' && optionalText(row.values[1]) === 'Ticker');
  const warnings = [];
  if (!asOfRow || !header) {
    warnings.push({
      code: 'ASSET_PRICE_SEED_LAYOUT_INVALID',
      severity: 'warning',
      message: 'read-only Asset Position price seed layout is missing As of Date or headers',
      sheet: sheetName,
    });
    return { rows: [], warnings };
  }

  let date;
  try {
    date = normalizeDate(asOfRow.values[1], `${sheetName}!${asOfRow.sourceRow} As of Date`);
  } catch (error) {
    warnings.push({
      code: 'ASSET_PRICE_SEED_DATE_INVALID',
      severity: 'warning',
      message: error.message,
      sheet: sheetName,
      source_row: asOfRow.sourceRow,
    });
    return { rows: [], warnings };
  }

  const output = [];
  for (const row of rows) {
    if (row.sourceRow <= header.sourceRow ||
        typeof row.values[0] !== 'number' || !Number.isFinite(row.values[0])) continue;
    const context = `${sheetName}!${row.sourceRow}`;
    let quantity;
    let latestPrice;
    try {
      quantity = optionalNumber(row.values[3], `${context} quantity`);
      latestPrice = optionalNumber(row.values[4], `${context} latest price`);
    } catch (error) {
      warnings.push({
        code: 'ASSET_PRICE_SEED_ROW_INVALID', severity: 'warning', message: error.message,
        sheet: sheetName, source_row: row.sourceRow, date,
      });
      continue;
    }
    if (!(quantity > 0) || !(latestPrice > 0)) continue;

    const ticker = optionalText(row.values[1]).toUpperCase();
    if (!ticker) {
      warnings.push({
        code: 'ASSET_PRICE_SEED_ROW_INVALID', severity: 'warning',
        message: `${context} ticker is required for an active position`,
        sheet: sheetName, source_row: row.sourceRow, date,
      });
      continue;
    }
    let marketValue;
    try {
      marketValue = requiredNumber(row.values[5], `${context} market value`);
    } catch (error) {
      warnings.push({
        code: 'ASSET_PRICE_SEED_ROW_INVALID', severity: 'warning', message: error.message,
        sheet: sheetName, source_row: row.sourceRow, date, ticker,
      });
      continue;
    }

    const expectedMarketValue = quantity * latestPrice;
    const marketValueGap = Math.abs(expectedMarketValue - marketValue);
    const tolerance = Math.max(0.02, Math.abs(marketValue) * 1e-8);
    if (marketValueGap > tolerance) {
      warnings.push({
        code: 'ASSET_PRICE_SEED_MARKET_VALUE_MISMATCH',
        severity: 'warning',
        message: `quantity * latest price does not match market value at ${context}`,
        sheet: sheetName,
        source_row: row.sourceRow,
        date,
        ticker,
        expected_market_value: roundNumber(expectedMarketValue),
        market_value: roundNumber(marketValue),
        market_value_gap: roundNumber(marketValueGap),
        tolerance,
      });
    }
    output.push({
      date,
      currency,
      ticker,
      name: optionalText(row.values[2]),
      quantity: roundNumber(quantity),
      latest_price: roundNumber(latestPrice),
      market_value: roundNumber(marketValue),
      source: 'LEGACY_READ_ONLY_PROJECTION',
      source_sheet: sheetName,
      source_row: row.sourceRow,
      source_workbook_sha256: workbookSha,
    });
  }
  output.sort((left, right) =>
    left.date.localeCompare(right.date) || left.ticker.localeCompare(right.ticker) ||
    left.source_row - right.source_row);
  return { rows: output, warnings };
}

function migrationBlockingErrors() {
  // Corporate actions are old-position -> absolute new-position quantity
  // transformations. Cash-record Amounts remain the only cost/proceeds truth;
  // a multi-output action never allocates or creates cost basis, so there is no
  // operator-supplied allocation field to block during migration.
  return [];
}

export async function migrateLegacyWorkbook({ portfolio, input }) {
  const portfolioId = String(portfolio || '').trim().toLowerCase();
  const portfolioDefinition = PORTFOLIOS[portfolioId];
  if (!portfolioDefinition) throw new Error('portfolio must be one of: us, hk, a');
  if (!input) throw new Error('input workbook path is required');

  const inputPath = path.resolve(String(input));
  const workbookBytes = await readFile(inputPath);
  const workbookSha = sha256(workbookBytes);
  const entries = new Set(listZipEntries(inputPath));
  const sheets = workbookSheetEntries(inputPath, entries);
  const missingSheets = EVENT_SHEETS.filter(definition => !sheets.has(definition.name));
  if (missingSheets.length) {
    throw new Error(`missing required event sheet(s): ${missingSheets.map(item => item.name).join(', ')}`);
  }
  const sharedStrings = parseSharedStrings(inputPath, entries);

  const events = [];
  const warnings = [];
  for (const definition of EVENT_SHEETS) {
    const entry = sheets.get(definition.name);
    if (!entries.has(entry)) throw new Error(`worksheet entry is missing: ${entry}`);
    const rows = worksheetRows(readZipEntry(inputPath, entry), sharedStrings)
      .filter(row => typeof row.values[0] === 'number' && Number.isFinite(row.values[0]));
    const firstDuplicate = new Map();
    for (const row of rows) {
      const event = canonicalEvent(
        portfolioId,
        portfolioDefinition.currency,
        workbookSha,
        definition,
        row,
      );
      events.push(event);
      const duplicateKey = duplicateRowKey(definition, row);
      const prior = firstDuplicate.get(duplicateKey);
      if (prior) {
        warnings.push({
          code: 'DUPLICATE_LEGACY_ROW',
          severity: 'warning',
          message: `duplicate business row preserved at ${definition.name}!${row.sourceRow}`,
          sheet: definition.name,
          source_rows: [prior.source_row, row.sourceRow],
          event_ids: [prior.event_id, event.event_id],
        });
      } else {
        firstDuplicate.set(duplicateKey, event);
      }
    }
  }

  events.sort(eventSort);
  const navSeed = historicalNavSeed(inputPath, sheets, sharedStrings, portfolioDefinition.currency);
  navSeed.rows.forEach(row => { row.source_workbook_sha256 = workbookSha; });
  warnings.push(...navSeed.warnings);
  const priceSeed = historicalPriceSeed(
    inputPath,
    sheets,
    sharedStrings,
    portfolioDefinition.currency,
    workbookSha,
  );
  warnings.push(...priceSeed.warnings);
  const blockingErrors = migrationBlockingErrors(events);
  const derivedParityOracleSheets = [];
  if (priceSeed.rows.length) derivedParityOracleSheets.push('Asset Position Record');
  if (navSeed.rows.length) derivedParityOracleSheets.push('NAV Statement');
  return {
    schema_version: MIGRATION_SCHEMA_VERSION,
    portfolio_id: portfolioId,
    currency: portfolioDefinition.currency,
    source_workbook_sha256: workbookSha,
    event_sheets: EVENT_SHEETS.map(item => item.name),
    ignored_derived_sheets: [...DERIVED_SHEETS],
    read_only_projection_seed_sheets: [],
    derived_parity_oracle_sheets: derivedParityOracleSheets,
    derived_parity_oracle: {
      historical_price_row_count: priceSeed.rows.length,
      historical_price_sha256: sha256(stableStringify(priceSeed.rows)),
      historical_nav_row_count: navSeed.rows.length,
      historical_nav_sha256: sha256(stableStringify(navSeed.rows)),
    },
    event_count: events.length,
    historical_price_row_count: 0,
    historical_nav_row_count: 0,
    ready_for_confirm: blockingErrors.length === 0,
    blocking_error_count: blockingErrors.length,
    warning_count: warnings.length,
    events,
    historical_price_rows: [],
    historical_nav_rows: [],
    blocking_errors: blockingErrors,
    warnings,
  };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/migrate-legacy-ledgers.mjs --portfolio us|hk|a --input workbook.xlsx --output ledger.json',
    '  node scripts/migrate-legacy-ledgers.mjs --portfolio us|hk|a --input workbook.xlsx --dry-run',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const equal = /^(--portfolio|--input|--output)=(.*)$/.exec(argument);
    if (equal) {
      options[equal[1].slice(2)] = equal[2];
      continue;
    }
    if (['--portfolio', '--input', '--output'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.portfolio) throw new Error('--portfolio is required');
  if (!options.input) throw new Error('--input is required');
  if (!options.dryRun && !options.output) throw new Error('--output is required unless --dry-run is used');

  const migration = await migrateLegacyWorkbook({
    portfolio: options.portfolio,
    input: options.input,
  });
  const serialized = `${JSON.stringify(migration, null, 2)}\n`;
  if (options.dryRun) {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, 'utf8');
  process.stderr.write(
    `Migrated ${migration.event_count} events with ${migration.warning_count} warning(s) to ${outputPath}\n`,
  );
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    process.stderr.write(`Migration failed: ${error.message}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
