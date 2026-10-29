export type ProviderSettingsMode = 'mock' | 'custom';
export type ProviderSettingsState = 'mock' | 'unconfigured' | 'configured-unverified';
// Add a protocol only with a separate validated adapter and its own contract tests.
export const PROVIDER_PROTOCOL_OPTIONS = [
  { id: 'openai-responses', label: 'OpenAI 官方 Responses', available: true },
  { id: 'openai-compatible', label: 'OpenAI 兼容协议（离线设置）', available: true },
  { id: 'other', label: '其它协议（待适配）', available: false },
] as const;

export interface ProviderSettingsConfig {
  mode: ProviderSettingsMode;
  protocol: 'openai-compatible' | 'openai-responses';
  baseUrl: string;
  model: string;
  credentialRef: string;
}

export interface ProviderSettingsSummary extends ProviderSettingsConfig {
  revision: number;
  updatedAt: string | null;
  state: ProviderSettingsState;
  credentialStatus: 'present' | 'absent';
  realCallsEnabled: boolean;
  recommendedCredentialRef?: string;
  connectionTestAvailable: false;
  urlValidation: 'syntax-only-no-dns';
}

export interface ProviderSettingsInput extends ProviderSettingsConfig {
  expectedRevision: number;
}

// This offline configuration never activates a TranslationAdapter or tests a connection.
// Credential references identify server environment variables; values never enter this API.
// Official Responses uses a separate gated runtime with DNS pinning/TLS validation.
// Custom compatible settings remain offline; URL syntax validation is not DNS validation.
