/*
 * YiCapital deterministic portfolio ledger.
 *
 * Pure calculation boundary:
 *   - no DOM, database, network, clock or random-number access;
 *   - money enters as major-unit decimal values or integer minor units;
 *   - all cash arithmetic is performed with safe integer minor units;
 *   - replay never mutates its input.
 */

export const LEDGER_SCHEMA_VERSION = 'portfolio-ledger-v1';
export const LEDGER_EVENT_SCHEMA_VERSION = 'portfolio-ledger-event-v1';

export const LEDGER_EVENT_TYPES = Object.freeze([
  'buy',
  'sell',
  'dividend',
  'corporate_action',
  'capital',
  'liability',
  'fund_action',
  'reversal',
]);

export const CORPORATE_ACTION_TYPES = Object.freeze([
  'SPLIT',
  'SPINOFF',
  'RENAME',
  'MERGER',
]);

export const EVENT_PRIORITY = Object.freeze({
  capital: 0,
  liability: 1,
  corporate_action: 2,
  buy: 3,
  sell: 3,
  dividend: 4,
  fund_action: 5,
  reversal: 6,
});

const EVENT_TYPE_SET = new Set(LEDGER_EVENT_TYPES);
const CORPORATE_ACTION_TYPE_SET = new Set(CORPORATE_ACTION_TYPES);
const STATUS_SET = new Set(['confirmed', 'pending', 'void']);
const TYPE_TIE_BREAK = Object.freeze({ buy: 0, sell: 1 });
const DEFAULT_DECIMALS = 2;
const QUANTITY_DECIMALS = 12;
const PER_SHARE_DECIMALS = 8;

const SOURCE_SHEETS = Object.freeze({
  capital: 'Capital Record',
  liability: 'Liability Record',
  corporate_action: 'Corporate Action Record',
  buy: 'ETF Stock Buy Record',
  sell: 'ETF Stock Sell Record',
  dividend: 'ETF Stock Dividend Record',
  fund_action: 'Fund Action Record',
  reversal: 'Reversal Record',
});

export class LedgerValidationError extends Error {
  constructor(issues, message = 'Portfolio ledger validation failed') {
    super(message);
    this.name = 'LedgerValidationError';
    this.code = 'LEDGER_VALIDATION_FAILED';
    this.issues = issues;
  }
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function firstPresent(object, keys) {
  for (const key of keys) {
    if (own(object, key) && object[key] !== '' && object[key] != null) {
      return object[key];
    }
  }
  return undefined;
}

function roundNumber(value, decimals = QUANTITY_DECIMALS) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** decimals;
  return Math.round((value + Math.sign(value || 1) * Number.EPSILON) * scale) / scale;
}

function issue(code, field, message, severity = 'error', details = {}) {
  return { code, field, message, severity, ...details };
}

function normalizeDecimals(value) {
  const decimals = value == null ? DEFAULT_DECIMALS : Number(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new LedgerValidationError([
      issue('INVALID_CURRENCY_DECIMALS', 'currency_decimals',
        'currency_decimals must be an integer between 0 and 6'),
    ]);
  }
  return decimals;
}

function decimalStringToMinor(value, decimals) {
  const source = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(source);
  if (!match) return { error: 'must be a plain decimal value' };
  const fraction = match[3] || '';
  if (fraction.length > decimals) {
    return { error: `supports at most ${decimals} decimal places` };
  }
  const scale = 10 ** decimals;
  const whole = Number(match[2]);
  const fractionMinor = Number(fraction.padEnd(decimals, '0') || '0');
  if (!Number.isSafeInteger(whole) || whole > Math.floor(Number.MAX_SAFE_INTEGER / scale)) {
    return { error: 'is outside the safe money range' };
  }
  const sign = match[1] === '-' ? -1 : 1;
  const minor = sign * (whole * scale + fractionMinor);
  if (!Number.isSafeInteger(minor)) return { error: 'is outside the safe money range' };
  return { minor };
}

function majorToMinor(value, decimals) {
  if (typeof value === 'string') return decimalStringToMinor(value, decimals);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: 'must be a finite major-unit number or decimal string' };
  }
  const scale = 10 ** decimals;
  const minor = Math.round((value + Math.sign(value || 1) * Number.EPSILON) * scale);
  if (!Number.isSafeInteger(minor)) return { error: 'is outside the safe money range' };
  return { minor };
}

function parseMinorInput(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      String(value).trim() === '' || !/^[+-]?\d+$/.test(String(value).trim())) {
    return { error: 'must be a safe integer minor-unit value' };
  }
  const minor = Number(value);
  if (!Number.isSafeInteger(minor)) return { error: 'must be a safe integer minor-unit value' };
  return { minor };
}

function formatMinor(minor, decimals) {
  const scale = 10 ** decimals;
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / scale);
  if (!decimals) return `${sign}${whole}`;
  return `${sign}${whole}.${String(absolute % scale).padStart(decimals, '0')}`;
}

function moneyObject(minor, decimals) {
  return {
    amount: minor / (10 ** decimals),
    decimal: formatMinor(minor, decimals),
    minor,
  };
}

function assignMoney(target, field, minor, decimals) {
  target[field] = minor / (10 ** decimals);
  target[`${field}_decimal`] = formatMinor(minor, decimals);
  target[`${field}_minor`] = minor;
}

function assignNullableMoney(target, field, minor, decimals) {
  if (minor == null) {
    target[field] = null;
    target[`${field}_decimal`] = null;
    target[`${field}_minor`] = null;
    return;
  }
  assignMoney(target, field, minor, decimals);
}

function moneyProvided(raw, field, aliases = []) {
  return firstPresent(raw, [
    `${field}_minor`, `${field}_decimal`, field,
    ...aliases.flatMap(alias => [`${alias}_minor`, `${alias}_decimal`, alias]),
  ]) !== undefined;
}

function readTaxes(raw, decimals, issues, genericAsWithholding = false) {
  const withholdingSupplied = firstPresent(raw, [
    'withholding_tax_minor', 'withholding_tax_decimal', 'withholding_tax', 'withholding',
  ]) !== undefined;
  const transactionSupplied = firstPresent(raw, [
    'transaction_tax_minor', 'transaction_tax_decimal', 'transaction_tax',
    'stamp_duty_minor', 'stamp_duty_decimal', 'stamp_duty',
  ]) !== undefined;
  const genericSupplied = firstPresent(raw, [
    'tax_amount_minor', 'tax_amount_decimal', 'tax_amount', 'tax_minor', 'tax_decimal', 'tax',
  ]) !== undefined;
  let withholdingMinor = readMoney(raw, 'withholding_tax', ['withholding'], decimals, issues, {
    nonNegative: true,
  });
  let transactionTaxMinor = readMoney(raw, 'transaction_tax', ['stamp_duty'], decimals, issues, {
    nonNegative: true,
  });
  if (genericSupplied) {
    const genericMinor = readMoney(raw, 'tax_amount', ['tax'], decimals, issues, {
      nonNegative: true,
    });
    if (!withholdingSupplied && !transactionSupplied) {
      if (genericAsWithholding) withholdingMinor = genericMinor;
      else transactionTaxMinor = genericMinor;
    } else if (genericMinor !== withholdingMinor + transactionTaxMinor) {
      issues.push(issue('TAX_AMOUNT_MISMATCH', 'tax_amount',
        'tax_amount must equal withholding_tax plus transaction_tax'));
    }
  }
  return { withholdingMinor, transactionTaxMinor };
}

function assignTaxReviewMetadata(raw, event) {
  event.tax_status = String(raw.tax_status || '').trim().toUpperCase() || null;
  event.tax_review_required = raw.tax_review_required === true ||
    String(raw.tax_review_required || '').toLowerCase() === 'true';
  event.tax_review_reason = String(raw.tax_review_reason || raw.tax_status_reason || '').trim() || null;
  return event.tax_status === 'UNKNOWN_LEGACY' ||
    event.tax_status === 'PENDING_RECONFIRMATION';
}

function readMoney(raw, field, aliases, decimals, issues, options = {}) {
  const minorKey = `${field}_minor`;
  const decimalKey = `${field}_decimal`;
  const minorValue = firstPresent(raw, [minorKey, ...aliases.map(alias => `${alias}_minor`)]);
  const majorValue = firstPresent(raw, [
    decimalKey,
    field,
    ...aliases.flatMap(alias => [`${alias}_decimal`, alias]),
  ]);
  if (minorValue === undefined && majorValue === undefined) {
    if (options.required) {
      issues.push(issue('MONEY_REQUIRED', field, `${field} is required`));
    }
    return options.defaultMinor ?? 0;
  }

  let parsedMinor;
  if (minorValue !== undefined) {
    const parsed = parseMinorInput(minorValue);
    if (parsed.error) {
      issues.push(issue('INVALID_MINOR_AMOUNT', minorKey, `${minorKey} ${parsed.error}`));
    } else {
      parsedMinor = parsed.minor;
    }
  }

  if (majorValue !== undefined) {
    const parsed = majorToMinor(majorValue, decimals);
    if (parsed.error) {
      issues.push(issue('INVALID_MONEY', field, `${field} ${parsed.error}`));
    } else if (parsedMinor !== undefined && parsed.minor !== parsedMinor) {
      issues.push(issue('MONEY_REPRESENTATION_MISMATCH', field,
        `${field} and ${minorKey} do not represent the same amount`));
    } else {
      parsedMinor = parsed.minor;
    }
  }

  const result = parsedMinor ?? (options.defaultMinor ?? 0);
  if (options.nonNegative && result < 0) {
    issues.push(issue('NEGATIVE_AMOUNT', field, `${field} cannot be negative`));
  }
  return result;
}

