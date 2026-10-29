import { Router } from 'express';
import type { LiveProviderStatus } from '../shared/live-provider.js';
import { findOpenAIModel, OPENAI_MODELS } from '../shared/openai-models.js';
import { createMockAdapter, ProviderError, type TranslationAdapter } from './adapter.js';
import { createOpenAIAdapter } from './openai-adapter.js';
import { BudgetError, OpenAIBudgetLedger, parseUsdToMicros } from './openai-budget.js';
import { createOpenAITransport, type OpenAITransport } from './openai-transport.js';
import { readProviderConfiguration, type ProviderSettingsStore } from './provider-settings.js';
import type { TaskService } from './service.js';

export class LiveProviderError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LiveProviderError';
  }
}
function failure(status: number, code: string, message: string): never {
  throw new LiveProviderError(status, code, message);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function operatorCap(env: NodeJS.ProcessEnv): number {
  try {
    return parseUsdToMicros(env.TRANSLATION_MAX_BUDGET_USD ?? '0');
  } catch {
    return 0;
  }
}

// Merely creating this runtime never resolves DNS or makes a provider request.
// Restart always disarms; the persistent cumulative ledger is never reset.
export class LiveProviderRuntime {
  readonly ledger: OpenAIBudgetLedger;
  readonly adapter: TranslationAdapter;
  private selectedReal = false;
  private active: TranslationAdapter | null = null;
  private activeRevision = -1;
  private outputTokens = 4096;
  private readonly transport: OpenAITransport;
  constructor(
    private readonly store: ProviderSettingsStore,
    readonly environment: NodeJS.ProcessEnv = process.env,
    transport?: OpenAITransport,
    mock = createMockAdapter(),
  ) {
    this.transport = transport ?? createOpenAITransport();
    this.ledger = new OpenAIBudgetLedger(store, {
      operatorCapMicros: operatorCap(environment),
      prices: Object.fromEntries(OPENAI_MODELS.map((model) => [model.id, model])),
    });
    if (this.ledger.summary().initialized) this.ledger.disarm();
    const state = {
      mode: (): 'mock' | 'real' => (this.selectedReal ? 'real' : 'mock'),
      ready: () => (this.selectedReal ? this.isActive() : mock.ready),
      label: () => (this.selectedReal ? this.status().reason : mock.label),
      identity: () => (this.selectedReal ? this.active?.identity : undefined),
    };
    this.adapter = {
      get mode() {
        return state.mode();
      },
      get ready() {
        return state.ready();
      },
      get label() {
        return state.label();
      },
      get identity() {
        return state.identity();
      },
      translate: (input, signal) => {
        if (!this.selectedReal) return mock.translate(input, signal);
        if (!this.isActive() || !this.active) throw new ProviderError('REAL_CALLS_DISABLED', false);
        return this.active.translate(input, signal);
      },
    };
  }

  private isActive(): boolean {
    return (
      !!this.active &&
      this.environment.ALLOW_REAL_TRANSLATION === 'true' &&
      this.ledger.summary().armed &&
      readProviderConfiguration(this.store).revision === this.activeRevision
    );
  }
  status(): LiveProviderStatus {
    const { config, revision } = readProviderConfiguration(this.store);
    const budget = this.ledger.summary();
    const operatorEnabled =
      this.environment.ALLOW_REAL_TRANSLATION === 'true' && budget.operatorCapMicros > 0;
    const present = !!config.credentialRef && !!this.environment[config.credentialRef]?.trim();
    const live = this.selectedReal && this.isActive();
    return {
      mode: live ? 'live' : this.selectedReal ? 'real-disabled' : 'mock',
      ready: live,
      reason: live
        ? `OpenAI 真实调用已启动 · ${config.model}；仅翻译按钮发送请求，结果须人工复核。`
        : !operatorEnabled
          ? '服务端真实调用开关或累计预算上限尚未放行，当前不会发送真实请求。'
          : !present
            ? '服务端凭据变量尚未设置；请通过安全入口配置，勿粘贴密钥到网页。'
            : config.protocol !== 'openai-responses' || config.mode !== 'custom'
              ? '请先保存 OpenAI 官方 Responses 设置；其它协议本阶段仅保留离线配置。'
              : !findOpenAIModel(config.model)
                ? '模型未列入已核对的定价目录，真实调用被阻止。'
                : budget.overrun
                  ? '预算或 token 预留出现超限，真实调用已阻止，请核对费用记录。'
                  : '真实调用尚未启动；明确确认传输与累计费用后才可开启，开启本身不测试连接。',
      settingsRevision: revision,
      provider: config.protocol === 'openai-responses' ? 'openai-responses' : 'none',
      model: config.model,
      maxOutputTokens: this.outputTokens,
      operatorEnabled,
      credentialStatus: present ? 'present' : 'absent',
      budget,
    };
  }
  start(body: unknown): LiveProviderStatus {
    const keys = [
      'expectedRevision',
      'acknowledgeCosts',
      'confirmDataTransfer',
      'budgetMicros',
      'maxOutputTokens',
    ];
    if (
      !record(body) ||
      Object.keys(body).some((key) => !keys.includes(key)) ||
      body.acknowledgeCosts !== true ||
      body.confirmDataTransfer !== true
    )
      failure(
        400,
        'LIVE_CONSENT_REQUIRED',
        '请明确确认本轮累计费用和将原文、上下文及术语发送至 OpenAI。',
      );
    const { config, revision } = readProviderConfiguration(this.store);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== revision)
      failure(409, 'LIVE_SETTINGS_CONFLICT', '服务设置已变化，请重新读取后明确启动。');
    if (this.environment.ALLOW_REAL_TRANSLATION !== 'true' || operatorCap(this.environment) === 0)
      failure(403, 'LIVE_OPERATOR_GATE', '服务端尚未允许真实调用或尚未批准累计预算。');
    if (this.isActive())
      failure(409, 'LIVE_ALREADY_ACTIVE', '真实调用已经启动，不能重复启动或重置预算。');
    if (
      config.mode !== 'custom' ||
      config.protocol !== 'openai-responses' ||
      config.baseUrl !== 'https://api.openai.com/v1'
    )
      failure(
        400,
        'OFFICIAL_PROVIDER_REQUIRED',
        '本阶段真实调用仅支持固定官方 OpenAI Responses 协议。',
      );
    const model = findOpenAIModel(config.model);
    if (!model) failure(400, 'UNPRICED_MODEL', '模型未列入已核对的定价目录，不能启动真实调用。');
    if (
      !Number.isSafeInteger(body.maxOutputTokens) ||
      (body.maxOutputTokens as number) < 256 ||
      (body.maxOutputTokens as number) > model.maxOutputTokens
    )
      failure(400, 'INVALID_OUTPUT_LIMIT', '最大输出 token 必须为 256 至模型应用上限之间的整数。');
    const key = config.credentialRef && this.environment[config.credentialRef]?.trim();
    if (!key) failure(400, 'CREDENTIAL_MISSING', '服务端凭据变量尚未设置，不能启动真实调用。');
    this.ledger.arm({ budgetMicros: body.budgetMicros as number, acknowledgeCosts: true });
    this.outputTokens = body.maxOutputTokens as number;
    this.active = createOpenAIAdapter(
      {
        apiKey: key,
        model: model.id,
        maxOutputTokens: this.outputTokens,
        enabled: true,
        timeoutMs: 30000,
      },
      { transport: this.transport, budget: this.ledger },
    );
    this.activeRevision = revision;
    this.selectedReal = true;
    return this.status();
  }
  stop(mock = false): LiveProviderStatus {
    this.ledger.disarm();
    this.active = null;
    this.activeRevision = -1;
    if (mock) this.selectedReal = false;
    return this.status();
  }
  beforeSave(): void {
    if (this.isActive())
      failure(
        409,
        'LIVE_SETTINGS_BUSY',
        '请先停止真实调用，再修改服务设置；停止不会重置累计预算。',
      );
  }
}
export function createLiveProviderRouter(
  runtime: LiveProviderRuntime,
  service: TaskService,
): Router {
  const router = Router();
  router.get('/', (_req, res) => res.json(runtime.status()));
  router.post('/start', (req, res) => {
    if (service.store.list().some((task) => task.status === 'running'))
      failure(409, 'LIVE_TASK_BUSY', '请先完成或取消正在运行的任务，再切换调用模式。');
    res.json(runtime.start(req.body));
  });
  for (const path of ['/stop', '/mock'])
    router.post(path, (_req, res) => {
      // Disarm first: no queued retry/paragraph can obtain another reservation.
      const status = runtime.stop(path === '/mock');
      for (const task of service.store.list())
        if (task.status === 'running') service.cancel(task.id);
      res.json(status);
    });
  router.use(
    (
      error: unknown,
      _req: unknown,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (error instanceof LiveProviderError || error instanceof BudgetError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    },
  );
  return router;
}
