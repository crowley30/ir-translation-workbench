import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LiveProviderStatus, StartLiveProvider } from '../shared/live-provider';
import type { ProviderSettingsConfig, ProviderSettingsSummary } from '../shared/provider-settings';
import { OPENAI_DEFAULT_MODEL } from '../shared/openai-models';

const COST_CONSENT = '我确认本轮累计费用上限，包含全部请求和重试';
const TRANSFER_CONSENT = '我同意将所选任务的原文与必要上下文发送给 OpenAI';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function syntheticStatus(overrides: Partial<LiveProviderStatus> = {}): LiveProviderStatus {
  return {
    mode: 'mock',
    ready: false,
    reason: '合成控制状态：尚未启动，不进行连接测试。',
    settingsRevision: 7,
    provider: 'openai-responses',
    model: OPENAI_DEFAULT_MODEL,
    maxOutputTokens: 4096,
    operatorEnabled: true,
    credentialStatus: 'present',
    budget: {
      armed: false,
      budgetMicros: 0,
      spentMicros: 0,
      reservedMicros: 0,
      remainingMicros: 0,
      operatorCapMicros: 1_000_000,
      overrun: false,
    },
    ...overrides,
  };
}

async function livePanel(page: Page): Promise<Locator> {
  const details = page.locator('details.live-provider');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open)))
    await details.locator(':scope > summary').click();
  await expect(details.getByLabel('本轮累计预算（美元）', { exact: true })).toBeVisible();
  return details;
}

async function acceptLiveDraft(panel: Locator, budget = '0.25', tokens = '1024') {
  await panel.getByLabel('本轮累计预算（美元）', { exact: true }).fill(budget);
  await panel.getByLabel('每段最大输出 token', { exact: true }).fill(tokens);
  await panel.getByLabel(COST_CONSENT, { exact: true }).check();
  await panel.getByLabel(TRANSFER_CONSENT, { exact: true }).check();
}

async function blockBrowserProviderRequests(page: Page) {
  let count = 0;
  await page.route('https://api.openai.com/**', async (route) => {
    count++;
    await route.abort('blockedbyclient');
  });
  return () => count;
}

test('OpenAI model settings save without activating a provider and the default real-call gate stays closed', async ({
  page,
  request,
}, testInfo) => {
  const beforeResponse = await request.get('/api/provider-settings');
  expect(beforeResponse.ok()).toBeTruthy();
  const before = (await beforeResponse.json()) as ProviderSettingsSummary;
  const countProvider = await blockBrowserProviderRequests(page);
  let starts = 0;
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/live-provider/start') starts++;
  });
  try {
    await page.goto('/');
    const settings = page.locator('details.provider-settings');
    await settings.locator(':scope > summary').click();
    await expect(settings.getByLabel('服务设置模式', { exact: true })).toBeEnabled();
    await settings.getByLabel('服务设置模式', { exact: true }).selectOption('custom');
    await settings.getByLabel('服务协议', { exact: true }).selectOption('openai-responses');
    await expect(settings.getByLabel('服务基础地址', { exact: true })).toHaveValue(
      'https://api.openai.com/v1',
    );
    await settings.getByLabel('模型标识', { exact: true }).fill(OPENAI_DEFAULT_MODEL);
    await settings
      .getByLabel('服务端凭据变量引用', { exact: true })
      .fill('IR_TRANSLATION_BROWSER_OPENAI_KEY');
    await expect(settings.locator('input[type=password]')).toHaveCount(0);
    await settings.getByRole('button', { name: '保存离线设置', exact: true }).click();
    await expect(settings.getByText(/设置已保存，尚未验证/)).toBeVisible();
    const saved = (await (
      await request.get('/api/provider-settings')
    ).json()) as ProviderSettingsSummary;
    expect(saved).toMatchObject({
      mode: 'custom',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      model: OPENAI_DEFAULT_MODEL,
      credentialRef: 'IR_TRANSLATION_BROWSER_OPENAI_KEY',
      credentialStatus: 'absent',
      realCallsEnabled: false,
    });
    expect(saved).not.toHaveProperty('apiKey');
    const panel = await livePanel(page);
    await expect(panel.getByLabel('本轮累计预算（美元）', { exact: true })).toHaveValue('');
    const start = panel.getByRole('button', { name: '启用真实翻译', exact: true });
    await expect(start).toBeDisabled();
    await acceptLiveDraft(panel);
    await expect(start).toBeDisabled();
    const status = (await (await request.get('/api/live-provider')).json()) as LiveProviderStatus;
    expect(status.operatorEnabled).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.mode).toBe('mock');
    expect(status.budget.operatorCapMicros).toBe(0);
    expect((await (await request.get('/api/config')).json()).mode).toBe('mock');
    await page.reload();
    const reopenedSettings = page.locator('details.provider-settings');
    await reopenedSettings.locator(':scope > summary').click();
    await expect(reopenedSettings.getByLabel('服务协议', { exact: true })).toHaveValue(
      'openai-responses',
    );
    await expect(reopenedSettings.getByLabel('模型标识', { exact: true })).toHaveValue(
      OPENAI_DEFAULT_MODEL,
    );
    await expect(reopenedSettings.getByLabel('服务端凭据变量引用', { exact: true })).toHaveValue(
      'IR_TRANSLATION_BROWSER_OPENAI_KEY',
    );
    const reopened = await livePanel(page);
    await expect(reopened.getByLabel('本轮累计预算（美元）', { exact: true })).toHaveValue('');
    await expect(
      reopened.getByRole('button', { name: '启用真实翻译', exact: true }),
    ).toBeDisabled();
    expect(starts).toBe(0);
    expect(countProvider()).toBe(0);
    await reopened.screenshot({ path: testInfo.outputPath('synthetic-openai-default-closed.png') });
  } finally {
    const latest = (await (
      await request.get('/api/provider-settings')
    ).json()) as ProviderSettingsSummary;
    const restore: ProviderSettingsConfig = {
      mode: before.mode,
      protocol: before.protocol,
      baseUrl: before.baseUrl,
      model: before.model,
      credentialRef: before.credentialRef,
    };
    const restored = await request.put('/api/provider-settings', {
      data: { ...restore, expectedRevision: latest.revision },
    });
    expect(restored.ok()).toBeTruthy();
  }
});

