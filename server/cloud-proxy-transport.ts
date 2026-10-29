import { getCACertificates } from 'node:tls';
import { Socket } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { isValidBearerCredential } from './credential.js';
import { Client, ProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';
import {
  OPENAI_RESPONSES_URL,
  OpenAITransportError,
  type OpenAITransport,
  type OpenAITransportResponse,
} from './openai-transport.js';

const MAX_REQUEST_BYTES = 256_000;
const MAX_RESPONSE_BYTES = 250_000;
const MAX_HEADER_BYTES = 16_384;
const MAX_CA_BYTES = 1_048_576;

export interface CloudProxyConfig {
  // Operator/platform configuration only. This must never come from a browser
  // setting or document. The proxy is allowed to be a platform-internal host.
  proxyUrl: string;
  additionalCa?: string | Buffer | readonly (string | Buffer)[];
}
export interface CloudProxyDispatcher {
  destroy(): Promise<void> | void;
}
export interface CloudProxyBody extends AsyncIterable<Uint8Array | string> {
  destroy(): unknown;
  on?(event: 'error', listener: () => void): unknown;
}
export interface CloudProxyResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: CloudProxyBody;
}
export interface CloudProxyRequestOptions {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  dispatcher: CloudProxyDispatcher;
  maxRedirections: 0;
  headersTimeout: number;
  bodyTimeout: number;
  idempotent: false;
  blocking: true;
}
export interface CloudProxyDependencies {
  createProxyAgent?: (options: ProxyAgent.Options) => CloudProxyDispatcher;
  request?: (url: string, options: CloudProxyRequestOptions) => Promise<CloudProxyResponse>;
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function invalidConfiguration(): never {
  throw new OpenAITransportError('INVALID_REQUEST');
}

/** Pure validation, with no environment reads, DNS, credentials or network I/O. */
export function validateCloudProxyUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\s\\]/u.test(value) ||
    hasControl(value)
  )
    return invalidConfiguration();
  const match = /^(https?):\/\/([^/?#]+)\/?$/.exec(value);
  // Refuse even empty userinfo or encoded authority spellings. Proxy
  // authentication is not part of this non-secret configuration contract.
  if (!match || /[@%\u0080-\uffff]/u.test(match[2])) return invalidConfiguration();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidConfiguration();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.length > 253 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))
  )
    return invalidConfiguration();
  return url.href;
}

function additionalCertificates(value: CloudProxyConfig['additionalCa']): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > 512) return invalidConfiguration();
  let bytes = 0;
  const extra: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' && !Buffer.isBuffer(item)) return invalidConfiguration();
    const text = Buffer.isBuffer(item) ? item.toString('utf8') : item;
    bytes += Buffer.byteLength(text, 'utf8');
    if (!text.trim() || bytes > MAX_CA_BYTES) return invalidConfiguration();
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (
      !blocks?.length ||
      text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
    )
      return invalidConfiguration();
    if (extra.length + blocks.length > 512) return invalidConfiguration();
    for (const block of blocks) {
      try {
        const certificate = new X509Certificate(block);
        if (!certificate.ca) return invalidConfiguration();
        extra.push(block);
      } catch {
        return invalidConfiguration();
      }
    }
  }
  // Explicit `ca` replaces Node defaults. Retain the active defaults, including
  // startup NODE_EXTRA_CA_CERTS, and deduplicate additional public trust roots.
  const certificates = new Map<string, string>();
  for (const pem of [...getCACertificates('default'), ...extra]) {
    try {
      const fingerprint = new X509Certificate(pem).fingerprint256;
      if (!certificates.has(fingerprint)) certificates.set(fingerprint, pem);
    } catch {
      return invalidConfiguration();
    }
  }
  return [...certificates.values()];
}