function readFiniteNumber(raw, field, aliases, issues, options = {}) {
  const value = firstPresent(raw, [field, ...aliases]);
  if (value === undefined) {
    if (options.required) issues.push(issue('NUMBER_REQUIRED', field, `${field} is required`));
    return options.defaultValue ?? null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    issues.push(issue('INVALID_NUMBER', field, `${field} must be finite`));
    return options.defaultValue ?? null;
  }
  if (options.positive && !(number > 0)) {
    issues.push(issue('NON_POSITIVE_NUMBER', field, `${field} must be greater than zero`));
  }
  if (options.nonNegative && number < 0) {
    issues.push(issue('NEGATIVE_NUMBER', field, `${field} cannot be negative`));
  }
  return options.preservePrecision ? number : roundNumber(number);
}

function normalizeDate(value, issues, field = 'date') {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const source = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    const date = new Date(`${source}T00:00:00.000Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === source) return source;
  } else if (source) {
    const date = new Date(source);
    if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
  }
  issues.push(issue('INVALID_DATE', field, `${field} must be a valid date`));
  return source;
}

function canonicalType(value) {
  const source = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    div: 'dividend',
    corp: 'corporate_action',
    corporate: 'corporate_action',
    capital_record: 'capital',
    liability_record: 'liability',
    fund: 'fund_action',
    fund_split: 'fund_action',
    reverse: 'reversal',
  };
  return aliases[source] || source;
}

function parseList(value) {
  if (Array.isArray(value)) return value.slice();
  if (value == null || String(value).trim() === '') return [];
  const source = String(value).trim();
  if (source.startsWith('[') || source.includes(',')) {
    return source.replace(/^\[/, '').replace(/\]$/, '').split(',')
      .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return [source.replace(/^['"]|['"]$/g, '')];
}

function normalizeTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeAllocation(rawAllocation, tickers, outputAllocations, issues) {
  let weights = [];
  if (Array.isArray(rawAllocation)) {
    weights = rawAllocation.map(Number);
  } else if (rawAllocation && typeof rawAllocation === 'object') {
    weights = tickers.map(ticker => Number(rawAllocation[ticker] ?? rawAllocation[ticker.toLowerCase()]));
  } else if (rawAllocation != null && rawAllocation !== '') {
    weights = parseList(rawAllocation).map(Number);
  } else if (outputAllocations.some(value => value != null && value !== '')) {
    weights = outputAllocations.map(Number);
  }

  if (!weights.length) {
    if (tickers.length === 1) return [1];
    // The Python manager derives multi-output allocation from the first
    // available post-action closes. Null keeps that calculation outside the
    // input fact instead of asking the operator for an accounting allocation.
    return tickers.map(() => null);
  }
  if (weights.length !== tickers.length || weights.some(value => !Number.isFinite(value) || value < 0)) {
    issues.push(issue('INVALID_ALLOCATION', 'allocation',
      'allocation must contain one non-negative weight per post ticker'));
    return tickers.map((_, index) => index === 0 ? 1 : 0);
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    issues.push(issue('INVALID_ALLOCATION', 'allocation', 'allocation weights must total more than zero'));
    return tickers.map((_, index) => index === 0 ? 1 : 0);
  }
  const normalized = weights.map(value => roundNumber(value / total));
  if (Math.abs(total - 1) > 1e-9 && Math.abs(total - 100) > 1e-9) {
    issues.push(issue('ALLOCATION_NORMALIZED', 'allocation',
      'allocation weights were normalized to one', 'warning', { supplied_total: total }));
  }
  return normalized;
}

function normalizeCorporateOutputs(raw, actionType, ticker, splitRatio, issues) {
  let outputs = [];
  if (Array.isArray(raw.outputs)) {
    outputs = raw.outputs.map(output => ({
      ticker: normalizeTicker(output?.ticker ?? output?.post_ticker),
      quantity: output?.quantity ?? output?.post_quantity,
      allocation: output?.allocation,
      name: String(output?.name || '').trim(),
    }));
  } else {
    const tickers = parseList(firstPresent(raw, ['post_tickers', 'post_ticker', 'PostTicker']))
      .map(normalizeTicker);
    const quantities = parseList(firstPresent(raw, ['post_quantities', 'post_quantity', 'PostQty']));
    outputs = tickers.map((postTicker, index) => ({
      ticker: postTicker,
      quantity: quantities[index],
      allocation: null,
      name: '',
    }));
    if (quantities.length && quantities.length !== tickers.length) {
      issues.push(issue('CORPORATE_OUTPUT_LENGTH_MISMATCH', 'post_quantities',
        'post tickers and post quantities must have equal lengths'));
    }
  }

  if (!outputs.length && actionType === 'SPLIT' && splitRatio > 0) {
    outputs = [{ ticker, quantity: null, allocation: 1, name: '' }];
  }
  if (!outputs.length && actionType === 'RENAME') {
    const target = normalizeTicker(firstPresent(raw, ['new_ticker', 'target_ticker']));
    if (target) outputs = [{ ticker: target, quantity: null, allocation: 1, name: '' }];
  }
  if (!outputs.length) {
    issues.push(issue('CORPORATE_OUTPUT_REQUIRED', 'outputs',
      'corporate action requires at least one post-action ticker'));
    return [];
  }

  const tickers = outputs.map(output => output.ticker);
  if (tickers.some(value => !value)) {
    issues.push(issue('TICKER_REQUIRED', 'outputs.ticker', 'every corporate output needs a ticker'));
  }
  const outputAllocations = outputs.map(output => output.allocation);
  const allocation = normalizeAllocation(raw.allocation, tickers, outputAllocations, issues);
  return outputs.map((output, index) => {
    let quantity = null;
    if (output.quantity != null && output.quantity !== '') {
      quantity = Number(output.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        issues.push(issue('INVALID_POST_QUANTITY', `outputs.${index}.quantity`,
          'post quantity must be a non-negative finite number'));
        quantity = 0;
      }
    }
    return {
      ticker: output.ticker,
      name: output.name,
      quantity: quantity == null ? null : roundNumber(quantity),
      allocation: allocation[index],
    };
  });
}

function normalizeCommon(raw, index, issues) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(issue('EVENT_NOT_OBJECT', '', 'event must be an object'));
    return {
      schema_version: LEDGER_EVENT_SCHEMA_VERSION,
      event_id: null,
      type: '',
      date: '',
      sequence: index,
      status: 'confirmed',
      notes: '',
    };
  }
  const type = canonicalType(firstPresent(raw, ['event_type', 'kind', 'record_type', 'type']));
  if (!EVENT_TYPE_SET.has(type)) {
    issues.push(issue('UNSUPPORTED_EVENT_TYPE', 'type',
      `type must be one of: ${LEDGER_EVENT_TYPES.join(', ')}`));
  }
  const status = String(raw.status || 'confirmed').trim().toLowerCase();
  if (!STATUS_SET.has(status)) {
    issues.push(issue('INVALID_STATUS', 'status', 'status must be confirmed, pending or void'));
  }
  const eventIdValue = firstPresent(raw, ['event_id', 'id']);
  const eventId = eventIdValue == null ? null : String(eventIdValue).trim();
  if (eventIdValue != null && !eventId) {
    issues.push(issue('INVALID_EVENT_ID', 'event_id', 'event_id cannot be blank'));
  }
  const sequenceValue = firstPresent(raw, ['sequence', 'sequence_no', 'trade_no', 'no', 'No']);
  let sequence = sequenceValue == null ? index : Number(sequenceValue);
  if (!Number.isFinite(sequence)) {
    issues.push(issue('INVALID_SEQUENCE', 'sequence', 'sequence must be finite'));
    sequence = index;
  }
  return {
    schema_version: LEDGER_EVENT_SCHEMA_VERSION,
    event_id: eventId,
    type,
    date: normalizeDate(firstPresent(raw,
      ['date', 'trade_date', 'execution_date', 'effective_date', 'Date']), issues),
    sequence: roundNumber(sequence),
    status: STATUS_SET.has(status) ? status : 'confirmed',
    notes: String(firstPresent(raw, ['notes', 'note', 'Notes']) || '').trim(),
    source: String(raw.source || '').trim() || null,
  };
}

function normalizeTrade(raw, event, decimals, issues) {
  event.ticker = normalizeTicker(firstPresent(raw, ['ticker', 'symbol', 'Ticker']));
  if (!event.ticker) issues.push(issue('TICKER_REQUIRED', 'ticker', 'ticker is required'));
  event.name = String(firstPresent(raw, ['name', 'asset_name', 'Name']) || event.ticker).trim();
  event.quantity = readFiniteNumber(raw, 'quantity', ['qty', 'shares', 'Qty'], issues, {
    required: true,
    positive: true,
    defaultValue: 0,
  });

  assignTaxReviewMetadata(raw, event);
  const unknownLegacy = event.tax_status === 'UNKNOWN_LEGACY';
  const incompleteTaxFacts = unknownLegacy || event.tax_status === 'PENDING_RECONFIRMATION';
  const withholdingProvided = moneyProvided(raw, 'withholding_tax', ['withholding']);
  const transactionTaxProvided = moneyProvided(raw, 'transaction_tax', ['stamp_duty']);
  const genericTaxProvided = moneyProvided(raw, 'tax_amount', ['tax']);
  const anyTaxProvided = withholdingProvided || transactionTaxProvided || genericTaxProvided;
  const feesProvided = moneyProvided(raw, 'fees', ['fee', 'commission', 'fee_amount']);

  let withholdingMinor = null;
  let transactionTaxMinor = null;
  if (!incompleteTaxFacts || anyTaxProvided) {
    const taxes = readTaxes(raw, decimals, issues, event.type === 'dividend');
    withholdingMinor = taxes.withholdingMinor;
    transactionTaxMinor = taxes.transactionTaxMinor;
  }
  const feesMinor = !incompleteTaxFacts || feesProvided
    ? readMoney(raw, 'fees', ['fee', 'commission', 'fee_amount'], decimals, issues, {
      nonNegative: true,
    })
    : null;

  const grossProvided = moneyProvided(raw, 'gross_amount');
  let grossMinor = grossProvided
    ? readMoney(raw, 'gross_amount', [], decimals, issues, { nonNegative: true })
    : null;
  const operationalProvided = moneyProvided(raw, 'operational_amount', ['amount', 'Amount']);
  const netProvided = moneyProvided(raw, 'net_amount');
  const netCashProvided = moneyProvided(raw, 'net_cash');
  let suppliedOperational = null;

  if (operationalProvided) {
    suppliedOperational = readMoney(raw, 'operational_amount', ['amount', 'Amount'],
      decimals, issues, { nonNegative: true });
  }
  if (netProvided) {
    const suppliedNet = readMoney(raw, 'net_amount', [], decimals, issues, {
      nonNegative: true,
    });
    if (suppliedOperational != null && suppliedOperational !== suppliedNet) {
      issues.push(issue('AMOUNT_NET_MISMATCH', 'amount',
        'Amount must equal net_amount because Amount is the authoritative cash magnitude'));
    }
    suppliedOperational = suppliedOperational ?? suppliedNet;
  }
  if (netCashProvided) {
    const suppliedCash = readMoney(raw, 'net_cash', [], decimals, issues);
    const expectedSign = event.type === 'buy' ? -1 : 1;
    if (suppliedCash !== 0 && Math.sign(suppliedCash) !== expectedSign) {
      issues.push(issue('NET_CASH_SIGN_MISMATCH', 'net_cash',
        `net_cash must be ${event.type === 'buy' ? 'negative' : 'positive'} for ${event.type}`));
    }
    const magnitude = Math.abs(suppliedCash);
    if (suppliedOperational != null && suppliedOperational !== magnitude) {
      issues.push(issue('NET_CASH_MISMATCH', 'net_cash',
        'absolute net_cash must equal Amount/net_amount'));
    }
    suppliedOperational = suppliedOperational ?? magnitude;
  }

  const taxFactsKnown = withholdingMinor != null && transactionTaxMinor != null && feesMinor != null;
  const deductions = taxFactsKnown
    ? withholdingMinor + transactionTaxMinor + feesMinor
    : null;
  let grossInferred = raw.gross_amount_inferred === true ||
    String(raw.gross_amount_inferred || '').toLowerCase() === 'true';
  if (grossMinor == null && !incompleteTaxFacts && suppliedOperational != null && deductions != null) {
    grossMinor = event.type === 'buy'
      ? suppliedOperational - deductions
      : suppliedOperational + deductions;
    grossInferred = true;
    if (grossMinor < 0) {
      issues.push(issue('NEGATIVE_INFERRED_GROSS', 'gross_amount',
        'Amount is smaller than buy taxes and fees, so gross_amount cannot be inferred'));
    }
  }

  let computedNet = null;
  if (grossMinor != null && deductions != null) {
    computedNet = event.type === 'buy' ? grossMinor + deductions : grossMinor - deductions;
    if (computedNet < 0) {
      issues.push(issue('NEGATIVE_NET_AMOUNT', 'net_amount',
        'taxes and fees cannot exceed gross_amount for sell or dividend'));
    }
  }
  if (computedNet != null && suppliedOperational != null && computedNet !== suppliedOperational) {
    issues.push(issue('NET_AMOUNT_MISMATCH', 'net_amount',
      'Amount/net_amount does not match gross_amount and the applicable taxes and fees'));
  }
  const netMinor = suppliedOperational ?? computedNet;
  if (netMinor == null) {
    issues.push(issue('OPERATIONAL_AMOUNT_REQUIRED', 'amount',
      'trade requires Amount/net_amount, or complete gross/tax/fee facts'));
  }
  if (unknownLegacy && grossMinor == null && suppliedOperational == null) {
    issues.push(issue('UNKNOWN_LEGACY_NET_REQUIRED', 'net_amount',
      'UNKNOWN_LEGACY trade requires net_amount, net_cash or Amount'));
  }

  const safeNetMinor = netMinor ?? 0;
  const cashMinor = event.type === 'buy' ? -safeNetMinor : safeNetMinor;
  if (!event.tax_status) {
    event.tax_status = (withholdingMinor || transactionTaxMinor || feesMinor) ? 'KNOWN' : 'NONE';
  }
  event.gross_amount_inferred = grossInferred;
  assignNullableMoney(event, 'gross_amount', grossMinor, decimals);
  assignNullableMoney(event, 'withholding_tax', withholdingMinor, decimals);
  assignNullableMoney(event, 'transaction_tax', transactionTaxMinor, decimals);
  assignNullableMoney(event, 'fees', feesMinor, decimals);
  assignMoney(event, 'net_amount', safeNetMinor, decimals);
  assignMoney(event, 'operational_amount', safeNetMinor, decimals);
  assignMoney(event, 'amount', safeNetMinor, decimals);
  assignMoney(event, 'cash_change', cashMinor, decimals);
  assignNullableMoney(event, 'tax_amount',
    withholdingMinor == null || transactionTaxMinor == null
      ? null
      : withholdingMinor + transactionTaxMinor,
    decimals);
  assignNullableMoney(event, 'fee_amount', feesMinor, decimals);
  assignMoney(event, 'net_cash', cashMinor, decimals);

  const perShare = event.quantity > 0
    ? roundNumber(safeNetMinor / (10 ** decimals) / event.quantity, PER_SHARE_DECIMALS)
    : null;
  event.per_share = perShare;
  event.per_share_decimal = perShare == null ? null : perShare.toFixed(PER_SHARE_DECIMALS);
  const grossPerShare = event.quantity > 0 && grossMinor != null
    ? roundNumber(grossMinor / (10 ** decimals) / event.quantity, PER_SHARE_DECIMALS)
    : null;
  event.gross_per_share = grossPerShare;
  event.gross_per_share_decimal = grossPerShare == null
    ? null
    : grossPerShare.toFixed(PER_SHARE_DECIMALS);
  const suppliedPerShare = firstPresent(raw, ['per_share', 'price_per_share', 'PerShare']);
  if (suppliedPerShare != null && Number.isFinite(Number(suppliedPerShare)) &&
      perShare != null && Math.abs(Number(suppliedPerShare) - perShare) > 1e-8) {
    issues.push(issue('PER_SHARE_RECOMPUTED', 'per_share',
      'per_share was recomputed from authoritative Amount / quantity', 'warning'));
  }
  const price = firstPresent(raw, ['price', 'trade_price', 'Price']);
  event.price = price == null || price === '' ? perShare : Number(price);
  if (event.price != null && !Number.isFinite(event.price)) {
    issues.push(issue('INVALID_PRICE', 'price', 'price must be finite when provided'));
    event.price = null;
  }
}

function normalizeSignedOperationalCash(raw, event, decimals, issues, options = {}) {
  const incompleteTaxFacts = assignTaxReviewMetadata(raw, event);
  const withholdingProvided = moneyProvided(raw, 'withholding_tax', ['withholding']);
  const transactionTaxProvided = moneyProvided(raw, 'transaction_tax', ['stamp_duty']);
  const genericTaxProvided = moneyProvided(raw, 'tax_amount', ['tax']);
  const anyTaxProvided = withholdingProvided || transactionTaxProvided || genericTaxProvided;
  const feesProvided = moneyProvided(raw, 'fees', ['fee', 'fee_amount']);
  let withholdingMinor = null;
  let transactionTaxMinor = null;
  if (!incompleteTaxFacts || anyTaxProvided) {
    const taxes = readTaxes(raw, decimals, issues, options.genericAsWithholding === true);
    withholdingMinor = taxes.withholdingMinor;
    transactionTaxMinor = taxes.transactionTaxMinor;
  }
  const feesMinor = !incompleteTaxFacts || feesProvided
    ? readMoney(raw, 'fees', ['fee', 'fee_amount'], decimals, issues, {
      nonNegative: true,
    })
    : null;

  const operationalInputs = [
    ['cash_change', []],
    ['net_cash', []],
    ['net_amount', []],
    ['operational_amount', []],
    ['cash_amount', ['cash', 'Cash']],
  ];
  let operationalMinor = null;
  let operationalWasProvided = false;
  for (const [field, aliases] of operationalInputs) {
    if (!moneyProvided(raw, field, aliases)) continue;
    operationalWasProvided = true;
    const candidate = readMoney(raw, field, aliases, decimals, issues);
    if (operationalMinor != null && operationalMinor !== candidate) {
      issues.push(issue('CASH_REPRESENTATION_MISMATCH', field,
        `${field} must equal the signed operational cash change`));
    } else {
      operationalMinor = candidate;
    }
  }
  if (operationalMinor == null) operationalMinor = 0;

  const grossProvided = moneyProvided(raw, 'gross_amount');
  let grossMinor = grossProvided
    ? readMoney(raw, 'gross_amount', [], decimals, issues, { nonNegative: true })
    : null;
  const taxFactsKnown = withholdingMinor != null && transactionTaxMinor != null && feesMinor != null;
  const deductions = taxFactsKnown
    ? withholdingMinor + transactionTaxMinor + feesMinor
    : null;
  let grossInferred = raw.gross_amount_inferred === true ||
    String(raw.gross_amount_inferred || '').toLowerCase() === 'true';
  if (grossMinor == null && !incompleteTaxFacts && deductions != null) {
    grossMinor = operationalMinor < 0
      ? Math.abs(operationalMinor) - deductions
      : operationalMinor + deductions;
    grossInferred = grossInferred || (operationalWasProvided && operationalMinor !== 0);
    if (grossMinor < 0) {
      issues.push(issue('NEGATIVE_INFERRED_GROSS', 'gross_amount',
        'operational cash is smaller than outflow taxes and fees'));
    }
  }
  if (grossMinor != null && deductions != null) {
    if (!operationalWasProvided && grossMinor !== 0) {
      issues.push(issue('SIGNED_CASH_REQUIRED', 'cash_change',
        'signed cash_change/net_cash is required when gross_amount is non-zero'));
    } else {
      const computed = operationalMinor < 0
        ? -(grossMinor + deductions)
        : grossMinor - deductions;
      if (computed !== operationalMinor) {
        issues.push(issue('NET_AMOUNT_MISMATCH', 'cash_change',
          'cash_change does not match gross_amount and taxes/fees'));
      }
    }
  }

  if (!event.tax_status) {
    event.tax_status = (withholdingMinor || transactionTaxMinor || feesMinor) ? 'KNOWN' : 'NONE';
  }
  event.gross_amount_inferred = grossInferred;
  assignNullableMoney(event, 'gross_amount', grossMinor, decimals);
  assignNullableMoney(event, 'withholding_tax', withholdingMinor, decimals);
  assignNullableMoney(event, 'transaction_tax', transactionTaxMinor, decimals);
  assignNullableMoney(event, 'fees', feesMinor, decimals);
  assignNullableMoney(event, 'tax_amount',
    withholdingMinor == null || transactionTaxMinor == null
      ? null
      : withholdingMinor + transactionTaxMinor,
    decimals);
  assignNullableMoney(event, 'fee_amount', feesMinor, decimals);
  assignMoney(event, 'cash_amount', operationalMinor, decimals);
  assignMoney(event, 'operational_amount', operationalMinor, decimals);
  assignMoney(event, 'net_amount', operationalMinor, decimals);
  assignMoney(event, 'cash_change', operationalMinor, decimals);
  assignMoney(event, 'net_cash', operationalMinor, decimals);
}

function normalizeCorporateAction(raw, event, decimals, issues) {
  event.ticker = normalizeTicker(firstPresent(raw, ['ticker', 'source_ticker', 'Ticker']));
  if (!event.ticker) issues.push(issue('TICKER_REQUIRED', 'ticker', 'ticker is required'));
  event.name = String(firstPresent(raw, ['name', 'asset_name', 'Name']) || event.ticker).trim();
  event.action_type = String(firstPresent(raw,
    ['action_type', 'corporate_action_type', 'ca_type', 'Type']) || '').trim().toUpperCase();
  if (!CORPORATE_ACTION_TYPE_SET.has(event.action_type)) {
    issues.push(issue('UNSUPPORTED_CORPORATE_ACTION', 'action_type',
      `action_type must be one of: ${CORPORATE_ACTION_TYPES.join(', ')}`));
  }
  event.pre_quantity = readFiniteNumber(raw, 'pre_quantity', ['quantity', 'qty', 'Qty'], issues, {
    nonNegative: true,
    defaultValue: null,
  });
  event.split_ratio = readFiniteNumber(raw, 'split_ratio', ['ratio'], issues, {
    positive: firstPresent(raw, ['split_ratio', 'ratio']) != null,
    defaultValue: null,
  });
  event.outputs = normalizeCorporateOutputs(
    raw,
    event.action_type,
    event.ticker,
    event.split_ratio,
    issues,
  );
  event.corporate_action_type = event.action_type;
  event.quantity = event.pre_quantity;
  const postTickers = event.outputs.map(output => output.ticker);
  const postQuantities = event.outputs.map(output => output.quantity);
  event.post_ticker = postTickers.length <= 1 ? (postTickers[0] || null) : `[${postTickers.join(',')}]`;
  event.post_quantity = postQuantities.length <= 1
    ? (postQuantities[0] ?? null)
    : `[${postQuantities.map(value => value ?? '').join(',')}]`;

  normalizeSignedOperationalCash(raw, event, decimals, issues);
}

function normalizeCapital(raw, event, decimals, issues) {
  event.shareholder = String(firstPresent(raw, ['shareholder', 'investor', 'Shareholder']) || '').trim();
  if (!event.shareholder) {
    issues.push(issue('SHAREHOLDER_REQUIRED', 'shareholder', 'shareholder is required'));
  }
  const subscriptionMinor = readMoney(raw, 'subscription', ['sub', 'Sub'], decimals, issues, {
    nonNegative: true,
  });
  const redemptionMinor = readMoney(raw, 'redemption', ['red', 'Red'], decimals, issues, {
    nonNegative: true,
  });
  // Unit price is a fund-unit ratio, not money. Preserve the input precision;
  // Python only formats the Excel cell to six decimals and rounds the derived
  // Quantity to six decimals.
  const unitPrice = readFiniteNumber(raw, 'unit_price', ['price', 'UnitPrice'], issues, {
    nonNegative: true,
    defaultValue: 0,
    preservePrecision: true,
  });
  const cashMinor = subscriptionMinor - redemptionMinor;
  if (cashMinor !== 0 && !(unitPrice > 0)) {
    issues.push(issue('UNIT_PRICE_REQUIRED', 'unit_price',
      'unit_price must be greater than zero when subscription or redemption is non-zero'));
  }
  event.units_delta = unitPrice > 0
    ? roundNumber((cashMinor / (10 ** decimals)) / unitPrice, 6)
    : 0;
  event.quantity = event.units_delta;
  assignMoney(event, 'subscription', subscriptionMinor, decimals);
  assignMoney(event, 'redemption', redemptionMinor, decimals);
  event.unit_price = unitPrice;
  event.unit_price_decimal = String(unitPrice);
  assignMoney(event, 'net_amount', cashMinor, decimals);
  assignMoney(event, 'cash_change', cashMinor, decimals);
  assignMoney(event, 'net_cash', cashMinor, decimals);
}

function normalizeLiability(raw, event, decimals, issues) {
  const changeMinor = readMoney(raw, 'change', ['liability_change', 'Change'], decimals, issues);
  const interestMinor = readMoney(raw, 'interest', ['interest_expense', 'Interest'], decimals, issues, {
    nonNegative: true,
  });
  const cashMinor = changeMinor - interestMinor;
  assignMoney(event, 'change', changeMinor, decimals);
  assignMoney(event, 'interest', interestMinor, decimals);
  assignMoney(event, 'liability_change', changeMinor, decimals);
  assignMoney(event, 'interest_expense', interestMinor, decimals);
  assignMoney(event, 'net_amount', cashMinor, decimals);
  assignMoney(event, 'cash_change', cashMinor, decimals);
  assignMoney(event, 'net_cash', cashMinor, decimals);
}

function normalizeFundAction(raw, event, decimals, issues) {
  const suppliedActionType = firstPresent(raw,
    ['action_type', 'fund_action_type', 'fund_type', 'Type']);
  const hasSplitFields = firstPresent(raw,
    ['pre_units', 'quantity', 'qty', 'Qty', 'post_units', 'post_quantity', 'PostQty',
      'split_ratio', 'ratio']) != null;
  event.action_type = String(suppliedActionType || (hasSplitFields ? 'UNIT_SPLIT' : 'CASH'))
    .trim().toUpperCase();
  event.pre_units = readFiniteNumber(raw, 'pre_units', ['quantity', 'qty', 'Qty'], issues, {
    nonNegative: true,
    defaultValue: null,
  });
  event.post_units = readFiniteNumber(raw, 'post_units', ['post_quantity', 'PostQty'], issues, {
    nonNegative: true,
    defaultValue: null,
  });
  event.split_ratio = readFiniteNumber(raw, 'split_ratio', ['ratio'], issues, {
    positive: firstPresent(raw, ['split_ratio', 'ratio']) != null,
    defaultValue: null,
  });
  if (event.split_ratio == null && event.pre_units > 0 && event.post_units > 0 &&
      Math.abs(event.pre_units - event.post_units) > 1e-12) {
    event.split_ratio = roundNumber(event.post_units / event.pre_units);
  }
  if (event.action_type.includes('SPLIT') && !(event.split_ratio > 0)) {
    issues.push(issue('FUND_SPLIT_RATIO_REQUIRED', 'split_ratio',
      'fund unit split requires positive pre/post units or split_ratio'));
  }
  event.fund_action_type = event.action_type;
  event.quantity = event.pre_units;
  event.post_quantity = event.post_units;

  normalizeSignedOperationalCash(raw, event, decimals, issues, {
    genericAsWithholding: event.action_type.includes('DIVIDEND'),
  });
}

function normalizeReversal(raw, event, decimals, issues, depth) {
  event.reversal_of_event_id = String(firstPresent(raw,
    ['reversal_of_event_id', 'reversal_of', 'original_event_id']) || '').trim() || null;
  event.original_event = null;
  if (raw.original_event != null) {
    if (depth > 0) {
      issues.push(issue('NESTED_REVERSAL_UNSUPPORTED', 'original_event',
        'a reversal cannot contain another nested reversal'));
      return;
    }
    const nested = normalizeEventInternal(raw.original_event, {
      currency_decimals: decimals,
      index: 0,
      depth: depth + 1,
    });
    for (const nestedIssue of nested.issues) {
      issues.push({ ...nestedIssue, field: `original_event.${nestedIssue.field}` });
    }
    event.original_event = nested.event;
    if (nested.event.type === 'corporate_action') {
      issues.push(issue('CORPORATE_ACTION_REVERSAL_UNSAFE', 'original_event',
        'corporate actions cannot be reversed without an explicit corrective action chain', 'fatal'));
    }
    if (nested.event.type === 'reversal') {
      issues.push(issue('REVERSAL_OF_REVERSAL_UNSUPPORTED', 'original_event',
        'reverse the corrected event instead of reversing a reversal', 'fatal'));
    }
    if (event.reversal_of_event_id && nested.event.event_id &&
        event.reversal_of_event_id !== nested.event.event_id) {
      issues.push(issue('REVERSAL_TARGET_MISMATCH', 'reversal_of_event_id',
        'reversal_of_event_id does not match original_event.event_id'));
    }
    if (!event.reversal_of_event_id && nested.event.event_id) {
      event.reversal_of_event_id = nested.event.event_id;
    }
  }
  if (!event.reversal_of_event_id && !event.original_event) {
    issues.push(issue('REVERSAL_TARGET_REQUIRED', 'reversal_of_event_id',
      'reversal requires original_event or reversal_of_event_id'));
  }
}

function normalizeEventInternal(raw, options = {}) {
  const issues = [];
  const decimals = normalizeDecimals(options.currency_decimals);
  const event = normalizeCommon(raw, options.index ?? 0, issues);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    assignTaxReviewMetadata(raw, event);
  }
  switch (event.type) {
    case 'buy':
    case 'sell':
    case 'dividend':
      normalizeTrade(raw, event, decimals, issues);
      break;
    case 'corporate_action':
      normalizeCorporateAction(raw, event, decimals, issues);
      break;
    case 'capital':
      normalizeCapital(raw, event, decimals, issues);
      break;
    case 'liability':
      normalizeLiability(raw, event, decimals, issues);
      break;
    case 'fund_action':
      normalizeFundAction(raw, event, decimals, issues);
      break;
    case 'reversal':
      normalizeReversal(raw, event, decimals, issues, options.depth ?? 0);
      break;
    default:
      break;
  }
  event.event_type = event.type;
  event.trade_date = event.date;
  event.trade_no = event.sequence;
  return { event, issues };
}

export function validateLedgerEvent(raw, options = {}) {
  let normalized;
  try {
    normalized = normalizeEventInternal(raw, options);
  } catch (error) {
    if (!(error instanceof LedgerValidationError)) throw error;
    return { valid: false, errors: error.issues, warnings: [], event: null };
  }
  const errors = normalized.issues.filter(item => item.severity !== 'warning');
  const warnings = normalized.issues.filter(item => item.severity === 'warning');
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    event: normalized.event,
  };
}

export function normalizeLedgerEvent(raw, options = {}) {
  const validation = validateLedgerEvent(raw, options);
  if (!validation.valid) throw new LedgerValidationError(validation.errors);
  return validation.event;
}

export function validateLedgerEvents(rawEvents, options = {}) {
  if (!Array.isArray(rawEvents)) {
    return {
      valid: false,
      errors: [issue('EVENTS_NOT_ARRAY', 'events', 'events must be an array')],
      warnings: [],
      events: [],
    };
  }
  const events = [];
  const errors = [];
  const warnings = [];
  rawEvents.forEach((raw, index) => {
    const validation = validateLedgerEvent(raw, { ...options, index });
    if (validation.valid && validation.event) events.push(validation.event);
    validation.errors.forEach(item => errors.push({ ...item, event_index: index,
      event_id: validation.event?.event_id || null }));
    validation.warnings.forEach(item => warnings.push({ ...item, event_index: index,
      event_id: validation.event?.event_id || null }));
  });
  return { valid: errors.length === 0, errors, warnings, events };
}

export function normalizeLedgerEvents(rawEvents, options = {}) {
  const validation = validateLedgerEvents(rawEvents, options);
  if (!validation.valid) throw new LedgerValidationError(validation.errors);
  return validation.events;
}

function compareEvents(left, right, eventMap) {
  const dateOrder = left.date.localeCompare(right.date);
  if (dateOrder) return dateOrder;
  const resolveType = event => {
    if (event.type !== 'reversal') return event.type;
    return event.original_event?.type || eventMap.get(event.reversal_of_event_id)?.type || 'reversal';
  };
  const leftType = resolveType(left);
  const rightType = resolveType(right);
  const priorityOrder = (EVENT_PRIORITY[leftType] ?? EVENT_PRIORITY.reversal) -
    (EVENT_PRIORITY[rightType] ?? EVENT_PRIORITY.reversal);
  if (priorityOrder) return priorityOrder;
  const sequenceOrder = (left.trade_no ?? left.sequence) - (right.trade_no ?? right.sequence);
  if (sequenceOrder) return sequenceOrder;
  const typeOrder = (TYPE_TIE_BREAK[leftType] ?? 0) - (TYPE_TIE_BREAK[rightType] ?? 0);
  if (typeOrder) return typeOrder;
  const idOrder = String(left.event_id || '').localeCompare(String(right.event_id || ''));
  if (idOrder) return idOrder;
  return left._input_index - right._input_index;
}

function assignMonthlyTradeNumbers(events) {
  const bySheet = new Map();
  for (const event of events) {
    if (!bySheet.has(event.type)) bySheet.set(event.type, []);
    bySheet.get(event.type).push(event);
  }
  for (const rows of bySheet.values()) {
    rows.sort((left, right) => left.date.localeCompare(right.date) ||
      left._input_index - right._input_index);
    let month = '';
    let number = 0;
    for (const event of rows) {
      const nextMonth = event.date.slice(0, 7);
      if (nextMonth !== month) {
        month = nextMonth;
        number = 0;
      }
      event.trade_no = ++number;
    }
  }
}

function addCheck(checks, event, code, message, severity = 'warning', details = {}) {
  checks.push({
    code,
    severity,
    message,
    event_id: event?.event_id || null,
    date: event?.date || null,
    type: event?.type || null,
    ...details,
  });
}

function emptyPosition(ticker, name = ticker) {
  return {
    ticker,
    name: name || ticker,
    quantity: 0,
    total_shares_bought: 0,
    buy_cost_minor: 0,
    sell_proceeds_minor: 0,
    dividend_income_minor: 0,
    gross_buy_minor: 0,
    gross_sell_minor: 0,
    gross_dividend_minor: 0,
    gross_buy_unknown_count: 0,
    gross_sell_unknown_count: 0,
    gross_dividend_unknown_count: 0,
    withholding_tax_minor: 0,
    transaction_tax_minor: 0,
    fees_minor: 0,
    tax_unknown_count: 0,
    fees_unknown_count: 0,
  };
}

function positionFor(state, ticker, name) {
  if (!state.positions.has(ticker)) state.positions.set(ticker, emptyPosition(ticker, name));
  const position = state.positions.get(ticker);
  if (name && (!position.name || position.name === ticker)) position.name = name;
  return position;
}

function applyCash(state, event, changeMinor, sourceType, decimals) {
  // Python omits zero-cash events from Cash Flow Statement while still
  // applying their non-cash effects (for example a stock spin-off).
  if (changeMinor === 0) return;
  const beforeMinor = state.cashMinor;
  const afterMinor = beforeMinor + changeMinor;
  if (!Number.isSafeInteger(afterMinor)) {
    throw new LedgerValidationError([
      issue('MONEY_OVERFLOW', 'cash', 'cash balance exceeded the safe integer range', 'fatal'),
    ]);
  }
  state.cashMinor = afterMinor;
  const row = {
    event_id: event.event_id,
    date: event.date,
    sequence: event.trade_no ?? event.sequence,
    type: event.type,
    source_type: sourceType,
    source_sheet: SOURCE_SHEETS[event.type] || SOURCE_SHEETS[sourceType],
    action_type: event.action_type || null,
  };
  assignMoney(row, 'cash_before', beforeMinor, decimals);
  assignMoney(row, 'cash_change', changeMinor, decimals);
  assignMoney(row, 'cash_after', afterMinor, decimals);
  state.cashChain.push(row);
  if (afterMinor < 0) {
    addCheck(state.checks, event, 'NEGATIVE_CASH',
      `cash balance became ${formatMinor(afterMinor, decimals)}`, 'warning', {
        cash_after_minor: afterMinor,
      });
  }
}

function applyTrade(state, event, direction, decimals, sourceEvent = event) {
  const position = positionFor(state, event.ticker, event.name);
  const quantityChange = event.type === 'buy'
    ? event.quantity * direction
    : event.type === 'sell'
      ? -event.quantity * direction
      : 0;
  if (event.type === 'sell' && direction === 1 && event.quantity > position.quantity + 1e-9) {
    addCheck(state.checks, sourceEvent, 'OVERSELL',
      `sell quantity ${event.quantity} exceeds ${event.ticker} holding ${position.quantity}`,
      'error', { ticker: event.ticker, available_quantity: position.quantity,
        sell_quantity: event.quantity });
  }
  if (event.type === 'buy') {
    position.quantity = roundNumber(position.quantity + quantityChange);
    position.total_shares_bought = roundNumber(
      position.total_shares_bought + event.quantity * direction,
    );
    position.buy_cost_minor += event.net_amount_minor * direction;
    position.gross_buy_minor += (event.gross_amount_minor ?? 0) * direction;
    if (event.gross_amount_minor == null) position.gross_buy_unknown_count += direction;
  } else if (event.type === 'sell') {
    position.quantity = roundNumber(position.quantity + quantityChange);
    position.sell_proceeds_minor += event.net_amount_minor * direction;
    position.gross_sell_minor += (event.gross_amount_minor ?? 0) * direction;
    if (event.gross_amount_minor == null) position.gross_sell_unknown_count += direction;
  } else {
    if (direction === 1 && position.quantity <= 1e-12) {
      addCheck(state.checks, sourceEvent, 'DIVIDEND_WITHOUT_POSITION',
        `dividend recorded for ${event.ticker} without a positive holding`, 'warning', {
          ticker: event.ticker,
        });
    }
    position.dividend_income_minor += event.net_amount_minor * direction;
    position.gross_dividend_minor += (event.gross_amount_minor ?? 0) * direction;
    if (event.gross_amount_minor == null) position.gross_dividend_unknown_count += direction;
  }
  position.withholding_tax_minor += (event.withholding_tax_minor ?? 0) * direction;
  position.transaction_tax_minor += (event.transaction_tax_minor ?? 0) * direction;
  position.fees_minor += (event.fees_minor ?? 0) * direction;
  if (event.withholding_tax_minor == null || event.transaction_tax_minor == null) {
    position.tax_unknown_count += direction;
  }
  if (event.fees_minor == null) position.fees_unknown_count += direction;
  applyCash(state, sourceEvent, event.cash_change_minor * direction, event.type, decimals);
}

function applyCapital(state, event, direction, decimals, sourceEvent = event) {
  const before = state.units;
  state.units = roundNumber(state.units + event.units_delta * direction);
  const shareholderBefore = state.shareholders.get(event.shareholder) || 0;
  const shareholderAfter = roundNumber(shareholderBefore + event.units_delta * direction);
  state.shareholders.set(event.shareholder, shareholderAfter);
  state.unitChain.push({
    event_id: sourceEvent.event_id,
    date: sourceEvent.date,
    type: sourceEvent.type,
    source_type: event.type,
    shareholder: event.shareholder,
    units_before: before,
    units_change: roundNumber(event.units_delta * direction),
    units_after: state.units,
    shareholder_units_before: shareholderBefore,
    shareholder_units_after: shareholderAfter,
  });
  if (state.units < -1e-9 || shareholderAfter < -1e-9) {
    addCheck(state.checks, sourceEvent, 'NEGATIVE_UNITS',
      'capital event produced negative fund or shareholder units', 'error', {
        units_after: state.units,
        shareholder: event.shareholder,
        shareholder_units_after: shareholderAfter,
      });
  }
  applyCash(state, sourceEvent, event.cash_change_minor * direction, event.type, decimals);
}

function applyLiability(state, event, direction, decimals, sourceEvent = event) {
  const beforeMinor = state.liabilityMinor;
  state.liabilityMinor += event.change_minor * direction;
  const row = {
    event_id: sourceEvent.event_id,
    date: sourceEvent.date,
    type: sourceEvent.type,
    source_type: event.type,
  };
  assignMoney(row, 'liability_before', beforeMinor, decimals);
  assignMoney(row, 'interest', event.interest_minor * direction, decimals);
  assignMoney(row, 'liability_change', event.change_minor * direction, decimals);
  assignMoney(row, 'liability_after', state.liabilityMinor, decimals);
  state.liabilityChain.push(row);
  if (state.liabilityMinor < 0) {
    addCheck(state.checks, sourceEvent, 'NEGATIVE_LIABILITY',
      'liability balance became negative', 'warning', {
        liability_after_minor: state.liabilityMinor,
      });
  }
  applyCash(state, sourceEvent, event.cash_change_minor * direction, event.type, decimals);
}

function applyFundAction(state, event, direction, decimals, sourceEvent = event) {
  const ratio = event.split_ratio;
  if (ratio > 0 && Math.abs(ratio - 1) > 1e-12) {
    if (direction === -1 && !(ratio > 0)) {
      addCheck(state.checks, sourceEvent, 'FUND_ACTION_REVERSAL_UNSAFE',
        'fund split ratio cannot be safely reversed', 'fatal');
      return;
    }
    if (event.pre_units != null && direction === 1 &&
        Math.abs(state.units - event.pre_units) > 1e-8) {
      addCheck(state.checks, sourceEvent, 'FUND_PRE_UNITS_MISMATCH',
        `recorded pre-units ${event.pre_units} differ from replayed units ${state.units}`,
        'warning', { recorded_pre_units: event.pre_units, replayed_units: state.units });
    }
    const before = state.units;
    const multiplier = direction === 1 ? ratio : 1 / ratio;
    state.units = roundNumber(state.units * multiplier);
    for (const [name, units] of state.shareholders) {
      state.shareholders.set(name, roundNumber(units * multiplier));
    }
    state.unitChain.push({
      event_id: sourceEvent.event_id,
      date: sourceEvent.date,
      type: sourceEvent.type,
      source_type: event.type,
      shareholder: null,
      units_before: before,
      units_change: roundNumber(state.units - before),
      units_after: state.units,
      split_ratio: ratio,
      direction,
    });
  }
  applyCash(state, sourceEvent, event.cash_change_minor * direction, event.type, decimals);
}

function allocateMinor(total, weights) {
  if (!weights.length) return [];
  const allocated = [];
  let used = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const value = index === weights.length - 1
      ? total - used
      : Math.round(total * weights[index]);
    allocated.push(value);
    used += value;
  }
  return allocated;
}

function normalizeCorporateActionPriceRows(rawRows) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows.map(row => ({
    ticker: normalizeTicker(row && (row.ticker ?? row.symbol)),
    date: String(row && (row.date ?? row.price_date ?? row.trade_date) || '').slice(0, 10),
    price: Number(row && (row.price ?? row.close ?? row.latest_price)),
  })).filter(row => row.ticker && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.price > 0)
    .sort((left, right) => left.date.localeCompare(right.date) || left.ticker.localeCompare(right.ticker));
}

function corporateActionWeights(state, event, quantities) {
  if (event.outputs.length <= 1) return [1];

  // A populated allocation is a cached result of the same automatic price
  // calculation. Legacy/Pending rows normally leave it null.
  const cached = event.outputs.map(output => Number(output.allocation));
  if (cached.every(value => Number.isFinite(value) && value >= 0) &&
      cached.reduce((sum, value) => sum + value, 0) > 0) {
    const total = cached.reduce((sum, value) => sum + value, 0);
    return cached.map(value => roundNumber(value / total));
  }

  const start = Date.parse(`${event.date}T00:00:00.000Z`);
  const end = start + 7 * 24 * 60 * 60 * 1000;
  const marketValues = event.outputs.map((output, index) => {
    const observation = state.corporateActionPrices.find(row => {
      const observed = Date.parse(`${row.date}T00:00:00.000Z`);
      return row.ticker === output.ticker && observed >= start && observed <= end;
    });
    return quantities[index] * Number(observation && observation.price || 0);
  });
  const totalMarketValue = marketValues.reduce((sum, value) => sum + value, 0);
  if (totalMarketValue > 0) {
    return marketValues.map(value => roundNumber(value / totalMarketValue));
  }

  addCheck(state.checks, event, 'CORPORATE_ACTION_PRICE_FALLBACK',
    `post-action prices were unavailable; cumulative cost remains with ${event.outputs[0].ticker}`,
    'warning', { tickers: event.outputs.map(output => output.ticker), action_date: event.date });
  return event.outputs.map((_, index) => index === 0 ? 1 : 0);
}

function checkCorporateActionContinuity(state, event, oldQuantity, quantities) {
  const actionTime = Date.parse(`${event.date}T00:00:00.000Z`);
  const windowEnd = actionTime + 7 * 86400000;
  const oldQuote = state.corporateActionPrices
    .filter(row => row.ticker === event.ticker &&
      Date.parse(`${row.date}T00:00:00.000Z`) < actionTime)
    .at(-1);
  if (!oldQuote || !(oldQuantity > 0)) return;
  let afterValue = 0;
  for (let index = 0; index < event.outputs.length; index += 1) {
    const output = event.outputs[index];
    const quote = state.corporateActionPrices.find(row => {
      const observed = Date.parse(`${row.date}T00:00:00.000Z`);
      return row.ticker === output.ticker && observed >= actionTime && observed <= windowEnd;
    });
    if (!quote) return;
    afterValue += quantities[index] * quote.price;
  }
  const beforeValue = oldQuantity * oldQuote.price;
  if (!(beforeValue > 0) || !(afterValue > 0)) return;
  const jump = afterValue / beforeValue - 1;
  if (Math.abs(jump) > 0.08) {
    addCheck(state.checks, event, 'CORPORATE_ACTION_VALUE_JUMP',
      'corporate action market value changed by more than 8%', 'warning', {
        market_value_before: beforeValue,
        market_value_after: afterValue,
        change_ratio: jump,
      });
  }
}

function applyCorporateAction(state, event, decimals) {
  const old = state.positions.get(event.ticker) || emptyPosition(event.ticker, event.name);
  if (!state.positions.has(event.ticker)) {
    addCheck(state.checks, event, 'CORPORATE_ACTION_SOURCE_MISSING',
      `corporate action source ${event.ticker} was not held`, 'warning', {
        ticker: event.ticker,
      });
  }
  if (event.pre_quantity != null && Math.abs(old.quantity - event.pre_quantity) > 0.01) {
    addCheck(state.checks, event, 'CORPORATE_PRE_QUANTITY_MISMATCH',
      `recorded pre-quantity ${event.pre_quantity} differs from replayed holding ${old.quantity}`,
      'warning', { ticker: event.ticker, recorded_pre_quantity: event.pre_quantity,
        replayed_quantity: old.quantity });
  }
  state.positions.delete(event.ticker);

  const quantities = event.outputs.map(output => {
    if (output.quantity != null) return output.quantity;
    if (event.action_type === 'SPLIT' && event.split_ratio > 0) {
      return roundNumber(old.quantity * event.split_ratio);
    }
    return old.quantity;
  });
  checkCorporateActionContinuity(state, event, old.quantity, quantities);
  const weights = corporateActionWeights(state, event, quantities);
  const buyCosts = allocateMinor(old.buy_cost_minor, weights);
  const grossBuys = allocateMinor(old.gross_buy_minor, weights);
  const taxes = allocateMinor(old.transaction_tax_minor, weights);
  const fees = allocateMinor(old.fees_minor, weights);

  event.outputs.forEach((output, index) => {
    const position = positionFor(state, output.ticker, output.name || (index === 0 ? old.name : output.ticker));
    position.quantity = roundNumber(position.quantity + quantities[index]);
    position.total_shares_bought = roundNumber(
      position.total_shares_bought + quantities[index],
    );
    position.buy_cost_minor += buyCosts[index];
    position.gross_buy_minor += grossBuys[index];
    position.transaction_tax_minor += taxes[index];
    position.fees_minor += fees[index];
    if (weights[index] > 0) {
      position.gross_buy_unknown_count += old.gross_buy_unknown_count;
    }
    if (index === 0) {
      position.sell_proceeds_minor += old.sell_proceeds_minor;
      position.dividend_income_minor += old.dividend_income_minor;
      position.gross_sell_minor += old.gross_sell_minor;
      position.gross_dividend_minor += old.gross_dividend_minor;
      position.withholding_tax_minor += old.withholding_tax_minor;
      position.gross_sell_unknown_count += old.gross_sell_unknown_count;
      position.gross_dividend_unknown_count += old.gross_dividend_unknown_count;
      position.tax_unknown_count += old.tax_unknown_count;
      position.fees_unknown_count += old.fees_unknown_count;
    }
  });
  applyCash(state, event, event.cash_change_minor, event.type, decimals);
}

function resolveReversalTarget(state, event) {
  if (event.original_event) return event.original_event;
  return state.appliedById.get(event.reversal_of_event_id) || null;
}

function applyReversal(state, event, decimals) {
  const original = resolveReversalTarget(state, event);
  if (!original) {
    addCheck(state.checks, event, 'REVERSAL_TARGET_NOT_APPLIED',
      `reversal target ${event.reversal_of_event_id || '(missing)'} was not applied earlier`, 'fatal');
    return;
  }
  const targetId = event.reversal_of_event_id || original.event_id;
  if (targetId && state.reversedIds.has(targetId)) {
    addCheck(state.checks, event, 'EVENT_ALREADY_REVERSED',
      `event ${targetId} has already been reversed`, 'fatal');
    return;
  }
  if (original.type === 'corporate_action') {
    addCheck(state.checks, event, 'CORPORATE_ACTION_REVERSAL_UNSAFE',
      'corporate actions require an explicit corrective action chain and cannot be automatically reversed',
      'fatal');
    return;
  }
  if (original.type === 'reversal') {
    addCheck(state.checks, event, 'REVERSAL_OF_REVERSAL_UNSUPPORTED',
      'reverse the corrected event instead of reversing a reversal', 'fatal');
    return;
  }
  applyEvent(state, original, decimals, -1, event);
  if (targetId) state.reversedIds.add(targetId);
}

function applyEvent(state, event, decimals, direction = 1, sourceEvent = event) {
  if (direction === 1 && event.tax_review_required === true) {
    addCheck(state.checks, sourceEvent, 'TAX_REVIEW_REQUIRED',
      event.tax_review_reason || 'tax facts require explicit review before confirmation', 'error', {
        tax_status: event.tax_status || null,
      });
  }
  switch (event.type) {
    case 'buy':
    case 'sell':
    case 'dividend':
      applyTrade(state, event, direction, decimals, sourceEvent);
      break;
    case 'capital':
      applyCapital(state, event, direction, decimals, sourceEvent);
      break;
    case 'liability':
      applyLiability(state, event, direction, decimals, sourceEvent);
      break;
    case 'fund_action':
      applyFundAction(state, event, direction, decimals, sourceEvent);
      break;
    case 'corporate_action':
      if (direction === -1) {
        addCheck(state.checks, sourceEvent, 'CORPORATE_ACTION_REVERSAL_UNSAFE',
          'corporate actions cannot be automatically reversed', 'fatal');
      } else {
        applyCorporateAction(state, event, decimals);
      }
      break;
    case 'reversal':
      if (direction === -1) {
        addCheck(state.checks, sourceEvent, 'REVERSAL_OF_REVERSAL_UNSUPPORTED',
          'reversals cannot themselves be automatically reversed', 'fatal');
      } else {
        applyReversal(state, event, decimals);
      }
      break;
    default:
      break;
  }
}

function normalizeOpeningMoney(options, field, decimals) {
  const issues = [];
  const value = readMoney(options, field, [], decimals, issues);
  if (issues.length) throw new LedgerValidationError(issues);
  return value;
}

function nextMonth(month) {
  const [year, value] = month.split('-').map(Number);
  return value === 12
    ? `${year + 1}-01`
    : `${year}-${String(value + 1).padStart(2, '0')}`;
}

function buildLiabilityStatement(events, decimals, requestedAsOf) {
  const liabilityEvents = events.filter(event => event.type === 'liability');
  if (!liabilityEvents.length) return [];
  const firstMonth = liabilityEvents[0].date.slice(0, 7);
  const latestEventMonth = liabilityEvents.at(-1).date.slice(0, 7);
  const requestedMonth = /^\d{4}-\d{2}(?:-\d{2})?$/.test(String(requestedAsOf || ''))
    ? String(requestedAsOf).slice(0, 7)
    : latestEventMonth;
  const lastMonth = requestedMonth > latestEventMonth ? requestedMonth : latestEventMonth;
  const totals = new Map();
  for (const event of liabilityEvents) {
    const month = event.date.slice(0, 7);
    const row = totals.get(month) || { interestMinor: 0, changeMinor: 0 };
    row.interestMinor += event.interest_minor;
    row.changeMinor += event.change_minor;
    totals.set(month, row);
  }
  const rows = [];
  let openingMinor = 0;
  for (let month = firstMonth; month <= lastMonth; month = nextMonth(month)) {
    const total = totals.get(month) || { interestMinor: 0, changeMinor: 0 };
    const closingMinor = openingMinor + total.changeMinor;
    const row = { no: rows.length + 1, date: month, month, notes: null };
    assignMoney(row, 'opening_liability', openingMinor, decimals);
    assignMoney(row, 'interest_paid', total.interestMinor, decimals);
    assignMoney(row, 'liability_change', total.changeMinor, decimals);
    assignMoney(row, 'closing_liability', closingMinor, decimals);
    rows.push(row);
    openingMinor = closingMinor;
  }
  return rows;
}

function serializePosition(position, decimals) {
  const grossBuyComplete = position.gross_buy_unknown_count === 0;
  // Python book-value fallback is always recorded Amount divided by all
  // shares ever bought. Gross/tax/fee fields are audit decomposition only.
  const fallbackAmountMinor = position.buy_cost_minor;
  const fallbackPrice = position.total_shares_bought > 1e-12
    ? roundNumber(
      fallbackAmountMinor / (10 ** decimals) / position.total_shares_bought,
      PER_SHARE_DECIMALS,
    )
    : 0;
  const result = {
    ticker: position.ticker,
    name: position.name,
    quantity: roundNumber(position.quantity),
    total_shares_bought: roundNumber(position.total_shares_bought),
    fallback_price: fallbackPrice,
    fallback_price_decimal: fallbackPrice.toFixed(PER_SHARE_DECIMALS),
    reference_price: fallbackPrice,
    fallback_price_source: 'operational_buy_amount',
  };
  assignMoney(result, 'buy_cost', position.buy_cost_minor, decimals);
  assignMoney(result, 'sell_proceeds', position.sell_proceeds_minor, decimals);
  assignMoney(result, 'dividend_income', position.dividend_income_minor, decimals);
  assignNullableMoney(result, 'gross_buy_amount',
    grossBuyComplete ? position.gross_buy_minor : null, decimals);
  assignNullableMoney(result, 'gross_sell_amount',
    position.gross_sell_unknown_count === 0 ? position.gross_sell_minor : null, decimals);
  assignNullableMoney(result, 'gross_dividend_amount',
    position.gross_dividend_unknown_count === 0 ? position.gross_dividend_minor : null, decimals);
  assignNullableMoney(result, 'withholding_tax',
    position.tax_unknown_count === 0 ? position.withholding_tax_minor : null, decimals);
  assignNullableMoney(result, 'transaction_tax',
    position.tax_unknown_count === 0 ? position.transaction_tax_minor : null, decimals);
  assignNullableMoney(result, 'fees',
    position.fees_unknown_count === 0 ? position.fees_minor : null, decimals);
  assignMoney(result, 'net_cost', position.buy_cost_minor - position.sell_proceeds_minor, decimals);
  assignMoney(result, 'total_buy_cost', position.buy_cost_minor, decimals);
  return result;
}

function stateSummary(result) {
  return {
    cash: result.cash,
    liability: result.liability,
    units: result.units,
    positions: result.positions,
    checks: result.checks,
  };
}

function sourceRecord(event) {
  const common = { No: event.trade_no ?? event.sequence, Date: event.date, Notes: event.notes || null };
  if (['buy', 'sell', 'dividend'].includes(event.type)) {
    return {
      ...common,
      Ticker: event.ticker,
      Name: event.name,
      Qty: event.quantity,
      Amount: event.amount,
      Price: event.price,
      PerShare: event.per_share,
      GrossAmount: event.gross_amount,
      WithholdingTax: event.withholding_tax,
      TransactionTax: event.transaction_tax,
      Fees: event.fees,
      NetAmount: event.net_amount,
    };
  }
  if (event.type === 'corporate_action') {
    return {
      ...common,
      Ticker: event.ticker,
      Name: event.name,
      Type: event.action_type,
      Qty: event.pre_quantity,
      PostTicker: event.outputs.map(output => output.ticker),
      PostQty: event.outputs.map(output => output.quantity),
      Allocation: event.outputs.map(output => output.allocation),
      Cash: event.net_amount,
    };
  }
  if (event.type === 'capital') {
    return { ...common, Shareholder: event.shareholder, Sub: event.subscription,
      Red: event.redemption, UnitPrice: event.unit_price, Qty: event.units_delta };
  }
  if (event.type === 'liability') {
    return { ...common, Interest: event.interest, Change: event.change };
  }
  if (event.type === 'fund_action') {
    return { ...common, Type: event.action_type, Qty: event.pre_units,
      PostQty: event.post_units, Cash: event.net_amount };
  }
  return { ...common, ReversalOf: event.reversal_of_event_id || event.original_event?.event_id || null };
}

export function projectPythonCompatibility(result, options = {}) {
  const currency = String(options.currency || result.currency || 'USD').toUpperCase();
  const records = { buy: [], sell: [], div: [], corp: [], lia: [], cap: [], fund: [], reversal: [] };
  const recordKeys = {
    buy: 'buy', sell: 'sell', dividend: 'div', corporate_action: 'corp', liability: 'lia',
    capital: 'cap', fund_action: 'fund', reversal: 'reversal',
  };
  for (const event of result.ordered_events) {
    records[recordKeys[event.type]].push(sourceRecord(event));
  }

  const dfCashflow = result.cash_chain
    .filter(row => row.cash_change_minor !== 0)
    .map(row => ({
      Date: row.date,
      'Source Sheet': row.source_sheet,
      'Trade No.': row.sequence,
      [`Cash Before (${currency})`]: row.cash_before,
      [`Cash Change (${currency})`]: row.cash_change,
      [`Cash After (${currency})`]: row.cash_after,
    }));
  const dfCash = result.cash_chain
    .filter(row => row.cash_change_minor !== 0)
    .map(row => {
      const type = row.source_type;
      const fundType = String(row.action_type || '').toUpperCase();
      const isFundFee = type === 'fund_action' &&
        (fundType.includes('FEE') || fundType.includes('管理'));
      return {
        '日期': row.date,
        '原有现金': row.cash_before,
        '赎回申购': type === 'capital' ? row.cash_change : null,
        '交易股票': ['buy', 'sell', 'corporate_action'].includes(type) ? row.cash_change : null,
        '股票派息': type === 'dividend' ? row.cash_change : null,
        '基金派息': type === 'fund_action' && row.cash_change < 0 && !isFundFee ? -row.cash_change : null,
        '管理费': type === 'fund_action' && row.cash_change < 0 && isFundFee ? -row.cash_change : null,
        '负债(贷款/结算）': type === 'liability' ? row.cash_change : null,
        '结算现金': row.cash_after,
      };
    });
  const dfEquity = result.unit_chain.filter(row => row.source_type === 'capital').map(row => ({
    '日期': row.date,
    '股东': row.shareholder,
    '原股份': row.shareholder_units_before,
    '股份变动': row.units_change,
    '现有股份': row.shareholder_units_after,
  }));
  const dfLiability = result.liability_chain.map(row => ({
    '日期': row.date,
    '原负债': row.liability_before,
    '利息支出': row.interest,
    '负债改变': row.liability_change,
    '现有负债': row.liability_after,
  }));
  const dfTransaction = result.ordered_events.filter(event =>
    ['buy', 'sell', 'dividend'].includes(event.type)).map(event => ({
      '日期': event.date,
      Ticker: event.ticker,
      '股数': event.quantity,
      '购入价': event.type === 'buy' ? event.per_share : null,
      '卖出价': event.type === 'sell' ? event.per_share : null,
      '股票派息': event.type === 'dividend' ? event.per_share : null,
      'Amount': event.gross_amount,
      'Withholding Tax': event.withholding_tax,
      'Transaction Tax': event.transaction_tax,
      'Fees': event.fees,
      'Net Amount': event.net_amount,
    }));
  const dfCorp = result.ordered_events.filter(event => event.type === 'corporate_action')
    .map(sourceRecord);
  const dfAssets = result.positions.map(position => ({
    Ticker: position.ticker,
    '名称': position.name,
    '现有股数': position.quantity,
    [`总买入成本 (${currency})`]: position.buy_cost,
    [`总卖出收入 (${currency})`]: position.sell_proceeds,
    [`股息收入 (${currency})`]: position.dividend_income,
    [`净成本 (${currency})`]: position.net_cost,
  }));
  return {
    currency,
    rec: records,
    df_cashflow: dfCashflow,
    df_cash: dfCash,
    df_equity: dfEquity,
    df_liability: dfLiability,
    df_transaction: dfTransaction,
    df_corp: dfCorp,
    df_assets: dfAssets,
    cash: result.cash.amount,
    liability: result.liability.amount,
    units: result.units.total,
    positions: result.positions.map(position => ({
      t: position.ticker,
      n: position.name,
      q: position.quantity,
      buyCost: position.buy_cost,
      sellProceeds: position.sell_proceeds,
      dividend: position.dividend_income,
      netCost: position.net_cost,
    })),
  };
}

export function replayPortfolioLedger(rawEvents, options = {}) {
  const decimals = normalizeDecimals(options.currency_decimals);
  const validation = validateLedgerEvents(rawEvents, { currency_decimals: decimals });
  if (!validation.valid && options.strict !== false) {
    throw new LedgerValidationError(validation.errors);
  }

  const checks = [...validation.errors, ...validation.warnings];
  const candidates = validation.events.map((event, index) => ({ ...event, _input_index: index }));
  const pendingEvents = candidates.filter(event => event.status === 'pending');
  const replayable = candidates.filter(event =>
    event.status === 'confirmed' || (options.include_pending === true && event.status === 'pending'));
  const seenIds = new Set();
  const unique = [];
  for (const event of replayable) {
    if (event.event_id && seenIds.has(event.event_id)) {
      addCheck(checks, event, 'DUPLICATE_EVENT_ID',
        `duplicate event_id ${event.event_id} was ignored`, 'warning');
      continue;
    }
    if (event.event_id) seenIds.add(event.event_id);
    unique.push(event);
  }
  const eventMap = new Map(unique.filter(event => event.event_id)
    .map(event => [event.event_id, event]));
  assignMonthlyTradeNumbers(unique);
  unique.sort((left, right) => compareEvents(left, right, eventMap));

  const state = {
    cashMinor: normalizeOpeningMoney(options, 'opening_cash', decimals),
    liabilityMinor: normalizeOpeningMoney(options, 'opening_liability', decimals),
    units: roundNumber(Number(options.opening_units || 0)),
    shareholders: new Map(),
    positions: new Map(),
    cashChain: [],
    unitChain: [],
    liabilityChain: [],
    checks,
    appliedById: new Map(),
    reversedIds: new Set(),
    corporateActionPrices: normalizeCorporateActionPriceRows(options.corporate_action_prices),
  };
  if (!Number.isFinite(state.units)) {
    throw new LedgerValidationError([
      issue('INVALID_OPENING_UNITS', 'opening_units', 'opening_units must be finite'),
    ]);
  }
  if (options.opening_shareholders && typeof options.opening_shareholders === 'object') {
    for (const [name, units] of Object.entries(options.opening_shareholders)) {
      if (!Number.isFinite(Number(units))) {
        throw new LedgerValidationError([
          issue('INVALID_OPENING_SHAREHOLDER_UNITS', 'opening_shareholders',
            'all opening shareholder units must be finite'),
        ]);
      }
      state.shareholders.set(name, roundNumber(Number(units)));
    }
  }

  for (const event of unique) {
    applyEvent(state, event, decimals);
    if (event.event_id && event.type !== 'reversal') state.appliedById.set(event.event_id, event);
  }

  const orderedEvents = unique.map(({ _input_index, ...event }) => event);
  const liabilityStatement = buildLiabilityStatement(
    orderedEvents,
    decimals,
    options.as_of_date,
  );
  const positions = Array.from(state.positions.values())
    .filter(position => Math.abs(position.quantity) > 1e-12 ||
      position.buy_cost_minor !== 0 || position.sell_proceeds_minor !== 0 ||
      position.dividend_income_minor !== 0)
    .sort((left, right) => left.ticker.localeCompare(right.ticker))
    .map(position => serializePosition(position, decimals));
  const shareholders = Array.from(state.shareholders, ([shareholder, units]) => ({ shareholder, units }))
    .sort((left, right) => left.shareholder.localeCompare(right.shareholder));
  const result = {
    schema_version: LEDGER_SCHEMA_VERSION,
    currency: String(options.currency || 'USD').toUpperCase(),
    currency_decimals: decimals,
    ok: !state.checks.some(item => ['error', 'fatal'].includes(item.severity)),
    ordered_events: orderedEvents,
    pending_events: pendingEvents.map(({ _input_index, ...event }) => event),
    cash_chain: state.cashChain,
    unit_chain: state.unitChain,
    liability_chain: state.liabilityChain,
    liability_statement: liabilityStatement,
    positions,
    shareholders,
    units: { total: state.units, by_shareholder: shareholders },
    cash: moneyObject(state.cashMinor, decimals),
    liability: moneyObject(state.liabilityMinor, decimals),
    checks: state.checks,
  };
  result.cash_balance = result.cash.amount;
  result.cash_balance_decimal = result.cash.decimal;
  result.cash_balance_minor = result.cash.minor;
  result.liability_balance = result.liability.amount;
  result.liability_balance_decimal = result.liability.decimal;
  result.liability_balance_minor = result.liability.minor;
  result.total_units = result.units.total;
  result.python_projection = projectPythonCompatibility(result, options);
  return result;
}

function positionDelta(before, after) {
  const beforeMap = new Map(before.positions.map(position => [position.ticker, position]));
  const afterMap = new Map(after.positions.map(position => [position.ticker, position]));
  return Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort().map(ticker => {
    const left = beforeMap.get(ticker);
    const right = afterMap.get(ticker);
    return {
      ticker,
      quantity_change: roundNumber((right?.quantity || 0) - (left?.quantity || 0)),
      buy_cost_minor_change: (right?.buy_cost_minor || 0) - (left?.buy_cost_minor || 0),
      sell_proceeds_minor_change:
        (right?.sell_proceeds_minor || 0) - (left?.sell_proceeds_minor || 0),
      dividend_income_minor_change:
        (right?.dividend_income_minor || 0) - (left?.dividend_income_minor || 0),
    };
  }).filter(delta => delta.quantity_change !== 0 || delta.buy_cost_minor_change !== 0 ||
    delta.sell_proceeds_minor_change !== 0 || delta.dividend_income_minor_change !== 0);
}

export function previewPortfolioEvent(rawEvents, draftEventOrEvents, options = {}) {
  const drafts = Array.isArray(draftEventOrEvents) ? draftEventOrEvents : [draftEventOrEvents];
  const validation = validateLedgerEvents(drafts, options);
  const before = replayPortfolioLedger(rawEvents, options);
  if (!validation.valid) {
    return {
      ok: false,
      validation,
      before: stateSummary(before),
      after: null,
      delta: null,
    };
  }
  const confirmedDrafts = validation.events.map(event => ({ ...event, status: 'confirmed' }));
  const after = replayPortfolioLedger([...rawEvents, ...confirmedDrafts], options);
  return {
    ok: after.ok,
    validation,
    operations: confirmedDrafts,
    before: stateSummary(before),
    after: stateSummary(after),
    delta: {
      cash_minor: after.cash.minor - before.cash.minor,
      liability_minor: after.liability.minor - before.liability.minor,
      units: roundNumber(after.units.total - before.units.total),
      positions: positionDelta(before, after),
    },
  };
}

export const validateEvent = validateLedgerEvent;
export const normalizeEvent = normalizeLedgerEvent;
export const replayLedger = replayPortfolioLedger;
export const previewLedgerEvent = previewPortfolioEvent;
export const pythonCompatibleProjection = projectPythonCompatibility;
