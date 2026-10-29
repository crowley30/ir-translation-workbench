import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createMockAdapter } from './adapter.js';
import { LiveProviderRuntime } from './live-provider.js';
import type {
  OpenAITransport,
  OpenAITransportRequest,
  OpenAITransportResponse,
} from './openai-transport.js';
import { TaskService } from './service.js';
import { TaskStore } from './store.js';
import { OPENAI_DEFAULT_MODEL } from '../shared/openai-models.js';
import type { LiveProviderStatus } from '../shared/live-provider.js';
import type { Task } from '../shared/types.js';

const BUDGET_KEY = 'openai-budget-v1';
const CREDENTIAL_REF = 'IR_TRANSLATION_REWORK_KEY';
const SYNTHETIC_CREDENTIAL = 'synthetic-placeholder-never-a-real-key';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function success(input: OpenAITransportRequest): OpenAITransportResponse {
  const body = JSON.parse(input.body) as { model: string; input: { content: string }[] };
  const source = JSON.parse(body.input[0].content) as { id: string };
  return {
    status: 200,
    body: JSON.stringify({
      object: 'response',
      id: 'resp_synthetic_rework',
      model: body.model,
      service_tier: 'default',
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      error: null,
      incomplete_details: null,
      output: [
        {
          id: 'msg_synthetic_rework',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                paragraphs: [{ id: source.id, translation: '合成回归译文，未调用真实服务。' }],
              }),
            },
          ],
        },
      ],
    }),
  };
}

let store: TaskStore;
let service: TaskService;
let runtime: LiveProviderRuntime;
let app: ReturnType<typeof createApp>;
let failBudgetWrites: boolean;
let transport: ReturnType<typeof vi.fn<OpenAITransport>>;
const environment = () => ({
  ALLOW_REAL_TRANSLATION: 'true',
  TRANSLATION_MAX_BUDGET_USD: '1',
  [CREDENTIAL_REF]: SYNTHETIC_CREDENTIAL,
});

beforeEach(() => {
  store = new TaskStore(':memory:');
  failBudgetWrites = false;
  const original = store.setSetting.bind(store);
  vi.spyOn(store, 'setSetting').mockImplementation((key, value) => {
    const disarming =
      !!value && typeof value === 'object' && 'armed' in value && value.armed === false;
    if (failBudgetWrites && key === BUDGET_KEY && disarming)
      throw new Error('Synthetic disarm persistence failure.');
    original(key, value);
  });
  transport = vi.fn(async (input) => success(input));
  runtime = new LiveProviderRuntime(
    store,
    environment(),
    transport,
    createMockAdapter({ delayMs: 0 }),
  );
  service = new TaskService(store, runtime.adapter, 1000);
  app = createApp(service, undefined, runtime);
});

afterEach(async () => {
  failBudgetWrites = false;
  await service.shutdown();
  store.close();
  vi.restoreAllMocks();
});

async function configure() {
  await request(app)
    .put('/api/provider-settings')
    .send({
      mode: 'custom',
      protocol: 'openai-responses',
      baseUrl: '',
      model: OPENAI_DEFAULT_MODEL,
      credentialRef: CREDENTIAL_REF,
      expectedRevision: 0,
    })
    .expect(200);
}

function start() {
  return request(app).post('/api/live-provider/start').send({
    expectedRevision: 1,
    acknowledgeCosts: true,
    confirmDataTransfer: true,
    budgetMicros: 1_000_000,
    maxOutputTokens: 1024,
  });
}

async function status(): Promise<LiveProviderStatus> {
  const response = await request(app).get('/api/live-provider').expect(200);
  return response.body as LiveProviderStatus;
}

