import { EventEmitter } from 'node:events';
import { validateHeaderValue, type ClientRequest, type IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS } from '../shared/openai-models.js';
import { createApp } from './app.js';
import { createRealAdapter, type TranslationInput } from './adapter.js';
import { isValidBearerCredential } from './credential.js';
import { LiveProviderRuntime } from './live-provider.js';
import { createOpenAIAdapter } from './openai-adapter.js';
import { OpenAIBudgetLedger } from './openai-budget.js';
import { createOpenAITransport } from './openai-transport.js';
import { TaskService } from './service.js';
import { TaskStore } from './store.js';

const SYNTHETIC_UNENCODABLE = 'synthetic-中文-placeholder';
const input: TranslationInput = {
  paragraphId: 'synthetic-p1',
  source: 'Synthetic fund update.',
  style: 'business',
  paragraphIndex: 0,
  scenario: 'normal',
};
const config = (apiKey: string) => ({
  apiKey,
  model: OPENAI_DEFAULT_MODEL,
  maxOutputTokens: 1024,
  enabled: true,
});
function ledger(store: TaskStore) {
  const value = new OpenAIBudgetLedger(store, {
    operatorCapMicros: 1_000_000,
    prices: Object.fromEntries(OPENAI_MODELS.map((model) => [model.id, model])),
  });
  value.arm({ budgetMicros: 1_000_000, acknowledgeCosts: true });
  return value;
}
function nativeHeaderFailureTransport() {
  const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const outbound = vi.fn((options: import('node:https').RequestOptions) => {
    // Use the real Node encoder oracle, while never opening a socket. Before
    // readiness validation was fixed this throws ERR_INVALID_CHAR synchronously.
    const headers = options.headers as Record<string, string>;
    validateHeaderValue('Authorization', headers.Authorization);
    throw new Error('Synthetic request seam must never be reached for invalid credentials.');
  });
  return { lookup, outbound, transport: createOpenAITransport({ lookup, request: outbound }) };
}

