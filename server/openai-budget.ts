// One synchronous ledger is shared by a single Node service process. Reserve is
// persisted before any await/network activity. This is a conservative local
// spending guard, not a provider-side billing guarantee or multi-process lock.
export interface BudgetSettingsStore {
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
}

export interface BudgetModelPrice {
  // Integer micro-USD per one million tokens. The caller supplies a verified,
  // conservative price ceiling, including any applicable cache write price.
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}

export interface BudgetUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface BudgetSummary {
  initialized: boolean;
  armed: boolean;
  budgetMicros: number;
  spentMicros: number;
  reservedMicros: number;
  remainingMicros: number;
  operatorCapMicros: number;
  overrun: boolean;
  attempts: number;
  pendingAttempts: number;
  unknownAttempts: number;
}

export interface BudgetReservation {
  id: string;
  model: string;
  reservedMicros: number;
}

interface Entry extends BudgetReservation {
  inputTokensUpperBound: number;
  maxOutputTokens: number;
  price: BudgetModelPrice;
  state: 'pending' | 'unknown' | 'settled';
  usage: BudgetUsage | null;
  chargedMicros: number | null;
}

interface Ledger {
  version: 1;
  budgetMicros: number;
  armed: boolean;
  entries: Entry[];
}

export class BudgetError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}

const KEY = 'openai-budget-v1';
const MILLION = 1_000_000n;
const MAX_TOKENS = 1_000_000_000;
export const MAX_BUDGET_ATTEMPTS = 10_000;

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validPrice(value: unknown): value is BudgetModelPrice {
  return (
    record(value) &&
    safeInteger(value.inputMicrosPerMillion, 1) &&
    safeInteger(value.outputMicrosPerMillion, 1)
  );
}

function validUsage(value: unknown): value is BudgetUsage {
  return (
    record(value) &&
    safeInteger(value.input_tokens) &&
    safeInteger(value.output_tokens) &&
    safeInteger(value.total_tokens) &&
    value.input_tokens <= MAX_TOKENS &&
    value.output_tokens <= MAX_TOKENS &&
    value.total_tokens === value.input_tokens + value.output_tokens
  );
}

function usageCopy(value: BudgetUsage): BudgetUsage {
  return {
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    total_tokens: value.total_tokens,
  };
}

function unavailable(): BudgetError {
  return new BudgetError('BUDGET_UNAVAILABLE', 503, '累计预算记录不可用，真实请求已阻止。');
}

function checkedNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  return Number(value);
}

export function tokenCostMicros(
  price: BudgetModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  if (
    !validPrice(price) ||
    !safeInteger(inputTokens) ||
    !safeInteger(outputTokens) ||
    inputTokens > MAX_TOKENS ||
    outputTokens > MAX_TOKENS
  ) {
    throw new BudgetError(
      'INVALID_BUDGET_PRICE',
      400,
      '模型价格或 token 限额无效，真实请求已阻止。',
    );
  }
  // Round each direction upward; never use floating-point USD multiplication.
  const input =
    (BigInt(inputTokens) * BigInt(price.inputMicrosPerMillion) + MILLION - 1n) / MILLION;
  const output =
    (BigInt(outputTokens) * BigInt(price.outputMicrosPerMillion) + MILLION - 1n) / MILLION;
  return checkedNumber(input + output);
}

export function parseUsdToMicros(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value)) {
    throw new BudgetError('INVALID_BUDGET_AMOUNT', 400, '预算须为最多六位小数的美元金额。');
  }
  const [whole, fraction = ''] = value.split('.');
  return checkedNumber(BigInt(whole) * MILLION + BigInt(fraction.padEnd(6, '0')));
}

export class OpenAIBudgetLedger {
  private readonly operatorCapMicros: number;
  private readonly prices = new Map<string, BudgetModelPrice>();

  constructor(
    private readonly store: BudgetSettingsStore,
    options: {
      operatorCapMicros?: number;
      prices: Readonly<Record<string, BudgetModelPrice>>;
    },
  ) {
    this.operatorCapMicros = safeInteger(options.operatorCapMicros) ? options.operatorCapMicros : 0;
    for (const [model, price] of Object.entries(options.prices)) {
      if (validPrice(price)) {
        this.prices.set(model, {
          inputMicrosPerMillion: price.inputMicrosPerMillion,
          outputMicrosPerMillion: price.outputMicrosPerMillion,
        });
      }
    }
  }

