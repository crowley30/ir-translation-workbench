import { Router } from 'express';
import { isIP } from 'node:net';
import type {
  ProviderSettingsConfig,
  ProviderSettingsSummary,
} from '../shared/provider-settings.js';

export class ProviderSettingsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderSettingsError';
  }
}

export interface ProviderSettingsStore {
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
}

const STORE_KEY = 'provider-settings-v1';
const CREDENTIAL_REF = /^(?:TRANSLATION_API_KEY|IR_TRANSLATION_[A-Z0-9_]+_KEY)$/;
const SECRET_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})\b/;
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'lan',
  'home',
  'home.arpa',
  'corp',
  'intranet',
  'private',
  'test',
  'invalid',
  'example',
  'onion',
  'alt',
  'svc',
  'nip.io',
  'sslip.io',
  'xip.io',
  'localtest.me',
  'lvh.me',
  'vcap.me',
  'localhost.direct',
  'localhost.tv',
  'traefik.me',
  'local.gd',
  'localho.st',
];
const invalidUrl = () =>
  new ProviderSettingsError(
    400,
    'INVALID_PROVIDER_URL',
    '服务地址必须是 HTTPS 公共 DNS 主机，仅允许默认或 443 端口；不能含凭据、查询参数、片段或本地地址。',
  );

// Pure syntax checks only: no DNS, HTTP, socket, credential or provider operation occurs here.
export function validatePublicProviderUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\s\\]/u.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
    SECRET_PATTERN.test(value)
  )
    throw invalidUrl();
  const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/.exec(value);
  if (!raw || /[%@\]\u0080-\uffff]/u.test(raw[1]) || raw[1].includes('[')) throw invalidUrl();
  const authority = raw[1];
  const port = authority.includes(':') ? authority.slice(authority.lastIndexOf(':') + 1) : '';
  if (port && port !== '443') throw invalidUrl();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split('.');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(hostname) !== 0 ||
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)!) ||
    PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)) ||
    labels.some((label) => ['metadata', 'instance-data', 'metadata-latest'].includes(label)) ||
    hostname === 'metadata.tencentyun.com' ||
    raw[2]?.split('/').some((segment) => segment === '.' || segment === '..') ||
    /%(?:2e|2f|5c|00)/i.test(raw[2] ?? '')
  )
    throw invalidUrl();
  // Reject authority spellings normalized by URL parsing, including empty or padded ports.
  const expectedAuthority = hostname + (port ? ':443' : '');
  if (authority.toLowerCase() !== expectedAuthority) throw invalidUrl();
  return url.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const DEFAULT_CONFIG: ProviderSettingsConfig = {
  mode: 'mock',
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  credentialRef: 'TRANSLATION_API_KEY',
};

function configFrom(value: Record<string, unknown>): ProviderSettingsConfig {
  if (
    !['mock', 'custom'].includes(value.mode as string) ||
    value.protocol !== 'openai-compatible' ||
    typeof value.baseUrl !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.credentialRef !== 'string'
  ) {
    throw new ProviderSettingsError(
      400,
      'INVALID_PROVIDER_SETTINGS',
      '请选择支持的模式和协议，并提供完整的非敏感设置字段。',
    );
  }
  if (
    value.model.length > 120 ||
    (value.model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value.model)) ||
    SECRET_PATTERN.test(value.model)
  ) {
    throw new ProviderSettingsError(
      400,
      'INVALID_PROVIDER_MODEL',
      '模型名格式无效，请仅填写服务商提供的模型标识。',
    );
  }
  if (
    value.credentialRef.length > 100 ||
    (value.credentialRef && !CREDENTIAL_REF.test(value.credentialRef))
  ) {
    throw new ProviderSettingsError(
      400,
      'INVALID_CREDENTIAL_REFERENCE',
      '仅允许受支持的服务端凭据变量引用，不能填写密钥值。',
    );
  }
  return {
    mode: value.mode as ProviderSettingsConfig['mode'],
    protocol: 'openai-compatible',
    baseUrl: value.baseUrl ? validatePublicProviderUrl(value.baseUrl) : '',
    model: value.model,
    credentialRef: value.credentialRef,
  };
}

interface StoredSettings {
  version: 1;
  revision: number;
  updatedAt: string | null;
  config: ProviderSettingsConfig;
}

function read(store: ProviderSettingsStore): StoredSettings {
  const value = store.getSetting(STORE_KEY);
  if (value === undefined || value === null)
    return { version: 1, revision: 0, updatedAt: null, config: { ...DEFAULT_CONFIG } };
  try {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 1 ||
      typeof value.updatedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.updatedAt) ||
      !isRecord(value.config)
    )
      throw new Error('Invalid stored settings');
    return {
      version: 1,
      revision: value.revision as number,
      updatedAt: value.updatedAt,
      config: configFrom(value.config),
    };
  } catch {
    throw new ProviderSettingsError(
      500,
      'PROVIDER_SETTINGS_UNAVAILABLE',
      '已保存的服务设置暂时无法读取，请检查服务端数据。',
    );
  }
}

function summary(value: StoredSettings, env: NodeJS.ProcessEnv): ProviderSettingsSummary {
  const config = value.config;
  const present = !!config.credentialRef && !!env[config.credentialRef]?.trim();
  return {
    ...config,
    revision: value.revision,
    updatedAt: value.updatedAt,
    state:
      config.mode === 'mock'
        ? 'mock'
        : config.baseUrl && config.model && config.credentialRef && present
          ? 'configured-unverified'
          : 'unconfigured',
    credentialStatus: present ? 'present' : 'absent',
    realCallsEnabled: false,
    connectionTestAvailable: false,
    urlValidation: 'syntax-only-no-dns',
  };
}

export function createProviderSettingsRouter(
  store: ProviderSettingsStore,
  env: NodeJS.ProcessEnv = process.env,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (_req, res) => res.json(summary(read(store), env)));
  router.put('/', (req, res) => {
    const input: unknown = req.body;
    const keys = ['mode', 'protocol', 'baseUrl', 'model', 'credentialRef', 'expectedRevision'];
    if (!isRecord(input) || Object.keys(input).some((key) => !keys.includes(key))) {
      throw new ProviderSettingsError(
        400,
        'INVALID_PROVIDER_FIELDS',
        '仅允许非敏感设置字段，不能提交密钥、令牌或额外字段。',
      );
    }
    const current = read(store);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision !== current.revision
    ) {
      throw new ProviderSettingsError(
        409,
        'PROVIDER_SETTINGS_CONFLICT',
        '设置已更新或版本无效，请重新加载后再保存。',
      );
    }
    const config = configFrom(input);
    const saved: StoredSettings = {
      version: 1,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      config,
    };
    store.setSetting(STORE_KEY, saved);
    res.json(summary(saved, env));
  });
  router.use(
    (
      error: unknown,
      _req: unknown,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (error instanceof ProviderSettingsError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    },
  );
  return router;
}
