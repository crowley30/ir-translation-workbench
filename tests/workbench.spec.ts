import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Task, MockScenario } from '../shared/types';

const synthetic =
  'Dear investor, our synthetic robotics fund invested USD 12 million in 2026.\n\nThis fictional company develops AI models for warehouse robots.';

async function taskFromApi(request: APIRequestContext, id: string): Promise<Task> {
  const response = await request.get(`/api/tasks/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Task>;
}

async function currentId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/task=/);
  return new URL(page.url()).searchParams.get('task')!;
}

async function waitStopped(request: APIRequestContext, id: string): Promise<Task> {
  await expect
    .poll(async () => !['draft', 'running'].includes((await taskFromApi(request, id)).status), {
      timeout: 16000,
    })
    .toBe(true);
  return taskFromApi(request, id);
}

async function chooseScenario(page: Page, scenario: MockScenario): Promise<void> {
  const select = page.getByLabel('模拟场景', { exact: true });
  if (!(await select.isVisible())) await page.getByText('模拟测试设置', { exact: true }).click();
  await select.selectOption(scenario);
}

async function createInUi(page: Page, scenario: MockScenario = 'normal'): Promise<string> {
  await page.goto('/');
  await page.getByLabel('输入英文', { exact: true }).fill(synthetic);
  await page.getByLabel('文体', { exact: true }).selectOption('business');
  await chooseScenario(page, scenario);
  await page.getByRole('button', { name: '创建并翻译', exact: true }).click();
  return currentId(page);
}

test('input bounds, explicit simulation label, save/reopen and text export', async ({
  page,
  request,
  context,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('模拟模式', { exact: false }).first()).toBeVisible();
  const create = page.getByRole('button', { name: '创建并翻译', exact: true });
  await expect(create).toBeDisabled();
  await page.getByLabel('输入英文', { exact: true }).fill('   \n  ');
  await expect(create).toBeDisabled();
  await page.getByLabel('输入英文', { exact: true }).fill('a'.repeat(20001));
  await expect(create).toBeDisabled();
  await page
    .getByLabel('输入英文', { exact: true })
    .fill(Array.from({ length: 101 }, () => 'Synthetic paragraph.').join('\n\n'));
  await expect(create).toBeDisabled();
  await page.getByLabel('输入英文', { exact: true }).fill(synthetic);
  await page.getByLabel('文体', { exact: true }).selectOption('faithful');
  await create.click();
  const id = await currentId(page);
  const done = await waitStopped(request, id);
  expect(done.status).toBe('completed');
  expect(done.mode).toBe('mock');
  expect(done.paragraphs).toHaveLength(2);
  expect(done.paragraphs[0].translation).toMatch(/模拟/);
  expect(done.paragraphs[0].translation).toMatch(/非译文/);
  const edit = page.getByLabel('译文 1', { exact: true });
  await expect(edit).toHaveValue(done.paragraphs[0].translation);
  await edit.fill('人工校订：这是一条合成测试内容。');
  await page.getByRole('button', { name: '保存修改', exact: true }).first().click();
  await expect
    .poll(async () => (await taskFromApi(request, id)).paragraphs[0].translation)
    .toBe('人工校订：这是一条合成测试内容。');
  await page.reload();
  await expect(edit).toHaveValue('人工校订：这是一条合成测试内容。');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByLabel('输入英文', { exact: true })).toBeVisible();
  await page.locator(`a[href="?task=${id}"]`).click();
  await expect(edit).toHaveValue('人工校订：这是一条合成测试内容。');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制译文', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('人工校订');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文本', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.txt$/);
  const stream = await download.createReadStream();
  let exported = '';
  if (stream) for await (const chunk of stream) exported += chunk.toString();
  expect(exported).toContain('人工校订');
  expect(exported).toContain('模拟');
  await page.screenshot({ path: testInfo.outputPath('synthetic-workbench.png'), fullPage: true });
});

test('local retranslation preserves other saved edits and edits made while response is pending', async ({
  page,
  request,
}) => {
  const id = await createInUi(page);
  const initial = await waitStopped(request, id);
  const second = page.getByLabel('译文 2', { exact: true });
  await expect(second).toHaveValue(initial.paragraphs[1].translation);
  await second.fill('人工修改第二段：请保留。');
  await page.getByRole('button', { name: '保存修改', exact: true }).nth(1).click();
  await expect.poll(async () => (await taskFromApi(request, id)).paragraphs[1].edited).toBe(true);
  await chooseScenario(page, 'slow');
  await page.getByRole('button', { name: '重译本段', exact: true }).first().click();
  await expect.poll(async () => (await taskFromApi(request, id)).status).toBe('running');
  const first = page.getByLabel('译文 1', { exact: true });
  await first.fill('运行中的人工修改也必须保留。');
  await page.getByRole('button', { name: '保存修改', exact: true }).first().click();
  await expect.poll(async () => (await taskFromApi(request, id)).paragraphs[0].edited).toBe(true);
  const done = await waitStopped(request, id);
  expect(done.paragraphs[0].translation).toBe('运行中的人工修改也必须保留。');
  expect(done.paragraphs[1].translation).toBe('人工修改第二段：请保留。');
  await page.reload();
  await expect(first).toHaveValue('运行中的人工修改也必须保留。');
  await expect(second).toHaveValue('人工修改第二段：请保留。');
});

test('duplicate translate rejected, cancel survives navigation and remaining paragraphs can retry', async ({
  page,
  request,
}) => {
  const id = await createInUi(page, 'slow');
  await expect.poll(async () => (await taskFromApi(request, id)).status).toBe('running');
  const duplicate = await request.post(`/api/tasks/${id}/translate`, {
    data: { scenario: 'slow' },
  });
  expect(duplicate.status()).toBe(409);
  await page.reload();
  await expect(page.getByRole('button', { name: '取消翻译', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消翻译', exact: true }).click();
  const cancelled = await waitStopped(request, id);
  expect(cancelled.status).toBe('cancelled');
  await page.reload();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.locator(`a[href="?task=${id}"]`).click();
  await chooseScenario(page, 'normal');
  await page.getByRole('button', { name: '继续翻译', exact: true }).click();
  const done = await waitStopped(request, id);
  expect(done.status).toBe('completed');
  expect(done.paragraphs.every((p) => p.status === 'done')).toBe(true);
});

test('newer typing during a pending save remains editable and saves with the rebased revision', async ({
  page,
  request,
}) => {
  const id = await createInUi(page);
  const initial = await waitStopped(request, id);
  const first = page.getByLabel('译文 1', { exact: true });
  await expect(first).toHaveValue(initial.paragraphs[0].translation);
  let committed!: () => void;
  let release!: () => void;
  const committedPromise = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const holdResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/tasks/*/paragraphs/*',
    async (route) => {
      const response = await route.fetch();
      committed();
      await holdResponse;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await first.fill('人工草稿第一版。');
  await page.getByRole('button', { name: '保存修改', exact: true }).first().click();
  await committedPromise;
  await first.fill('保存请求期间继续输入的第二版。');
  release();
  const save = page.getByRole('button', { name: '保存修改', exact: true }).first();
  await expect(save).toBeEnabled();
  await expect(first).toHaveValue('保存请求期间继续输入的第二版。');
  await save.click();
  await expect
    .poll(async () => (await taskFromApi(request, id)).paragraphs[0].translation)
    .toBe('保存请求期间继续输入的第二版。');
  await page.reload();
  await expect(first).toHaveValue('保存请求期间继续输入的第二版。');
});

test('a model response arriving before save requires acknowledgment before replacing the newer result', async ({
  page,
  request,
}) => {
  const id = await createInUi(page);
  const initial = await waitStopped(request, id);
  const first = page.getByLabel('译文 1', { exact: true });
  await expect(first).toHaveValue(initial.paragraphs[0].translation);
  await chooseScenario(page, 'slow');
  await page.getByRole('button', { name: '重译本段', exact: true }).first().click();
  await expect.poll(async () => (await taskFromApi(request, id)).status).toBe('running');
  await first.fill('翻译响应到达前开始的人工草稿。');
  await waitStopped(request, id);
  await expect
    .poll(async () => (await taskFromApi(request, id)).paragraphs[0].revision)
    .toBe(initial.paragraphs[0].revision + 1);
  // Let the UI receive the new server revision while retaining the visible local draft.
  await expect(page.getByRole('button', { name: '取消翻译', exact: true })).toHaveCount(0);
  await expect(first).toHaveValue('翻译响应到达前开始的人工草稿。');
  let acknowledged = false;
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    acknowledged = true;
    await dialog.accept();
  });
  await page.getByRole('button', { name: '保存修改', exact: true }).first().click();
  expect(acknowledged).toBe(true);
  await expect
    .poll(async () => (await taskFromApi(request, id)).paragraphs[0].translation)
    .toBe('翻译响应到达前开始的人工草稿。');
});

test('two immediate create clicks result in one persisted task', async ({ page, request }) => {
  await page.goto('/');
  await page.getByLabel('输入英文', { exact: true }).fill(synthetic);
  let createRequests = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/tasks') createRequests++;
  });
  const button = page.getByRole('button', { name: '创建并翻译', exact: true });
  await expect(button).toBeEnabled();
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  const id = await currentId(page);
  expect((await waitStopped(request, id)).status).toBe('completed');
  expect(createRequests).toBe(1);
});

test('a temporary config read failure recovers without a page reload', async ({
  page,
}, testInfo) => {
  await page.route(
    '**/api/config',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic transient failure' }),
      }),
    { times: 1 },
  );
  await page.goto('/');
  await page.getByLabel('输入英文', { exact: true }).fill(synthetic);
  await expect(page.getByRole('button', { name: '创建并翻译', exact: true })).toBeEnabled();
  await expect(page.getByText('模拟模式', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('synthetic-compose.png'), fullPage: true });
});

for (const scenario of ['timeout', 'rate-limit', 'server-error', 'malformed', 'partial'] as const) {
  test(`mock ${scenario}: finite failure, visible state and recovery`, async ({
    page,
    request,
  }) => {
    const id = await createInUi(page, scenario);
    const failed = await waitStopped(request, id);
    expect(['failed', 'partial']).toContain(failed.status);
    expect(failed.paragraphs.some((p) => p.status === 'failed' && p.error)).toBe(true);
    expect(
      failed.paragraphs.filter((p) => p.status === 'failed').every((p) => !p.translation),
    ).toBe(true);
    await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeEnabled();
    await page.reload();
    await chooseScenario(page, 'normal');
    await page.getByRole('button', { name: '继续翻译', exact: true }).click();
    const recovered = await waitStopped(request, id);
    expect(recovered.status).toBe('completed');
    expect(recovered.paragraphs.every((p) => p.translation.includes('模拟'))).toBe(true);
  });
}
