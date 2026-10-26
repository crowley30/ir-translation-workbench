import { describe, expect, it, vi } from 'vitest';
import {
  createAdapter,
  createMockAdapter,
  createRealAdapter,
  ProviderError,
  type TranslationInput,
} from './adapter.ts';

const input: TranslationInput = {
  source: 'Synthetic AI fund update: USD 12 million.',
  style: 'faithful',
  paragraphIndex: 0,
  scenario: 'normal',
};
const config = {
  apiUrl: 'https://synthetic.example/v1/chat/completions',
  apiKey: 'synthetic-test-placeholder',
  model: 'synthetic-model',
  enabled: true,
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const success = (translation = '合成样本：人工智能基金。') => ({
  choices: [{ message: { content: JSON.stringify({ translation }) } }],
});
const signal = () => new AbortController().signal;

describe('honest mock adapter', () => {
  it('defaults to clearly labelled mock and preserves original instead of pretending to translate', async () => {
    const adapter = createAdapter({});
    expect(adapter.mode).toBe('mock');
    expect(adapter.label).toContain('模拟');
    const result = await adapter.translate(input, signal());
    expect(result).toContain('[模拟占位·非译文]');
    expect(result).toContain(input.source);
  });

  it('marks business output as a simulated placeholder as well', async () => {
    const output = await createMockAdapter({ delayMs: 0 }).translate(
      { ...input, style: 'business' },
      signal(),
    );
    expect(output).toContain('[模拟占位·非译文] 商务文体');
  });

  it.each([
    ['timeout', 'TIMEOUT', true],
    ['rate-limit', 'RATE_LIMIT', true],
    ['server-error', 'SERVER_ERROR', true],
    ['malformed', 'INVALID_RESPONSE', false],
  ] as const)('injects %s as a classified error', async (scenario, code, retryable) => {
    await expect(
      createMockAdapter({ delayMs: 0, timeoutMs: 0 }).translate({ ...input, scenario }, signal()),
    ).rejects.toMatchObject({ code, retryable });
  });

  it('fails only the designated paragraph for partial failure', async () => {
    const adapter = createMockAdapter({ delayMs: 0 });
    await expect(
      adapter.translate({ ...input, scenario: 'partial', paragraphIndex: 0 }, signal()),
    ).resolves.toContain('模拟占位');
    await expect(
      adapter.translate({ ...input, scenario: 'partial', paragraphIndex: 1 }, signal()),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    await expect(
      adapter.translate({ ...input, scenario: 'partial', paragraphIndex: 2 }, signal()),
    ).resolves.toContain('模拟占位');
  });

  it('aborts pending simulated work without completing late', async () => {
    const controller = new AbortController();
    const result = createMockAdapter().translate({ ...input, scenario: 'slow' }, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    await expect(createMockAdapter().translate(input, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });
});

describe('real adapter configuration and safety', () => {
  it.each([
    { TRANSLATION_MODE: 'real' },
    { TRANSLATION_MODE: 'typo' },
    { TRANSLATION_MODE: 'real', ALLOW_REAL_TRANSLATION: 'false' },
  ])('does not silently switch an unready real configuration to mock', async (env) => {
    const adapter = createAdapter(env);
    expect(adapter.mode).toBe('real');
    expect(adapter.ready).toBe(false);
    await expect(adapter.translate(input, signal())).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it.each([{ enabled: false }, { apiKey: '' }, { model: '' }, { apiUrl: '' }])(
    'requires every real-service configuration field and explicit opt-in: %j',
    async (incomplete) => {
      const fetchImpl = vi.fn();
      const adapter = createRealAdapter({ ...config, ...incomplete }, fetchImpl);
      expect(adapter.ready).toBe(false);
      await expect(adapter.translate(input, signal())).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('can report a fully configured real service without making a request', () => {
    const adapter = createAdapter({
      TRANSLATION_MODE: 'real',
      ALLOW_REAL_TRANSLATION: 'true',
      TRANSLATION_API_URL: config.apiUrl,
      TRANSLATION_API_KEY: config.apiKey,
      TRANSLATION_MODEL: config.model,
    });
    expect(adapter.mode).toBe('real');
    expect(adapter.ready).toBe(true);
  });

  it.each([
    'http://synthetic.example/api',
    'https://name:secret@synthetic.example/api',
    'https://synthetic.example/api?key=hidden',
    'bad-url',
  ])('rejects unsafe endpoint configuration: %s', async (apiUrl) => {
    const fetchImpl = vi.fn();
    const adapter = createRealAdapter({ ...config, apiUrl }, fetchImpl);
    expect(adapter.ready).toBe(false);
    await expect(adapter.translate(input, signal())).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses injected fetch, server credential, style instruction and strict response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(success()));
    const adapter = createRealAdapter(config, fetchImpl);
    expect(adapter.ready).toBe(true);
    await expect(adapter.translate(input, signal())).resolves.toBe('合成样本：人工智能基金。');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe(config.apiUrl);
    expect(request.headers.Authorization).toBe(`Bearer ${config.apiKey}`);
    const body = JSON.parse(request.body);
    expect(body.messages[0].content).toContain('合同文体');
    expect(body.messages[1].content).toBe(JSON.stringify({ source: input.source }));
    expect(
      JSON.stringify({ mode: adapter.mode, ready: adapter.ready, label: adapter.label }),
    ).not.toContain(config.apiKey);
  });

  it.each([
    [429, 'RATE_LIMIT', true],
    [500, 'SERVER_ERROR', true],
    [503, 'SERVER_ERROR', true],
    [400, 'REQUEST_REJECTED', false],
    [401, 'REQUEST_REJECTED', false],
  ] as const)(
    'classifies HTTP %s without leaking response content',
    async (status, code, retryable) => {
      const adapter = createRealAdapter(
        config,
        vi.fn().mockResolvedValue(response({ error: 'secret-provider-response' }, status)),
      );
      const error = await adapter.translate(input, signal()).catch((error) => error);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code, retryable });
      expect(String(error)).not.toContain('secret-provider-response');
      expect(String(error)).not.toContain(config.apiKey);
    },
  );

  it.each([
    {},
    { choices: [] },
    { choices: [{ message: { content: 'not-json' } }] },
    { choices: [{ message: { content: JSON.stringify({ translation: '' }) } }] },
    {
      choices: [
        { message: { content: JSON.stringify({ translation: 'ok', extra: 'omitted paragraph' }) } },
      ],
    },
    { choices: [{ message: { content: JSON.stringify({ translation: 42 }) } }] },
    success('x'.repeat(40001)),
  ])('rejects malformed provider output without applying a partial translation', async (body) => {
    const adapter = createRealAdapter(config, vi.fn().mockResolvedValue(response(body)));
    await expect(adapter.translate(input, signal())).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });

  it('stops reading an oversized provider body before JSON parsing', async () => {
    const adapter = createRealAdapter(
      config,
      vi.fn().mockResolvedValue(new Response('x'.repeat(250001))),
    );
    await expect(adapter.translate(input, signal())).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });

  it('discards an in-flight provider response after cancellation', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(async () => {
      controller.abort();
      return response(success());
    });
    await expect(
      createRealAdapter(config, fetchImpl).translate(input, controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
  });

  it('redacts network errors and distinguishes cancellation', async () => {
    const adapter = createRealAdapter(
      config,
      vi.fn().mockRejectedValue(new Error(`secret-network ${config.apiKey}`)),
    );
    const error = await adapter.translate(input, signal()).catch((error) => error);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    expect(String(error)).not.toContain(config.apiKey);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.translate(input, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
      retryable: false,
    });
  });
});