test('synthetic live control requires both consents and sends one bounded start after repeated clicks', async ({
  page,
}, testInfo) => {
  const countProvider = await blockBrowserProviderRequests(page);
  let status = syntheticStatus();
  const entered = deferred(),
    release = deferred();
  let starts = 0;
  let body: StartLiveProvider | undefined;
  await page.route('**/api/live-provider**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/start')) {
      starts++;
      body = route.request().postDataJSON() as StartLiveProvider;
      entered.resolve();
      await release.promise;
      status = syntheticStatus({
        mode: 'live',
        ready: true,
        maxOutputTokens: 1024,
        reason: '合成已启用：未调用真实供应商。',
        budget: {
          ...status.budget,
          armed: true,
          budgetMicros: 250_000,
          remainingMicros: 250_000,
        },
      });
    }
    await route.fulfill({ json: status });
  });
  await page.goto('/');
  const panel = await livePanel(page);
  const start = panel.getByRole('button', { name: '启用真实翻译', exact: true });
  await expect(start).toBeDisabled();
  await panel.getByLabel('本轮累计预算（美元）', { exact: true }).fill('0.25');
  await panel.getByLabel('每段最大输出 token', { exact: true }).fill('1024');
  await panel.getByLabel(COST_CONSENT, { exact: true }).check();
  await expect(start).toBeDisabled();
  expect(starts).toBe(0);
  await panel.getByLabel(TRANSFER_CONSENT, { exact: true }).check();
  await expect(start).toBeEnabled();
  await start.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await entered.promise;
  expect(starts).toBe(1);
  await expect(panel.getByLabel('本轮累计预算（美元）', { exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '正在启用…', exact: true })).toBeDisabled();
  expect(body).toEqual({
    expectedRevision: 7,
    acknowledgeCosts: true,
    confirmDataTransfer: true,
    budgetMicros: 250_000,
    maxOutputTokens: 1024,
  });
  release.resolve();
  await expect(
    panel.locator('.provider-settings-status').getByText('真实调用已启用', { exact: true }),
  ).toBeVisible();
  expect(countProvider()).toBe(0);
  await panel.screenshot({ path: testInfo.outputPath('synthetic-openai-explicit-start.png') });
});

