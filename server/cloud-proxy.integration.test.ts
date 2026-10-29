import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import httpRequest from 'supertest';
import { createApp } from './app.js';
import { TaskStore } from './store.js';
import { TaskService } from './service.js';
import { LiveProviderRuntime } from './live-provider.js';
import { createCloudProxyTransport } from './cloud-proxy-transport.js';
import { createOpenAIAdapter } from './openai-adapter.js';
import { OpenAIBudgetLedger } from './openai-budget.js';
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS } from '../shared/openai-models.js';
import type { OpenAITransport, OpenAITransportRequest } from './openai-transport.js';

// Private keys are deliberately generated for this isolated test run in /tmp.
// They are never constants, fixture files, command output, environment values or
// repository artifacts. No request in this file forwards outside 127.0.0.1.
interface SyntheticCertificates {
  directory: string;
  ca: Buffer;
  official: { key: Buffer; cert: Buffer };
  wrongHost: { key: Buffer; cert: Buffer };
  proxy: { key: Buffer; cert: Buffer };
}
function certificates(): SyntheticCertificates {
  const directory = mkdtempSync(join(tmpdir(), 'ir-cloud-proxy-cert-'));
  const run = (...args: string[]) =>
    execFileSync('openssl', args, { cwd: directory, stdio: 'ignore', timeout: 5000 });
  const leaf = (name: string, hostname: string, sans = `DNS:${hostname}`) => {
    run(
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${hostname}`,
    );
    writeFileSync(
      join(directory, `${name}.ext`),
      `subjectAltName=${sans}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`,
    );
    run(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '1',
      '-extfile',
      `${name}.ext`,
    );
    return {
      key: readFileSync(join(directory, `${name}.key`)),
      cert: readFileSync(join(directory, `${name}.pem`)),
    };
  };
  try {
    run(
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=IR Synthetic Proxy CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    );
    return {
      directory,
      ca: readFileSync(join(directory, 'ca.pem')),
      official: leaf('official', 'api.openai.com'),
      wrongHost: leaf('wrong', 'wrong.synthetic.invalid'),
      proxy: leaf('proxy', 'localhost', 'IP:127.0.0.1,DNS:localhost'),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

const PLACEHOLDER = 'synthetic-network-placeholder';
const UPSTREAM_CREDENTIAL = 'synthetic-upstream-credential';
const translation = '合成基金于2026年10月29日投资了1200万美元。';
const input = {
  paragraphId: 'p0001',
  source: 'The synthetic fund invested USD 12 million on October 29, 2026.',
  style: 'faithful' as const,
  paragraphIndex: 0,
  scenario: 'normal' as const,
};
function envelope(id = 'p0001') {
  return {
    object: 'response',
    id: 'resp_local_synthetic',
    model: OPENAI_DEFAULT_MODEL,
    service_tier: 'default',
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
    output: [
      {
        type: 'message',
        id: 'msg_local_synthetic',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            annotations: [],
            text: JSON.stringify({ paragraphs: [{ id, translation }] }),
          },
        ],
      },
    ],
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Scenario =
  | 'normal'
  | 'connect-403'
  | 'connect-407'
  | 'connect-redirect'
  | 'large-connect-header'
  | 'slow-connect'
  | 'slow-headers'
  | 'slow-body'
  | 'response-redirect'
  | 'large-body'
  | 'rate-limit';
interface SeenRequest {
  target: string;
  method: string;
  path: string;
  hostname: string;
  placeholder: string;
  surrogateAuthorization: string;
  body: string;
}
interface LocalProxy {
  url: string;
  connects: string[];
  readonly tcpConnections: number;
  seen: SeenRequest[];
  sockets: Set<Socket | TLSSocket>;
  connected: ReturnType<typeof deferred>;
  requested: ReturnType<typeof deferred>;
  setScenario(value: Scenario): void;
  close(): Promise<void>;
}
let generated: SyntheticCertificates;
const proxies: LocalProxy[] = [];

async function localProxy(
  scenario: Scenario = 'normal',
  wrongHost = false,
  secureProxy = false,
  wrongProxyHost = false,
): Promise<LocalProxy> {
  const connects: string[] = [];
  let tcpConnections = 0;
  const seen: SeenRequest[] = [];
  const sockets = new Set<Socket | TLSSocket>();
  const connected = deferred(),
    requested = deferred();
  const track = (socket: Socket | TLSSocket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  };
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 256000) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      const original = request.headers.authorization ?? '';
      const allowed =
        request.method === 'POST' &&
        request.url === '/v1/responses' &&
        request.headers.host === 'api.openai.com';
      const surrogateAuthorization =
        allowed && original === `Bearer ${PLACEHOLDER}` ? `Bearer ${UPSTREAM_CREDENTIAL}` : '';
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        target: connects.at(-1) ?? '',
        method: request.method ?? '',
        path: request.url ?? '',
        hostname: request.headers.host ?? '',
        placeholder: original,
        surrogateAuthorization,
        body,
      });
      requested.resolve();
      if (!allowed || !surrogateAuthorization) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (scenario === 'slow-headers') return;
      if (scenario === 'response-redirect') {
        response.writeHead(307, { Location: 'https://must-not-contact.invalid/private' });
        response.end();
        return;
      }
      if (scenario === 'rate-limit') {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0.25' });
        response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (scenario === 'slow-body') {
        response.write('{"status":');
        return;
      }
      if (scenario === 'large-body') {
        response.end('x'.repeat(250001));
        return;
      }
      let id = 'p0001';
      try {
        const payload = JSON.parse(body) as { input?: { content?: string }[] };
        if (typeof payload.input?.[0]?.content === 'string') {
          const data = JSON.parse(payload.input[0].content) as { id?: string };
          if (typeof data.id === 'string') id = data.id;
        }
      } catch {
        /* Raw transport cases intentionally use a small non-Responses payload. */
      }
      response.end(JSON.stringify(envelope(id)));
    });
    request.on('error', () => undefined);
  };
  const upstream = createHttpServer(handler);
  const secureContext = createSecureContext(wrongHost ? generated.wrongHost : generated.official);
  const server = createHttpServer((_request, response) => {
    response.writeHead(400);
    response.end();
  });
  if (!secureProxy) server.on('connection', track);
  const listener = secureProxy
    ? createNetServer((socket) => {
        const secured = new TLSSocket(socket, {
          isServer: true,
          secureContext: createSecureContext(wrongProxyHost ? generated.official : generated.proxy),
        });
        track(secured);
        server.emit('connection', secured);
      })
    : server;
  listener.on('connection', () => {
    tcpConnections++;
  });
  server.on('connect', (request, socket, head) => {
    connects.push(request.url ?? '');
    connected.resolve();
    // CONNECT sockets belong to the proxy after upgrade; consume EOF and close
    // the server half too, so a peer abort is observable as a full TCP teardown.
    socket.on('end', () => socket.destroy());
    if (request.url !== 'api.openai.com:443') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (scenario === 'slow-connect') {
      socket.resume();
      return;
    }
    if (scenario === 'connect-403' || scenario === 'connect-407') {
      const status =
        scenario === 'connect-403' ? '403 Forbidden' : '407 Proxy Authentication Required';
      socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (scenario === 'connect-redirect') {
      socket.end(
        'HTTP/1.1 302 Found\r\nLocation: https://must-not-contact.invalid/\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    if (scenario === 'large-connect-header') {
      socket.end(
        `HTTP/1.1 200 Connection Established\r\nX-Synthetic: ${'x'.repeat(100000)}\r\n\r\n`,
      );
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    const secured = new TLSSocket(socket, { isServer: true, secureContext });
    // Track the actual TLS wrapper, not a stale raw Socket object whose handle
    // ownership moved during wrapping. No close assertion is skipped.
    if (socket instanceof Socket) sockets.delete(socket);
    track(secured);
    upstream.emit('connection', secured);
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic proxy did not bind');
  const result: LocalProxy = {
    url: `${secureProxy ? 'https' : 'http'}://127.0.0.1:${address.port}`,
    connects,
    get tcpConnections() {
      return tcpConnections;
    },
    seen,
    sockets,
    connected,
    requested,
    setScenario(value) {
      scenario = value;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      upstream.removeAllListeners();
    },
  };
  proxies.push(result);
  return result;
}
function request(transport: OpenAITransport, overrides: Partial<OpenAITransportRequest> = {}) {
  return transport({
    apiKey: PLACEHOLDER,
    body: JSON.stringify({ synthetic: true }),
    signal: new AbortController().signal,
    timeoutMs: 1500,
    ...overrides,
  });
}
async function waitClosed(proxy: LocalProxy) {
  try {
    await vi.waitFor(() => expect(proxy.sockets.size).toBe(0), { timeout: 1500, interval: 10 });
  } catch {
    throw new Error(
      `Synthetic socket teardown state: ${JSON.stringify([...proxy.sockets].map((socket) => ({ type: socket.constructor.name, destroyed: socket.destroyed, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded, readyState: socket.readyState, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten })))}`,
    );
  }
}
function setupAdapter(transport: OpenAITransport) {
  const values = new Map<string, unknown>();
  const budget = new OpenAIBudgetLedger(
    {
      getSetting: (key) => values.get(key),
      setSetting: (key, value) => values.set(key, structuredClone(value)),
    },
    {
      operatorCapMicros: 1_000_000,
      prices: Object.fromEntries(OPENAI_MODELS.map((model) => [model.id, model])),
    },
  );
  budget.arm({ budgetMicros: 1_000_000, acknowledgeCosts: true });
  return {
    budget,
    adapter: createOpenAIAdapter(
      {
        apiKey: PLACEHOLDER,
        model: OPENAI_DEFAULT_MODEL,
        maxOutputTokens: 4096,
        enabled: true,
        timeoutMs: 1500,
      },
      { transport, budget },
    ),
  };
}

beforeAll(() => {
  generated = certificates();
});
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (generated) rmSync(generated.directory, { recursive: true, force: true });
});