  private read(): Ledger | null {
    try {
      const value = this.store.getSetting(KEY);
      if (value === undefined || value === null) return null;
      if (
        !record(value) ||
        value.version !== 1 ||
        !safeInteger(value.budgetMicros, 1) ||
        typeof value.armed !== 'boolean' ||
        !Array.isArray(value.entries) ||
        value.entries.length > MAX_BUDGET_ATTEMPTS
      ) {
        throw unavailable();
      }
      const entries: Entry[] = [];
      for (const [index, item] of value.entries.entries()) {
        if (
          !record(item) ||
          item.id !== `r${String(index + 1).padStart(8, '0')}` ||
          typeof item.model !== 'string' ||
          item.model.length > 120 ||
          !validPrice(item.price) ||
          !safeInteger(item.inputTokensUpperBound, 1) ||
          !safeInteger(item.maxOutputTokens, 1) ||
          item.inputTokensUpperBound > MAX_TOKENS ||
          item.maxOutputTokens > MAX_TOKENS ||
          !safeInteger(item.reservedMicros, 1) ||
          item.reservedMicros !==
            tokenCostMicros(item.price, item.inputTokensUpperBound, item.maxOutputTokens) ||
          !['pending', 'unknown', 'settled'].includes(item.state as string)
        ) {
          throw unavailable();
        }
        if (
          item.state === 'settled'
            ? !validUsage(item.usage) ||
              item.chargedMicros !==
                tokenCostMicros(item.price, item.usage.input_tokens, item.usage.output_tokens)
            : item.usage !== null || item.chargedMicros !== null
        ) {
          throw unavailable();
        }
        // Return detached values even when a simple in-memory store returns aliases.
        entries.push(structuredClone(item) as unknown as Entry);
      }
      const result: Ledger = {
        version: 1,
        budgetMicros: value.budgetMicros,
        armed: value.armed,
        entries,
      };
      this.totals(result); // Also reject corrupted/overflowed accumulated amounts.
      return result;
    } catch {
      throw unavailable();
    }
  }

  private write(ledger: Ledger): void {
    try {
      this.store.setSetting(KEY, structuredClone(ledger));
    } catch {
      throw unavailable();
    }
  }

  private totals(ledger: Ledger): { spentMicros: number; reservedMicros: number } {
    let spent = 0n;
    let reserved = 0n;
    for (const entry of ledger.entries) {
      if (entry.state === 'settled') spent += BigInt(entry.chargedMicros!);
      else reserved += BigInt(entry.reservedMicros);
    }
    checkedNumber(spent + reserved);
    return { spentMicros: checkedNumber(spent), reservedMicros: checkedNumber(reserved) };
  }

  private summarize(ledger: Ledger | null): BudgetSummary {
    const { spentMicros, reservedMicros } = ledger
      ? this.totals(ledger)
      : { spentMicros: 0, reservedMicros: 0 };
    const limit = Math.min(ledger?.budgetMicros ?? 0, this.operatorCapMicros);
    const used = spentMicros + reservedMicros;
    const overrun =
      (!!ledger && used > limit) ||
      !!ledger?.entries.some(
        (entry) =>
          entry.state === 'settled' &&
          (entry.chargedMicros! > entry.reservedMicros ||
            entry.usage!.input_tokens > entry.inputTokensUpperBound ||
            entry.usage!.output_tokens > entry.maxOutputTokens),
      );
    return {
      initialized: !!ledger,
      armed: !!ledger?.armed && this.operatorCapMicros > 0 && !overrun,
      budgetMicros: ledger?.budgetMicros ?? 0,
      spentMicros,
      reservedMicros,
      remainingMicros: overrun ? 0 : Math.max(0, limit - used),
      operatorCapMicros: this.operatorCapMicros,
      overrun,
      attempts: ledger?.entries.length ?? 0,
      pendingAttempts: ledger?.entries.filter((entry) => entry.state === 'pending').length ?? 0,
      unknownAttempts: ledger?.entries.filter((entry) => entry.state === 'unknown').length ?? 0,
    };
  }

  summary(): BudgetSummary {
    return this.summarize(this.read());
  }

