import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const HOSTNAME = 'api.openai.com';
const MAX_REQUEST_BYTES = 256000;
const MAX_RESPONSE_BYTES = 250000;
const MAX_DNS_ADDRESSES = 16;

export type OpenAITransportErrorCode =
  | 'INVALID_ENDPOINT'
  | 'INVALID_REQUEST'
  | 'UNSAFE_ADDRESS'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'REDIRECT_BLOCKED'
  | 'INVALID_RESPONSE';

// Only fixed, non-sensitive messages may leave this layer. Native TLS/DNS/HTTP
// errors, provider bodies, addresses and request headers are never reflected.
export class OpenAITransportError extends Error {
  constructor(public readonly code: OpenAITransportErrorCode) {
    super(`OpenAI transport: ${code}`);
    this.name = 'OpenAITransportError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}
export interface OpenAITransportRequest {
  url?: string;
  apiKey: string;
  body: string;
  signal: AbortSignal;
  timeoutMs?: number;
}
export interface OpenAITransportResponse {
  status: number;
  body: string;
  retryAfter?: string;
}
export type OpenAITransport = (input: OpenAITransportRequest) => Promise<OpenAITransportResponse>;
export interface OpenAITransportDependencies {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
}
function ipv6Number(address: string): bigint | null {
  // Dotted tails and scoped addresses are deliberately unsupported. In
  // particular, an IPv4-mapped address cannot bypass the IPv4 exclusions.
  if (address.includes('.') || address.includes('%')) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}
function inV4Range(address: number, first: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(ipv4Number(first) / size);
}
function inV6Range(address: bigint, first: string, bits: number): boolean {
  const start = ipv6Number(first)!;
  const shift = BigInt(128 - bits);
  return address >> shift === start >> shift;
}

/** Conservative public-unicast policy, not merely a private-address blacklist. */
export function isPublicOpenAIAddress(address: string, family: number): boolean {
  if (typeof address !== 'string' || isIP(address) !== family) return false;
  if (family === 4) {
    const value = ipv4Number(address);
    const blocked: [string, number][] = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 3],
    ];
    return !blocked.some(([first, bits]) => inV4Range(value, first, bits));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === null || !inV6Range(value, '2000::', 3)) return false;
    return ![
      ['2001::', 23], // IETF special-purpose space, including Teredo/ORCHID.
      ['2001:db8::', 32], // Documentation.
      ['2002::', 16], // 6to4 can encode non-public IPv4 destinations.
      ['3fff::', 20], // Documentation.
    ].some(([first, bits]) => inV6Range(value, first as string, bits as number));
  }
  return false;
}

/**
 * Official endpoint only. Custom endpoints remain offline configuration until a
 * separate protocol and destination policy are accepted. Merely saving settings
 * never constructs a request, resolves DNS, or reads a credential.
 *
 * Each call validates every DNS answer, pins one approved address into the
 * native TLS connection, and retains the official hostname for SNI/certificate
 * verification. No proxy environment variables, redirects or connection pool
 * can silently select a different destination. Dependency seams are for local
 * fake transports in tests; they must never be populated from browser input.
 */