describe('local synthetic Cloud TLS-intercepting proxy integration', () => {
  it('translates through one actual CONNECT/TLS request, substitutes only a synthetic placeholder and reconciles usage', async () => {
    const proxy = await localProxy();
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    const { budget, adapter } = setupAdapter(transport);
    expect(proxy.connects).toHaveLength(0);
    expect(await adapter.translate(input, new AbortController().signal)).toBe(translation);
    expect(proxy.connects).toEqual(['api.openai.com:443']);
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/responses',
      hostname: 'api.openai.com',
      placeholder: `Bearer ${PLACEHOLDER}`,
      surrogateAuthorization: `Bearer ${UPSTREAM_CREDENTIAL}`,
    });
    const body = JSON.parse(proxy.seen[0].body) as { input: { content: string }[] };
    expect(JSON.parse(body.input[0].content)).toMatchObject({
      id: input.paragraphId,
      source: input.source,
      style: 'faithful',
    });
    expect(budget.summary()).toMatchObject({
      attempts: 1,
      pendingAttempts: 0,
      unknownAttempts: 0,
      spentMicros: 45,
      reservedMicros: 0,
    });
    await waitClosed(proxy);
  });

  it('does not log synthetic credentials, source text or raw proxy errors', async () => {
    const calls: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    const proxy = await localProxy('connect-407');
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    const error = await request(transport).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: 'OpenAITransportError' });
    const exposed = JSON.stringify([calls, String(error)]);
    for (const value of [PLACEHOLDER, UPSTREAM_CREDENTIAL, input.source, proxy.url])
      expect(exposed).not.toContain(value);
    expect(proxy.connects).toHaveLength(1);
    expect(proxy.seen).toHaveLength(0);
    await waitClosed(proxy);
  });

  it('rejects an untrusted synthetic issuer without sending HTTP credentials', async () => {
    const proxy = await localProxy();
    const transport = createCloudProxyTransport({ proxyUrl: proxy.url });
    await expect(request(transport)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(proxy.connects).toHaveLength(1);
    expect(proxy.seen).toHaveLength(0);
    await waitClosed(proxy);
  });

  it('retains official hostname verification even when the synthetic CA is trusted', async () => {
    const proxy = await localProxy('normal', true);
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    await expect(request(transport)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(proxy.connects).toHaveLength(1);
    expect(proxy.seen).toHaveLength(0);
    await waitClosed(proxy);
  });

  it.each(['connect-403', 'connect-407', 'connect-redirect', 'large-connect-header'] as const)(
    '%s terminates one attempt without falling back to a direct connection',
    async (scenario) => {
      const proxy = await localProxy(scenario);
      const transport = createCloudProxyTransport({
        proxyUrl: proxy.url,
        additionalCa: generated.ca,
      });
      await expect(request(transport)).rejects.toMatchObject({ name: 'OpenAITransportError' });
      expect(proxy.connects).toEqual(['api.openai.com:443']);
      expect(proxy.seen).toHaveLength(0);
      await waitClosed(proxy);
    },
  );

  it('rejects a tunneled response redirect instead of following it', async () => {
    const proxy = await localProxy('response-redirect');
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    await expect(request(transport)).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
    expect(proxy.connects).toHaveLength(1);
    expect(proxy.seen).toHaveLength(1);
    await waitClosed(proxy);
  });

  it('bounds a chunked response body independently of Content-Length', async () => {
    const proxy = await localProxy('large-body');
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    await expect(request(transport)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(proxy.connects).toHaveLength(1);
    expect(proxy.seen).toHaveLength(1);
    await waitClosed(proxy);
  });

  it('returns bounded Retry-After metadata to the existing finite retry layer', async () => {
    const proxy = await localProxy('rate-limit');
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    const response = await request(transport);
    expect(response.status).toBe(429);
    expect(response.retryAfter).toBe('0.25');
    expect(proxy.connects).toHaveLength(1);
    expect(proxy.seen).toHaveLength(1);
    await waitClosed(proxy);
  });

  it.each(['slow-connect', 'slow-headers', 'slow-body'] as const)(
    '%s shares one finite deadline and retains uncertain budget',
    async (scenario) => {
      const proxy = await localProxy(scenario);
      const transport = createCloudProxyTransport({
        proxyUrl: proxy.url,
        additionalCa: generated.ca,
      });
      const { budget, adapter } = setupAdapter((args) => transport({ ...args, timeoutMs: 120 }));
      await expect(adapter.translate(input, new AbortController().signal)).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
      expect(proxy.connects).toHaveLength(1);
      expect(budget.summary()).toMatchObject({ attempts: 1, spentMicros: 0, unknownAttempts: 1 });
      expect(budget.summary().reservedMicros).toBeGreaterThan(0);
      await waitClosed(proxy);
    },
  );

  it.each(['slow-connect', 'slow-body'] as const)(
    'cancelling %s closes the actual proxy socket without replay',
    async (scenario) => {
      const proxy = await localProxy(scenario);
      const transport = createCloudProxyTransport({
        proxyUrl: proxy.url,
        additionalCa: generated.ca,
      });
      const abort = new AbortController();
      // Observe rejection immediately, so a transport/configuration failure cannot
      // become an unhandled rejection while waiting for a network precondition.
      const work = request(transport, { signal: abort.signal }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await Promise.race([
        scenario === 'slow-connect' ? proxy.connected.promise : proxy.requested.promise,
        work.then(() => {
          throw new Error('Synthetic transport completed before cancellation precondition');
        }),
      ]);
      abort.abort();
      const outcome = await work;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ code: 'CANCELLED' });
      expect(proxy.connects).toHaveLength(1);
      await waitClosed(proxy);
    },
  );

  it('uses the configured actual local proxy from the runtime while NO_PROXY requests a bypass, then aborts without refunding uncertain usage', async () => {
    const proxy = await localProxy();
    const store = new TaskStore(':memory:');
    const runtime = new LiveProviderRuntime(store, {
      TRANSLATION_TRANSPORT: 'cloud-proxy',
      HTTPS_PROXY: proxy.url,
      NO_PROXY: '*',
      SSL_CERT_FILE: join(generated.directory, 'ca.pem'),
      ALLOW_REAL_TRANSLATION: 'true',
      TRANSLATION_MAX_BUDGET_USD: '1',
      IR_TRANSLATION_SYNTH_KEY: PLACEHOLDER,
    });
    const service = new TaskService(store, runtime.adapter, 2000);
    const app = createApp(service, undefined, runtime);
    try {
      const initial = await httpRequest(app).get('/api/live-provider').expect(200);
      expect(initial.body).toMatchObject({
        mode: 'mock',
        transport: { mode: 'cloud-proxy', ready: true, upstreamDns: 'managed-proxy' },
      });
      expect(JSON.stringify(initial.body)).not.toContain(proxy.url);
      expect(JSON.stringify(initial.body)).not.toContain(PLACEHOLDER);
      const saved = await httpRequest(app)
        .put('/api/provider-settings')
        .send({
          mode: 'custom',
          protocol: 'openai-responses',
          baseUrl: 'https://api.openai.com/v1',
          model: OPENAI_DEFAULT_MODEL,
          credentialRef: 'IR_TRANSLATION_SYNTH_KEY',
          expectedRevision: 0,
        })
        .expect(200);
      await httpRequest(app)
        .post('/api/live-provider/start')
        .send({
          expectedRevision: saved.body.revision,
          acknowledgeCosts: true,
          confirmDataTransfer: true,
          budgetMicros: 1_000_000,
          maxOutputTokens: 1024,
        })
        .expect(200);
      expect(proxy.connects).toHaveLength(0);
      const created = await httpRequest(app)
        .post('/api/tasks')
        .send({ text: input.source, style: input.style })
        .expect(201);
      expect(proxy.connects).toHaveLength(0);
      await httpRequest(app).post(`/api/tasks/${created.body.id}/translate`).send({}).expect(202);
      await service.idle(created.body.id);
      expect(service.get(created.body.id)).toMatchObject({ status: 'completed', mode: 'real' });
      expect(service.get(created.body.id).paragraphs[0].translation).toBe(translation);
      expect(runtime.ledger.summary()).toMatchObject({
        attempts: 1,
        spentMicros: 45,
        reservedMicros: 0,
      });
      expect(proxy.connects).toEqual(['api.openai.com:443']);
      expect(proxy.seen[0].surrogateAuthorization).toBe(`Bearer ${UPSTREAM_CREDENTIAL}`);

      proxy.setScenario('slow-body');
      const next = await httpRequest(app)
        .post('/api/tasks')
        .send({ text: 'Another synthetic source, never a real document.', style: 'business' })
        .expect(201);
      await httpRequest(app).post(`/api/tasks/${next.body.id}/translate`).send({}).expect(202);
      await vi.waitFor(() => expect(proxy.seen).toHaveLength(2), { timeout: 1500, interval: 10 });
      await httpRequest(app).post('/api/live-provider/stop').send({}).expect(200);
      await service.idle(next.body.id);
      expect(service.get(next.body.id).status).toBe('cancelled');
      expect(runtime.ledger.summary()).toMatchObject({
        armed: false,
        attempts: 2,
        spentMicros: 45,
        unknownAttempts: 1,
      });
      expect(runtime.ledger.summary().reservedMicros).toBeGreaterThan(0);
      expect(proxy.connects).toEqual(['api.openai.com:443', 'api.openai.com:443']);
      await waitClosed(proxy);
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  it('verifies both TLS layers when the configured proxy URL is HTTPS', async () => {
    const proxy = await localProxy('normal', false, true);
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    const response = await request(transport);
    expect(response.status).toBe(200);
    expect(proxy.connects).toEqual(['api.openai.com:443']);
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0].surrogateAuthorization).toBe(`Bearer ${UPSTREAM_CREDENTIAL}`);
    await waitClosed(proxy);
  });

  it('rejects a trusted proxy certificate for the wrong hostname before sending CONNECT or credentials', async () => {
    const proxy = await localProxy('normal', false, true, true);
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    await expect(request(transport)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(proxy.connects).toHaveLength(0);
    expect(proxy.seen).toHaveLength(0);
    await waitClosed(proxy);
  });

  it('rejects a synthetic Unicode bearer before opening TCP to the proxy', async () => {
    const proxy = await localProxy();
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    await expect(request(transport, { apiKey: `${PLACEHOLDER}\u4e2d` })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proxy.tcpConnections).toBe(0);
    expect(proxy.connects).toHaveLength(0);
    expect(proxy.seen).toHaveLength(0);
  });

  it('refuses a nonofficial target before contacting the proxy', async () => {
    const proxy = await localProxy();
    const transport = createCloudProxyTransport({
      proxyUrl: proxy.url,
      additionalCa: generated.ca,
    });
    await expect(
      request(transport, { url: 'https://must-not-contact.invalid/v1/responses' }),
    ).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(proxy.connects).toHaveLength(0);
    expect(proxy.seen).toHaveLength(0);
  });
});
