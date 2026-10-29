import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from './store.js';
import { TaskService } from './service.js';
import { LiveProviderRuntime } from './live-provider.js';
import { createApp } from './app.js';
import { createMockAdapter } from './adapter.js';
import type { OpenAITransport } from './openai-transport.js';
import { OPENAI_DEFAULT_MODEL } from '../shared/openai-models.js';

// These guards ensure every integration test is offline even if a regression
// accidentally tries to initiate a provider request. Supertest's HTTP loopback
// connection remains available; no real DNS or provider HTTP request is allowed.
const network = vi.hoisted(() => ({
  proxyRequest: vi.fn(async () => {
    throw new Error('Provider network forbidden in this synthetic suite');
  }),
  directLookup: vi.fn(async () => {
    throw new Error('Provider DNS forbidden in this synthetic suite');
  }),
}));
vi.mock('undici', async (original) => ({
  ...(await original<object>()),
  request: network.proxyRequest,
}));
vi.mock('node:dns/promises', async (original) => ({
  ...(await original<object>()),
  lookup: network.directLookup,
}));

const CREDENTIAL = 'OPENAI_API_KEY';
const SYNTHETIC = 'synthetic-cloud-runtime-placeholder';
const PROXY = 'http://platform-proxy.example:8080';
const BODY = {
  acknowledgeCosts: true,
  confirmDataTransfer: true,
  budgetMicros: 1_000_000,
  maxOutputTokens: 1024,
};
let store: TaskStore;
let service: TaskService;
let runtime: LiveProviderRuntime;
let app: ReturnType<typeof createApp>;
let temporary: string;

function environment(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ALLOW_REAL_TRANSLATION: 'true',
    TRANSLATION_MAX_BUDGET_USD: '1',
    [CREDENTIAL]: SYNTHETIC,
    ...values,
  };
}
function open(env: NodeJS.ProcessEnv, injected?: OpenAITransport) {
  runtime = new LiveProviderRuntime(store, env, injected, createMockAdapter({ delayMs: 0 }));
  service = new TaskService(store, runtime.adapter, 100);
  app = createApp(service, undefined, runtime);
}
async function settings(extra: Record<string, unknown> = {}, expectedStatus = 200) {
  const current = (await request(app).get('/api/provider-settings').expect(200)).body as {
    revision: number;
  };
  return request(app)
    .put('/api/provider-settings')
    .send({
      mode: 'custom',
      protocol: 'openai-responses',
      baseUrl: '',
      model: OPENAI_DEFAULT_MODEL,
      credentialRef: CREDENTIAL,
      expectedRevision: current.revision,
      ...extra,
    })
    .expect(expectedStatus);
}

