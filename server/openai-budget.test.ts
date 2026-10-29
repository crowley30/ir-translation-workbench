import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from './store.js';
import {
  BudgetError,
  MAX_BUDGET_ATTEMPTS,
  OpenAIBudgetLedger,
  parseUsdToMicros,
  tokenCostMicros,
  type BudgetSettingsStore,
} from './openai-budget.js';

const model = 'synthetic-priced-model';
const price = { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 };
const prices = { [model]: price };
const input = { model, inputTokensUpperBound: 10, maxOutputTokens: 20 };
const usage = { input_tokens: 5, output_tokens: 8, total_tokens: 13 };

function memoryStore(): BudgetSettingsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    getSetting: (key) => values.get(key),
    setSetting: (key, value) => values.set(key, structuredClone(value)),
  };
}

function setup(budgetMicros = 100, operatorCapMicros = 1_000) {
  const store = memoryStore();
  const ledger = new OpenAIBudgetLedger(store, { operatorCapMicros, prices });
  ledger.arm({ budgetMicros, acknowledgeCosts: true });
  return { store, ledger };
}

function code(work: () => unknown, expected: string): void {
  try {
    work();
    throw new Error('Expected a budget rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetError);
    expect((error as BudgetError).code).toBe(expected);
  }
}

describe('exact conservative USD arithmetic', () => {
  it.each([
    ['0', 0],
    ['1', 1_000_000],
    ['0.000001', 1],
    ['0.1', 100_000],
    ['1.230000', 1_230_000],
    ['99999999.999999', 99_999_999_999_999],
  ])('parses %s without floating point USD multiplication', (value, expected) => {
    expect(parseUsdToMicros(value)).toBe(expected);
  });

  it.each(['', ' 1', '1 ', '-1', '+1', '01', '1e0', '.1', '1.', '0.0000001', 'NaN', 1, null])(
    'rejects ambiguous or invalid USD amount %s',
    (value) => code(() => parseUsdToMicros(value), 'INVALID_BUDGET_AMOUNT'),
  );

  it('rounds each direction upward, including sub-micro prices', () => {
    expect(tokenCostMicros({ inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 }, 1, 1)).toBe(2);
    expect(tokenCostMicros(price, 10, 20)).toBe(50);
    expect(tokenCostMicros(price, 0, 0)).toBe(0);
  });

  it.each([
    { inputMicrosPerMillion: 0, outputMicrosPerMillion: 1 },
    { inputMicrosPerMillion: 1, outputMicrosPerMillion: -1 },
    { inputMicrosPerMillion: 0.1, outputMicrosPerMillion: 1 },
    { inputMicrosPerMillion: Number.NaN, outputMicrosPerMillion: 1 },
  ])('rejects unreliable price %j', (invalid) => {
    code(() => tokenCostMicros(invalid, 1, 1), 'INVALID_BUDGET_PRICE');
  });

  it('rejects unsafe integer totals rather than rounding or overflowing', () => {
    code(
      () =>
        tokenCostMicros(
          {
            inputMicrosPerMillion: Number.MAX_SAFE_INTEGER,
            outputMicrosPerMillion: Number.MAX_SAFE_INTEGER,
          },
          1_000_000_000,
          1_000_000_000,
        ),
      'BUDGET_UNAVAILABLE',
    );
  });
});

describe('explicit cumulative budget gate', () => {
  it('defaults the operator cap to zero and never arms implicitly', () => {
    const ledger = new OpenAIBudgetLedger(memoryStore(), { prices });
    expect(ledger.summary()).toMatchObject({
      initialized: false,
      armed: false,
      operatorCapMicros: 0,
      budgetMicros: 0,
      remainingMicros: 0,
    });
    code(() => ledger.arm({ budgetMicros: 1, acknowledgeCosts: true }), 'BUDGET_OPERATOR_GATE');
    code(() => ledger.reserve(input), 'BUDGET_NOT_ARMED');
  });

  it.each([Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'invalid operator cap %s fails closed',
    (operatorCapMicros) => {
      const ledger = new OpenAIBudgetLedger(memoryStore(), { operatorCapMicros, prices });
      expect(ledger.summary().operatorCapMicros).toBe(0);
      code(() => ledger.arm({ budgetMicros: 1, acknowledgeCosts: true }), 'BUDGET_OPERATOR_GATE');
    },
  );

  it.each([0, -1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid budget amount %s',
    (budgetMicros) => {
      const ledger = new OpenAIBudgetLedger(memoryStore(), { operatorCapMicros: 1_000, prices });
      code(() => ledger.arm({ budgetMicros, acknowledgeCosts: true }), 'INVALID_BUDGET_AMOUNT');
      expect(ledger.summary().initialized).toBe(false);
    },
  );

  it('requires actual boolean acknowledgment and a budget within the server cap', () => {
    const ledger = new OpenAIBudgetLedger(memoryStore(), { operatorCapMicros: 100, prices });
    code(() => ledger.arm({ budgetMicros: 100, acknowledgeCosts: false }), 'INVALID_BUDGET_AMOUNT');
    code(() => ledger.arm({ budgetMicros: 101, acknowledgeCosts: true }), 'BUDGET_OPERATOR_GATE');
    expect(ledger.arm({ budgetMicros: 100, acknowledgeCosts: true })).toMatchObject({
      initialized: true,
      armed: true,
      budgetMicros: 100,
      remainingMicros: 100,
    });
  });

  it('stopping and rearming never resets spent or unknown amounts', () => {
    const { ledger } = setup();
    const first = ledger.reserve(input);
    ledger.settle(first.id, usage);
    const second = ledger.reserve(input);
    ledger.unknown(second.id);
    expect(ledger.disarm()).toMatchObject({ armed: false, spentMicros: 21, reservedMicros: 50 });
    code(() => ledger.reserve(input), 'BUDGET_NOT_ARMED');
    expect(ledger.arm({ budgetMicros: 100, acknowledgeCosts: true })).toMatchObject({
      spentMicros: 21,
      reservedMicros: 50,
      remainingMicros: 29,
    });
    code(() => ledger.arm({ budgetMicros: 101, acknowledgeCosts: true }), 'BUDGET_IMMUTABLE');
    code(() => ledger.arm({ budgetMicros: 99, acknowledgeCosts: true }), 'BUDGET_IMMUTABLE');
    code(() => ledger.reserve(input), 'BUDGET_EXHAUSTED');
  });

  it('only uses the lower current operator cap after restart', () => {
    const { ledger, store } = setup();
    ledger.reserve(input);
    const restarted = new OpenAIBudgetLedger(store, { operatorCapMicros: 40, prices });
    expect(restarted.summary()).toMatchObject({ armed: false, overrun: true, remainingMicros: 0 });
    code(() => restarted.reserve(input), 'BUDGET_EXHAUSTED');
    code(
      () => restarted.arm({ budgetMicros: 100, acknowledgeCosts: true }),
      'BUDGET_OPERATOR_GATE',
    );
    expect(new OpenAIBudgetLedger(store, { prices }).summary().armed).toBe(false);
  });
});

describe('attempt reservations cover concurrent, retried and uncertain requests', () => {
  it('persists a full input and max output reservation before returning', () => {
    const { ledger, store } = setup();
    expect(ledger.reserve(input)).toEqual({ id: 'r00000001', model, reservedMicros: 50 });
    expect(ledger.summary()).toMatchObject({
      spentMicros: 0,
      reservedMicros: 50,
      remainingMicros: 50,
    });
    const restarted = new OpenAIBudgetLedger(store, { operatorCapMicros: 1_000, prices });
    expect(restarted.summary()).toMatchObject({ pendingAttempts: 1, reservedMicros: 50 });
    expect(restarted.reserve(input).id).toBe('r00000002');
    code(() => restarted.reserve(input), 'BUDGET_EXHAUSTED');
  });

  it('parallel promise callers cannot oversubscribe the shared synchronous store', async () => {
    const { ledger, store } = setup(100);
    const otherInstance = new OpenAIBudgetLedger(store, { operatorCapMicros: 100, prices });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() =>
          (index % 2 ? ledger : otherInstance).reserve({ ...input, maxOutputTokens: 10 }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(17);
    expect(ledger.summary()).toMatchObject({
      reservedMicros: 90,
      remainingMicros: 10,
      attempts: 3,
    });
  });

  it('timeout/cancel/network/429/5xx attempts retain their reservations on every retry', () => {
    const { ledger } = setup(150);
    for (const reason of ['timeout', '429', '5xx']) {
      void reason; // All failures with unknown provider usage have the same budget semantics.
      const reservation = ledger.reserve(input);
      ledger.unknown(reservation.id);
    }
    expect(ledger.summary()).toMatchObject({
      reservedMicros: 150,
      spentMicros: 0,
      remainingMicros: 0,
      unknownAttempts: 3,
    });
    code(() => ledger.reserve(input), 'BUDGET_EXHAUSTED');
  });

  it('does not call an async service or store provider material', () => {
    const { ledger, store } = setup();
    const reservation = ledger.reserve(input);
    ledger.unknown(reservation.id);
    expect(JSON.stringify([...store.values])).not.toMatch(
      /source|prompt|apiKey|Authorization|Bearer/,
    );
    expect(Object.keys(ledger.summary()).sort()).toEqual(
      [
        'initialized',
        'armed',
        'budgetMicros',
        'spentMicros',
        'reservedMicros',
        'remainingMicros',
        'operatorCapMicros',
        'overrun',
        'attempts',
        'pendingAttempts',
        'unknownAttempts',
      ].sort(),
    );
  });

  it('unknown or malformed model pricing prevents any reservation', () => {
    const { ledger } = setup();
    code(() => ledger.reserve({ ...input, model: 'unknown-model' }), 'UNKNOWN_MODEL_PRICE');
    const invalid = new OpenAIBudgetLedger(memoryStore(), {
      operatorCapMicros: 100,
      prices: { [model]: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 1 } },
    });
    invalid.arm({ budgetMicros: 100, acknowledgeCosts: true });
    code(() => invalid.reserve(input), 'UNKNOWN_MODEL_PRICE');
    expect(ledger.summary().attempts).toBe(0);
  });

  it.each([0, -1, 1.2, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 1_000_000_001])(
    'rejects invalid input bound %s without consuming budget',
    (inputTokensUpperBound) => {
      const { ledger } = setup();
      code(() => ledger.reserve({ ...input, inputTokensUpperBound }), 'INVALID_BUDGET_PRICE');
      expect(ledger.summary().attempts).toBe(0);
    },
  );

  it('copies the injected price registry, so later mutation cannot lower reservations', () => {
    const mutable = { [model]: { ...price } };
    const ledger = new OpenAIBudgetLedger(memoryStore(), {
      operatorCapMicros: 100,
      prices: mutable,
    });
    ledger.arm({ budgetMicros: 100, acknowledgeCosts: true });
    mutable[model].outputMicrosPerMillion = 1;
    expect(ledger.reserve(input).reservedMicros).toBe(50);
  });

  it('never returns permission to send after a failed persistence write', () => {
    const { ledger, store } = setup();
    store.setSetting = () => {
      throw new Error('Synthetic persistence failure');
    };
    code(() => ledger.reserve(input), 'BUDGET_UNAVAILABLE');
    expect(ledger.summary().attempts).toBe(0);
  });
});

describe('usage reconciliation is conservative and immutable', () => {
  it('charges returned valid usage and releases only the proven unused part', () => {
    const { ledger } = setup();
    const reservation = ledger.reserve(input);
    expect(ledger.settle(reservation.id, usage)).toMatchObject({
      spentMicros: 21,
      reservedMicros: 0,
      remainingMicros: 79,
      pendingAttempts: 0,
    });
    ledger.reserve(input);
    expect(ledger.summary().reservedMicros).toBe(50);
  });

  it('accepts documented usage detail fields without storing them', () => {
    const { ledger, store } = setup();
    const reservation = ledger.reserve(input);
    ledger.settle(reservation.id, { ...usage, input_tokens_details: { cached_tokens: 3 } });
    expect(JSON.stringify([...store.values])).not.toContain('cached_tokens');
    expect(ledger.summary().spentMicros).toBe(21); // Cache billed at the conservative input ceiling.
  });

  it.each([
    null,
    {},
    { input_tokens: 1, output_tokens: 2 },
    { input_tokens: 1, output_tokens: 2, total_tokens: 4 },
    { input_tokens: -1, output_tokens: 2, total_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 },
    { input_tokens: '1', output_tokens: 2, total_tokens: 3 },
    { input_tokens: 1, output_tokens: Number.NaN, total_tokens: Number.NaN },
    { input_tokens: 1_000_000_001, output_tokens: 1, total_tokens: 1_000_000_002 },
  ])('malformed usage %j never releases the reservation', (invalid) => {
    const { ledger } = setup();
    const reservation = ledger.reserve(input);
    code(() => ledger.settle(reservation.id, invalid), 'INVALID_BUDGET_USAGE');
    expect(ledger.summary()).toMatchObject({
      reservedMicros: 50,
      spentMicros: 0,
      remainingMicros: 50,
    });
  });

  it('repeated identical settlement is idempotent; conflicting settlement cannot rewrite charges', () => {
    const { ledger } = setup();
    const reservation = ledger.reserve(input);
    const first = ledger.settle(reservation.id, usage);
    expect(ledger.settle(reservation.id, { ...usage })).toEqual(first);
    expect(ledger.unknown(reservation.id)).toEqual(first);
    code(
      () => ledger.settle(reservation.id, { input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
      'RESERVATION_ALREADY_SETTLED',
    );
    expect(ledger.summary()).toEqual(first);
  });

  it('an unknown result keeps its full hold and may only reconcile against later valid usage', () => {
    const { ledger } = setup();
    const reservation = ledger.reserve(input);
    ledger.unknown(reservation.id);
    expect(ledger.unknown(reservation.id)).toMatchObject({
      reservedMicros: 50,
      unknownAttempts: 1,
    });
    expect(ledger.settle(reservation.id, usage)).toMatchObject({
      reservedMicros: 0,
      spentMicros: 21,
      unknownAttempts: 0,
    });
  });

  it('charges all returned actual debt and blocks further calls if usage exceeds the reservation', () => {
    const { ledger } = setup(1_000);
    const reservation = ledger.reserve(input);
    expect(
      ledger.settle(reservation.id, { input_tokens: 20, output_tokens: 40, total_tokens: 60 }),
    ).toMatchObject({
      spentMicros: 100,
      reservedMicros: 0,
      overrun: true,
      armed: false,
      remainingMicros: 0,
    });
    code(() => ledger.reserve(input), 'BUDGET_EXHAUSTED');
    expect(ledger.arm({ budgetMicros: 1_000, acknowledgeCosts: true }).armed).toBe(false);
  });

  it('treats an exceeded token bound as an overrun even when output savings mask cost', () => {
    const { ledger } = setup();
    const reservation = ledger.reserve(input);
    expect(
      ledger.settle(reservation.id, { input_tokens: 11, output_tokens: 0, total_tokens: 11 }),
    ).toMatchObject({
      spentMicros: 11,
      overrun: true,
      remainingMicros: 0,
    });
  });

  it('rejects unrelated reservation IDs without altering another attempt', () => {
    const { ledger } = setup();
    ledger.reserve(input);
    code(() => ledger.settle('r99999999', usage), 'INVALID_RESERVATION');
    code(() => ledger.unknown('r99999999'), 'INVALID_RESERVATION');
    expect(ledger.summary().reservedMicros).toBe(50);
  });
});

describe('persistent history and resource limits', () => {
  it('keeps spent/pending/unknown reservations across an actual SQLite close and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ir-budget-synthetic-'));
    let store: TaskStore | undefined;
    try {
      const path = join(directory, 'synthetic.sqlite');
      store = new TaskStore(path);
      const ledger = new OpenAIBudgetLedger(store, { operatorCapMicros: 1_000, prices });
      ledger.arm({ budgetMicros: 1_000, acknowledgeCosts: true });
      ledger.settle(ledger.reserve(input).id, usage);
      ledger.unknown(ledger.reserve(input).id);
      ledger.reserve(input);
      ledger.disarm();
      store.close();
      store = new TaskStore(path);
      const restarted = new OpenAIBudgetLedger(store, { operatorCapMicros: 1_000, prices });
      expect(restarted.summary()).toMatchObject({
        armed: false,
        spentMicros: 21,
        reservedMicros: 100,
        remainingMicros: 879,
        pendingAttempts: 1,
        unknownAttempts: 1,
      });
      expect(restarted.arm({ budgetMicros: 1_000, acknowledgeCosts: true }).remainingMicros).toBe(
        879,
      );
      expect(restarted.reserve(input).id).toBe('r00000004');
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on corrupt stored state and never silently starts a fresh budget', () => {
    const { ledger, store } = setup();
    ledger.reserve(input);
    const stored = structuredClone([...store.values.values()][0]) as {
      entries: { reservedMicros: number }[];
    };
    stored.entries[0].reservedMicros = 1;
    store.values.set('openai-budget-v1', stored);
    code(() => ledger.summary(), 'BUDGET_UNAVAILABLE');
    code(() => ledger.arm({ budgetMicros: 100, acknowledgeCosts: true }), 'BUDGET_UNAVAILABLE');
    code(() => ledger.reserve(input), 'BUDGET_UNAVAILABLE');
  });

  it('bounded attempt history rejects new requests without deleting uncertain old holds', () => {
    const { ledger, store } = setup(1_000_000, 1_000_000);
    ledger.reserve(input);
    const stored = structuredClone([...store.values.values()][0]) as { entries: { id: string }[] };
    const entry = stored.entries[0];
    stored.entries = Array.from({ length: MAX_BUDGET_ATTEMPTS }, (_, index) => ({
      ...entry,
      id: `r${String(index + 1).padStart(8, '0')}`,
    }));
    store.values.set('openai-budget-v1', stored);
    code(() => ledger.reserve(input), 'BUDGET_HISTORY_LIMIT');
    expect(ledger.summary()).toMatchObject({
      attempts: MAX_BUDGET_ATTEMPTS,
      reservedMicros: 500_000,
    });
  });
});
