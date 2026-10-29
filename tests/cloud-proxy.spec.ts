import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LiveProviderStatus } from '../shared/live-provider';
import { OPENAI_DEFAULT_MODEL } from '../shared/openai-models';

const COST_CONSENT = '我确认本轮累计费用上限，包含全部请求和重试';
const TRANSFER_CONSENT = '我同意将所选任务的原文与必要上下文发送给 OpenAI';

function syntheticStatus(
  transport: NonNullable<LiveProviderStatus['transport']>,
): LiveProviderStatus {
  return {
    mode: 'mock',
    ready: false,
    reason: '合成控制状态：未连接 Cloud 或真实供应商。',
    settingsRevision: 3,
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
    transport,
  };
}
async function panel(page: Page): Promise<Locator> {
  const details = page.locator('details.live-provider');
  await expect(details.locator(':scope > summary')).not.toContainText('正在同步');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open)))
    await details.locator(':scope > summary').click();
  return details;
}
async function consent(details: Locator) {
  await details.getByLabel('本轮累计预算（美元）', { exact: true }).fill('1');
  await details.getByLabel('每段最大输出 token', { exact: true }).fill('1024');
  await details.getByLabel(COST_CONSENT, { exact: true }).check();
  await details.getByLabel(TRANSFER_CONSENT, { exact: true }).check();
}
async function rejectProviderRequests(page: Page) {
  let providerRequests = 0;
  await page.route('https://api.openai.com/**', async (route) => {
    providerRequests++;
    await route.abort('blockedbyclient');
  });
  return () => providerRequests;
}

test('default transport metadata exposes only a safe summary and never activates a provider', async ({
  page,
  request,
}) => {
  const countProvider = await rejectProviderRequests(page);
  let starts = 0;
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/live-provider/start') starts++;
  });
  const response = await request.get('/api/live-provider');
  expect(response.ok()).toBeTruthy();
  const status = (await response.json()) as LiveProviderStatus;
  expect(status.mode).toBe('mock');
  expect(status.ready).toBe(false);
  expect(status.operatorEnabled).toBe(false);
  expect(status.budget.operatorCapMicros).toBe(0);
  expect(status.transport).toBeDefined();
  expect(Object.keys(status.transport!).sort()).toEqual(['mode', 'ready', 'reason', 'upstreamDns']);
  const labels = {
    direct: '服务端直连',
    'cloud-proxy': 'Cloud 受控代理',
    unconfigured: '传输尚未配置',
  };
  await page.goto('/');
  const details = await panel(page);
  const transport = details.getByRole('region', { name: '服务端传输状态', exact: true });
  await expect(transport).toContainText(labels[status.transport!.mode]);
  await expect(transport.locator('input, select, textarea')).toHaveCount(0);
  await expect(details.getByRole('button', { name: '启用真实翻译', exact: true })).toBeDisabled();
  if (status.transport!.mode === 'unconfigured') {
    expect(status.transport!.ready).toBe(false);
    await expect(transport).toContainText('不会自动回退直连');
  }
  expect(starts).toBe(0);
  expect(countProvider()).toBe(0);
});