  arm(input: { budgetMicros: number; acknowledgeCosts: boolean }): BudgetSummary {
    if (!safeInteger(input.budgetMicros, 1) || input.acknowledgeCosts !== true) {
      throw new BudgetError('INVALID_BUDGET_AMOUNT', 400, '请明确确认本轮所有请求累计预算。');
    }
    if (this.operatorCapMicros === 0 || input.budgetMicros > this.operatorCapMicros) {
      throw new BudgetError(
        'BUDGET_OPERATOR_GATE',
        403,
        '预算未获服务端允许或超过服务端累计上限。',
      );
    }
    const current = this.read();
    if (current && current.budgetMicros !== input.budgetMicros) {
      throw new BudgetError(
        'BUDGET_IMMUTABLE',
        409,
        '本轮累计预算已固定，停止或重新启用不会重置余额。',
      );
    }
    const ledger: Ledger = current ?? {
      version: 1,
      budgetMicros: input.budgetMicros,
      armed: false,
      entries: [],
    };
    ledger.armed = true;
    this.write(ledger);
    return this.summarize(ledger);
  }

  disarm(): BudgetSummary {
    const ledger = this.read();
    if (ledger) {
      ledger.armed = false;
      this.write(ledger);
    }
    return this.summarize(ledger);
  }

  reserve(input: {
    model: string;
    inputTokensUpperBound: number;
    maxOutputTokens: number;
  }): BudgetReservation {
    const ledger = this.read();
    if (!ledger || !ledger.armed || this.operatorCapMicros === 0) {
      throw new BudgetError('BUDGET_NOT_ARMED', 409, '请先确认并显式启用本轮累计预算。');
    }
    const price = this.prices.get(input.model);
    if (!price || input.model.length > 120) {
      throw new BudgetError(
        'UNKNOWN_MODEL_PRICE',
        409,
        '该模型没有已核实的保守价格，真实请求已阻止。',
      );
    }
    if (!safeInteger(input.inputTokensUpperBound, 1) || !safeInteger(input.maxOutputTokens, 1)) {
      throw new BudgetError('INVALID_BUDGET_PRICE', 400, '请求 token 上限无效，真实请求已阻止。');
    }
    if (ledger.entries.length >= MAX_BUDGET_ATTEMPTS) {
      throw new BudgetError('BUDGET_HISTORY_LIMIT', 409, '本轮请求记录已达上限，真实请求已阻止。');
    }
    const reservedMicros = tokenCostMicros(
      price,
      input.inputTokensUpperBound,
      input.maxOutputTokens,
    );
    if (reservedMicros > this.summarize(ledger).remainingMicros) {
      throw new BudgetError(
        'BUDGET_EXHAUSTED',
        409,
        '剩余累计预算不足以预留输入与最大输出，本次请求未发送。',
      );
    }
    const reservation: Entry = {
      id: `r${String(ledger.entries.length + 1).padStart(8, '0')}`,
      model: input.model,
      reservedMicros,
      inputTokensUpperBound: input.inputTokensUpperBound,
      maxOutputTokens: input.maxOutputTokens,
      price: { ...price },
      state: 'pending',
      usage: null,
      chargedMicros: null,
    };
    ledger.entries.push(reservation);
    this.write(ledger);
    return { id: reservation.id, model: reservation.model, reservedMicros };
  }

  unknown(id: string): BudgetSummary {
    const ledger = this.read();
    const entry = ledger?.entries.find((candidate) => candidate.id === id);
    if (!ledger || !entry) {
      throw new BudgetError('INVALID_RESERVATION', 409, '请求预算记录不存在。');
    }
    if (entry.state === 'settled') return this.summarize(ledger);
    entry.state = 'unknown';
    this.write(ledger);
    return this.summarize(ledger);
  }

  settle(id: string, usage: unknown): BudgetSummary {
    const ledger = this.read();
    const entry = ledger?.entries.find((candidate) => candidate.id === id);
    if (!ledger || !entry) {
      throw new BudgetError('INVALID_RESERVATION', 409, '请求预算记录不存在。');
    }
    if (!validUsage(usage)) {
      throw new BudgetError('INVALID_BUDGET_USAGE', 409, '返回用量无效，原预算预留未释放。');
    }
    const chargedMicros = tokenCostMicros(entry.price, usage.input_tokens, usage.output_tokens);
    if (entry.state === 'settled') {
      if (
        entry.usage!.input_tokens !== usage.input_tokens ||
        entry.usage!.output_tokens !== usage.output_tokens
      ) {
        throw new BudgetError('RESERVATION_ALREADY_SETTLED', 409, '请求预算已对账，不能重复修改。');
      }
      return this.summarize(ledger);
    }
    entry.state = 'settled';
    entry.usage = usageCopy(usage);
    entry.chargedMicros = chargedMicros;
    // Actual usage may exceed the reservation. Record the full debt instead of
    // capping it at the estimate; summary/next reserve then fail closed.
    this.totals(ledger);
    this.write(ledger);
    return this.summarize(ledger);
  }
}
