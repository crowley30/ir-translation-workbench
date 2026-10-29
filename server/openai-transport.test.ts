import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import {
  createOpenAITransport,
  isPublicOpenAIAddress,
  OPENAI_RESPONSES_URL,
  OpenAITransportError,
  type OpenAITransportDependencies,
  type OpenAITransportRequest,
} from './openai-transport';

const syntheticKey = 'synthetic-only-credential';
const publicV4 = { address: '93.184.216.34', family: 4 };
const publicV6 = { address: '2606:4700:4700::1111', family: 6 };
const input = (overrides: Partial<OpenAITransportRequest> = {}): OpenAITransportRequest => ({
  apiKey: syntheticKey,
  body: '{"model":"synthetic-model","input":"synthetic"}',
  signal: new AbortController().signal,
  ...overrides,
});
class FakeRequest extends EventEmitter {
  destroyed = false;
  body = '';
  constructor(private respond: () => void) {
    super();
  }
  end(body: string) {
    this.body = body;
    queueMicrotask(this.respond);
    return this;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
}
function harness(
  settings: {
    status?: number;
    body?: string | Buffer;
    headers?: Record<string, string | string[]>;
    hang?: boolean;
    hangHeaders?: boolean;
    beforeReply?: (response: IncomingMessage, request: FakeRequest) => void;
  } = {},
) {
  const requests: FakeRequest[] = [];
  const responses: IncomingMessage[] = [];
  const options: RequestOptions[] = [];
  const lookup = vi.fn<NonNullable<OpenAITransportDependencies['lookup']>>(async () => [publicV4]);
  const request = vi.fn<NonNullable<OpenAITransportDependencies['request']>>((config, reply) => {
    options.push(config);
    const response = Object.assign(new PassThrough(), {
      statusCode: settings.status ?? 200,
      headers: settings.headers ?? {},
    }) as unknown as IncomingMessage;
    responses.push(response);
    const outgoing = new FakeRequest(() => {
      if (settings.hangHeaders) return;
      settings.beforeReply?.(response, outgoing);
      reply(response);
      if (!settings.hang)
        (response as unknown as PassThrough).end(settings.body ?? '{"synthetic":true}');
    });
    requests.push(outgoing);
    return outgoing as unknown as ClientRequest;
  });
  return {
    requests,
    responses,
    options,
    lookup,
    request,
    transport: createOpenAITransport({ lookup, request }),
  };
}
async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('conservative OpenAI public-unicast destination validation', () => {
  it.each([
    '0.0.0.0',
    '0.2.3.4',
    '10.10.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.9',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.10',
    '203.0.113.2',
    '224.0.0.1',
    '255.255.255.255',
  ])('rejects IPv4 special-use destination %s', (address) => {
    expect(isPublicOpenAIAddress(address, 4)).toBe(false);
  });
  it.each([
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:93.184.216.34',
    'fc00::1',
    'fd12::2',
    'fe80::1',
    'ff02::1',
    '64:ff9b::a00:1',
    '2001::1',
    '2001:20::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '3fff::1',
    '2606:4700:4700::1111%eth0',
  ])('rejects IPv6 special-use/mapped/scoped destination %s', (address) => {
    expect(isPublicOpenAIAddress(address, 6)).toBe(false);
  });
  it('accepts explicit public unicast families and refuses malformed/mismatched families', () => {
    expect(isPublicOpenAIAddress(publicV4.address, 4)).toBe(true);
    expect(isPublicOpenAIAddress(publicV6.address, 6)).toBe(true);
    expect(isPublicOpenAIAddress(publicV4.address, 6)).toBe(false);
    expect(isPublicOpenAIAddress(publicV6.address, 4)).toBe(false);
    expect(isPublicOpenAIAddress('2130706433', 4)).toBe(false);
    expect(isPublicOpenAIAddress('127.1', 4)).toBe(false);
    expect(isPublicOpenAIAddress('0x7f000001', 4)).toBe(false);
    expect(isPublicOpenAIAddress('garbage', 4)).toBe(false);
    expect(isPublicOpenAIAddress(publicV4.address, 0)).toBe(false);
  });
});

describe('fixed official endpoint and pinned native HTTPS transport', () => {
  it.each([
    'https://api.openai.com/v1/responses/',
    'https://api.openai.com/v1/responses?redirect=1',
    'https://api.openai.com/v1/responses#fragment',
    'https://api.openai.com:443/v1/responses',
    'https://api.openai.com.evil.example.com/v1/responses',
    'https://metadata.google.internal/v1/responses',
    'https://127.0.0.1/v1/responses',
    'http://api.openai.com/v1/responses',
    'https://credential@api.openai.com/v1/responses',
    'https://custom.example.com/v1/responses',
  ])('rejects any non-exact endpoint before DNS or credential transmission: %s', async (url) => {
    const h = harness();
    await expect(h.transport(input({ url }))).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it('only constructs requests on explicit invocation, pins lookup and keeps TLS hostname checks', async () => {
    const h = harness({ body: '{"translation":"合成"}', headers: { 'retry-after': '2' } });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    const result = await h.transport(input({ url: OPENAI_RESPONSES_URL }));
    expect(result).toEqual({ status: 200, body: '{"translation":"合成"}', retryAfter: '2' });
    expect(h.lookup).toHaveBeenCalledExactlyOnceWith('api.openai.com');
    const options = h.options[0];
    expect(options).toMatchObject({
      protocol: 'https:',
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/responses',
      servername: 'api.openai.com',
      rejectUnauthorized: true,
      agent: false,
      family: 4,
      method: 'POST',
      maxHeaderSize: 16384,
      headers: {
        Authorization: `Bearer ${syntheticKey}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity',
        'Content-Length': Buffer.byteLength(input().body),
      },
    });
    expect(options).not.toHaveProperty('rejectUnauthorized', false);
    expect(options).not.toHaveProperty('checkServerIdentity');
    expect(h.requests[0].body).toBe(input().body);
    const pinned = vi.fn();
    options.lookup!('api.openai.com', {}, pinned);
    expect(pinned).toHaveBeenLastCalledWith(null, publicV4.address, 4);
    options.lookup!('api.openai.com', { all: true }, pinned);
    expect(pinned).toHaveBeenLastCalledWith(null, [publicV4], undefined);
    // Calling the pinned callback again cannot perform another system lookup.
    options.lookup!('api.openai.com', {}, pinned);
    expect(h.lookup).toHaveBeenCalledTimes(1);
    options.lookup!('attacker.example.com', {}, pinned);
    expect(pinned.mock.lastCall?.[0]).toBeInstanceOf(Error);
  });
  it('pins an IPv6 result without IPv4 fallback or address family ambiguity', async () => {
    const h = harness();
    h.lookup.mockResolvedValue([publicV6, publicV4]);
    await h.transport(input());
    expect(h.options[0].family).toBe(6);
    const callback = vi.fn();
    h.options[0].lookup!('api.openai.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, publicV6.address, 6);
  });
  it.each(
    [
      [],
      [publicV4, { address: '127.0.0.1', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }, publicV4],
      [publicV6, { address: '::ffff:7f00:1', family: 6 }],
      [{ address: publicV4.address, family: 6 }],
      Array.from({ length: 17 }, () => publicV4),
    ].map((addresses) => ({ addresses })),
  )(
    'rejects the whole DNS answer set when any answer is unsafe or invalid: %j',
    async ({ addresses }) => {
      const h = harness();
      h.lookup.mockResolvedValue(addresses);
      await expect(h.transport(input())).rejects.toMatchObject({ code: 'UNSAFE_ADDRESS' });
      expect(h.request).not.toHaveBeenCalled();
    },
  );
  it('re-resolves and validates every separate connection; a later DNS rebinding never sends a request', async () => {
    const h = harness();
    h.lookup
      .mockResolvedValueOnce([publicV4])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await h.transport(input());
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'UNSAFE_ADDRESS' });
    expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 303, 307, 308])(
    'does not follow or leak credentials on HTTP %s',
    async (status) => {
      const h = harness({
        status,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      });
      await expect(h.transport(input())).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.requests[0].destroyed).toBe(true);
      expect(h.responses[0].destroyed).toBe(true);
    },
  );
  it('keeps provider error bodies bounded and returns only fixed errors for native failures', async () => {
    const h = harness({ status: 429, body: '{"error":"synthetic rate limit"}' });
    expect(await h.transport(input())).toEqual({
      status: 429,
      body: '{"error":"synthetic rate limit"}',
    });
    h.lookup.mockRejectedValue(new Error(`Synthetic native error ${syntheticKey}`));
    const result = await h.transport(input()).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(OpenAITransportError);
    expect(result).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(result)).not.toContain(syntheticKey);
  });
  it('does not return oversized or unsafe Retry-After header content', async () => {
    const h = harness({ headers: { 'retry-after': 'x'.repeat(81) } });
    expect(await h.transport(input())).not.toHaveProperty('retryAfter');
  });
});

describe('request/response limits, deadlines and cancellation', () => {
  it.each([
    { apiKey: '' },
    { apiKey: 'synthetic\nheader' },
    { body: '' },
    { body: 'x'.repeat(256001) },
    { body: '中'.repeat(86000) },
    { timeoutMs: 0 },
    { timeoutMs: 120001 },
    { timeoutMs: NaN },
  ])('rejects invalid request bounds before DNS', async (overrides) => {
    const h = harness();
    await expect(h.transport(input(overrides))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.lookup).not.toHaveBeenCalled();
  });
  it('does no DNS or request work for an already cancelled call', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.transport(input({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it('same-tick cancellation prevents even the queued DNS lookup', async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.transport(input({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await turn();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('bounds a never-completing DNS lookup and ignores its late result', async () => {
    vi.useFakeTimers();
    const h = harness();
    let release!: (value: (typeof publicV4)[]) => void;
    h.lookup.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const promise = h.transport(input({ timeoutMs: 10 }));
    const check = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await check;
    release([publicV4]);
    await turn();
    expect(h.request).not.toHaveBeenCalled();
  });
  it('cancels during DNS and ignores a later safe answer', async () => {
    const h = harness();
    let release!: (value: (typeof publicV4)[]) => void;
    h.lookup.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const controller = new AbortController();
    const promise = h.transport(input({ signal: controller.signal }));
    const check = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    await turn();
    controller.abort();
    await check;
    release([publicV4]);
    await turn();
    expect(h.request).not.toHaveBeenCalled();
  });
  it('the deadline also bounds a connection that never supplies response headers', async () => {
    vi.useFakeTimers();
    const h = harness({ hangHeaders: true });
    const promise = h.transport(input({ timeoutMs: 10 }));
    const check = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await check;
    expect(h.requests[0].destroyed).toBe(true);
  });
  it('a deadline covers a successful response header followed by an endless body', async () => {
    vi.useFakeTimers();
    const h = harness({ hang: true });
    const promise = h.transport(input({ timeoutMs: 10 }));
    const check = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await check;
    expect(h.requests[0].destroyed).toBe(true);
    expect(h.responses[0].destroyed).toBe(true);
  });
  it('cancellation destroys both active request and response and ignores late output', async () => {
    const h = harness({ hang: true });
    const controller = new AbortController();
    const promise = h.transport(input({ signal: controller.signal }));
    const check = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    await turn();
    controller.abort();
    await check;
    expect(h.requests[0].destroyed).toBe(true);
    expect(h.responses[0].destroyed).toBe(true);
    h.responses[0].emit('data', Buffer.from('{"late":true}'));
    h.responses[0].emit('end');
  });
  it.each([
    { body: 'x'.repeat(250001) },
    { headers: { 'content-length': '250001' } },
    { headers: { 'content-length': 'invalid' } },
    { body: Buffer.from([0xff, 0xfe]) },
  ])('rejects excessive lengths and invalid UTF-8 without reflecting payload', async (settings) => {
    const h = harness(settings);
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(h.requests[0].destroyed).toBe(true);
    expect(h.responses[0].destroyed).toBe(true);
  });
  it('premature response close rejects without waiting until the full deadline', async () => {
    const h = harness({
      hang: true,
      beforeReply: (response) => queueMicrotask(() => response.destroy()),
    });
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
  it('native request failures are sanitized and destroy the active transport', async () => {
    const h = harness({
      hang: true,
      beforeReply: (_response, request) => {
        request.emit('error', new Error(`synthetic native TLS error ${syntheticKey}`));
      },
    });
    const error = await h.transport(input()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(error)).not.toContain(syntheticKey);
    expect(h.requests[0].destroyed).toBe(true);
  });
  it('keeps error listeners after an early invalid-header failure so late stream errors are harmless', async () => {
    const h = harness({ headers: { 'content-length': '250001' } });
    await expect(h.transport(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(() => h.responses[0].emit('error', new Error('synthetic late failure'))).not.toThrow();
  });
  it('successful calls clear deadlines and abort listeners', async () => {
    vi.useFakeTimers();
    const h = harness();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = h.transport(input({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 200 });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(h.requests[0].destroyed).toBe(false);
  });
});
