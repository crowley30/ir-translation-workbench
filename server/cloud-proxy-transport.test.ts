import { Readable } from 'node:stream';
import { getCACertificates, type ConnectionOptions } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudProxyTransport,
  validateCloudProxyUrl,
  type CloudProxyDependencies,
  type CloudProxyRequestOptions,
  type CloudProxyResponse,
} from './cloud-proxy-transport.js';
import { OPENAI_RESPONSES_URL, type OpenAITransportRequest } from './openai-transport.js';
import type { ProxyAgent } from 'undici';

const proxyUrl = 'http://proxy.synthetic.invalid:8080';
const input = (overrides: Partial<OpenAITransportRequest> = {}): OpenAITransportRequest => ({
  apiKey: 'synthetic-placeholder-only',
  body: '{"input":"synthetic source"}',
  signal: new AbortController().signal,
  ...overrides,
});
function stream(chunks: (Buffer | string)[] = ['{"synthetic":true}']) {
  return Readable.from(chunks);
}
function harness(response: Partial<CloudProxyResponse> = {}) {
  const agent = { destroy: vi.fn(async () => undefined) };
  const configurations: ProxyAgent.Options[] = [];
  const options: CloudProxyRequestOptions[] = [];
  const createProxyAgent = vi.fn<NonNullable<CloudProxyDependencies['createProxyAgent']>>(
    (value) => {
      configurations.push(value);
      return agent;
    },
  );
  const body = response.body ?? stream();
  const request = vi.fn<NonNullable<CloudProxyDependencies['request']>>(async (_url, value) => {
    options.push(value);
    return { statusCode: 200, headers: {}, body, ...response };
  });
  return {
    agent,
    configurations,
    options,
    createProxyAgent,
    request,
    body,
    transport: createCloudProxyTransport({ proxyUrl }, { createProxyAgent, request }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('trusted Cloud proxy configuration without secret or environment reads', () => {
  it.each([
    'http://proxy.internal:8080',
    'https://proxy.internal',
    'http://127.0.0.1:12345/',
    'https://[::1]:12345',
  ])('accepts operator-owned proxy %s (not a public destination allowlist)', (value) => {
    expect(validateCloudProxyUrl(value)).toBe(new URL(value).href);
  });
  it.each([
    undefined,
    null,
    12,
    '',
    ' proxy.internal',
    'http://proxy.internal ',
    'ftp://proxy.internal',
    'socks5://proxy.internal',
    'file:///tmp/proxy',
    'http://user:synthetic-password@proxy.internal',
    'http://user@proxy.internal',
    'http://@proxy.internal',
    'http://user%3Asecret@proxy.internal',
    'http://proxy.internal/path',
    'http://proxy.internal//',
    'http://proxy.internal?token=synthetic',
    'http://proxy.internal#fragment',
    'http://proxy.internal:0',
    'http://proxy.internal:65536',
    'http://proxy.internal\\@other.invalid',
    'http://proxy.internal\n',
    'http://pröxy.internal',
    'http://%70roxy.internal',
  ])('rejects invalid/credential-bearing proxy configuration without reflecting it', (value) => {
    expect(() => validateCloudProxyUrl(value)).toThrow('OpenAI transport: INVALID_REQUEST');
  });
  it('rejects oversized proxy URLs and CA material before creating a dispatcher', () => {
    expect(() => validateCloudProxyUrl(`http://${'a'.repeat(2050)}`)).toThrow();
    for (const additionalCa of [
      '',
      [],
      Array<string>(513).fill('synthetic-ca'),
      'x'.repeat(1048577),
      'PRIVATE KEY',
    ])
      expect(() => createCloudProxyTransport({ proxyUrl, additionalCa })).toThrow(
        'INVALID_REQUEST',
      );
  });
  it('bounds certificate blocks inside a single bundle as well as array entries', () => {
    const root = getCACertificates('default').find((pem) => Buffer.byteLength(pem) < 1800)!;
    expect(root).toBeDefined();
    expect(() =>
      createCloudProxyTransport({
        proxyUrl,
        additionalCa: Array<string>(513).fill(root).join('\n'),
      }),
    ).toThrow('INVALID_REQUEST');
  });
  it('constructs no agent or request until the explicit translate transport invocation', () => {
    const h = harness();
    expect(h.createProxyAgent).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe('one official logical endpoint through an explicit bounded dispatcher', () => {
  it('sends one POST through the supplied proxy, retains TLS and disables redirects/idempotent replay', async () => {
    const h = harness();
    const result = await h.transport(input());
    expect(result).toEqual({ status: 200, body: '{"synthetic":true}' });
    expect(h.createProxyAgent).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][0]).toBe(OPENAI_RESPONSES_URL);
    expect(h.options[0]).toMatchObject({
      method: 'POST',
      dispatcher: h.agent,
      maxRedirections: 0,
      idempotent: false,
      blocking: true,
      body: input().body,
      headers: {
        Authorization: 'Bearer synthetic-placeholder-only',
        'Accept-Encoding': 'identity',
      },
    });
    expect(h.configurations[0]).toMatchObject({
      uri: `${proxyUrl}/`,
      proxyTunnel: true,
      connections: 1,
      pipelining: 0,
      allowH2: false,
      maxHeaderSize: 16384,
      maxResponseSize: 250000,
      maxRequestsPerClient: 1,
      requestTls: { rejectUnauthorized: true, servername: 'api.openai.com', allowH2: false },
      proxyTls: { rejectUnauthorized: true, allowH2: false },
    });
    expect(h.configurations[0]).not.toHaveProperty('auth');
    expect(h.configurations[0]).not.toHaveProperty('token');
    expect(h.agent.destroy).toHaveBeenCalledTimes(1);
  });
  it('bounds the proxy CONNECT parser independently, not only the tunneled response parser', async () => {
    const h = harness();
    await h.transport(input({ timeoutMs: 987 }));
    const factory = h.configurations[0].clientFactory!;
    const client = factory(new URL(proxyUrl), {});
    // The factory creates the installed Undici Client. Its options are verified
    // through actual oversized/slow CONNECT responses in the local TLS fixture.
    expect(client).toBeDefined();
    await client.destroy();
    expect(h.configurations[0]).toMatchObject({
      connectTimeout: 987,
      headersTimeout: 987,
      bodyTimeout: 987,
    });
    expect(h.options[0]).toMatchObject({ headersTimeout: 987, bodyTimeout: 987 });
  });
  it('appends explicit platform certificates to the active default trust roots', async () => {
    const h = harness();
    const transport = createCloudProxyTransport(
      { proxyUrl, additionalCa: Buffer.from(getCACertificates('default')[0]) },
      h,
    );
    await transport(input());
    const ca = (h.configurations[0].requestTls as ConnectionOptions | undefined)?.ca;
    expect(Array.isArray(ca)).toBe(true);
    if (!Array.isArray(ca)) throw new Error('Expected public CA certificate array');
    expect(ca).toContain(getCACertificates('default')[0]);
    expect(new Set(ca).size).toBe((ca as string[]).length);
    expect((h.configurations[0].proxyTls as ConnectionOptions | undefined)?.ca).toEqual(ca);
  });
  it('accepts a large public CA bundle and deduplicates repeated roots', async () => {
    const h = harness();
    const roots = getCACertificates('default').slice(0, 30);
    expect(roots.length).toBeGreaterThan(16);
    const transport = createCloudProxyTransport({ proxyUrl, additionalCa: roots }, h);
    await transport(input());
    const ca = (h.configurations[0].requestTls as ConnectionOptions | undefined)?.ca as string[];
    expect(ca.length).toBeGreaterThanOrEqual(roots.length);
    expect(new Set(ca).size).toBe(ca.length);
  });
  it.each([
    'http://api.openai.com/v1/responses',
    'https://api.openai.com/v1/responses/',
    'https://api.openai.com:444/v1/responses',
    'https://other.synthetic.invalid/v1/responses',
    'https://127.0.0.1/v1/responses',
  ])('rejects a non-exact destination %s without constructing any proxy request', async (url) => {
    const h = harness();
    await expect(h.transport(input({ url }))).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(h.createProxyAgent).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it.each([
    { apiKey: '' },
    { apiKey: 'synthetic key' },
    { apiKey: 'synthetic\nkey' },
    { apiKey: 'x'.repeat(1025) },
    { body: '' },
    { body: 'x'.repeat(256001) },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 120001 },
    { timeoutMs: 1.5 },
  ])('rejects invalid request data before contacting a proxy %#', async (overrides) => {
    const h = harness();
    await expect(h.transport(input(overrides))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.createProxyAgent).not.toHaveBeenCalled();
  });
  it.each([
    'synthetic-中',
    'synthetic-🙂',
    'synthetic-\u0100',
    'synthetic-\uD800',
    'synthetic-\uDC00',
  ])(
    'rejects an Authorization value Node cannot encode before constructing a dispatcher %#',
    async (apiKey) => {
      const h = harness();
      const failure = await h.transport(input({ apiKey })).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'INVALID_REQUEST',
        message: 'OpenAI transport: INVALID_REQUEST',
      });
      expect(h.createProxyAgent).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(String(failure)).not.toContain(apiKey);
    },
  );
  it('bounds UTF-8 request bytes and sends the correct Content-Length', async () => {
    const h = harness();
    await h.transport(input({ body: '合成' }));
    expect(h.options[0].headers['Content-Length']).toBe('6');
    const second = harness();
    await expect(second.transport(input({ body: '中'.repeat(90000) }))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(second.request).not.toHaveBeenCalled();
  });
});

describe('bounded response and sanitized failures', () => {
  it.each([301, 302, 303, 307, 308])(
    'rejects response redirect %s and never sends a second request',
    async (statusCode) => {
      const h = harness({ statusCode, headers: { location: 'https://other.synthetic.invalid/' } });
      await expect(h.transport(input())).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.agent.destroy).toHaveBeenCalledTimes(1);
    },
  );
  it.each([0, 99, 600, 200.5, NaN])('rejects malformed status %s', async (statusCode) => {
    const h = harness({ statusCode });
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each(['250001', '-1', '2e3', ['100', '200']])(
    'rejects invalid/oversized Content-Length %#',
    async (length) => {
      const h = harness({ headers: { 'content-length': length } });
      await expect(h.transport(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );
  it('bounds chunked bytes without trusting Content-Length', async () => {
    const h = harness({ body: stream([Buffer.alloc(125000), Buffer.alloc(125001)]) });
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(h.agent.destroy).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid UTF-8 rather than replacing bytes in a model response', async () => {
    const h = harness({ body: stream([Buffer.from([0xc3, 0x28])]) });
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each(['123', 'Wed, 21 Oct 2037 07:28:00 GMT'])(
    'passes only bounded printable Retry-After metadata %s',
    async (retryAfter) => {
      const h = harness({ statusCode: 429, headers: { 'retry-after': retryAfter } });
      expect(await h.transport(input())).toMatchObject({ status: 429, retryAfter });
    },
  );
  it.each(['x'.repeat(81), 'synthetic\nsecret', ['1', '2'], '非ASCII'])(
    'discards malformed Retry-After %#',
    async (retryAfter) => {
      const h = harness({ statusCode: 503, headers: { 'retry-after': retryAfter } });
      expect(await h.transport(input())).not.toHaveProperty('retryAfter');
    },
  );
  it('never reflects raw proxy, certificate, source or authorization exception text', async () => {
    const h = harness();
    h.request.mockRejectedValueOnce(
      new Error('synthetic-placeholder-only http://private-proxy synthetic source'),
    );
    const error = await h.transport(input()).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'OpenAI transport: NETWORK_ERROR',
    });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.agent.destroy).toHaveBeenCalledTimes(1);
  });
  it('maps parser overflow to a deterministic sanitized response failure', async () => {
    const h = harness();
    h.request.mockRejectedValueOnce(
      Object.assign(new Error('synthetic raw header'), { code: 'UND_ERR_HEADERS_OVERFLOW' }),
    );
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('sanitizes a synchronous dispatcher construction failure without attempting a request', async () => {
    const h = harness();
    h.createProxyAgent.mockImplementationOnce(() => {
      throw new Error('synthetic-private-proxy-url');
    });
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe('whole-operation cancellation and cleanup', () => {
  it('an already aborted signal causes no dispatcher or network request', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    await expect(h.transport(input({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(h.createProxyAgent).not.toHaveBeenCalled();
  });
  it('times out even when an injected request ignores cancellation, and destroys its late body', async () => {
    const pending = deferred<CloudProxyResponse>();
    const h = harness();
    h.request.mockReturnValueOnce(pending.promise);
    const work = h.transport(input({ timeoutMs: 15 }));
    await expect(work).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(h.agent.destroy).toHaveBeenCalledTimes(1);
    const late = stream();
    const destroy = vi.spyOn(late, 'destroy');
    pending.resolve({ statusCode: 200, headers: {}, body: late });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it('cancels a pending proxy operation and removes caller abort listeners', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const h = harness();
    h.request.mockReturnValueOnce(new Promise(() => undefined));
    const work = h.transport(input({ signal: controller.signal }));
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(h.agent.destroy).toHaveBeenCalledTimes(1);
  });
  it('bounds a hanging response body, closes it, and never waits for a broken destructor', async () => {
    const hanging = new Readable({ read() {} });
    const h = harness({ body: hanging });
    h.agent.destroy.mockReturnValueOnce(new Promise(() => undefined));
    await expect(h.transport(input({ timeoutMs: 15 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(hanging.destroyed).toBe(true);
  });
  it('isolates dispatchers and cleanup for concurrent calls', async () => {
    const agents: { destroy: ReturnType<typeof vi.fn> }[] = [];
    const transport = createCloudProxyTransport(
      { proxyUrl },
      {
        createProxyAgent: () => {
          const agent = { destroy: vi.fn(async () => undefined) };
          agents.push(agent);
          return agent;
        },
        request: async () => ({ statusCode: 200, headers: {}, body: stream() }),
      },
    );
    await Promise.all([transport(input()), transport(input())]);
    expect(agents).toHaveLength(2);
    expect(agents.every((agent) => agent.destroy.mock.calls.length === 1)).toBe(true);
  });
});