test('synthetic start failure preserves the explicit budget draft and a retry is user initiated', async ({
  page,
}) => {
  const status = syntheticStatus();
  let starts = 0;
  await page.route('**/api/live-provider**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/start')) {
      starts++;
      await route.fulfill({ status: 503, json: { error: '合成启动门禁拒绝；未发送供应商请求。' } });
    } else await route.fulfill({ json: status });
  });
  await page.goto('/');
  const panel = await livePanel(page);
  await acceptLiveDraft(panel, '0.30', '512');
  const start = panel.getByRole('button', { name: '启用真实翻译', exact: true });
  await start.click();
  await expect(panel.getByRole('alert')).toContainText('合成启动门禁拒绝');
  await expect(panel.getByLabel('本轮累计预算（美元）', { exact: true })).toHaveValue('0.30');
  await expect(panel.getByLabel('每段最大输出 token', { exact: true })).toHaveValue('512');
  await expect(panel.getByLabel(COST_CONSENT, { exact: true })).toBeChecked();
  await expect(panel.getByLabel(TRANSFER_CONSENT, { exact: true })).toBeChecked();
  await expect(start).toBeEnabled();
  expect(starts).toBe(1);
  await start.click();
  await expect.poll(() => starts).toBe(2);
  await expect(start).toBeEnabled();
});

test('synthetic stop and mock transitions retain cumulative spent and unknown reservation totals', async ({
  page,
}) => {
  let status = syntheticStatus({
    mode: 'live',
    ready: true,
    budget: {
      armed: true,
      budgetMicros: 1_000_000,
      spentMicros: 100_000,
      reservedMicros: 200_000,
      remainingMicros: 700_000,
      operatorCapMicros: 1_000_000,
      overrun: false,
    },
  });
  const mutations: string[] = [];
  await page.route('**/api/live-provider**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      mutations.push(path);
      expect(route.request().postDataJSON()).toEqual({});
      status = {
        ...status,
        mode: path.endsWith('/mock') ? 'mock' : 'real-disabled',
        ready: false,
        reason: '合成已停止，未知费用预留保持，不代表供应商退款。',
        budget: { ...status.budget, armed: false },
      };
    }
    await route.fulfill({ json: status });
  });
  await page.goto('/');
  const panel = await livePanel(page);
  await expect(
    panel.locator('.provider-settings-status').getByText('真实调用已启用', { exact: true }),
  ).toBeVisible();
  const paid = panel.getByText('已对账费用', { exact: true }).locator('..').locator('dd');
  const held = panel.getByText('进行中或未知用量预留', { exact: true }).locator('..').locator('dd');
  const remaining = panel.getByText('剩余可预留', { exact: true }).locator('..').locator('dd');
  await expect(paid).toHaveText('$0.100000');
  await expect(held).toHaveText('$0.200000');
  await expect(remaining).toHaveText('$0.700000');
  await panel.getByRole('button', { name: '停止真实调用', exact: true }).click();
  await expect(
    panel.locator('.provider-settings-status').getByText('真实调用已关闭', { exact: true }),
  ).toBeVisible();
  expect(status.budget).toMatchObject({
    spentMicros: 100_000,
    reservedMicros: 200_000,
    remainingMicros: 700_000,
    armed: false,
  });
  await panel.getByRole('button', { name: '切回模拟模式', exact: true }).click();
  await expect(
    panel.locator('.provider-settings-status').getByText('模拟模式', { exact: true }),
  ).toBeVisible();
  await expect(paid).toHaveText('$0.100000');
  await expect(held).toHaveText('$0.200000');
  await expect(remaining).toHaveText('$0.700000');
  expect(status.budget.spentMicros).toBe(100_000);
  expect(status.budget.reservedMicros).toBe(200_000);
  expect(mutations).toEqual(['/api/live-provider/stop', '/api/live-provider/mock']);
});

test('synthetic live control rejects invalid cumulative amounts and output limits before a start request', async ({
  page,
}) => {
  let starts = 0;
  await page.route('**/api/live-provider**', async (route) => {
    if (route.request().method() === 'POST') starts++;
    await route.fulfill({ json: syntheticStatus() });
  });
  await page.goto('/');
  const panel = await livePanel(page);
  await acceptLiveDraft(panel);
  const budget = panel.getByLabel('本轮累计预算（美元）', { exact: true });
  const tokens = panel.getByLabel('每段最大输出 token', { exact: true });
  const start = panel.getByRole('button', { name: '启用真实翻译', exact: true });
  await expect(start).toBeEnabled();
  for (const value of ['0', '-1', '1.000001', '0.0000001', 'not-a-budget']) {
    await budget.fill(value);
    await expect(start).toBeDisabled();
  }
  await budget.fill('0.25');
  for (const value of ['0', '255', '8193', '1.5', '-1']) {
    await tokens.fill(value);
    await expect(start).toBeDisabled();
  }
  await tokens.fill('1024');
  await expect(start).toBeEnabled();
  await panel.getByLabel(COST_CONSENT, { exact: true }).uncheck();
  await expect(start).toBeDisabled();
  expect(starts).toBe(0);
});
