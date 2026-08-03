import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LedgerValidationError,
  normalizeLedgerEvent,
  previewPortfolioEvent,
  replayPortfolioLedger,
  validateLedgerEvent,
} from '../worker/portfolio-ledger.js';

const capital = (overrides = {}) => ({
  event_id: 'capital-1',
  type: 'capital',
  date: '2026-01-02',
  sequence: 1,
  shareholder: 'Investor A',
  subscription: '1000.00',
  redemption: '0.00',
  unit_price: '10.00',
  ...overrides,
});

const buy = (overrides = {}) => ({
  event_id: 'buy-1',
  type: 'buy',
  date: '2026-01-02',
  sequence: 2,
  ticker: 'AAA',
  name: 'Alpha',
  quantity: 10,
  gross_amount: '100.00',
  ...overrides,
});

test('tax-aware trades use recorded Amount, expose exact minor/decimal forms and accumulate net economics', () => {
  const result = replayPortfolioLedger([
    {
      event_id: 'div-1',
      type: 'dividend',
      date: '2026-01-04',
      sequence: 4,
      ticker: 'AAA',
      quantity: 8,
      gross_amount: '10.00',
      withholding_tax: '1.00',
      fees: '1.00',
    },
    {
      event_id: 'sell-1',
      type: 'sell',
      date: '2026-01-03',
      sequence: 3,
      ticker: 'AAA',
      quantity: 2,
      gross_amount: '30.00',
      withholding_tax: '3.00',
      transaction_tax: '1.00',
      fees: '1.00',
    },
    buy({
      price: 999,
      transaction_tax: '1.00',
      fees: '2.00',
    }),
    capital(),
  ]);

  assert.equal(result.cash.minor, 93000);
  assert.equal(result.cash.decimal, '930.00');
  assert.equal(result.cash.amount, 930);
  assert.deepEqual(result.cash_chain.map(row => row.cash_change_minor), [100000, -10300, 2500, 800]);

  const normalizedBuy = result.ordered_events.find(event => event.type === 'buy');
  assert.equal(normalizedBuy.gross_amount_minor, 10000);
  assert.equal(normalizedBuy.gross_amount_decimal, '100.00');
  assert.equal(normalizedBuy.net_amount_minor, 10300);
  assert.equal(normalizedBuy.per_share, 10.3);
  assert.equal(normalizedBuy.gross_per_share, 10);
  assert.notEqual(normalizedBuy.per_share, normalizedBuy.price);

  assert.deepEqual(result.positions.map(position => ({
    ticker: position.ticker,
    quantity: position.quantity,
    buy: position.buy_cost_minor,
    sell: position.sell_proceeds_minor,
    dividend: position.dividend_income_minor,
  })), [{ ticker: 'AAA', quantity: 8, buy: 10300, sell: 2500, dividend: 800 }]);
  assert.equal(result.positions[0].total_shares_bought, 10);
  assert.equal(result.positions[0].fallback_price, 10.3);
  assert.equal(result.positions[0].reference_price, 10.3);
  assert.equal(result.positions[0].total_buy_cost_minor, 10300);
  assert.equal(result.python_projection.rec.buy[0].Amount, 103);
  assert.equal(result.python_projection.rec.buy[0].GrossAmount, 100);
  assert.equal(result.python_projection.df_cashflow.at(-1)['Cash After (USD)'], 930);
});

