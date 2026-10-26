import { test, expect, type APIRequestContext, type Download, type Page } from '@playwright/test';
import { fromBuffer } from 'yauzl';
import { SaxesParser } from 'saxes';
import { DOCX_LIMITS, type DocxImport } from '../shared/docx';
import type { MockScenario, Task } from '../shared/types';
import { supportedFixture, unsupportedFixture, warningFixture } from '../server/docx/fixtures';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ACKNOWLEDGMENT = '我已了解基础排版会变化，继续使用可编辑文档';
const filename = 'synthetic-ir-update.docx';
const manual = 'DOCX 人工校订：合成基金 & <测试>，USD 12 million。';
const sources = [
  'Synthetic IR update',
  'Dear synthetic investor.',
  'Robotics platform.',
  'First milestone.',
  'Metric',
  'Quarter',
  'Value',
  'Revenue',
  'USD 12 million',
  'Synthetic estimate.',
];
const sourceCells = [
  ['Metric', 'Quarter'],
  ['Value'],
  ['Revenue'],
  ['USD 12 million', 'Synthetic estimate.'],
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function readTask(request: APIRequestContext, id: string): Promise<Task> {
  const response = await request.get(`/api/tasks/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Task>;
}
async function waitStopped(request: APIRequestContext, id: string): Promise<Task> {
  await expect
    .poll(async () => !['draft', 'running'].includes((await readTask(request, id)).status), {
      timeout: 18000,
    })
    .toBe(true);
  return readTask(request, id);
}
async function chooseScenario(page: Page, scenario: MockScenario) {
  const select = page.getByLabel('模拟场景', { exact: true });
  if (!(await select.isVisible())) await page.getByText('模拟测试设置', { exact: true }).click();
  await select.selectOption(scenario);
}
async function selectDocx(page: Page, buffer?: Buffer, name = filename) {
  await page
    .getByLabel('上传 DOCX', { exact: true })
    .setInputFiles({ name, mimeType: MIME, buffer: buffer ?? (await supportedFixture()) });
}
async function preflight(page: Page, buffer?: Buffer, name = filename): Promise<DocxImport> {
  await selectDocx(page, buffer, name);
  const responseEvent = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/docx/preflight' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '上传并预检查', exact: true }).click();
  const response = await responseEvent;
  expect(response.ok()).toBeTruthy();
  const imported = (await response.json()) as DocxImport;
  await expect(page.getByRole('heading', { name: 'DOCX 预检查', exact: true })).toBeVisible();
  for (const issue of imported.report.issues)
    await expect(page.getByText(issue.message, { exact: false }).first()).toBeVisible();
  return imported;
}
async function acknowledge(page: Page) {
  const create = page.getByRole('button', { name: '创建文档任务并翻译', exact: true });
  const checkbox = page.getByLabel(ACKNOWLEDGMENT, { exact: true });
  if (await checkbox.count()) {
    await expect(create).toBeDisabled();
    await checkbox.check();
  }
  await expect(create).toBeEnabled();
}
async function createDocumentTask(page: Page, scenario: MockScenario = 'normal'): Promise<string> {
  await chooseScenario(page, scenario);
  await acknowledge(page);
  await page.getByRole('button', { name: '创建文档任务并翻译', exact: true }).click();
  await expect(page).toHaveURL(/task=/);
  return new URL(page.url()).searchParams.get('task')!;
}
async function downloadBytes(download: Download): Promise<Buffer> {
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Synthetic DOCX download has no byte stream');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function documentXml(bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Downloaded DOCX is not a ZIP'));
        return;
      }
      let found = false;
      zip.on('error', reject);
      zip.on('end', () => {
        if (!found) reject(new Error('Downloaded DOCX lacks word/document.xml'));
      });
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'word/document.xml') {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('No XML stream'));
            zip.close();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
            zip.close();
          });
        });
      });
      zip.readEntry();
    });
  });
}
function inspectXml(xml: string): { paragraphs: string[]; cells: string[][]; tables: number } {
  const paragraphs: string[] = [],
    cells: string[][] = [];
  let tables = 0,
    paragraph: string | null = null,
    text = false,
    cell: string[] | null = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.uri !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') return;
    if (tag.local === 'tbl') tables++;
    if (tag.local === 'tc') {
      cell = [];
      cells.push(cell);
    }
    if (tag.local === 'p') paragraph = '';
    if (tag.local === 't') text = true;
    if (tag.local === 'br' && paragraph !== null) paragraph += '\n';
    if (tag.local === 'tab' && paragraph !== null) paragraph += '\t';
  });
  parser.on('text', (value) => {
    if (text && paragraph !== null) paragraph += value;
  });
  parser.on('closetag', (tag) => {
    if (tag.uri !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') return;
    if (tag.local === 't') text = false;
    if (tag.local === 'p') {
      paragraphs.push(paragraph ?? '');
      cell?.push(paragraph ?? '');
      paragraph = null;
    }
    if (tag.local === 'tc') cell = null;
  });
  parser.write(xml).close();
  return { paragraphs, cells, tables };
}
async function exportFromUi(page: Page, mode: '中文' | '双语', outputPath?: string) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: `导出${mode} DOCX`, exact: true }).click();
  const download = await event;
  if (outputPath) await download.saveAs(outputPath);
  return inspectXml(await documentXml(await downloadBytes(download)));
}
function exports(page: Page) {
  return ['中文', '双语'].map((mode) =>
    page.getByRole('button', { name: `导出${mode} DOCX`, exact: true }),
  );
}

test('supported DOCX completes preflight, durable review and actual Chinese/bilingual downloads', async ({
  page,
  request,
}, testInfo) => {
  await page.goto('/');
  const imported = await preflight(page);
  expect(imported.report.status).not.toBe('blocked');
  expect(imported.report.stats.translatableParagraphs).toBe(10);
  expect(imported.report.stats.emptyParagraphs).toBe(1);
  expect(imported.report.stats.tables).toBe(1);
  expect(imported.report.stats.cells).toBe(4);
  await page.getByText('查看原文结构', { exact: true }).click();
  const previewTable = page.getByRole('table', { name: '原文简单表格', exact: true });
  await expect(previewTable).toBeVisible();
  await expect(previewTable.getByRole('row')).toHaveCount(2);
  await expect(previewTable.getByRole('cell')).toHaveCount(4);
  await expect(page.getByText('（空段落，保留结构）', { exact: true })).toBeVisible();
  await page.getByLabel('文体', { exact: true }).selectOption('faithful');
  await page
    .locator('.docx-card')
    .screenshot({ path: testInfo.outputPath('synthetic-docx-preflight-card.png') });
  await page.getByRole('heading', { name: 'DOCX 预检查', exact: true }).evaluate((element) => {
    window.scrollTo({
      top: window.scrollY + element.getBoundingClientRect().top - 60,
      behavior: 'instant',
    });
  });
  await page.screenshot({ path: testInfo.outputPath('synthetic-docx-preflight-desktop.png') });
  await acknowledge(page);
  let createRequests = 0;
  const committed = deferred(),
    release = deferred();
  await page.route('**/api/tasks/docx', async (route) => {
    createRequests++;
    const response = await route.fetch();
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page
    .getByRole('button', { name: '创建文档任务并翻译', exact: true })
    .evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
  await committed.promise;
  await expect(page.getByLabel('上传 DOCX', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('文体', { exact: true })).toBeDisabled();
  expect(createRequests).toBe(1);
  release.resolve();
  await expect(page).toHaveURL(/task=/);
  const id = new URL(page.url()).searchParams.get('task')!;
  const initial = await waitStopped(request, id);
  expect(initial.status).toBe('completed');
  expect(initial.document?.filename).toBe(filename);
  expect(initial.paragraphs.map((p) => p.source)).toEqual(sources);
  expect(new Set(initial.paragraphs.map((p) => p.id)).size).toBe(10);
  expect(initial.paragraphs.every((p) => p.location)).toBe(true);
  for (const [index, p] of initial.paragraphs.entries()) {
    await expect(
      page
        .getByRole('region', { name: `段落 ${index + 1}`, exact: true })
        .getByText(p.location!, { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByText(filename, { exact: false }).first()).toBeVisible();
  const first = page.getByLabel('译文 1', { exact: true });
  await expect(first).toHaveValue(initial.paragraphs[0].translation);
  await first.fill(manual);
  for (const button of exports(page)) await expect(button).toBeDisabled();
  await page.getByRole('button', { name: '保存修改', exact: true }).first().click();
  await expect
    .poll(async () => (await readTask(request, id)).paragraphs[0].translation)
    .toBe(manual);
  for (const button of exports(page)) await expect(button).toBeEnabled();
  await page.reload();
  await expect(first).toHaveValue(manual);
  expect((await readTask(request, id)).paragraphs.map((p) => p.id)).toEqual(
    initial.paragraphs.map((p) => p.id),
  );
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.locator(`a[href="?task=${id}"]`).click();
  await expect(first).toHaveValue(manual);
  const saved = await readTask(request, id);
  const translated = new Map(saved.paragraphs.map((p) => [p.source, p.translation]));
  const chinese = await exportFromUi(page, '中文', testInfo.outputPath('synthetic-chinese.docx'));
  expect(chinese.paragraphs[0]).toContain('模拟');
  expect(chinese.paragraphs[0]).toContain('非实际翻译');
  expect(chinese.paragraphs).toContain(manual);
  expect(chinese.tables).toBe(1);
  expect(chinese.cells).toEqual(
    sourceCells.map((cell) => cell.map((source) => translated.get(source)!)),
  );
  const bilingual = await exportFromUi(
    page,
    '双语',
    testInfo.outputPath('synthetic-bilingual.docx'),
  );
  let cursor = 0;
  for (const p of saved.paragraphs) {
    const index = bilingual.paragraphs.findIndex(
      (text, i) => i >= cursor && text.endsWith(p.source),
    );
    expect(index).toBeGreaterThanOrEqual(cursor);
    expect(bilingual.paragraphs[index + 1].endsWith(p.translation)).toBe(true);
    cursor = index + 2;
  }
  expect(bilingual.tables).toBe(1);
  expect(bilingual.cells).toEqual(
    sourceCells.map((cell) => cell.flatMap((source) => [source, translated.get(source)!])),
  );
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('synthetic-docx-review.png') });
});

test('formatting warnings require explicit acknowledgment and can be cancelled', async ({
  page,
}) => {
  await page.goto('/');
  const imported = await preflight(page, await warningFixture(), 'synthetic-format-warning.docx');
  expect(imported.report.status).toBe('warning');
  expect(imported.report.issues.some((issue) => issue.severity === 'warning')).toBe(true);
  await expect(page.getByLabel(ACKNOWLEDGMENT, { exact: true })).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: '创建文档任务并翻译', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '取消导入', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DOCX 预检查', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('上传 DOCX', { exact: true })).toBeEnabled();
});

for (const kind of ['drawing', 'merged'] as const) {
  test(`unsupported ${kind} is explicitly blocked before document task creation`, async ({
    page,
  }) => {
    await page.goto('/');
    const imported = await preflight(
      page,
      await unsupportedFixture(kind),
      `synthetic-${kind}.docx`,
    );
    expect(imported.report.status).toBe('blocked');
    expect(imported.report.issues.some((issue) => issue.severity === 'blocking')).toBe(true);
    await expect(
      page.getByRole('button', { name: '创建文档任务并翻译', exact: true }),
    ).toBeDisabled();
    await expect(page).not.toHaveURL(/task=/);
  });
}

test('fake extension and corrupt DOCX cannot create document tasks', async ({ page }) => {
  await page.goto('/');
  let uploads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/docx/preflight') uploads++;
  });
  await selectDocx(page, await supportedFixture(), 'synthetic-fake.txt');
  const upload = page.getByRole('button', { name: '上传并预检查', exact: true });
  if (await upload.isEnabled()) await upload.click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(uploads).toBe(0);
  await selectDocx(
    page,
    Buffer.from('Synthetic ordinary text is not a DOCX ZIP.'),
    'synthetic-corrupt.docx',
  );
  const response = page.waitForResponse(
    (result) => new URL(result.url()).pathname === '/api/docx/preflight',
  );
  await upload.click();
  expect((await response).status()).toBe(400);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'DOCX 预检查', exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/task=/);
});

test('oversized DOCX is rejected by the browser and the raw server boundary', async ({
  page,
  request,
}) => {
  await page.goto('/');
  let uploads = 0;
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/docx/preflight') uploads++;
  });
  const oversized = Buffer.alloc(DOCX_LIMITS.uploadBytes + 1);
  await selectDocx(page, oversized, 'synthetic-oversized.docx');
  const upload = page.getByRole('button', { name: '上传并预检查', exact: true });
  if (await upload.isEnabled()) await upload.click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(uploads).toBe(0);
  const response = await request.post('/api/docx/preflight', {
    headers: { 'Content-Type': MIME, 'X-Filename': encodeURIComponent('synthetic-oversized.docx') },
    data: oversized,
  });
  expect(response.status()).toBe(413);
  expect((await response.json()).error).toBeTruthy();
});

test('repeated upload clicks send one request and cancellation ignores the late preflight result', async ({
  page,
}) => {
  await page.goto('/');
  const textDraft = 'Synthetic text draft survives cancelled DOCX preflight.';
  await page.getByLabel('输入英文', { exact: true }).fill(textDraft);
  await selectDocx(page);
  let uploads = 0,
    aborted = false;
  const entered = deferred(),
    release = deferred(),
    settled = deferred();
  page.on('requestfailed', (req) => {
    if (new URL(req.url()).pathname === '/api/docx/preflight') aborted = true;
  });
  await page.route('**/api/docx/preflight', async (route) => {
    uploads++;
    const response = await route.fetch();
    entered.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* The cancelled upload cannot deliver its late response. */
    } finally {
      settled.resolve();
    }
  });
  await page
    .getByRole('button', { name: '上传并预检查', exact: true })
    .evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
  await entered.promise;
  await expect(page.getByLabel('上传 DOCX', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('文体', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('输入英文', { exact: true })).toBeDisabled();
  expect(uploads).toBe(1);
  await page.getByRole('button', { name: '取消预检查', exact: true }).click();
  await expect.poll(() => aborted).toBe(true);
  release.resolve();
  await settled.promise;
  await expect(page.getByRole('heading', { name: 'DOCX 预检查', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('上传 DOCX', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('输入英文', { exact: true })).toHaveValue(textDraft);
});

test('switching tasks aborts pending preflight and does not restore its late preview', async ({
  page,
  request,
}) => {
  const seedResponse = await request.post('/api/tasks', {
    data: { text: 'Synthetic navigation task.', style: 'business', title: '合成导入导航任务' },
  });
  const seed = (await seedResponse.json()) as Task;
  await page.goto('/');
  await selectDocx(page);
  const entered = deferred(),
    release = deferred(),
    settled = deferred();
  let aborted = false;
  page.on('requestfailed', (req) => {
    if (new URL(req.url()).pathname === '/api/docx/preflight') aborted = true;
  });
  await page.route('**/api/docx/preflight', async (route) => {
    const response = await route.fetch();
    entered.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* Navigation disposed this import request. */
    } finally {
      settled.resolve();
    }
  });
  await page.getByRole('button', { name: '上传并预检查', exact: true }).click();
  await entered.promise;
  await page.locator(`a[href="?task=${seed.id}"]`).click();
  await expect(page.getByRole('heading', { name: seed.title, exact: true })).toBeVisible();
  await expect.poll(() => aborted).toBe(true);
  release.resolve();
  await settled.promise;
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DOCX 预检查', exact: true })).toHaveCount(0);
});

test('document translation cancellation keeps export disabled until remaining paragraphs recover', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await preflight(page);
  const id = await createDocumentTask(page, 'slow');
  await expect.poll(async () => (await readTask(request, id)).status).toBe('running');
  for (const button of exports(page)) await expect(button).toBeDisabled();
  await page.getByRole('button', { name: '取消翻译', exact: true }).click();
  const cancelled = await waitStopped(request, id);
  expect(cancelled.status).toBe('cancelled');
  const ids = cancelled.paragraphs.map((p) => p.id);
  await page.reload();
  for (const button of exports(page)) await expect(button).toBeDisabled();
  await chooseScenario(page, 'normal');
  await page.getByRole('button', { name: '继续翻译', exact: true }).click();
  const completed = await waitStopped(request, id);
  expect(completed.status).toBe('completed');
  expect(completed.paragraphs.map((p) => p.id)).toEqual(ids);
  for (const button of exports(page)) await expect(button).toBeEnabled();
});

test('partial document failure can retry without replacing another manually saved paragraph', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await preflight(page);
  const id = await createDocumentTask(page, 'partial');
  const partial = await waitStopped(request, id);
  expect(partial.status).toBe('partial');
  for (const button of exports(page)) await expect(button).toBeDisabled();
  const third = page.getByLabel('译文 3', { exact: true });
  await expect(third).toHaveValue(partial.paragraphs[2].translation);
  await third.fill('文档第三段人工修改必须保留。');
  await page.getByRole('button', { name: '保存修改', exact: true }).nth(2).click();
  await expect.poll(async () => (await readTask(request, id)).paragraphs[2].edited).toBe(true);
  await chooseScenario(page, 'normal');
  await page.getByRole('button', { name: '继续翻译', exact: true }).click();
  const recovered = await waitStopped(request, id);
  expect(recovered.status).toBe('completed');
  expect(recovered.paragraphs[2].translation).toBe('文档第三段人工修改必须保留。');
  expect(recovered.paragraphs.map((p) => p.id)).toEqual(partial.paragraphs.map((p) => p.id));
  for (const button of exports(page)) await expect(button).toBeEnabled();
});

test('mode change during document task creation leaves a draft in the list without auto-translation', async ({
  page,
  request,
}) => {
  let changed = false,
    translateRequests = 0;
  await page.route('**/api/config', async (route) => {
    if (!changed) return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), mode: 'real', ready: false, label: '合成真实服务未配置' },
    });
  });
  await page.goto('/');
  await preflight(page);
  await acknowledge(page);
  const entered = deferred(),
    release = deferred();
  let created!: Task;
  await page.route('**/api/tasks/docx', async (route) => {
    const response = await route.fetch();
    created = (await response.json()) as Task;
    entered.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  page.on('request', (req) => {
    if (
      req.method() === 'POST' &&
      /\/api\/tasks\/[^/]+\/translate$/.test(new URL(req.url()).pathname)
    )
      translateRequests++;
  });
  await page.getByRole('button', { name: '创建文档任务并翻译', exact: true }).click();
  await entered.promise;
  changed = true;
  await expect(page.getByText('真实服务', { exact: true })).toBeVisible();
  release.resolve();
  await expect(page.getByText(/服务模式已变化/).first()).toBeVisible();
  await expect(page).not.toHaveURL(/task=/);
  await expect(page.getByRole('heading', { name: 'DOCX 预检查', exact: true })).toBeVisible();
  await expect(page.locator(`a[href="?task=${created.id}"]`)).toBeVisible();
  expect((await readTask(request, created.id)).status).toBe('draft');
  expect(translateRequests).toBe(0);
});