function safeFailure(error: unknown): OpenAITransportError {
  if (error instanceof OpenAITransportError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return new OpenAITransportError(
    code === 'UND_ERR_HEADERS_OVERFLOW' ||
      code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' ||
      code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE'
      ? 'INVALID_RESPONSE'
      : 'NETWORK_ERROR',
  );
}

/**
 * A logical official-host connection through the explicitly supplied trusted
 * proxy. The proxy performs upstream DNS; this is not direct upstream IP
 * pinning. There is no environment-proxy selection, NO_PROXY bypass, redirect,
 * fallback transport, implicit retry interceptor or global dispatcher mutation.
 */
export function createCloudProxyTransport(
  config: CloudProxyConfig,
  dependencies: CloudProxyDependencies = {},
): OpenAITransport {
  const proxyUrl = validateCloudProxyUrl(config.proxyUrl);
  const ca = additionalCertificates(config.additionalCa);
  const createAgent = dependencies.createProxyAgent ?? ((options) => new ProxyAgent(options));
  const request =
    dependencies.request ??
    ((url, options) =>
      undiciRequest(url, { ...options, dispatcher: options.dispatcher as Dispatcher }));
  return async (input): Promise<OpenAITransportResponse> => {
    if ((input.url ?? OPENAI_RESPONSES_URL) !== OPENAI_RESPONSES_URL)
      throw new OpenAITransportError('INVALID_ENDPOINT');
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (
      !isValidBearerCredential(input.apiKey) ||
      typeof input.body !== 'string' ||
      !input.body ||
      Buffer.byteLength(input.body, 'utf8') > MAX_REQUEST_BYTES ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    )
      throw new OpenAITransportError('INVALID_REQUEST');
    if (input.signal.aborted) throw new OpenAITransportError('CANCELLED');

    const controller = new AbortController();
    let reason: 'CANCELLED' | 'TIMEOUT' | undefined;
    let agent: CloudProxyDispatcher | undefined;
    let agentDestroyed = false;
    const sockets = new Set<Socket>();
    const trackSocket = (value: unknown) => {
      if (!(value instanceof Socket) || sockets.has(value)) return;
      sockets.add(value);
      value.on('error', () => undefined);
      value.once('close', () => sockets.delete(value));
      if (reason) value.destroy();
    };
    let body: CloudProxyBody | undefined;
    let bodyDestroyed = false;
    const destroyBody = () => {
      if (!body || bodyDestroyed) return;
      bodyDestroyed = true;
      try {
        // A deliberately destroyed late body must not emit an unhandled error.
        body.on?.('error', () => undefined);
        body.destroy();
      } catch {
        // Destruction cannot turn safe output into a raw stream error.
      }
    };
    const destroyAgent = () => {
      for (const socket of sockets) socket.destroy();
      if (!agent || agentDestroyed) return;
      agentDestroyed = true;
      try {
        // Teardown starts immediately. Do not let a broken destructor turn the
        // caller's bounded deadline into another unbounded await.
        void Promise.resolve(agent.destroy()).catch(() => undefined);
      } catch {
        // No raw proxy/TLS exception is surfaced, including from cleanup.
      }
    };
    let rejectStopped!: (error: OpenAITransportError) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const stop = (code: 'CANCELLED' | 'TIMEOUT') => {
      if (reason) return;
      reason = code;
      controller.abort();
      destroyBody();
      destroyAgent();
      rejectStopped(new OpenAITransportError(code));
    };
    const abort = () => stop('CANCELLED');
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const operation = async (): Promise<OpenAITransportResponse> => {
      if (input.signal.aborted) stop('CANCELLED');
      if (reason) throw new OpenAITransportError(reason);
      const tls = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
      agent = createAgent({
        uri: proxyUrl,
        proxyTunnel: true,
        connections: 1,
        pipelining: 0,
        allowH2: false,
        connectTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        maxHeaderSize: MAX_HEADER_BYTES,
        maxResponseSize: MAX_RESPONSE_BYTES,
        maxCachedSessions: 0,
        maxRequestsPerClient: 1,
        requestTls: { ...tls, servername: 'api.openai.com', allowH2: false },
        proxyTls: { ...tls, allowH2: false },
        // ProxyAgent passes only {connect} here. Without these explicit client
        // options the CONNECT response would inherit unrelated/default limits.
        clientFactory: (origin, options) => {
          const connector = (options as Client.Options).connect;
          const trackedConnect: NonNullable<Client.Options['connect']> =
            typeof connector === 'function'
              ? (connectOptions, callback) => {
                  const socket: unknown = connector(connectOptions, (error, connected) => {
                    trackSocket(connected);
                    if (error) callback(error, null);
                    else callback(null, connected);
                  });
                  // This pinned Undici version returns the connecting socket;
                  // tracking it also closes a pre-TCP/TLS-handshake cancellation.
                  trackSocket(socket);
                }
              : (connector ?? {});
          return new Client(origin, {
            ...options,
            connect: trackedConnect,
            maxHeaderSize: MAX_HEADER_BYTES,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            connectTimeout: timeoutMs,
            maxResponseSize: MAX_RESPONSE_BYTES,
            pipelining: 0,
            allowH2: false,
            maxCachedSessions: 0,
            maxRequestsPerClient: 1,
          });
        },
      });
      if (reason) {
        destroyAgent();
        throw new OpenAITransportError(reason);
      }
      const response = await request(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'Content-Length': String(Buffer.byteLength(input.body, 'utf8')),
        },
        body: input.body,
        signal: controller.signal,
        dispatcher: agent,
        maxRedirections: 0,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        idempotent: false,
        blocking: true,
      });
      body = response.body;
      if (reason || controller.signal.aborted) {
        destroyBody();
        throw new OpenAITransportError(reason ?? 'CANCELLED');
      }
      const status = response.statusCode;
      if (!Number.isInteger(status) || status < 100 || status > 599)
        throw new OpenAITransportError('INVALID_RESPONSE');
      if (status >= 300 && status < 400) throw new OpenAITransportError('REDIRECT_BLOCKED');
      const length = response.headers['content-length'];
      if (
        length !== undefined &&
        (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
      )
        throw new OpenAITransportError('INVALID_RESPONSE');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of body) {
        if (reason) throw new OpenAITransportError(reason);
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new OpenAITransportError('INVALID_RESPONSE');
        chunks.push(buffer);
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new OpenAITransportError('INVALID_RESPONSE');
      }
      const retryAfter = response.headers['retry-after'];
      return {
        status,
        body: text,
        ...(typeof retryAfter === 'string' &&
        retryAfter.length <= 80 &&
        /^[\x20-\x7e]+$/.test(retryAfter)
          ? { retryAfter }
          : {}),
      };
    };
    try {
      return await Promise.race([operation(), stopped]);
    } catch (error) {
      throw new OpenAITransportError(reason ?? safeFailure(error).code);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      destroyBody();
      destroyAgent();
    }
  };
}