for (const mode of ['cloud-proxy', 'direct'] as const) {
  test(`synthetic ${mode} summary is read only and keeps its DNS trust boundary explicit`, async ({
    page,
  }, testInfo) => {
    const countProvider = await rejectProviderRequests(page);
    const hiddenUrl = 'http://synthetic-proxy.invalid:8080';
    let mutations = 0;
    const status = syntheticStatus({
      mode,
      ready: true,
      reason: '合成传输配置：没有连接实际平台代理或真实供应商。',
      upstreamDns: mode === 'cloud-proxy' ? 'managed-proxy' : 'client-pinned',
    });
    await page.route('**/api/live-provider**', async (route) => {
      if (route.request().method() !== 'GET') mutations++;
      await route.fulfill({
        json: {
          ...status,
          transport: {
            ...status.transport,
            proxyUrl: hiddenUrl,
            certificate: 'synthetic-hidden-ca',
          },
        },
      });
    });
    await page.goto('/');
    const details = await panel(page);
    const transport = details.getByRole('region', { name: '服务端传输状态', exact: true });
    await expect(transport).toContainText('合成传输配置');
    await expect(transport.locator('input, select, textarea')).toHaveCount(0);
    if (mode === 'cloud-proxy') {
      await expect(transport).toContainText('平台代理解析上游，非客户端上游 IP 固定');
      await expect(transport).toContainText('客户端仍验证 TLS 证书链和官方主机名');
      await expect(transport).toContainText('外部信任边界');
    } else {
      await expect(transport).toContainText('应用校验全部 DNS 结果并固定连接地址');
      await expect(transport).not.toContainText('平台代理解析上游');
    }
    await consent(details);
    await expect(details.getByRole('button', { name: '启用真实翻译', exact: true })).toBeEnabled();
    expect(await page.content()).not.toContain(hiddenUrl);
    expect(await page.content()).not.toContain('synthetic-hidden-ca');
    expect(mutations).toBe(0);
    expect(countProvider()).toBe(0);
    if (mode === 'cloud-proxy')
      await transport.screenshot({
        path: testInfo.outputPath('synthetic-cloud-proxy-boundary.png'),
      });
  });
}

test('unconfigured transport blocks live start even with consents while emergency stop stays available', async ({
  page,
}) => {
  const countProvider = await rejectProviderRequests(page);
  let status = syntheticStatus({
    mode: 'unconfigured',
    ready: false,
    reason: '合成代理配置缺失；没有执行真实连接。',
    upstreamDns: 'unavailable',
  });
  const mutations: string[] = [];
  await page.route('**/api/live-provider**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      mutations.push(path);
      expect(route.request().postDataJSON()).toEqual({});
      status = { ...status, mode: 'real-disabled', reason: '合成已停止：未调用真实供应商。' };
    }
    await route.fulfill({ json: status });
  });
  await page.goto('/');
  const details = await panel(page);
  await consent(details);
  await expect(details.getByRole('button', { name: '启用真实翻译', exact: true })).toBeDisabled();
  await expect(details.getByRole('region', { name: '服务端传输状态', exact: true })).toContainText(
    '不会自动回退直连',
  );
  const stop = details.getByRole('button', { name: '停止真实调用', exact: true });
  await expect(stop).toBeEnabled();
  await expect(details.getByRole('button', { name: '切回模拟模式', exact: true })).toBeEnabled();
  await stop.click();
  await expect.poll(() => mutations).toEqual(['/api/live-provider/stop']);
  await expect(details.locator(':scope > summary')).toContainText('真实调用已关闭');
  expect(countProvider()).toBe(0);
});

test('contradictory proxy DNS metadata is treated as unknown and cannot enable live calls', async ({
  page,
}) => {
  const countProvider = await rejectProviderRequests(page);
  let mutations = 0;
  await page.route('**/api/live-provider**', async (route) => {
    if (route.request().method() !== 'GET') mutations++;
    await route.fulfill({
      json: syntheticStatus({
        mode: 'cloud-proxy',
        ready: true,
        reason: '合成格式错误状态，未连接真实供应商。',
        upstreamDns: 'client-pinned',
      }),
    });
  });
  await page.goto('/');
  const details = await panel(page);
  await expect(details.getByRole('alert')).toContainText('服务返回的调用状态无效');
  await expect(details.locator(':scope > summary')).toContainText('调用状态未知');
  await expect(details.getByRole('region', { name: '服务端传输状态', exact: true })).toHaveCount(0);
  await expect(details.getByRole('button', { name: '启用真实翻译', exact: true })).toBeDisabled();
  await expect(details.getByRole('button', { name: '停止真实调用', exact: true })).toBeEnabled();
  expect(mutations).toBe(0);
  expect(countProvider()).toBe(0);
});
