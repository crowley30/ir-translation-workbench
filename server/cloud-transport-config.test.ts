import { afterAll, describe, expect, it, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rootCertificates } from 'node:tls';
import {
  MAX_PROXY_CA_BYTES,
  MAX_PROXY_CA_CERTIFICATES,
  resolveOpenAITransportConfiguration,
} from './cloud-transport-config.js';
import { OpenAITransportError, type OpenAITransport } from './openai-transport.js';

const publicRoot = rootCertificates.find((certificate) => new X509Certificate(certificate).ca)!;
const syntheticProxy = 'http://platform-proxy.example:8080';
const fakeTransport: OpenAITransport = vi.fn(async () => ({ status: 200, body: '{}' }));
const temporary = mkdtempSync(join(tmpdir(), 'ir-cloud-config-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
function cloud(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TRANSLATION_TRANSPORT: 'cloud-proxy', HTTPS_PROXY: syntheticProxy, ...values };
}
function denies(env: NodeJS.ProcessEnv) {
  const result = resolveOpenAITransportConfiguration(env);
  expect(result).toMatchObject({ mode: 'unconfigured', ready: false, upstreamDns: 'unavailable' });
  expect(() => result.createTransport()).toThrow(OpenAITransportError);
  return result;
}
function inaccessibleCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  Object.defineProperty(env, 'OPENAI_API_KEY', {
    get() {
      throw new Error('API credential must never be accessed');
    },
    enumerable: true,
  });
  Object.defineProperty(env, 'TRANSLATION_API_KEY', {
    get() {
      throw new Error('Legacy credential must never be accessed');
    },
    enumerable: true,
  });
  return env;
}