function assertOffline() {
  expect(network.proxyRequest).not.toHaveBeenCalled();
  expect(network.directLookup).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  store = new TaskStore(':memory:');
  temporary = mkdtempSync(join(tmpdir(), 'ir-cloud-runtime-'));
});
afterEach(async () => {
  await service?.shutdown();
  store.close();
  rmSync(temporary, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Cloud transport configuration integrated with live-control guards', () => {
  it('leaves a proxy-bearing environment unconfigured and rejects start before reading a credential', async () => {
    const env = environment({ HTTPS_PROXY: PROXY });
    open(env);
    const saved = await settings();
    const status = await request(app).get('/api/live-provider').expect(200);
    expect(status.body).toMatchObject({
      mode: 'mock',
      ready: false,
      transport: {
        mode: 'unconfigured',
        ready: false,
        upstreamDns: 'unavailable',
      },
    });
    const readKey = vi.fn((): string => {
      throw new Error('Do not read any key after transport gate fails');
    });
    Object.defineProperty(env, CREDENTIAL, { get: readKey });
    const response = await request(app)
      .post('/api/live-provider/start')
      .send({ ...BODY, expectedRevision: saved.body.revision })
      .expect(503);
    expect(response.body.code).toBe('TRANSPORT_UNAVAILABLE');
    expect(readKey).not.toHaveBeenCalled();
    expect(runtime.ledger.summary()).toMatchObject({
      initialized: false,
      armed: false,
      spentMicros: 0,
      reservedMicros: 0,
    });
    assertOffline();
  });

  it.each([
    { TRANSLATION_TRANSPORT: 'cloud-proxy' },
    { TRANSLATION_TRANSPORT: 'cloud-proxy', HTTPS_PROXY: '' },
    {
      TRANSLATION_TRANSPORT: 'cloud-proxy',
      HTTPS_PROXY: PROXY,
      https_proxy: 'http://other-proxy.example:8080',
    },
    {
      TRANSLATION_TRANSPORT: 'cloud-proxy',
      HTTPS_PROXY: 'http://synthetic-user:synthetic-password@platform-proxy.example:8080',
    },
    {
      TRANSLATION_TRANSPORT: 'cloud-proxy',
      HTTPS_PROXY: PROXY,
      SSL_CERT_FILE: '/synthetic/nonexistent-ca.pem',
    },
    { TRANSLATION_TRANSPORT: 'automatic' },
  ])('fails closed on missing, conflicting or invalid transport metadata (%#)', async (values) => {
    const env = environment(values);
    open(env);
    const saved = await settings();
    const response = await request(app)
      .post('/api/live-provider/start')
      .send({ ...BODY, expectedRevision: saved.body.revision })
      .expect(503);
    expect(response.body.code).toBe('TRANSPORT_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toMatch(
      /platform-proxy|synthetic-password|nonexistent-ca/,
    );
    const state = await request(app).get('/api/live-provider').expect(200);
    expect(state.body.transport).toMatchObject({ mode: 'unconfigured', ready: false });
    expect(JSON.stringify(state.body)).not.toContain(SYNTHETIC);
    assertOffline();
  });

  it('keeps explicit direct mode pinned but operator/default-budget gates closed without reading a key', async () => {
    const env = environment({
      TRANSLATION_TRANSPORT: 'direct',
      HTTPS_PROXY: PROXY,
      ALLOW_REAL_TRANSLATION: 'false',
      TRANSLATION_MAX_BUDGET_USD: '0',
    });
    open(env);
    const saved = await settings();
    const status = await request(app).get('/api/live-provider').expect(200);
    expect(status.body).toMatchObject({
      mode: 'mock',
      ready: false,
      operatorEnabled: false,
      transport: { mode: 'direct', ready: true, upstreamDns: 'client-pinned' },
    });
    const readKey = vi.fn((): string => {
      throw new Error('Operator gate must precede credential read');
    });
    Object.defineProperty(env, CREDENTIAL, { get: readKey });
    const response = await request(app)
      .post('/api/live-provider/start')
      .send({ ...BODY, expectedRevision: saved.body.revision })
      .expect(403);
    expect(response.body.code).toBe('LIVE_OPERATOR_GATE');
    expect(readKey).not.toHaveBeenCalled();
    expect(runtime.ledger.summary().initialized).toBe(false);
    assertOffline();
  });

  it('constructs a valid Cloud transport with a public CA bundle and arms without making a connection', async () => {
    const file = join(temporary, 'synthetic-public-cas.pem');
    const certs = rootCertificates
      .filter((certificate) => new X509Certificate(certificate).ca)
      .slice(0, 40);
    expect(certs.length).toBeGreaterThan(16);
    writeFileSync(file, certs.join('\n'));
    const env = environment({
      TRANSLATION_TRANSPORT: 'cloud-proxy',
      HTTPS_PROXY: PROXY,
      NO_PROXY: '*',
      SSL_CERT_FILE: file,
    });
    open(env);
    const config = await request(app).get('/api/config').expect(200);
    expect(config.body.mode).toBe('mock');
    const saved = await settings();
    const draft = await request(app)
      .post('/api/tasks')
      .send({ text: 'Synthetic Cloud example USD 12.', style: 'business' })
      .expect(201);
    expect(draft.body.mode).toBe('mock');
    assertOffline();
    const armed = await request(app)
      .post('/api/live-provider/start')
      .send({ ...BODY, expectedRevision: saved.body.revision })
      .expect(200);
    expect(armed.body).toMatchObject({
      mode: 'live',
      ready: true,
      budget: {
        armed: true,
        budgetMicros: 1_000_000,
        spentMicros: 0,
        reservedMicros: 0,
      },
      transport: { mode: 'cloud-proxy', ready: true, upstreamDns: 'managed-proxy' },
    });
    expect(JSON.stringify(armed.body)).not.toMatch(/platform-proxy|public-cas|BEGIN CERTIFICATE/);
    expect(JSON.stringify(armed.body)).not.toContain(SYNTHETIC);
    expect(armed.body.transport).not.toHaveProperty('createTransport');
    expect(armed.body.transport).not.toHaveProperty('proxyUrl');
    const persisted = JSON.stringify(store.getSetting('provider-settings-v1'));
    expect(persisted).not.toContain(PROXY);
    expect(persisted).not.toContain(SYNTHETIC);
    const stop = await request(app).post('/api/live-provider/stop').send({}).expect(200);
    expect(stop.body.mode).toBe('real-disabled');
    expect(stop.body.budget.budgetMicros).toBe(1_000_000);
    assertOffline();
  });

  it('keeps injected synthetic transports independent of real environment resolution', async () => {
    const env = environment();
    for (const name of ['TRANSLATION_TRANSPORT', 'HTTPS_PROXY', 'https_proxy', 'SSL_CERT_FILE']) {
      Object.defineProperty(env, name, {
        get() {
          throw new Error('Injected test must not inspect transport environment');
        },
      });
    }
    const fake: OpenAITransport = vi.fn(async () => ({ status: 200, body: '{}' }));
    open(env, fake);
    const saved = await settings();
    const armed = await request(app)
      .post('/api/live-provider/start')
      .send({ ...BODY, expectedRevision: saved.body.revision })
      .expect(200);
    expect(armed.body.ready).toBe(true);
    expect(armed.body.transport.reason).toContain('合成');
    expect(fake).not.toHaveBeenCalled();
    assertOffline();
  });

  it.each(['proxyUrl', 'HTTPS_PROXY', 'transport', 'ca', 'SSL_CERT_FILE'])(
    'does not accept browser-supplied %s in nonsecret provider settings',
    async (field) => {
      open(environment({ TRANSLATION_TRANSPORT: 'direct' }));
      const response = await settings({ [field]: 'synthetic-forbidden-field-value' }, 400);
      expect(response.body.code).toBe('INVALID_PROVIDER_FIELDS');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-forbidden-field-value');
      expect(runtime.ledger.summary().initialized).toBe(false);
      assertOffline();
    },
  );

  it.each(['proxyUrl', 'HTTPS_PROXY', 'transport', 'ca', 'SSL_CERT_FILE'])(
    'does not accept browser-supplied %s in live-start controls',
    async (field) => {
      open(environment({ TRANSLATION_TRANSPORT: 'direct' }));
      const saved = await settings();
      const response = await request(app)
        .post('/api/live-provider/start')
        .send({
          ...BODY,
          expectedRevision: saved.body.revision,
          [field]: 'synthetic-forbidden-field-value',
        })
        .expect(400);
      expect(response.body.code).toBe('LIVE_CONSENT_REQUIRED');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-forbidden-field-value');
      expect(runtime.ledger.summary().initialized).toBe(false);
      assertOffline();
    },
  );

  it('retains JSON and origin checks before live-control mutations', async () => {
    open(environment({ TRANSLATION_TRANSPORT: 'cloud-proxy', HTTPS_PROXY: PROXY }));
    const saved = await settings();
    await request(app)
      .post('/api/live-provider/start')
      .set('Origin', 'https://synthetic-untrusted.example')
      .send({
        ...BODY,
        expectedRevision: saved.body.revision,
      })
      .expect(403);
    await request(app)
      .post('/api/live-provider/start')
      .type('text/plain')
      .send('synthetic')
      .expect(415);
    expect(runtime.ledger.summary().initialized).toBe(false);
    assertOffline();
  });
});
