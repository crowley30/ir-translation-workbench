import { isValidBearerCredential } from './credential.js';
import { Router } from 'express';
import type { LiveProviderStatus, ProviderTransportStatus } from '../shared/live-provider.js';
import { findOpenAIModel, OPENAI_MODELS } from '../shared/openai-models.js';
import { createMockAdapter, ProviderError, type TranslationAdapter } from './adapter.js';
import { createOpenAIAdapter } from './openai-adapter.js';
import { BudgetError, OpenAIBudgetLedger, parseUsdToMicros } from './openai-budget.js';
import { OpenAITransportError, type OpenAITransport } from './openai-transport.js';
import { resolveOpenAITransportConfiguration } from './cloud-transport-config.js';
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
  private stopPersistenceFailed = false;
  private readonly transport: OpenAITransport;
  private readonly transportStatus: ProviderTransportStatus;
  constructor(
    private readonly store: ProviderSettingsStore,
    readonly environment: NodeJS.ProcessEnv = process.env,
    transport?: OpenAITransport,
    mock = createMockAdapter(),
  ) {
    if (transport) {
      this.transport = transport;
      this.transportStatus = {
        mode: 'direct',
        ready: true,
        upstreamDns: 'client-pinned',
        reason: '注入的合成传输契约，不代表真实连接验证。',
      };
    } else {
      const configuration = resolveOpenAITransportConfiguration(environment);
      let chosen: OpenAITransport;
      let summary: ProviderTransportStatus = {
        mode: configuration.mode,
        ready: configuration.ready,
        reason: configuration.reason,
        upstreamDns: configuration.upstreamDns,
      };
      try {
        chosen = configuration.ready
          ? configuration.createTransport()
          : async () => {
              throw new OpenAITransportError('INVALID_REQUEST');
            };
      } catch {
        summary = {
          mode: 'unconfigured',
          ready: false,
          upstreamDns: 'unavailable',
          reason: '服务端传输配置不可用，真实调用关闭且不会回退直连。',
        };
        chosen = async () => {
          throw new OpenAITransportError('INVALID_REQUEST');
        };
      }
      this.transport = chosen;
      this.transportStatus = Object.freeze(summary);
    }
    this.ledger = new OpenAIBudgetLedger(store, {
      operatorCapMicros: operatorCap(environment),
      prices: Object.fromEntries(OPENAI_MODELS.map((model) => [model.id, model])),
    });
    if (this.ledger.summary().initialized) {
      try {
        this.ledger.disarm();
      } catch {
        this.stopPersistenceFailed = true;
      }
    }
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
      this.transportStatus.ready &&
      this.active.ready &&
      !this.stopPersistenceFailed &&
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
        : this.stopPersistenceFailed
          ? '真实调用已在本进程关闭，但停止状态未能持久化；修复存储并重新明确启动前不会发送请求。'
          : !this.transportStatus.ready
            ? this.transportStatus.reason
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
      transport: { ...this.transportStatus },
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
    if (!this.transportStatus.ready)
      failure(503, 'TRANSPORT_UNAVAILABLE', this.transportStatus.reason);
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
    const key = config.credentialRef && this.environment[config.credentialRef];
    if (!key) failure(400, 'CREDENTIAL_MISSING', '服务端凭据变量尚未设置，不能启动真实调用。');
    if (!isValidBearerCredential(key))
      failure(
        400,
        'CREDENTIAL_INVALID',
        '服务端凭据格式无效，未启用真实调用；请通过安全入口检查。',
      );
    const candidate = createOpenAIAdapter(
      {
        apiKey: key,
        model: model.id,
        maxOutputTokens: body.maxOutputTokens as number,
        enabled: true,
        timeoutMs: 30000,
      },
      { transport: this.transport, budget: this.ledger },
    );
    if (!candidate.ready) failure(400, 'PROVIDER_NOT_READY', '服务配置尚不可用，未启用真实调用。');
    if (this.stopPersistenceFailed) {
      this.ledger.disarm();
      this.stopPersistenceFailed = false;
    }
    this.ledger.arm({ budgetMicros: body.budgetMicros as number, acknowledgeCosts: true });
    this.outputTokens = body.maxOutputTokens as number;
    this.active = candidate;
    this.activeRevision = revision;
    this.selectedReal = true;
    return this.status();
  }
  stop(mock = false): LiveProviderStatus {
    // Local revocation must not depend on durable storage succeeding.
    this.active = null;
    this.activeRevision = -1;
    if (mock) this.selectedReal = false;
    this.stopPersistenceFailed = true;
    this.ledger.disarm();
    this.stopPersistenceFailed = false;
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
      let status: LiveProviderStatus | undefined;
      let failure: unknown;
      try {
        status = runtime.stop(path === '/mock');
      } catch (error) {
        failure = error;
      }
      // Abort every run even when the budget or a task write fails.
      try {
        service.cancelAll();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
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