describe('server-owned explicit transport selection', () => {
  it('keeps no-proxy synthetic/local defaults direct and constructs lazily without I/O', () => {
    const direct = vi.fn(() => fakeTransport);
    const proxy = vi.fn(() => fakeTransport);
    const value = resolveOpenAITransportConfiguration(inaccessibleCredentials({}), {
      createDirectTransport: direct,
      createProxyTransport: proxy,
    });
    expect(value).toMatchObject({ mode: 'direct', ready: true, upstreamDns: 'client-pinned' });
    expect(direct).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
    expect(value.createTransport()).toBe(fakeTransport);
    expect(direct).toHaveBeenCalledOnce();
  });

  it.each(['HTTPS_PROXY', 'https_proxy'])(
    'requires a mode whenever %s is present, without reading its value',
    (name) => {
      const env = inaccessibleCredentials({});
      Object.defineProperty(env, name, {
        get() {
          throw new Error('Do not inspect proxy before explicit mode');
        },
      });
      const value = denies(env);
      expect(value.reason).toContain('尚未明确选择');
    },
  );

  it('permits explicit direct without reading any proxy, credential, or CA metadata values', () => {
    const env = inaccessibleCredentials({ TRANSLATION_TRANSPORT: 'direct' });
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
      Object.defineProperty(env, name, {
        get() {
          throw new Error('Unused metadata must not be accessed');
        },
      });
    }
    const value = resolveOpenAITransportConfiguration(env, {
      createDirectTransport: () => fakeTransport,
    });
    expect(value.ready).toBe(true);
    expect(value.createTransport()).toBe(fakeTransport);
  });

  it.each(['', 'DIRECT', 'proxy', 'auto', 'cloud', 'direct ', 'cloud-proxy\n'])(
    'rejects an unknown explicit mode %j',
    (mode) => {
      denies(inaccessibleCredentials({ TRANSLATION_TRANSPORT: mode }));
    },
  );

  it('rejects cloud mode without a HTTPS proxy and never uses HTTP_PROXY or ALL_PROXY as a fallback', () => {
    const direct = vi.fn(() => fakeTransport);
    const proxy = vi.fn(() => fakeTransport);
    const value = resolveOpenAITransportConfiguration(
      {
        TRANSLATION_TRANSPORT: 'cloud-proxy',
        HTTP_PROXY: syntheticProxy,
        ALL_PROXY: syntheticProxy,
      },
      { createDirectTransport: direct, createProxyTransport: proxy },
    );
    expect(value.ready).toBe(false);
    expect(() => value.createTransport()).toThrow(OpenAITransportError);
    expect(direct).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });

  it.each(['HTTPS_PROXY', 'https_proxy'])(
    'accepts the explicitly configured %s source only',
    (name) => {
      const create = vi.fn(() => fakeTransport);
      const value = resolveOpenAITransportConfiguration(
        inaccessibleCredentials({
          TRANSLATION_TRANSPORT: 'cloud-proxy',
          [name]: syntheticProxy,
        }),
        { createProxyTransport: create },
      );
      expect(value).toMatchObject({
        mode: 'cloud-proxy',
        ready: true,
        upstreamDns: 'managed-proxy',
      });
      expect(value.reason).toContain('不声明');
      expect(create).not.toHaveBeenCalled();
      expect(value.createTransport()).toBe(fakeTransport);
      expect(create).toHaveBeenCalledExactlyOnceWith({ proxyUrl: syntheticProxy + '/' });
    },
  );

  it('accepts consistent canonical proxy aliases but refuses different destinations', () => {
    expect(
      resolveOpenAITransportConfiguration(cloud({ https_proxy: syntheticProxy + '/' })).ready,
    ).toBe(true);
    denies(cloud({ https_proxy: 'http://different-platform.example:8080' }));
  });

  it.each([
    '',
    ' ',
    'proxy:8080',
    'socks5://platform-proxy.example:8080',
    'http://user:synthetic-password@platform-proxy.example:8080',
    'http://@platform-proxy.example:8080',
    'http://platform-proxy.example:8080/other',
    'http://platform-proxy.example:8080/?token=synthetic',
    'http://platform-proxy.example:8080/#fragment',
    'http://platform-proxy.example:0',
    'http://platform-proxy.example:65536',
    'http://platform-proxy.example:8080\n',
  ])('refuses invalid or sensitive proxy spelling (%#)', (proxy) => {
    const result = denies(cloud({ HTTPS_PROXY: proxy }));
    expect(JSON.stringify(result)).not.toContain('synthetic-password');
    expect(JSON.stringify(result)).not.toContain('platform-proxy.example');
  });

  it('does not let a valid lowercase proxy hide an invalid uppercase value', () => {
    denies(cloud({ HTTPS_PROXY: '', https_proxy: syntheticProxy }));
  });

  it('ignores NO_PROXY entirely and never consults unrelated environment values', () => {
    const env = inaccessibleCredentials(cloud());
    for (const name of ['NO_PROXY', 'no_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS']) {
      Object.defineProperty(env, name, {
        get() {
          throw new Error('Not an input to this explicit proxy mode');
        },
      });
    }
    const create = vi.fn(() => fakeTransport);
    const result = resolveOpenAITransportConfiguration(env, { createProxyTransport: create });
    expect(result.ready).toBe(true);
    result.createTransport();
    expect(create).toHaveBeenCalledExactlyOnceWith({ proxyUrl: syntheticProxy + '/' });
  });

  it('captures validated metadata and hides the internal factory and URL from JSON or object spreading', () => {
    const env = cloud();
    const create = vi.fn(() => fakeTransport);
    const value = resolveOpenAITransportConfiguration(env, { createProxyTransport: create });
    env.HTTPS_PROXY = 'http://changed.example:8080';
    expect(Object.keys(value)).toEqual(['mode', 'ready', 'reason', 'upstreamDns']);
    expect({ ...value }).not.toHaveProperty('createTransport');
    expect(JSON.stringify(value)).not.toMatch(/platform-proxy|proxyUrl|createTransport/);
    expect(Object.getOwnPropertyDescriptor(value, 'createTransport')).toMatchObject({
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(Object.isFrozen(value)).toBe(true);
    value.createTransport();
    expect(create).toHaveBeenCalledExactlyOnceWith({ proxyUrl: syntheticProxy + '/' });
  });
});

describe('bounded public CA union source', () => {
  it('does not read any certificate file when no additional source is configured', () => {
    const read = vi.fn(() => publicRoot);
    const result = resolveOpenAITransportConfiguration(cloud(), { readFile: read });
    expect(result.ready).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the optional certificate-only source with an explicit byte bound and forwards one canonical bundle', () => {
    const read = vi.fn(() => `\n${publicRoot}\n${publicRoot}\n`);
    const create = vi.fn(() => fakeTransport);
    const path = '/synthetic/platform/public-ca.pem';
    const result = resolveOpenAITransportConfiguration(cloud({ SSL_CERT_FILE: path }), {
      readFile: read,
      createProxyTransport: create,
    });
    expect(result.ready).toBe(true);
    expect(read).toHaveBeenCalledExactlyOnceWith(path, MAX_PROXY_CA_BYTES);
    result.createTransport();
    expect(create).toHaveBeenCalledExactlyOnceWith({
      proxyUrl: syntheticProxy + '/',
      additionalCa: new X509Certificate(publicRoot).toString(),
    });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(JSON.stringify(result)).not.toContain('BEGIN CERTIFICATE');
  });

  it('accepts many actual public roots with the real transport factory without creating any connection', () => {
    const roots = rootCertificates
      .filter((certificate) => new X509Certificate(certificate).ca)
      .slice(0, 40);
    expect(roots.length).toBeGreaterThan(16);
    const result = resolveOpenAITransportConfiguration(
      cloud({ SSL_CERT_FILE: '/synthetic/large-ca.pem' }),
      {
        readFile: () => roots.join('\n'),
      },
    );
    expect(result.ready).toBe(true);
    expect(typeof result.createTransport()).toBe('function');
  });

  it.each(['relative.pem', '/synthetic/ca\n.pem', '/synthetic/ca\0.pem', 'x'.repeat(4097)])(
    'rejects invalid certificate path metadata %j without reading a file',
    (path) => {
      const read = vi.fn(() => publicRoot);
      const value = resolveOpenAITransportConfiguration(cloud({ SSL_CERT_FILE: path }), {
        readFile: read,
      });
      expect(value.ready).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(value)).not.toContain(path);
    },
  );

  it('does not reflect filesystem errors or internal certificate material', () => {
    const value = resolveOpenAITransportConfiguration(
      cloud({ SSL_CERT_FILE: '/synthetic/private-location.pem' }),
      {
        readFile: () => {
          throw new Error('private-location.pem contains synthetic sensitive value');
        },
      },
    );
    expect(value.ready).toBe(false);
    expect(JSON.stringify(value)).not.toMatch(/private-location|sensitive value/);
  });

  const privateHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  it.each([
    '',
    'not a certificate',
    '-----BEGIN CERTIFICATE-----\nbm90LXg1MDk=\n-----END CERTIFICATE-----',
    `${publicRoot}\nscript extra`,
    `${privateHeader}\nsynthetic only`,
    `${publicRoot}\n${privateHeader}`,
  ])('rejects non-certificate, malformed and mixed private-key material (%#)', (content) => {
    const value = resolveOpenAITransportConfiguration(
      cloud({ SSL_CERT_FILE: '/synthetic/ca.pem' }),
      {
        readFile: () => content,
      },
    );
    expect(value.ready).toBe(false);
    expect(JSON.stringify(value)).not.toContain('synthetic only');
    expect(JSON.stringify(value)).not.toContain('script extra');
  });

  it('rejects a valid X509 leaf certificate as an added trust anchor', () => {
    const certificate = join(temporary, 'synthetic-leaf.pem');
    const privateKey = join(temporary, 'synthetic-leaf-key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        privateKey,
        '-out',
        certificate,
        '-subj',
        '/CN=synthetic.invalid',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
      ],
      { stdio: 'ignore' },
    );
    const leaf = readFileSync(certificate, 'utf8');
    expect(new X509Certificate(leaf).ca).toBe(false);
    const result = resolveOpenAITransportConfiguration(
      cloud({ SSL_CERT_FILE: '/synthetic/leaf.pem' }),
      {
        readFile: () => leaf,
      },
    );
    expect(result.ready).toBe(false);
  });

  it.each([
    Buffer.alloc(MAX_PROXY_CA_BYTES + 1, 65),
    Buffer.from([0xff, 0xfe, 0xfd]),
    '汉'.repeat(Math.ceil(MAX_PROXY_CA_BYTES / 3) + 1),
  ])('bounds returned bytes and rejects invalid UTF-8 (%#)', (content) => {
    const result = resolveOpenAITransportConfiguration(
      cloud({ SSL_CERT_FILE: '/synthetic/ca.pem' }),
      {
        readFile: () => content,
      },
    );
    expect(result.ready).toBe(false);
  });

  it('bounds certificate count before parsing a large repeated bundle', () => {
    const result = resolveOpenAITransportConfiguration(
      cloud({ SSL_CERT_FILE: '/synthetic/ca.pem' }),
      {
        readFile: () => publicRoot.repeat(MAX_PROXY_CA_CERTIFICATES + 1),
      },
    );
    expect(result.ready).toBe(false);
  });

  it('uses a bounded regular-file reader, follows normal public-certificate symlinks, and sanitizes invalid paths', () => {
    const certificate = join(temporary, 'public-ca.pem');
    const link = join(temporary, 'public-ca-link.pem');
    writeFileSync(certificate, publicRoot);
    symlinkSync(certificate, link);
    expect(resolveOpenAITransportConfiguration(cloud({ SSL_CERT_FILE: certificate })).ready).toBe(
      true,
    );
    expect(resolveOpenAITransportConfiguration(cloud({ SSL_CERT_FILE: link })).ready).toBe(true);
    expect(resolveOpenAITransportConfiguration(cloud({ SSL_CERT_FILE: temporary })).ready).toBe(
      false,
    );
    expect(
      resolveOpenAITransportConfiguration(cloud({ SSL_CERT_FILE: join(temporary, 'missing.pem') }))
        .ready,
    ).toBe(false);
    const oversized = join(temporary, 'oversized.pem');
    writeFileSync(oversized, Buffer.alloc(MAX_PROXY_CA_BYTES + 1));
    expect(resolveOpenAITransportConfiguration(cloud({ SSL_CERT_FILE: oversized })).ready).toBe(
      false,
    );
  });
});
