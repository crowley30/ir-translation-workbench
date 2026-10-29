import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { LiveProviderStatus } from '../shared/live-provider';
import type { ServiceConfig, Task } from '../shared/types';
import { OPENAI_DEFAULT_MODEL } from '../shared/openai-models';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function syntheticTask(): Task {
  return {
    id: 'synthetic-openai-emergency-control',
    revision: 1,
    title: '合成在途控制任务',
    style: 'business',
    status: 'draft',
    mode: 'real',
    provider: { provider: 'openai-responses', model: OPENAI_DEFAULT_MODEL },
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    paragraphs: [
      {
        id: 'p0001',
        source: 'A synthetic saved robotics paragraph.',
        translation: '合成已保存译文。',
        revision: 1,
        edited: false,
        status: 'done',
        error: null,
      },
      {
        id: 'p0002',
        source: 'A synthetic pending robotics paragraph.',
        translation: '',
        revision: 0,
        edited: false,
        status: 'pending',
        error: null,
      },
    ],
  };
}

function syntheticStatus(mode: LiveProviderStatus['mode'] = 'live'): LiveProviderStatus {
  const live = mode === 'live';
  return {
    mode,
    ready: live,
    reason: '合成控制状态，仅浏览器回归，不连接真实供应商。',
    settingsRevision: 2,
    provider: 'openai-responses',
    model: OPENAI_DEFAULT_MODEL,
    maxOutputTokens: 4096,
    operatorEnabled: true,
    credentialStatus: 'present',
    budget: {
      armed: live,
      budgetMicros: 1_000_000,
      spentMicros: 0,
      reservedMicros: 1000,
      remainingMicros: 999_000,
      operatorCapMicros: 1_000_000,
      overrun: false,
    },
  };
}
const realConfig: ServiceConfig = {
  mode: 'real',
  ready: true,
  label: '合成真实服务配置，无供应商请求',
  maxCharacters: 20000,
  maxParagraphs: 100,
};

async function blockProvider(page: Page) {
  let calls = 0;
  await page.route('https://api.openai.com/**', async (route) => {
    calls++;
    await route.abort('blockedbyclient');
  });
  return () => calls;
}

async function openPanel(page: Page): Promise<Locator> {
  const panel = page.locator('details.live-provider');
  if (!(await panel.evaluate((element: HTMLDetailsElement) => element.open)))
    await panel.locator(':scope > summary').click();
  return panel;
}