describe('live stop persistence failures fail closed immediately', () => {
  it.each(['/stop', '/mock'])(
    '%s cancels in-flight work and blocks the next paragraph even when disarm cannot persist',
    async (path) => {
      await configure();
      await start().expect(200);
      const entered = deferred<OpenAITransportRequest>();
      const release = deferred<void>();
      transport.mockImplementation(async (input) => {
        entered.resolve(input);
        // Deliberately ignore cancellation here: the service must still prevent
        // late results or a second paragraph from reviving a stopped run.
        await release.promise;
        return success(input);
      });
      const created = await request(app)
        .post('/api/tasks')
        .send({
          text: 'Synthetic first paragraph.\n\nSynthetic second paragraph.',
          style: 'business',
        })
        .expect(201);
      const task = created.body as Task;
      await request(app).post(`/api/tasks/${task.id}/translate`).send({}).expect(202);
      const first = await entered.promise;
      failBudgetWrites = true;
      try {
        await request(app).post(`/api/live-provider${path}`).send({}).expect(503);
        const stopped = await status();
        expect.soft(stopped.ready).toBe(false);
        expect.soft(stopped.mode).toBe(path === '/mock' ? 'mock' : 'real-disabled');
        expect.soft(stopped.budget.armed).toBe(false);
        expect
          .soft(() =>
            runtime.ledger.reserve({
              model: OPENAI_DEFAULT_MODEL,
              inputTokensUpperBound: 1,
              maxOutputTokens: 1,
            }),
          )
          .toThrow();
        expect.soft(first.signal.aborted).toBe(true);
        expect.soft(service.get(task.id).status).toBe('cancelled');
        // A persistence problem must not permit the next paragraph after a late
        // successful-shaped response returns from an uncooperative transport.
        release.resolve();
        await service.idle(task.id);
        expect.soft(transport).toHaveBeenCalledTimes(1);
        expect.soft(service.get(task.id).paragraphs.every((p) => p.translation === '')).toBe(true);
        expect.soft(service.get(task.id).status).toBe('cancelled');
        expect.soft((await status()).ready).toBe(false);
        await start().expect(503);
        expect.soft(transport).toHaveBeenCalledTimes(1);
        failBudgetWrites = false;
        const held = runtime.ledger.summary().reservedMicros;
        expect(held).toBeGreaterThan(0);
        await start().expect(200);
        expect((await status()).budget.reservedMicros).toBe(held);
        expect(transport).toHaveBeenCalledTimes(1);
      } finally {
        failBudgetWrites = false;
        release.resolve();
        await service.idle(task.id);
      }
    },
  );

  it('a restarted runtime cannot resume a persisted armed ledger while durable disarm still fails', async () => {
    await configure();
    await start().expect(200);
    failBudgetWrites = true;
    let restarted: LiveProviderRuntime | undefined;
    try {
      restarted = new LiveProviderRuntime(store, environment(), transport);
    } catch {
      // Refusing startup is also safe, but no request may be sent or ledger
      // erased. A surviving runtime must report its effective state as closed.
    }
    expect(transport).not.toHaveBeenCalled();
    const persisted = store.getSetting(BUDGET_KEY) as { armed: boolean; budgetMicros: number };
    expect(persisted.armed).toBe(true);
    expect(persisted.budgetMicros).toBe(1_000_000);
    if (restarted) {
      expect(restarted.status().ready).toBe(false);
      expect(restarted.status().budget.armed).toBe(false);
      expect(() =>
        restarted!.start({
          expectedRevision: 1,
          acknowledgeCosts: true,
          confirmDataTransfer: true,
          budgetMicros: 1_000_000,
          maxOutputTokens: 1024,
        }),
      ).toThrow();
    }
    failBudgetWrites = false;
    const recovered = new LiveProviderRuntime(store, environment(), transport);
    expect(recovered.status().ready).toBe(false);
    expect(recovered.status().budget.armed).toBe(false);
    expect(recovered.ledger.summary().budgetMicros).toBe(1_000_000);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('controller and provider readiness remain consistent', () => {
  it.each([
    'synthetic\ncredential',
    'synthetic\rcredential',
    'synthetic-tail\n',
    '\nsynthetic-head',
    ' synthetic-leading-space',
    'synthetic\tcredential',
    'synthetic-' + 'a'.repeat(1025),
    '',
    ' \t ',
    '\r\n',
  ])(
    'rejects unusable synthetic credential case %# without arming a budget',
    async (credential) => {
      await configure();
      const closed = new LiveProviderRuntime(
        store,
        { ...environment(), [CREDENTIAL_REF]: credential },
        transport,
      );
      runtime = closed;
      service = new TaskService(store, runtime.adapter, 1000);
      app = createApp(service, undefined, runtime);
      const response = await start();
      expect(response.status).toBe(400);
      expect((await status()).ready).toBe(false);
      expect((await status()).mode).not.toBe('live');
      expect(runtime.ledger.summary().armed).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain(credential || SYNTHETIC_CREDENTIAL);
    },
  );
});
