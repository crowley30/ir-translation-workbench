import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { TaskStore } from './store.js';
import {
  createProviderSettingsRouter,
  validatePublicProviderUrl,
  type ProviderSettingsStore,
} from './provider-settings.js';

const valid = {
  mode: 'custom',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'synthetic-model-v1',
  credentialRef: 'IR_TRANSLATION_TEST_KEY',
  expectedRevision: 0,
};
function memoryStore(): ProviderSettingsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    getSetting: (key) => values.get(key),
    setSetting: (key, value) => values.set(key, structuredClone(value)),
  };
}
function app(store: ProviderSettingsStore = memoryStore(), env: NodeJS.ProcessEnv = {}) {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/provider-settings', createProviderSettingsRouter(store, env));
  return instance;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('offline public provider URL syntax', () => {
  it.each([
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['https://API.Example.com:443/v1/', 'https://api.example.com/v1/'],
    ['https://api.example.com', 'https://api.example.com/'],
    ['https://api.vendor-example.org/openai/v1', 'https://api.vendor-example.org/openai/v1'],
  ])('accepts a public DNS spelling without a connection: %s', (value, expected) => {
    expect(validatePublicProviderUrl(value)).toBe(expected);
  });

  it.each([
    'http://api.example.com/v1',
    'ftp://api.example.com/v1',
    'file:///tmp/config',
    'https://localhost',
    'https://api.localhost/v1',
    'https://service.local/v1',
    'https://api.internal/v1',
    'https://service.lan',
    'https://service.home',
    'https://service.home.arpa',
    'https://service.corp',
    'https://service.intranet',
    'https://service.private',
    'https://service.svc',
    'https://service.invalid',
    'https://service.test',
    'https://service.example',
    'https://service.onion',
    'https://metadata.google.internal',
    'https://metadata.tencentyun.com',
    'https://metadata.azure.internal',
    'https://instance-data.ec2.internal',
    'https://metadata.example.com',
    'https://singlelabel',
    'https://127.0.0.1/v1',
    'https://10.0.0.1/v1',
    'https://172.16.0.1/v1',
    'https://192.168.1.1/v1',
    'https://169.254.169.254/v1',
    'https://8.8.8.8/v1',
    'https://2130706433/v1',
    'https://0x7f000001/v1',
    'https://0177.0.0.1/v1',
    'https://127.1/v1',
    'https://127.0.0.1./v1',
    'https://0/v1',
    'https://[::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://[2001:4860:4860::8888]/v1',
    'https://127.0.0.1.nip.io/v1',
    'https://127-0-0-1.sslip.io/v1',
    'https://localtest.me/v1',
    'https://a.lvh.me/v1',
    'https://localhost.direct/v1',
    'https://user:password@api.example.com/v1',
    'https://user@api.example.com/v1',
    'https://api.example.com/v1?api_key=synthetic',
    'https://api.example.com/v1#key',
    'https://api.example.com:444/v1',
    'https://api.example.com:0443/v1',
    'https://api.example.com:/v1',
    'https://api.example.com./v1',
    'https://%61pi.example.com/v1',
    'https://api%2eexample.com/v1',
    'https://api.example.com\\@localhost/v1',
    'https:\\api.example.com/v1',
    ' https://api.example.com/v1',
    'https://api.example.com/v1\n',
    'https://api.example.com/v1\u0000',
    'https://api.example.com/v1%0d%0a',
    'https://api.example.com/v1%7f',
    'https://api.example.com/a/../v1',
    'https://api.example.com/%2e%2e/v1',
    'https://api.example.com/a%5cb',
    'https://１２７.０.０.１/v1',
    'https://api.exämple.com/v1',
  ])('rejects private, ambiguous or noncanonical address %s', (value) => {
    expect(() => validatePublicProviderUrl(value)).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'INVALID_PROVIDER_URL',
      }),
    );
  });
});

