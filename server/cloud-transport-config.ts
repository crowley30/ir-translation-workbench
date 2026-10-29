import { X509Certificate } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  createCloudProxyTransport,
  validateCloudProxyUrl,
  type CloudProxyConfig,
} from './cloud-proxy-transport.js';
import {
  createOpenAITransport,
  OpenAITransportError,
  type OpenAITransport,
} from './openai-transport.js';

export interface OpenAITransportConfiguration {
  readonly mode: 'direct' | 'cloud-proxy' | 'unconfigured';
  readonly ready: boolean;
  readonly reason: string;
  readonly upstreamDns: 'client-pinned' | 'managed-proxy' | 'unavailable';
  // Non-enumerable: proxy addresses and public certificate material stay inside
  // this closure, never in a JSON status or spread-copy used by the browser.
  readonly createTransport: () => OpenAITransport;
}

export interface TransportConfigurationDependencies {
  readFile?: (path: string, maximumBytes: number) => string | Buffer;
  createDirectTransport?: () => OpenAITransport;
  createProxyTransport?: (config: CloudProxyConfig) => OpenAITransport;
}

export const MAX_PROXY_CA_BYTES = 1024 * 1024;
export const MAX_PROXY_CA_CERTIFICATES = 512;

function boundedCertificateFile(path: string, maximumBytes: number): Buffer {
  // Nonblocking open lets us reject a named pipe/device before reading from it.
  // A trusted platform certificate path may be a symlink, so validate the opened
  // target as a regular file rather than rejecting all normal CA symlinks.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maximumBytes) throw new Error('Invalid public CA bundle');
    const content = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > maximumBytes) throw new Error('Public CA bundle exceeds size limit');
    return content.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function certificateBundle(value: string | Buffer): string {
  if (
    (typeof value !== 'string' && !Buffer.isBuffer(value)) ||
    Buffer.byteLength(value, typeof value === 'string' ? 'utf8' : undefined) > MAX_PROXY_CA_BYTES
  )
    throw new Error('Invalid public CA bundle');
  const content =
    typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value);
  // This source is public PEM certificates only, not an OpenSSL configuration,
  // private-key bundle, shell script, or certificate plus arbitrary trailing data.
  const pem = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const certificates = content.match(pem) ?? [];
  if (
    !certificates.length ||
    certificates.length > MAX_PROXY_CA_CERTIFICATES ||
    content.replace(pem, '').trim()
  )
    throw new Error('Invalid public CA bundle');
  const canonical = certificates.map((certificate) => {
    const parsed = new X509Certificate(certificate);
    if (!parsed.ca) throw new Error('Public CA bundle contains a non-CA certificate');
    return parsed.toString();
  });
  const bundle = [...new Set(canonical)].join('\n');
  if (Buffer.byteLength(bundle, 'utf8') > MAX_PROXY_CA_BYTES)
    throw new Error('Invalid public CA bundle');
  return bundle;
}

function configuration(
  summary: Omit<OpenAITransportConfiguration, 'createTransport'>,
  factory: () => OpenAITransport,
): OpenAITransportConfiguration {
  return Object.freeze(
    Object.defineProperty({ ...summary }, 'createTransport', {
      value: factory,
      enumerable: false,
      writable: false,
      configurable: false,
    }),
  ) as OpenAITransportConfiguration;
}

function unavailable(reason: string): OpenAITransportConfiguration {
  return configuration(
    { mode: 'unconfigured', ready: false, reason, upstreamDns: 'unavailable' },
    () => {
      throw new OpenAITransportError('INVALID_REQUEST');
    },
  );
}

/** Resolve only server-owned transport metadata; never read any API credential.
 * No implicit process.env default, DNS lookup, provider request or connection
 * test occurs here. Node's startup trust roots are preserved by the transport.
 * SSL_CERT_FILE is additionally supported by this application as a bounded,
 * certificate-only public bundle; this does not claim Node always honors it.
 */
export function resolveOpenAITransportConfiguration(
  env: NodeJS.ProcessEnv,
  dependencies: TransportConfigurationDependencies = {},
): OpenAITransportConfiguration {
  try {
    const requestedMode = env.TRANSLATION_TRANSPORT;
    const upperPresent = Object.hasOwn(env, 'HTTPS_PROXY');
    const lowerPresent = Object.hasOwn(env, 'https_proxy');
    if (requestedMode === undefined && (upperPresent || lowerPresent))
      return unavailable('运行环境存在 HTTPS 代理，但尚未明确选择传输模式，真实调用保持关闭。');
    if (requestedMode === undefined || requestedMode === 'direct')
      return configuration(
        {
          mode: 'direct',
          ready: true,
          reason: '直连模式：由客户端验证并固定官方目的地址。',
          upstreamDns: 'client-pinned',
        },
        () => (dependencies.createDirectTransport ?? createOpenAITransport)(),
      );
    if (requestedMode !== 'cloud-proxy')
      return unavailable('服务端传输模式无效，请明确选择 direct 或 cloud-proxy。');
    if (!upperPresent && !lowerPresent)
      return unavailable('Cloud 代理模式缺少平台提供的 HTTPS 代理配置，不会回退直连。');
    const upper = upperPresent ? validateCloudProxyUrl(env.HTTPS_PROXY) : undefined;
    const lower = lowerPresent ? validateCloudProxyUrl(env.https_proxy) : undefined;
    if (upper && lower && upper !== lower)
      return unavailable('服务端 HTTPS 代理配置互相冲突，真实调用保持关闭。');
    const proxyUrl = upper ?? lower;
    if (!proxyUrl) return unavailable('Cloud 代理配置无效，真实调用保持关闭。');
    let additionalCa: string | undefined;
    const certificatePath = env.SSL_CERT_FILE;
    if (certificatePath !== undefined && certificatePath !== '') {
      if (
        certificatePath.length > 4096 ||
        !isAbsolute(certificatePath) ||
        Array.from(certificatePath).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        return unavailable('平台公共 CA 配置无效，真实调用保持关闭。');
      additionalCa = certificateBundle(
        (dependencies.readFile ?? boundedCertificateFile)(certificatePath, MAX_PROXY_CA_BYTES),
      );
    }
    const config: CloudProxyConfig = Object.freeze({
      proxyUrl,
      ...(additionalCa ? { additionalCa } : {}),
    });
    return configuration(
      {
        mode: 'cloud-proxy',
        ready: true,
        reason: 'Cloud 代理模式：上游 DNS 由平台代理管理，不声明客户端到上游的 IP 固定。',
        upstreamDns: 'managed-proxy',
      },
      () => (dependencies.createProxyTransport ?? createCloudProxyTransport)(config),
    );
  } catch {
    // Never reflect proxy credentials/URL, certificate paths/content, filesystem
    // errors or malformed environment values in browser-visible status or logs.
    return unavailable('Cloud 代理或公共 CA 配置不可用，真实调用保持关闭；不会回退直连。');
  }
}