test('same-day replay follows Capital, Liability, Corporate Action, Buy/Sell, Dividend, Fund Action', () => {
  const date = '2026-02-02';
  const events = [
    {
      event_id: 'fund-1', type: 'fund_action', date, sequence: 99,
      action_type: 'DISTRIBUTION', cash_amount: '-2.00',
    },
    {
      event_id: 'div-1', type: 'dividend', date, sequence: 99,
      ticker: 'NEW', quantity: 1, gross_amount: '1.00',
    },
    {
      event_id: 'sell-1', type: 'sell', date, sequence: 99,
      ticker: 'NEW', quantity: 1, gross_amount: '10.00',
    },
    {
      event_id: 'buy-1', type: 'buy', date, sequence: 99,
      ticker: 'NEW', quantity: 1, gross_amount: '8.00',
    },
    {
      event_id: 'corp-1', type: 'corporate_action', date, sequence: 99,
      ticker: 'OLD', action_type: 'RENAME', pre_quantity: 1,
      outputs: [{ ticker: 'NEW', quantity: 1 }],
    },
    {
      event_id: 'liability-1', type: 'liability', date, sequence: 99,
      change: '20.00', interest: '1.00',
    },
    capital({ event_id: 'capital-same-day', date, sequence: 99, subscription: '100.00' }),
    buy({ event_id: 'seed-old', date: '2026-02-01', ticker: 'OLD', quantity: 1,
      gross_amount: '5.00' }),
  ];
  const result = replayPortfolioLedger(events);

  assert.deepEqual(result.ordered_events.filter(event => event.date === date).map(event => event.type), [
    'capital', 'liability', 'corporate_action', 'sell', 'buy', 'dividend', 'fund_action',
  ]);
  assert.equal(result.positions.find(position => position.ticker === 'NEW').quantity, 1);
  assert.equal(result.checks.some(check => check.code === 'CORPORATE_ACTION_SOURCE_MISSING'), false);
  assert.equal(result.cash_chain.some(row => row.source_type === 'corporate_action'), false);
  assert.deepEqual(result.cash_chain.filter(row => row.date === date && ['buy', 'sell'].includes(row.source_type))
    .map(row => [row.source_type, row.sequence]), [['sell', 1], ['buy', 2]]);
});