export function createOpenAITransport(
  dependencies: OpenAITransportDependencies = {},
): OpenAITransport {
  const lookup =
    dependencies.lookup ??
    ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const request =
    dependencies.request ??
    ((options: RequestOptions, callback: (response: IncomingMessage) => void) =>
      httpsRequest(options, callback));
  return (input) => {
    if ((input.url ?? OPENAI_RESPONSES_URL) !== OPENAI_RESPONSES_URL)
      return Promise.reject(new OpenAITransportError('INVALID_ENDPOINT'));
    const timeoutMs = input.timeoutMs ?? 30000;
    if (
      typeof input.apiKey !== 'string' ||
      !input.apiKey.trim() ||
      input.apiKey.length > 1024 ||
      /\s/u.test(input.apiKey) ||
      Array.from(input.apiKey).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      typeof input.body !== 'string' ||
      !input.body ||
      Buffer.byteLength(input.body, 'utf8') > MAX_REQUEST_BYTES ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000
    )
      return Promise.reject(new OpenAITransportError('INVALID_REQUEST'));
    if (input.signal.aborted) return Promise.reject(new OpenAITransportError('CANCELLED'));
    return new Promise<OpenAITransportResponse>((resolve, reject) => {
      let settled = false;
      let outbound: ClientRequest | undefined;
      let inbound: IncomingMessage | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
      };
      const fail = (code: OpenAITransportErrorCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        outbound?.destroy();
        inbound?.destroy();
        reject(new OpenAITransportError(code));
      };
      const abort = () => fail('CANCELLED');
      input.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);
      if (input.signal.aborted) {
        fail('CANCELLED');
        return;
      }
      void Promise.resolve()
        .then(() => {
          if (settled || input.signal.aborted) return null;
          return lookup(HOSTNAME);
        })
        .then((addresses) => {
          if (settled) return;
          if (
            !Array.isArray(addresses) ||
            !addresses.length ||
            addresses.length > MAX_DNS_ADDRESSES ||
            addresses.some((entry) => !entry || !isPublicOpenAIAddress(entry.address, entry.family))
          ) {
            fail('UNSAFE_ADDRESS');
            return;
          }
          const pinned = { ...addresses[0] };
          const pinnedLookup: LookupFunction = (hostname, options, callback) => {
            if (hostname !== HOSTNAME) {
              callback(new Error('Unexpected TLS hostname'), '');
              return;
            }
            callback(
              null,
              options.all ? [pinned] : pinned.address,
              options.all ? undefined : pinned.family,
            );
          };
          outbound = request(
            {
              protocol: 'https:',
              hostname: HOSTNAME,
              port: 443,
              path: '/v1/responses',
              method: 'POST',
              servername: HOSTNAME,
              rejectUnauthorized: true,
              agent: false,
              family: pinned.family,
              lookup: pinnedLookup,
              maxHeaderSize: 16384,
              headers: {
                Authorization: `Bearer ${input.apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Accept-Encoding': 'identity',
                'Content-Length': Buffer.byteLength(input.body, 'utf8'),
              },
            },
            (response) => {
              inbound = response;
              let ended = false;
              response.on('error', () => fail('NETWORK_ERROR'));
              response.on('aborted', () => fail('NETWORK_ERROR'));
              response.on('close', () => {
                if (!ended) fail('NETWORK_ERROR');
              });
              if (settled) {
                response.destroy();
                return;
              }
              const status = response.statusCode;
              if (!Number.isInteger(status) || status! < 100 || status! > 599) {
                fail('INVALID_RESPONSE');
                return;
              }
              if (status! >= 300 && status! < 400) {
                fail('REDIRECT_BLOCKED');
                return;
              }
              const length = response.headers['content-length'];
              if (
                length !== undefined &&
                (typeof length !== 'string' ||
                  !/^\d+$/.test(length) ||
                  Number(length) > MAX_RESPONSE_BYTES)
              ) {
                fail('INVALID_RESPONSE');
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on('data', (chunk: Buffer | string) => {
                if (settled) return;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.byteLength;
                if (bytes > MAX_RESPONSE_BYTES) {
                  fail('INVALID_RESPONSE');
                  return;
                }
                chunks.push(buffer);
              });
              response.on('end', () => {
                ended = true;
                if (settled) return;
                let body: string;
                try {
                  body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                } catch {
                  fail('INVALID_RESPONSE');
                  return;
                }
                settled = true;
                cleanup();
                const retryAfter = response.headers['retry-after'];
                resolve({
                  status: status!,
                  body,
                  ...(typeof retryAfter === 'string' &&
                  retryAfter.length <= 80 &&
                  /^[\x20-\x7e]+$/.test(retryAfter)
                    ? { retryAfter }
                    : {}),
                });
              });
            },
          );
          outbound.on('error', () => fail('NETWORK_ERROR'));
          if (settled) outbound.destroy();
          else outbound.end(input.body);
        })
        .catch(() => fail('NETWORK_ERROR'));
    });
  };
}
