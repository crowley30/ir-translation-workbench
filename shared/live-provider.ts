export interface LiveBudgetSummary {
  armed: boolean;
  budgetMicros: number;
  spentMicros: number;
  reservedMicros: number;
  remainingMicros: number;
  operatorCapMicros: number;
  overrun: boolean;
}
export interface ProviderTransportStatus {
  mode: 'direct' | 'cloud-proxy' | 'unconfigured';
  ready: boolean;
  reason: string;
  upstreamDns: 'client-pinned' | 'managed-proxy' | 'unavailable';
}
export interface LiveProviderStatus {
  mode: 'mock' | 'real-disabled' | 'live';
  ready: boolean;
  reason: string;
  settingsRevision: number;
  provider: 'openai-responses' | 'none';
  model: string;
  maxOutputTokens: number;
  operatorEnabled: boolean;
  credentialStatus: 'present' | 'absent';
  budget: LiveBudgetSummary;
  transport?: ProviderTransportStatus;
}
// POST /api/live-provider/start: explicit user consent, no provider request.
export interface StartLiveProvider {
  expectedRevision: number;
  acknowledgeCosts: true;
  confirmDataTransfer: true;
  budgetMicros: number;
  maxOutputTokens: number;
}
// GET /api/live-provider; POST /start, /stop, /mock. Stop/mock cancel active runs.
// Loading/saving configuration or arming never tests a connection.