test('oversell and negative cash remain visible as checks instead of being silently repaired', () => {
  const result = replayPortfolioLedger([
    buy({ event_id: 'unfunded-buy', quantity: 2, gross_amount: '50.00' }),
    {
      event_id: 'oversell',
      type: 'sell',
      date: '2026-01-03',
      ticker: 'AAA',
      quantity: 3,
      gross_amount: '60.00',
    },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.checks.some(check => check.code === 'NEGATIVE_CASH'), true);
  assert.equal(result.checks.some(check => check.code === 'OVERSELL'), true);
  assert.equal(result.positions[0].quantity, -1);
});

test('SPLIT and SPINOFF replace quantities and auto-allocate cost from action-date market values', () => {
  const result = replayPortfolioLedger([
    capital(),
    buy(),
    {
      event_id: 'split-1',
      type: 'corporate_action',
      date: '2026-01-03',
      sequence: 1,
      ticker: 'AAA',
      action_type: 'SPLIT',
      pre_quantity: 10,
      split_ratio: 2,
    },
    {
      event_id: 'spinoff-1',
      type: 'corporate_action',
      date: '2026-01-04',
      sequence: 1,
      ticker: 'AAA',
      action_type: 'SPINOFF',
      pre_quantity: 20,
      outputs: [
        { ticker: 'AAA', quantity: 20 },
        { ticker: 'BBB', quantity: 5 },
      ],
    },
  ], {
    corporate_action_prices: [
      { ticker: 'AAA', date: '2026-01-04', price: 4 },
      { ticker: 'BBB', date: '2026-01-05', price: 4 },
    ],
  });

  assert.deepEqual(result.positions.map(position => ({
    ticker: position.ticker,
    quantity: position.quantity,
    cost: position.buy_cost_minor,
  })), [
    { ticker: 'AAA', quantity: 20, cost: 8000 },
    { ticker: 'BBB', quantity: 5, cost: 2000 },
  ]);

  const noAllocation = {
    event_id: 'spinoff-no-evidence',
    type: 'corporate_action',
    date: '2026-01-03',
    ticker: 'AAA',
    action_type: 'SPINOFF',
    outputs: [
      { ticker: 'AAA', quantity: 10 },
      { ticker: 'BBB', quantity: 2 },
    ],
  };
  const valid = validateLedgerEvent(noAllocation);
  assert.equal(valid.valid, true);
  const fallback = replayPortfolioLedger([buy(), noAllocation]);
  assert.deepEqual(fallback.positions.map(position => ({
    ticker: position.ticker,
    quantity: position.quantity,
    cost: position.buy_cost_minor,
  })), [
    { ticker: 'AAA', quantity: 10, cost: 10000 },
    { ticker: 'BBB', quantity: 2, cost: 0 },
  ]);
  assert.equal(fallback.checks.some(check =>
    check.code === 'CORPORATE_ACTION_PRICE_FALLBACK' && check.severity === 'warning'), true);
});

test('capital units and fund split replay chronologically for total and shareholder units', () => {
  const result = replayPortfolioLedger([
    capital(),
    {
      event_id: 'unit-split',
      type: 'fund_action',
      date: '2026-01-03',
      sequence: 1,
      action_type: 'UNIT_SPLIT',
      pre_units: 100,
      post_units: 200,
    },
    capital({
      event_id: 'capital-2',
      date: '2026-01-04',
      shareholder: 'Investor B',
      subscription: '100.00',
      unit_price: '10.00',
    }),
  ]);

  assert.equal(result.units.total, 210);
  assert.deepEqual(result.shareholders, [
    { shareholder: 'Investor A', units: 200 },
    { shareholder: 'Investor B', units: 10 },
  ]);

  const precise = replayPortfolioLedger([
    capital({ subscription: '100.00', unit_price: '0.123456' }),
  ]);
  assert.equal(precise.units.total, 810.005184);
  assert.equal(precise.ordered_events[0].unit_price, 0.123456);
  assert.equal(precise.ordered_events[0].unit_price_decimal, '0.123456');

  const highPrecision = normalizeLedgerEvent(capital({
    subscription: '100.00', unit_price: '0.14286718151075',
  }));
  const normalizedAgain = normalizeLedgerEvent(highPrecision);
  assert.equal(highPrecision.unit_price, 0.14286718151075);
  assert.equal(normalizedAgain.unit_price, highPrecision.unit_price);
  assert.equal(normalizedAgain.units_delta, highPrecision.units_delta);
});

test('liability cash equals change minus interest while balance changes by principal only', () => {
  const result = replayPortfolioLedger([
    {
      event_id: 'loan-1',
      type: 'liability',
      date: '2026-01-02',
      change: '100.00',
      interest: '2.50',
    },
    {
      event_id: 'loan-2',
      type: 'liability',
      date: '2026-01-03',
      change: '-20.00',
      interest: '1.00',
    },
  ]);

  assert.equal(result.cash.decimal, '76.50');
  assert.equal(result.liability.decimal, '80.00');
  assert.equal(result.liability_chain[0].interest_decimal, '2.50');
});

test('Liability Statement is a continuous monthly roll-forward through the requested as-of month', () => {
  const result = replayPortfolioLedger([
    {
      event_id: 'loan-jan', type: 'liability', date: '2026-01-15',
      change: '100.00', interest: '2.00',
    },
    {
      event_id: 'loan-mar', type: 'liability', date: '2026-03-01',
      change: '-25.00', interest: '3.00',
    },
  ], { as_of_date: '2026-04-30' });
  assert.deepEqual(result.liability_statement.map(row => ({
    month: row.month,
    opening: row.opening_liability,
    interest: row.interest_paid,
    change: row.liability_change,
    closing: row.closing_liability,
  })), [
    { month: '2026-01', opening: 0, interest: 2, change: 100, closing: 100 },
    { month: '2026-02', opening: 100, interest: 0, change: 0, closing: 100 },
    { month: '2026-03', opening: 100, interest: 3, change: -25, closing: 75 },
    { month: '2026-04', opening: 75, interest: 0, change: 0, closing: 75 },
  ]);
});

test('Fund Action negative cash is classified once as dividend or management fee', () => {
  const result = replayPortfolioLedger([
    { event_id: 'fund-div', type: 'fund_action', date: '2026-01-02',
      action_type: 'FUND DIVIDEND', cash_amount: '-10.00' },
    { event_id: 'fund-fee', type: 'fund_action', date: '2026-01-03',
      action_type: 'MGMT FEE', cash_amount: '-2.00' },
    { event_id: 'fund-positive', type: 'fund_action', date: '2026-01-04',
      action_type: 'OTHER', cash_amount: '5.00' },
  ], { opening_cash: '20.00' });
  const rows = result.python_projection.df_cash;
  assert.deepEqual(rows.map(row => [row['基金派息'], row['管理费']]), [
    [10, null], [null, 2], [null, null],
  ]);
  assert.equal(result.cash.amount, 13);
});

test('explicit event ids are idempotent and replay has no time- or input-mutation dependency', () => {
  const events = [capital(), buy()];
  const original = structuredClone(events);
  const once = replayPortfolioLedger(events);
  const twice = replayPortfolioLedger(events);
  assert.deepEqual(twice, once);
  assert.deepEqual(events, original);

  const duplicate = replayPortfolioLedger([...events, structuredClone(buy())]);
  assert.equal(duplicate.positions[0].quantity, 10);
  assert.equal(duplicate.checks.some(check => check.code === 'DUPLICATE_EVENT_ID'), true);
});

test('REVERSAL precisely negates supported immutable events and corrected event can follow', () => {
  const originalBuy = buy({ transaction_tax: '1.00', fees: '2.00' });
  const result = replayPortfolioLedger([
    capital(),
    originalBuy,
    {
      event_id: 'reverse-buy-1',
      type: 'REVERSAL',
      date: '2026-01-02',
      sequence: 3,
      reversal_of_event_id: 'buy-1',
    },
    buy({
      event_id: 'buy-1-corrected',
      sequence: 4,
      quantity: 8,
      gross_amount: '80.00',
      transaction_tax: '0.80',
      fees: '1.20',
    }),
  ]);

  assert.equal(result.positions[0].quantity, 8);
  assert.equal(result.positions[0].buy_cost_decimal, '82.00');
  assert.equal(result.cash.decimal, '918.00');
  assert.deepEqual(result.cash_chain.map(row => row.cash_change_decimal), [
    '1000.00', '-103.00', '103.00', '-82.00',
  ]);

  const unsafe = validateLedgerEvent({
    event_id: 'reverse-ca',
    type: 'reversal',
    date: '2026-01-04',
    original_event: {
      event_id: 'ca-1',
      type: 'corporate_action',
      date: '2026-01-03',
      ticker: 'AAA',
      action_type: 'RENAME',
      outputs: [{ ticker: 'BBB', quantity: 10 }],
    },
  });
  assert.equal(unsafe.valid, false);
  assert.equal(unsafe.errors.some(error => error.code === 'CORPORATE_ACTION_REVERSAL_UNSAFE'), true);
});

test('pending events stay outside confirmed state and preview returns auditable operations and deltas', () => {
  const pendingBuy = buy({ status: 'pending' });
  const result = replayPortfolioLedger([capital(), pendingBuy]);
  assert.equal(result.positions.length, 0);
  assert.equal(result.pending_events.length, 1);

  const preview = previewPortfolioEvent([capital()], pendingBuy);
  assert.equal(preview.validation.valid, true);
  assert.equal(preview.operations[0].status, 'confirmed');
  assert.equal(preview.delta.cash_minor, -10000);
  assert.equal(preview.delta.positions[0].quantity_change, 10);
});

test('minor and major representations must agree and excess decimal precision is rejected', () => {
  const normalized = normalizeLedgerEvent(buy({
    gross_amount: '12.34',
    gross_amount_minor: 1234,
    quantity: 2,
  }));
  assert.equal(normalized.gross_amount_decimal, '12.34');
  assert.equal(normalized.per_share_decimal, '6.17000000');

  assert.throws(() => normalizeLedgerEvent(buy({
    gross_amount: '12.34',
    gross_amount_minor: 1235,
  })), LedgerValidationError);
  assert.throws(() => normalizeLedgerEvent(buy({ gross_amount: '12.345' })), LedgerValidationError);
});

test('database aggregate money aliases and Excel cash_change fields normalize without losing tax', () => {
  const taxedSell = normalizeLedgerEvent({
    event_id: 'sell-alias',
    type: 'SELL',
    trade_date: '2026-06-01',
    sequence_no: 7,
    ticker: 'AAA',
    quantity: 2,
    gross_amount: '20.00',
    tax_amount: '1.25',
    fee_amount: '0.75',
    net_amount: '18.00',
  });
  assert.equal(taxedSell.transaction_tax_minor, 125);
  assert.equal(taxedSell.tax_amount_minor, 125);
  assert.equal(taxedSell.fees_minor, 75);
  assert.equal(taxedSell.fee_amount_minor, 75);
  assert.equal(taxedSell.net_cash_minor, 1800);
  assert.equal(taxedSell.sequence, 7);

  const cashActions = replayPortfolioLedger([
    {
      event_id: 'corp-cash', type: 'CORPORATE_ACTION', date: '2026-06-01',
      ticker: 'AAA', corporate_action_type: 'RENAME',
      post_ticker: 'BBB', post_quantity: 0, cash_change: '4.50',
    },
    {
      event_id: 'fund-cash', type: 'FUND_ACTION', date: '2026-06-02',
      fund_action_type: 'MGMT FEE', cash_change: '-1.50',
    },
  ]);
  assert.equal(cashActions.cash.decimal, '3.00');
});

test('canonical normalization is idempotent for inferred-gross trade and cash actions', () => {
  const rawEvents = [
    {
      event_id: 'canonical-buy', type: 'BUY', date: '2026-06-01',
      ticker: 'AAA', quantity: 2, amount: '20.00',
    },
    {
      event_id: 'canonical-fund', type: 'FUND_ACTION', date: '2026-06-02',
      fund_action_type: 'MGMT FEE', cash_amount: '-10.00',
    },
    {
      event_id: 'canonical-corp', type: 'CORPORATE_ACTION', date: '2026-06-03',
      ticker: 'AAA', corporate_action_type: 'RENAME',
      post_ticker: 'BBB', post_quantity: 2, cash_amount: '5.00',
    },
  ];
  for (const raw of rawEvents) {
    const once = normalizeLedgerEvent(raw);
    const twice = normalizeLedgerEvent(once);
    assert.equal(once.gross_amount_inferred, true);
    assert.deepEqual(twice, once);
  }
});

test('UNKNOWN_LEGACY and PENDING_RECONFIRMATION replay operational Amount without inventing tax facts', () => {
  const legacy = normalizeLedgerEvent({
    event_id: 'legacy-buy',
    type: 'BUY',
    date: '2025-01-02',
    ticker: 'OLD',
    quantity: 5,
    tax_status: 'UNKNOWN_LEGACY',
    net_amount: '50.00',
    net_cash: '-50.00',
    Amount: '50.00',
  });
  assert.equal(legacy.gross_amount, null);
  assert.equal(legacy.gross_amount_minor, null);
  assert.equal(legacy.tax_amount, null);
  assert.equal(legacy.fees, null);
  assert.equal(legacy.operational_amount_decimal, '50.00');
  assert.equal(legacy.amount_decimal, '50.00');
  assert.equal(legacy.per_share, 10);

  const result = replayPortfolioLedger([legacy], { opening_cash: '100.00' });
  assert.equal(result.cash.decimal, '50.00');
  assert.equal(result.positions[0].buy_cost_decimal, '50.00');
  assert.equal(result.positions[0].gross_buy_amount, null);
  assert.equal(result.positions[0].fallback_price, 10);
  assert.equal(result.positions[0].fallback_price_source,
    'operational_buy_amount');

  const staged = normalizeLedgerEvent({
    event_id: 'excel-new-row',
    type: 'SELL',
    date: '2026-07-01',
    status: 'pending',
    ticker: 'AAA',
    quantity: 1,
    amount: '9.00',
    net_amount: '9.00',
    net_cash: '9.00',
    tax_status: 'PENDING_RECONFIRMATION',
    tax_review_required: true,
    tax_review_reason: 'New Excel row has no tax facts',
  });
  assert.equal(staged.gross_amount, null);
  assert.equal(staged.tax_amount, null);
  assert.equal(staged.fees, null);
  assert.equal(staged.tax_review_required, true);
  assert.equal(staged.tax_review_reason, 'New Excel row has no tax facts');
  const reviewPreview = previewPortfolioEvent([], staged);
  assert.equal(reviewPreview.ok, false);
  assert.equal(reviewPreview.after.checks.some(check =>
    check.code === 'TAX_REVIEW_REQUIRED'), true);

  for (const cashEvent of [
    {
      event_id: 'pending-corp-cash', type: 'CORPORATE_ACTION', date: '2026-07-02',
      ticker: 'AAA', corporate_action_type: 'RENAME', post_ticker: 'BBB',
      post_quantity: 1, cash_change: '3.00', tax_status: 'PENDING_RECONFIRMATION',
      tax_review_required: true,
    },
    {
      event_id: 'pending-fund-cash', type: 'FUND_ACTION', date: '2026-07-02',
      fund_action_type: 'MGMT FEE', cash_change: '-2.00',
      tax_status: 'PENDING_RECONFIRMATION', tax_review_required: true,
    },
  ]) {
    const normalized = normalizeLedgerEvent(cashEvent);
    assert.equal(normalized.gross_amount, null);
    assert.equal(normalized.tax_amount, null);
    assert.equal(normalized.fees, null);
    assert.equal(normalized.cash_change, cashEvent.type === 'FUND_ACTION' ? -2 : 3);
  }
});