async function actualTask(request: APIRequestContext, id: string): Promise<Task> {
  const response = await request.get(`/api/tasks/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Task>;
}

async function routeTaskReads(
  page: Page,
  getTask: () => Task,
  config: () => ServiceConfig = () => realConfig,
) {
  const id = getTask().id;
  await page.route('**/api/config', (route) => route.fulfill({ json: config() }));
  await page.route('**/api/tasks', (route) => route.fulfill({ json: [getTask()] }));
  await page.route(`**/api/tasks/${id}`, (route) => route.fulfill({ json: getTask() }));
}

test('cancel remains effective while an actual mock translate 202 response is held, and its late snapshot cannot revive the run', async ({
  page,
  request,
}) => {
  const providerCalls = await blockProvider(page);
  const response = await request.post('/api/tasks', {
    data: {
      text: 'Synthetic first pending robotics paragraph.\n\nSynthetic second pending robotics paragraph.',
      style: 'business',
      title: '合成取消在途响应任务',
    },
  });
  expect(response.status()).toBe(201);
  const created = (await response.json()) as Task;
  const entered = deferred(),
    release = deferred(),
    settled = deferred();
  let starts = 0;
  await page.route(`**/api/tasks/${created.id}/translate`, async (route) => {
    starts++;
    const started = await route.fetch();
    entered.resolve();
    await release.promise;
    try {
      await route.fulfill({ response: started });
    } catch {
      /* A preempted caller can no longer receive this intentionally late 202. */
    } finally {
      settled.resolve();
    }
  });
  try {
    await page.goto(`/?task=${created.id}`);
    await expect(page.getByRole('heading', { name: created.title, exact: true })).toBeVisible();
    await page.getByText('模拟测试设置', { exact: true }).click();
    await page.getByLabel('模拟场景', { exact: true }).selectOption('slow');
    await page.getByRole('button', { name: '继续翻译', exact: true }).click();
    await entered.promise;
    await expect.poll(async () => (await actualTask(request, created.id)).status).toBe('running');
    const cancel = page.getByRole('button', { name: '取消翻译', exact: true });
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect.poll(async () => (await actualTask(request, created.id)).status).toBe('cancelled');
    await expect(page.locator('.page-heading .status-badge')).toHaveText('已取消');
    release.resolve();
    await settled.promise;
    await expect(page.locator('.page-heading .status-badge')).toHaveText('已取消');
    await expect(page.locator('.run-info')).toHaveCount(0);
    expect((await actualTask(request, created.id)).paragraphs[1].translation).toBe('');
    expect(starts).toBe(1);
    expect(providerCalls()).toBe(0);
  } finally {
    release.resolve();
    await request.post(`/api/tasks/${created.id}/cancel`, { data: {} });
  }
});

for (const control of [
  { path: 'stop', label: '停止真实调用', response: 200 },
  { path: 'mock', label: '切回模拟模式', response: 200 },
  { path: 'stop', label: '停止真实调用', response: 503 },
] as const) {
  test(`synthetic ${control.path} ${control.response} remains available during a held translate 202 and a late response never reactivates the task`, async ({
    page,
  }) => {
    const providerCalls = await blockProvider(page);
    let task = syntheticTask();
    let config = { ...realConfig };
    let status = syntheticStatus();
    const entered = deferred(),
      release = deferred(),
      settled = deferred();
    const mutations: string[] = [];
    let starts = 0;
    await routeTaskReads(
      page,
      () => task,
      () => config,
    );
    await page.route('**/api/live-provider**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST') {
        mutations.push(path);
        task = {
          ...task,
          revision: (task.revision ?? 0) + 1,
          status: 'cancelled',
          paragraphs: task.paragraphs.map((paragraph) =>
            paragraph.status === 'running'
              ? { ...paragraph, status: 'cancelled', error: '合成停止，未调用供应商。' }
              : paragraph,
          ),
        };
        status = syntheticStatus(control.path === 'mock' ? 'mock' : 'real-disabled');
        config = {
          ...config,
          mode: control.path === 'mock' ? 'mock' : 'real',
          ready: control.path === 'mock',
        };
        if (control.response === 503) {
          await route.fulfill({
            status: 503,
            json: {
              code: 'BUDGET_UNAVAILABLE',
              error: '合成停止已在本地生效，持久化失败；不会继续发送。',
            },
          });
          return;
        }
      }
      await route.fulfill({ json: status });
    });
    await page.route(`**/api/tasks/${task.id}/translate`, async (route) => {
      starts++;
      task = {
        ...task,
        revision: (task.revision ?? 0) + 1,
        status: 'running',
        paragraphs: task.paragraphs.map((paragraph) =>
          paragraph.status === 'pending' ? { ...paragraph, status: 'running' } : paragraph,
        ),
      };
      const late = structuredClone(task);
      entered.resolve();
      await release.promise;
      try {
        await route.fulfill({ status: 202, json: late });
      } catch {
        /* A stop can abort the pending native request without rolling it back. */
      } finally {
        settled.resolve();
      }
    });
    try {
      await page.goto(`/?task=${task.id}`);
      await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
      const panel = await openPanel(page);
      await expect(
        panel.locator('.provider-settings-status').getByText('真实调用已启用', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '继续翻译', exact: true }).click();
      await entered.promise;
      await expect(page.getByRole('button', { name: '取消翻译', exact: true })).toBeEnabled();
      const emergency = panel.getByRole('button', { name: control.label, exact: true });
      await expect(emergency).toBeEnabled();
      await emergency.click();
      await expect.poll(() => mutations.length).toBe(1);
      expect(mutations).toEqual([`/api/live-provider/${control.path}`]);
      await expect(page.locator('.page-heading .status-badge')).toHaveText('已取消');
      release.resolve();
      await settled.promise;
      await expect(page.locator('.page-heading .status-badge')).toHaveText('已取消');
      await expect(page.locator('.run-info')).toHaveCount(0);
      expect(task.status).toBe('cancelled');
      expect(task.paragraphs[1].translation).toBe('');
      expect(starts).toBe(1);
      expect(providerCalls()).toBe(0);
    } finally {
      release.resolve();
    }
  });
}

test('mount and reload read live status while the panel stays closed, with unknown state blocking real translation until synchronized', async ({
  page,
}) => {
  const providerCalls = await blockProvider(page);
  const task = syntheticTask();
  await routeTaskReads(page, () => task);
  let entered = deferred(),
    release = deferred();
  let statusReads = 0,
    starts = 0;
  await page.route('**/api/live-provider', async (route) => {
    statusReads++;
    const wait = release.promise;
    entered.resolve();
    await wait;
    await route.fulfill({ json: syntheticStatus() }).catch(() => undefined);
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/translate')) starts++;
  });
  try {
    await page.goto(`/?task=${task.id}`);
    for (let round = 0; round < 2; round++) {
      if (round) {
        entered = deferred();
        release = deferred();
        await page.reload();
      }
      await entered.promise;
      const panel = page.locator('details.live-provider');
      expect(await panel.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
      await expect(panel.locator(':scope > summary')).toContainText('调用状态未知');
      await expect(panel.locator(':scope > summary')).not.toContainText('默认关闭');
      await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeDisabled();
      await expect(
        page.getByRole('button', { name: '重译本段', exact: true }).first(),
      ).toBeDisabled();
      await openPanel(page);
      await expect(panel.getByRole('button', { name: '停止真实调用', exact: true })).toBeEnabled();
      await expect(panel.getByRole('button', { name: '切回模拟模式', exact: true })).toBeEnabled();
      await panel.locator(':scope > summary').click();
      release.resolve();
      await expect(panel.locator(':scope > summary')).toContainText('真实调用已启用');
      await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeEnabled();
      await expect(
        page.getByRole('button', { name: '重译本段', exact: true }).first(),
      ).toBeEnabled();
    }
    expect(statusReads).toBe(2);
    expect(starts).toBe(0);
    expect(providerCalls()).toBe(0);
  } finally {
    release.resolve();
  }
});

test('a failed initial live status read keeps billable controls disabled and emergency stop available until an explicit successful refresh', async ({
  page,
}) => {
  const providerCalls = await blockProvider(page);
  const task = syntheticTask();
  await routeTaskReads(page, () => task);
  let recover = false,
    reads = 0,
    starts = 0;
  await page.route('**/api/live-provider', async (route) => {
    reads++;
    await route.fulfill(
      recover
        ? { json: syntheticStatus() }
        : { status: 503, json: { error: '合成调用状态读取失败。' } },
    );
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/translate')) starts++;
  });
  await page.goto(`/?task=${task.id}`);
  const panel = await openPanel(page);
  await expect(panel.getByRole('alert')).toContainText('合成调用状态读取失败');
  await expect(panel.locator(':scope > summary')).toContainText('调用状态未知');
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重译本段', exact: true }).first()).toBeDisabled();
  await expect(panel.getByRole('button', { name: '停止真实调用', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: '切回模拟模式', exact: true })).toBeEnabled();
  const readsBeforeRefresh = reads;
  recover = true;
  await panel.getByRole('button', { name: '刷新调用状态', exact: true }).click();
  await expect(panel.locator(':scope > summary')).toContainText('真实调用已启用');
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeEnabled();
  expect(reads).toBe(readsBeforeRefresh + 1);
  expect(starts).toBe(0);
  expect(providerCalls()).toBe(0);
});