describe('Bearer credential encoding is checked before side effects', () => {
  it('blocks TaskService before a native-header error can create three retries and unknown budget holds', async () => {
    expect(() => validateHeaderValue('Authorization', `Bearer ${SYNTHETIC_UNENCODABLE}`)).toThrow();
    const store = new TaskStore(':memory:');
    const budget = ledger(store);
    const reserve = vi.spyOn(budget, 'reserve');
    const native = nativeHeaderFailureTransport();
    const adapter = createOpenAIAdapter(config(SYNTHETIC_UNENCODABLE), {
      transport: native.transport,
      budget,
    });
    const service = new TaskService(store, adapter);
    try {
      const task = service.create({ text: input.source, style: input.style });
      let startError: unknown;
      try {
        service.translate(task.id, {});
        await service.idle(task.id);
      } catch (error) {
        startError = error;
      }
      expect.soft(adapter.ready).toBe(false);
      expect.soft(startError).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect.soft(reserve).not.toHaveBeenCalled();
      expect.soft(native.lookup).not.toHaveBeenCalled();
      expect.soft(native.outbound).not.toHaveBeenCalled();
      expect.soft(budget.summary()).toMatchObject({
        attempts: 0,
        pendingAttempts: 0,
        unknownAttempts: 0,
        reservedMicros: 0,
      });
      expect.soft(service.get(task.id).status).toBe('draft');
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  it('rejects controller start with CREDENTIAL_INVALID without arming or reflecting a synthetic Unicode credential', async () => {
    const store = new TaskStore(':memory:');
    const native = nativeHeaderFailureTransport();
    const runtime = new LiveProviderRuntime(
      store,
      {
        ALLOW_REAL_TRANSLATION: 'true',
        TRANSLATION_MAX_BUDGET_USD: '1',
        IR_TRANSLATION_ENCODING_KEY: SYNTHETIC_UNENCODABLE,
      },
      native.transport,
    );
    const service = new TaskService(store, runtime.adapter);
    const app = createApp(service, undefined, runtime);
    try {
      await request(app)
        .put('/api/provider-settings')
        .send({
          mode: 'custom',
          protocol: 'openai-responses',
          baseUrl: '',
          model: OPENAI_DEFAULT_MODEL,
          credentialRef: 'IR_TRANSLATION_ENCODING_KEY',
          expectedRevision: 0,
        })
        .expect(200);
      const response = await request(app).post('/api/live-provider/start').send({
        expectedRevision: 1,
        acknowledgeCosts: true,
        confirmDataTransfer: true,
        budgetMicros: 1_000_000,
        maxOutputTokens: 1024,
      });
      expect.soft(response.status).toBe(400);
      expect.soft(response.body.code).toBe('CREDENTIAL_INVALID');
      expect.soft(JSON.stringify(response.body)).not.toContain(SYNTHETIC_UNENCODABLE);
      expect.soft(runtime.status().ready).toBe(false);
      expect.soft(runtime.ledger.summary().armed).toBe(false);
      expect.soft(runtime.ledger.summary().attempts).toBe(0);
      expect.soft(native.lookup).not.toHaveBeenCalled();
      expect.soft(native.outbound).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      store.close();
    }
  });
});

const invalidCredentials: [string, string, boolean][] = [
  ['CJK', SYNTHETIC_UNENCODABLE, false],
  ['emoji', 'synthetic-\u{1f916}-placeholder', false],
  ['first non-Latin-1 code point', 'synthetic-\u0100-placeholder', false],
  ['combining accent', 'synthetic-e\u0301-placeholder', false],
  ['lone high surrogate', 'synthetic-\ud800-placeholder', false],
  ['lone low surrogate', 'synthetic-\udfff-placeholder', false],
  ['NUL', 'synthetic-\x00-placeholder', false],
  ['last C0 control', 'synthetic-\x1f-placeholder', false],
  ['DEL', 'synthetic-\x7f-placeholder', false],
  ['carriage return', 'synthetic-\r-placeholder', false],
  ['line feed', 'synthetic-\n-placeholder', false],
  ['horizontal tab forbidden by credential policy', 'synthetic-\t-placeholder', true],
  ['ASCII space forbidden by credential policy', 'synthetic- -placeholder', true],
  [
    'Latin-1 nonbreaking space forbidden by credential policy',
    'synthetic-\u00a0-placeholder',
    true,
  ],
  ['empty', '', true],
  ['above credential length limit', 's'.repeat(1025), true],
];

function nodeAccepts(value: string): boolean {
  try {
    validateHeaderValue('Authorization', `Bearer ${value}`);
    return true;
  } catch {
    return false;
  }
}

describe('shared encoding policy is applied by every credential consumer', () => {
  it.each(invalidCredentials)(
    'rejects %s before reserve, DNS, HTTP or legacy fetch',
    async (_label, credential, nodeEncodable) => {
      expect(nodeAccepts(credential)).toBe(nodeEncodable);
      expect(isValidBearerCredential(credential)).toBe(false);
      const store = new TaskStore(':memory:');
      const budget = ledger(store);
      const reserve = vi.spyOn(budget, 'reserve');
      const native = nativeHeaderFailureTransport();
      const adapter = createOpenAIAdapter(config(credential), {
        transport: native.transport,
        budget,
      });
      const fetchImpl = vi.fn(async () => new Response('{}'));
      const legacy = createRealAdapter(
        {
          apiUrl: 'https://synthetic.example.com/v1/chat/completions',
          apiKey: credential,
          model: 'synthetic-model',
          enabled: true,
        },
        fetchImpl,
      );
      try {
        expect(adapter.ready).toBe(false);
        expect(legacy.ready).toBe(false);
        await expect(adapter.translate(input, new AbortController().signal)).rejects.toMatchObject({
          code: 'NOT_CONFIGURED',
          retryable: false,
        });
        await expect(legacy.translate(input, new AbortController().signal)).rejects.toMatchObject({
          code: 'NOT_CONFIGURED',
          retryable: false,
        });
        await expect(
          native.transport({
            apiKey: credential,
            body: '{}',
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(reserve).not.toHaveBeenCalled();
        expect(native.lookup).not.toHaveBeenCalled();
        expect(native.outbound).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(budget.summary()).toMatchObject({
          attempts: 0,
          unknownAttempts: 0,
          reservedMicros: 0,
        });
      } finally {
        store.close();
      }
    },
  );

  it.each([undefined, null, 123, false, {}, ['synthetic']])(
    'rejects non-string value %j without coercion',
    (value) => {
      expect(isValidBearerCredential(value)).toBe(false);
    },
  );
});

const validCredentials: [string, string][] = [
  ['ordinary synthetic ASCII', 'synthetic-placeholder-not-a-key'],
  ['ASCII punctuation', '!#$%&*+-./:=?@[]^_{|}~'],
  ['ASCII graphic boundaries', '!~'],
  ['Latin-1 lower boundary', 'synthetic-\x80-placeholder'],
  ['Latin-1 C1 header encoding', 'synthetic-\x85\x9f-placeholder'],
  ['Latin-1 upper boundary', 'synthetic-\xff-placeholder'],
  ['precomposed Latin-1 accent', 'synthetic-caf\xe9-placeholder'],
  ['exact credential length limit', 's'.repeat(1024)],
];

describe('header-encodable credentials remain usable without guessing provider-key prefixes', () => {
  it.each(validCredentials)(
    'accepts %s using the actual Node header validator and local response seams',
    async (_label, credential) => {
      // Encoding acceptance is not authentication, balance or translation quality.
      expect(() => validateHeaderValue('Authorization', `Bearer ${credential}`)).not.toThrow();
      expect(isValidBearerCredential(credential)).toBe(true);
      const store = new TaskStore(':memory:');
      const budget = ledger(store);
      const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
      const outbound = vi.fn(
        (
          options: import('node:https').RequestOptions,
          reply: (response: IncomingMessage) => void,
        ) => {
          const headers = options.headers as Record<string, string>;
          expect(headers.Authorization).toBe(`Bearer ${credential}`);
          validateHeaderValue('Authorization', headers.Authorization);
          const outgoing = new EventEmitter();
          Object.assign(outgoing, {
            destroy: () => undefined,
            end: () => {
              queueMicrotask(() => {
                const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
                reply(response as unknown as IncomingMessage);
                response.end(
                  JSON.stringify({
                    object: 'response',
                    id: 'resp_synthetic_encoding',
                    model: OPENAI_DEFAULT_MODEL,
                    service_tier: 'default',
                    status: 'completed',
                    error: null,
                    incomplete_details: null,
                    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
                    output: [
                      {
                        id: 'msg_synthetic_encoding',
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [
                          {
                            type: 'output_text',
                            text: JSON.stringify({
                              paragraphs: [
                                { id: input.paragraphId, translation: '合成编码回归译文。' },
                              ],
                            }),
                          },
                        ],
                      },
                    ],
                  }),
                );
              });
            },
          });
          return outgoing as unknown as ClientRequest;
        },
      );
      const adapter = createOpenAIAdapter(config(credential), {
        budget,
        transport: createOpenAITransport({ lookup, request: outbound }),
      });
      const fetchImpl = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
        const headers = options?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${credential}`);
        validateHeaderValue('Authorization', headers.Authorization);
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({ translation: '合成旧协议编码译文。' }),
                },
              },
            ],
          }),
        );
      });
      const legacy = createRealAdapter(
        {
          apiUrl: 'https://synthetic.example.com/v1/chat/completions',
          apiKey: credential,
          model: 'synthetic-model',
          enabled: true,
        },
        fetchImpl,
      );
      try {
        expect(adapter.ready).toBe(true);
        expect(legacy.ready).toBe(true);
        await expect(adapter.translate(input, new AbortController().signal)).resolves.toBe(
          '合成编码回归译文。',
        );
        await expect(legacy.translate(input, new AbortController().signal)).resolves.toBe(
          '合成旧协议编码译文。',
        );
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(outbound).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(budget.summary()).toMatchObject({
          attempts: 1,
          unknownAttempts: 0,
          reservedMicros: 0,
        });
      } finally {
        store.close();
      }
    },
  );
});