describe('offline provider settings API', () => {
  it('starts in mock with no test/real-call capability or server secret fields', async () => {
    const response = await request(app()).get('/api/provider-settings').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      mode: 'mock',
      state: 'mock',
      revision: 0,
      credentialStatus: 'absent',
      realCallsEnabled: false,
      connectionTestAvailable: false,
      urlValidation: 'syntax-only-no-dns',
    });
    expect(response.body).not.toHaveProperty('apiKey');
    expect(response.body).not.toHaveProperty('keySuffix');
  });

  it('supports incomplete drafts and does not confuse present credentials with verified service', async () => {
    const store = memoryStore();
    const instance = app(store);
    const incomplete = await request(instance)
      .put('/api/provider-settings')
      .send({ ...valid, baseUrl: '', model: '', credentialRef: '' })
      .expect(200);
    expect(incomplete.body.state).toBe('unconfigured');
    const withoutCredential = await request(instance)
      .put('/api/provider-settings')
      .send({ ...valid, expectedRevision: 1 })
      .expect(200);
    expect(withoutCredential.body.state).toBe('unconfigured');
    expect(withoutCredential.body.credentialStatus).toBe('absent');
    const secret = 'synthetic-server-secret-never-return-this-value';
    const present = await request(app(store, { IR_TRANSLATION_TEST_KEY: secret }))
      .get('/api/provider-settings')
      .expect(200);
    expect(present.body.state).toBe('configured-unverified');
    expect(present.body.credentialStatus).toBe('present');
    expect(present.body.realCallsEnabled).toBe(false);
    expect(JSON.stringify(present.body)).not.toContain(secret);
    expect(JSON.stringify([...store.values.values()])).not.toContain(secret);
  });

  it('performs compare-and-swap and leaves settings untouched after repeated or stale writes', async () => {
    const store = memoryStore();
    const instance = app(store);
    const responses = await Promise.all([
      request(instance).put('/api/provider-settings').send(valid),
      request(instance).put('/api/provider-settings').send(valid),
    ]);
    expect(responses.map((result) => result.status).sort()).toEqual([200, 409]);
    for (const expectedRevision of [0, null, undefined, -1, '1', 1.5]) {
      await request(instance)
        .put('/api/provider-settings')
        .send({ ...valid, model: 'different', expectedRevision })
        .expect(409);
    }
    const saved = await request(instance).get('/api/provider-settings').expect(200);
    expect(saved.body.model).toBe(valid.model);
    expect(saved.body.revision).toBe(1);
  });

  it('persists nonsecret settings across actual SQLite close/reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ir-provider-settings-'));
    let store = new TaskStore(join(directory, 'settings.sqlite'));
    try {
      await request(app(store)).put('/api/provider-settings').send(valid).expect(200);
      store.close();
      store = new TaskStore(join(directory, 'settings.sqlite'));
      const response = await request(app(store)).get('/api/provider-settings').expect(200);
      expect(response.body).toMatchObject({
        mode: valid.mode,
        protocol: valid.protocol,
        baseUrl: valid.baseUrl,
        model: valid.model,
        credentialRef: valid.credentialRef,
        revision: 1,
        state: 'unconfigured',
      });
      expect(response.body).not.toHaveProperty('expectedRevision');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['apiKey', 'api_key', 'secret', 'token', 'Authorization', 'password', 'extra'])(
    'rejects raw or unknown field %s without reflecting its value',
    async (field) => {
      const store = memoryStore();
      const secret = 'synthetic-private-input-do-not-echo';
      const response = await request(app(store))
        .put('/api/provider-settings')
        .send({ ...valid, [field]: secret })
        .expect(400);
      expect(JSON.stringify(response.body)).not.toContain(secret);
      expect(store.values.size).toBe(0);
    },
  );

  it.each([
    'PATH',
    'TRANSLATION_API_SECRET',
    'IR_TRANSLATION_bad_KEY',
    'IR_TRANSLATION_TEST_TOKEN',
    'IR_TRANSLATION_TEST_KEY\n',
    'synthetic-actual-key-value',
  ])('rejects unsupported credential reference %s', async (credentialRef) => {
    await request(app())
      .put('/api/provider-settings')
      .send({ ...valid, credentialRef })
      .expect(400);
  });

  it('rejects recognizable credentials pasted into model or URL fields', async () => {
    const accidentalKey = ['sk-', 'S'.repeat(30)].join('');
    for (const input of [
      { ...valid, model: accidentalKey },
      { ...valid, baseUrl: `https://api.example.com/${accidentalKey}` },
    ]) {
      const response = await request(app()).put('/api/provider-settings').send(input).expect(400);
      expect(JSON.stringify(response.body)).not.toContain(accidentalKey);
    }
  });

  it('keeps setting reads/writes offline and exposes only credential presence', async () => {
    const network = vi.fn(() => {
      throw new Error('Unexpected external request');
    });
    vi.stubGlobal('fetch', network);
    const lookup = vi.spyOn(dns, 'lookup');
    const resolve = vi.spyOn(dnsPromises, 'resolve');
    const router = createProviderSettingsRouter(memoryStore(), {
      IR_TRANSLATION_TEST_KEY: 'synthetic-server-only',
    });
    // Invoke middleware directly so the test's own loopback HTTP transport cannot
    // be mistaken for an attempted provider DNS lookup or connection.
    const invoke = (method: string, body?: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const req = { method, url: '/', headers: {}, body } as express.Request;
        const res = { setHeader: () => undefined, status: () => res, json: resolve };
        router(req, res as unknown as express.Response, (error) =>
          reject(error ?? new Error('Router did not respond')),
        );
      });
    await invoke('PUT', valid);
    await invoke('GET');
    expect(network).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
