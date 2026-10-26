import {
  test,
  expect,
  type APIRequestContext,
  type Download,
  type Locator,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fromBuffer } from 'yauzl';
import { SaxesParser } from 'saxes';
import type {
  TermInput,
  TermLibrary,
  TermRecord,
  TermApplicationPreview,
} from '../shared/professional';
import type { Task } from '../shared/types';
import type { ProviderSettingsSummary } from '../shared/provider-settings';
import { makeDocx, p } from '../server/docx/fixtures';

const createdTermIds = new Set<string>();
let settingsBefore: ProviderSettingsSummary | null = null;
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const APPLY_ACK = '我已检查术语变化，确认仅更新任务快照';
const projectName = () => `合成项目-${randomUUID().slice(0, 16)}`;
const sourceTerm = () =>
  `SyntheticProtocol${randomUUID()
    .replaceAll('-', '')
    .replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)))}`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function inputOf(term: TermRecord): TermInput {
  return {
    layer: term.layer,
    project: term.project,
    source: term.source,
    target: term.target,
    retainSource: term.retainSource,
    note: term.note,
    priority: term.priority,
    enabled: term.enabled,
    caseSensitive: term.caseSensitive,
    alternatives: [...term.alternatives],
  };
}
async function library(request: APIRequestContext): Promise<TermLibrary> {
  const response = await request.get('/api/terminology');
  expect(response.status()).toBe(200);
  return response.json() as Promise<TermLibrary>;
}
async function createTerm(
  request: APIRequestContext,
  project: string,
  source: string,
  target: string,
  changes: Partial<TermInput> = {},
): Promise<TermRecord> {
  const input: TermInput = {
    layer: 'project',
    project,
    source,
    target,
    retainSource: false,
    note: '合成浏览器测试词条，非行业标准。',
    priority: 50,
    enabled: true,
    caseSensitive: false,
    alternatives: [],
    ...changes,
  };
  const response = await request.post('/api/terminology', { data: input });
  expect(response.status()).toBe(201);
  const term = (await response.json()) as TermRecord;
  createdTermIds.add(term.id);
  return term;
}
async function updateTerm(
  request: APIRequestContext,
  term: TermRecord,
  changes: Partial<TermInput>,
): Promise<TermRecord> {
  const response = await request.patch(`/api/terminology/${term.id}`, {
    data: { ...inputOf(term), ...changes, expectedRevision: term.revision },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<TermRecord>;
}
test.afterEach(async ({ request }) => {
  // Unique project scopes and sources isolate fixtures. Disable our records after each case.
  const current = await library(request);
  for (const term of current.entries)
    if (createdTermIds.has(term.id) && term.enabled)
      await updateTerm(request, term, { enabled: false });
  createdTermIds.clear();
  if (settingsBefore) {
    const currentSettings = (await (
      await request.get('/api/provider-settings')
    ).json()) as ProviderSettingsSummary;
    const restored = await request.put('/api/provider-settings', {
      data: { ...settingsFields(settingsBefore), expectedRevision: currentSettings.revision },
    });
    expect(restored.status()).toBe(200);
    settingsBefore = null;
  }
});
function settingsFields(value: ProviderSettingsSummary) {
  return {
    mode: value.mode,
    protocol: value.protocol,
    baseUrl: value.baseUrl,
    model: value.model,
    credentialRef: value.credentialRef,
  };
}
async function offlineSettings(page: Page): Promise<Locator> {
  const panel = page.locator('.provider-settings');
  await openDetails(panel);
  await expect(panel.getByRole('button', { name: '保存离线设置', exact: true })).toBeEnabled();
  return panel;
}
async function readTask(request: APIRequestContext, id: string): Promise<Task> {
  const response = await request.get(`/api/tasks/${id}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Task>;
}
async function waitCompleted(request: APIRequestContext, id: string): Promise<Task> {
  await expect
    .poll(async () => (await readTask(request, id)).status, { timeout: 12000 })
    .toBe('completed');
  return readTask(request, id);
}
async function seedTask(
  request: APIRequestContext,
  project: string,
  text = 'A synthetic robotics platform.',
  context = '合成浏览器测试背景。',
  translate = true,
): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: {
      text,
      style: 'business',
      project,
      context,
      title: `合成专业审校-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(response.status()).toBe(201);
  const task = (await response.json()) as Task;
  if (!translate) return task;
  const started = await request.post(`/api/tasks/${task.id}/translate`, {
    data: { scenario: 'normal' },
  });
  expect(started.status()).toBe(202);
  return waitCompleted(request, task.id);
}
async function editViaApi(
  request: APIRequestContext,
  task: Task,
  index: number,
  translation: string,
): Promise<Task> {
  const paragraph = task.paragraphs[index];
  const response = await request.patch(`/api/tasks/${task.id}/paragraphs/${paragraph.id}`, {
    data: { translation, expectedRevision: paragraph.revision },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<Task>;
}
function paragraph(page: Page, index = 1): Locator {
  return page.getByRole('region', { name: `段落 ${index}`, exact: true });
}
async function openDetails(details: Locator) {
  if ((await details.getAttribute('open')) === null)
    await details.locator(':scope > summary').click();
}
async function professional(page: Page): Promise<Locator> {
  const panel = page.locator('.task-professional');
  await openDetails(panel);
  return panel;
}
async function review(page: Page, index = 1): Promise<Locator> {
  const panel = paragraph(page, index).locator('.paragraph-review');
  await openDetails(panel);
  return panel;
}
async function editViaUi(
  page: Page,
  request: APIRequestContext,
  task: Task,
  index: number,
  translation: string,
): Promise<Task> {
  const input = page.getByLabel(`译文 ${index + 1}`, { exact: true });
  await expect(input).toHaveValue(task.paragraphs[index].translation);
  await input.fill(translation);
  await paragraph(page, index + 1)
    .getByRole('button', { name: '保存修改', exact: true })
    .click();
  await expect
    .poll(async () => (await readTask(request, task.id)).paragraphs[index].translation)
    .toBe(translation);
  const saved = await readTask(request, task.id);
  await expect(
    paragraph(page, index + 1).getByRole('button', { name: '保存修改', exact: true }),
  ).toBeDisabled();
  return saved;
}
async function preview(page: Page): Promise<TermApplicationPreview> {
  const panel = await professional(page);
  const response = page.waitForResponse((item) =>
    /\/api\/tasks\/[^/]+\/terminology-preview$/.test(new URL(item.url()).pathname),
  );
  await panel.getByRole('button', { name: '预览重新应用术语', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  await expect(panel.getByRole('region', { name: '术语重新应用预览', exact: true })).toBeVisible();
  return result.json() as Promise<TermApplicationPreview>;
}
async function confirmPreview(page: Page) {
  const panel = await professional(page);
  await expect(panel.getByRole('button', { name: '确认应用术语快照', exact: true })).toBeDisabled();
  await panel.getByLabel(APPLY_ACK, { exact: true }).check();
  await panel.getByRole('button', { name: '确认应用术语快照', exact: true }).click();
}
const editableState = (task: Task) =>
  task.paragraphs.map(({ id, translation, revision, edited, status }) => ({
    id,
    translation,
    revision,
    edited,
    status,
  }));

async function docxText(download: Download, outputPath?: string): Promise<string> {
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  if (outputPath) await download.saveAs(outputPath);
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Synthetic DOCX download has no stream');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const xml = await new Promise<string>((resolve, reject) => {
    fromBuffer(Buffer.concat(chunks), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Downloaded DOCX is not ZIP'));
        return;
      }
      zip.on('error', reject);
      let found = false;
      zip.on('end', () => {
        if (!found) reject(new Error('Downloaded DOCX lacks document.xml'));
      });
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'word/document.xml') {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (readError, source) => {
          if (readError || !source) {
            reject(readError ?? new Error('No XML stream'));
            zip.close();
            return;
          }
          const parts: Buffer[] = [];
          source.on('data', (chunk: Buffer) => parts.push(chunk));
          source.on('error', reject);
          source.on('end', () => {
            resolve(Buffer.concat(parts).toString('utf8'));
            zip.close();
          });
        });
      });
      zip.readEntry();
    });
  });
  let text = '';
  const parser = new SaxesParser({ xmlns: true });
  let inText = false;
  parser.on('opentag', (tag) => {
    if (tag.uri.endsWith('/wordprocessingml/2006/main') && tag.local === 't') inText = true;
  });
  parser.on('text', (value) => {
    if (inText) text += value;
  });
  parser.on('closetag', (tag) => {
    if (tag.uri.endsWith('/wordprocessingml/2006/main')) {
      if (tag.local === 't') inText = false;
      if (tag.local === 'p') text += '\n';
    }
  });
  parser.write(xml).close();
  return text;
}

test('terminology manager adds, edits, retains English and disables a project-scoped term', async ({
  page,
  request,
}) => {
  const project = projectName(),
    source = sourceTerm();
  await page.goto('/');
  const manager = page.locator('.terminology-manager');
  await openDetails(manager);
  await expect(manager.getByText(/示例.*不代表/)).toBeVisible();
  await manager.getByRole('button', { name: '新增术语', exact: true }).click();
  await manager.getByLabel('术语层级', { exact: true }).selectOption('project');
  await manager.getByLabel('适用项目', { exact: true }).fill(project);
  await manager.getByLabel('英文术语', { exact: true }).fill(source);
  await manager.getByLabel('中文译法', { exact: true }).fill('合成首选译法');
  await manager.getByLabel('术语备注', { exact: true }).fill('仅用于此合成项目的浏览器验证。');
  await manager.getByLabel('术语优先级', { exact: true }).fill('70');
  await manager.getByLabel('区分大小写', { exact: true }).check();
  await manager
    .getByLabel('可接受译法（每行一个）', { exact: true })
    .fill('合成备选甲\n合成备选乙');
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/terminology' &&
      response.request().method() === 'POST',
  );
  await manager.getByRole('button', { name: '保存术语', exact: true }).click();
  const created = (await (await createdResponse).json()) as TermRecord;
  createdTermIds.add(created.id);
  expect(created).toMatchObject({
    project,
    source,
    target: '合成首选译法',
    enabled: true,
    caseSensitive: true,
    priority: 70,
    alternatives: ['合成备选甲', '合成备选乙'],
  });
  const row = manager
    .getByRole('table', { name: '术语库', exact: true })
    .getByRole('row')
    .filter({ hasText: source });
  await expect(row).toContainText('启用');
  await manager.getByRole('button', { name: `编辑术语 ${source}`, exact: true }).click();
  await manager.getByLabel('中文译法', { exact: true }).fill('合成修订译法');
  await manager.getByRole('button', { name: '保存术语', exact: true }).click();
  await expect
    .poll(
      async () => (await library(request)).entries.find((term) => term.id === created.id)?.target,
    )
    .toBe('合成修订译法');
  await expect(row).toContainText('合成修订译法');
  await manager.getByRole('button', { name: `编辑术语 ${source}`, exact: true }).click();
  await manager.getByLabel('保留英文原文', { exact: true }).check();
  await expect(manager.getByLabel('中文译法', { exact: true })).toHaveValue('');
  await manager.getByRole('button', { name: '保存术语', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await library(request)).entries.find((term) => term.id === created.id)?.retainSource,
    )
    .toBe(true);
  await manager.getByRole('button', { name: `编辑术语 ${source}`, exact: true }).click();
  await manager.getByLabel('启用此术语', { exact: true }).uncheck();
  await manager.getByRole('button', { name: '保存术语', exact: true }).click();
  await expect
    .poll(
      async () => (await library(request)).entries.find((term) => term.id === created.id)?.enabled,
    )
    .toBe(false);
  await page.reload();
  await openDetails(manager);
  await expect(row).toContainText('停用');
  await expect(row).toContainText('保留英文原文');
  expect(
    (await library(request)).entries
      .filter((term) => term.id.startsWith('example-'))
      .every((term) => !term.enabled),
  ).toBe(true);
});

test('manual numeric review shows exact source and translation locations and confirmation invalidates after editing', async ({
  page,
  request,
}, testInfo) => {
  const project = projectName(),
    context = `SYNTHETIC_BACKGROUND_${randomUUID()}`;
  const source =
    'The count was 12. Revenue was USD 12 million on 2026-10-26. Ownership was 10%, and the ratio was 2:1.';
  await page.goto('/');
  await page.getByLabel('输入英文', { exact: true }).fill(source);
  await page.getByLabel('项目名称', { exact: true }).fill(project);
  await page.getByLabel('翻译背景', { exact: true }).fill(context);
  await page.getByRole('button', { name: '创建并翻译', exact: true }).click();
  await expect(page).toHaveURL(/task=/);
  const id = new URL(page.url()).searchParams.get('task')!;
  const initial = await waitCompleted(request, id);
  expect(initial.professional?.snapshot).toMatchObject({ project, context });
  expect(initial.professional!.review.findings.map((finding) => finding.code)).toEqual([
    'MOCK_OUTPUT',
  ]);
  const panel = await review(page);
  await expect(panel.getByText(/模拟占位标记/)).toBeVisible();
  const wrong = '数量为13。收入为1300万元人民币，日期为2026年10月27日。持股为11%，比率为3:1。';
  const saved = await editViaUi(page, request, initial, 0, wrong);
  const codes = saved.professional!.review.findings.map((finding) => finding.code);
  for (const code of ['NUMBER_MISMATCH', 'CURRENCY_MISMATCH', 'DATE_MISMATCH', 'RATIO_MISMATCH']) {
    expect(codes).toContain(code);
    const finding = saved.professional!.review.findings.find(
      (item) => item.code === code && item.source && item.translation,
    )!;
    expect(finding).toBeDefined();
    expect(source.slice(finding.source!.start, finding.source!.end)).toBe(finding.source!.text);
    expect(wrong.slice(finding.translation!.start, finding.translation!.end)).toBe(
      finding.translation!.text,
    );
    const item = panel.locator('.professional-finding').filter({ hasText: finding.reason });
    await expect(
      item.getByText(`原文位置 [${finding.source!.start}, ${finding.source!.end})：`, {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      item.getByText(`译文位置 [${finding.translation!.start}, ${finding.translation!.end})：`, {
        exact: false,
      }),
    ).toBeVisible();
  }
  await paragraph(page).screenshot({
    path: testInfo.outputPath('synthetic-saved-numeric-review.png'),
  });
  await panel.getByRole('button', { name: '人工确认已复核此段', exact: true }).click();
  await expect
    .poll(async () => (await readTask(request, id)).professional!.review.approvals.length)
    .toBe(1);
  await page.reload();
  const reopened = await review(page);
  await expect(
    reopened.getByRole('button', { name: '撤销本段人工确认', exact: true }),
  ).toBeVisible();
  await reopened.getByRole('button', { name: '撤销本段人工确认', exact: true }).click();
  await expect
    .poll(async () => (await readTask(request, id)).professional!.review.approvals.length)
    .toBe(0);
  await reopened.getByRole('button', { name: '人工确认已复核此段', exact: true }).click();
  await expect
    .poll(async () => (await readTask(request, id)).professional!.review.approvals.length)
    .toBe(1);
  await expect(
    reopened.getByRole('button', { name: '撤销本段人工确认', exact: true }),
  ).toBeEnabled();
  const corrected = '数量为12。收入为1200万美元，日期为2026年10月26日。持股为10%，比率为2:1。';
  await page.getByLabel('译文 1', { exact: true }).fill(corrected);
  await expect(
    reopened.getByRole('button', { name: '撤销本段人工确认', exact: true }),
  ).toBeDisabled();
  await paragraph(page).getByRole('button', { name: '保存修改', exact: true }).click();
  await expect
    .poll(async () => (await readTask(request, id)).paragraphs[0].translation)
    .toBe(corrected);
  const latest = await readTask(request, id);
  expect(latest.professional!.review.approvals).toEqual([]);
  expect(latest.professional!.review.events.some((event) => event.type === 'invalidated')).toBe(
    true,
  );
  await expect(reopened.getByText(/之前的人工确认已失效/)).toBeVisible();
  await page.reload();
  await expect(
    (await review(page)).getByRole('button', { name: '人工确认已复核此段', exact: true }),
  ).toBeEnabled();
});

test('project scope overrides higher-priority global candidates without silently rewriting saved translation', async ({
  page,
  request,
}) => {
  const project = projectName(),
    source = sourceTerm();
  const fund = await createTerm(request, '', source, '基金候选译法', {
    layer: 'fund',
    priority: 100,
  });
  const technical = await createTerm(request, '', source, '技术候选译法', {
    layer: 'technical',
    priority: 99,
  });
  const local = await createTerm(request, project, source, '项目候选译法', { priority: 1 });
  let task = await seedTask(request, project, `The ${source} platform is synthetic.`);
  await page.goto(`/?task=${task.id}`);
  task = await editViaUi(page, request, task, 0, '基金候选译法平台已经就绪。');
  const findings = task.professional!.review.findings.filter(
    (finding) => finding.code === 'TERM_MISMATCH',
  );
  expect(findings.map((finding) => finding.termId)).toEqual([local.id]);
  expect(findings.some((finding) => [fund.id, technical.id].includes(finding.termId!))).toBe(false);
  await expect((await review(page)).getByText(/项目候选译法/)).toBeVisible();
  task = await editViaUi(page, request, task, 0, '项目候选译法平台已经就绪。');
  expect(
    task.professional!.review.findings.filter((finding) => finding.code === 'TERM_MISMATCH'),
  ).toEqual([]);
});

test('equal-priority conflicting project choices are visible and prevent automatic translation', async ({
  page,
  request,
}) => {
  const project = projectName(),
    source = sourceTerm();
  await createTerm(request, project, source, '合成甲译法');
  await createTerm(request, project, source, '合成乙译法');
  const task = await seedTask(
    request,
    project,
    `The ${source} platform is synthetic.`,
    '同优先级冲突合成背景。',
    false,
  );
  await page.goto(`/?task=${task.id}`);
  const result = await preview(page);
  expect(result.conflicts).toHaveLength(1);
  const panel = page.getByRole('region', { name: '术语重新应用预览', exact: true });
  await expect(panel.getByRole('heading', { name: /需人工处理的术语冲突/ })).toBeVisible();
  await expect(panel.getByText(/合成甲译法/)).toBeVisible();
  await expect(panel.getByText(/合成乙译法/)).toBeVisible();
  await expect(panel.getByText(/原文位置 \[/)).toBeVisible();
  await page.getByRole('button', { name: '继续翻译', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '术语冲突' })).toBeVisible();
  expect((await readTask(request, task.id)).paragraphs[0].translation).toBe('');
});

test('library changes leave historical tasks immutable and a confirmed snapshot reapply preserves every manual edit', async ({
  page,
  request,
}, testInfo) => {
  const project = projectName(),
    source = sourceTerm();
  let term = await createTerm(request, project, source, '旧合成译法');
  let task = await seedTask(
    request,
    project,
    `The ${source} robotics platform.\n\nA second synthetic paragraph.`,
    'OLD_SYNTHETIC_CONTEXT',
  );
  task = await editViaApi(request, task, 0, '旧合成译法平台的人工校订。');
  task = await editViaApi(request, task, 1, '第二段人工内容不能被术语应用覆盖。');
  await page.goto(`/?task=${task.id}`);
  await (
    await review(page)
  )
    .getByRole('button', { name: '人工确认已复核此段', exact: true })
    .click();
  await expect
    .poll(async () => (await readTask(request, task.id)).professional!.review.approvals.length)
    .toBe(1);
  const before = await readTask(request, task.id);
  term = await updateTerm(request, term, {
    target: '新合成译法',
    note: '新合成备注，必须经明确应用才影响任务快照。',
  });
  expect((await readTask(request, task.id)).professional).toEqual(before.professional);
  expect(editableState(await readTask(request, task.id))).toEqual(editableState(before));
  const panel = await professional(page);
  await panel.getByLabel('当前任务背景', { exact: true }).fill('NEW_SYNTHETIC_CONTEXT');
  const result = await preview(page);
  expect(result.changedSources).toContain(source);
  expect(result.preservedEditedParagraphs).toBe(2);
  const change = panel.getByRole('region', { name: '术语重新应用预览', exact: true });
  await expect(change.getByText(/将保留 2 段人工修改/)).toBeVisible();
  await expect(change.getByText(/旧合成译法/)).toBeVisible();
  await expect(change.getByText(/新合成译法/)).toBeVisible();
  await expect(
    change.getByRole('button', { name: '确认应用术语快照', exact: true }),
  ).toBeDisabled();
  expect((await readTask(request, task.id)).professional!.snapshot.id).toBe(
    before.professional!.snapshot.id,
  );
  await change.screenshot({
    path: testInfo.outputPath('synthetic-terminology-reapply-preview.png'),
  });
  const committed = deferred(),
    release = deferred(),
    settled = deferred();
  let applies = 0;
  await page.route(`**/api/tasks/${task.id}/terminology-apply`, async (route) => {
    applies++;
    const response = await route.fetch();
    committed.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* A task poll may already deliver this committed snapshot. */
    } finally {
      settled.resolve();
    }
  });
  await change.getByLabel(APPLY_ACK, { exact: true }).check();
  await change
    .getByRole('button', { name: '确认应用术语快照', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await committed.promise;
  expect(applies).toBe(1);
  release.resolve();
  await settled.promise;
  await expect
    .poll(async () => (await readTask(request, task.id)).professional!.snapshot.id)
    .not.toBe(before.professional!.snapshot.id);
  const applied = await readTask(request, task.id);
  expect(editableState(applied)).toEqual(editableState(before));
  expect(applied.professional!.snapshot).toMatchObject({
    project,
    context: 'NEW_SYNTHETIC_CONTEXT',
  });
  expect(applied.professional!.snapshot.entries.find((entry) => entry.id === term.id)?.target).toBe(
    '新合成译法',
  );
  expect(applied.professional!.snapshotHistory).toEqual([before.professional!.snapshot]);
  expect(applied.professional!.review.approvals).toEqual([]);
  const repeated = await request.post(`/api/tasks/${task.id}/terminology-apply`, {
    data: { token: result.token, confirm: true },
  });
  expect(repeated.status()).toBe(409);
  expect((await repeated.json()).code).toBe('PREVIEW_INVALID');
  await page.reload();
  await expect(page.getByLabel('译文 1', { exact: true })).toHaveValue(
    before.paragraphs[0].translation,
  );
  await expect(page.getByLabel('译文 2', { exact: true })).toHaveValue(
    before.paragraphs[1].translation,
  );
  await expect((await professional(page)).getByLabel('当前任务背景', { exact: true })).toHaveValue(
    'NEW_SYNTHETIC_CONTEXT',
  );
});

test('saving a paragraph makes an existing preview stale and prevents its application', async ({
  page,
  request,
}) => {
  const task = await seedTask(request, projectName());
  await page.goto(`/?task=${task.id}`);
  const result = await preview(page);
  await editViaUi(page, request, task, 0, '预览之后保存的人工草稿。');
  const panel = await professional(page);
  await expect(panel.getByRole('alert').filter({ hasText: '预览已失效' })).toBeVisible();
  await expect(panel.getByLabel(APPLY_ACK, { exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '确认应用术语快照', exact: true })).toBeDisabled();
  const response = await request.post(`/api/tasks/${task.id}/terminology-apply`, {
    data: { token: result.token, confirm: true },
  });
  expect(response.status()).toBe(409);
  expect((await response.json()).code).toBe('TASK_REVISION_CONFLICT');
  expect((await readTask(request, task.id)).paragraphs[0].translation).toBe(
    '预览之后保存的人工草稿。',
  );
});

test('a library revision changed after preview is rejected visibly and a fresh preview can recover', async ({
  page,
  request,
}) => {
  const project = projectName(),
    source = sourceTerm();
  let term = await createTerm(request, project, source, '最初合成译法');
  const task = await seedTask(request, project, `The ${source} platform.`);
  await page.goto(`/?task=${task.id}`);
  await preview(page);
  term = await updateTerm(request, term, { target: '最新合成译法' });
  await confirmPreview(page);
  const panel = await professional(page);
  await expect(panel.getByRole('alert').filter({ hasText: '术语库已变化' })).toBeVisible();
  expect((await readTask(request, task.id)).professional!.snapshot.id).toBe(
    task.professional!.snapshot.id,
  );
  const next = await preview(page);
  expect(next.snapshot.entries.find((entry) => entry.id === term.id)?.target).toBe('最新合成译法');
  await confirmPreview(page);
  await expect
    .poll(async () => (await readTask(request, task.id)).professional!.snapshot.id)
    .toBe(next.snapshot.id);
});

test('preview and apply failures retain task state and allow explicit retries', async ({
  page,
  request,
}) => {
  const task = await seedTask(request, projectName());
  await page.goto(`/?task=${task.id}`);
  let previews = 0,
    applies = 0;
  await page.route(`**/api/tasks/${task.id}/terminology-preview`, async (route) => {
    previews++;
    if (previews === 1)
      return route.fulfill({ status: 503, json: { error: '合成术语预览暂时失败。' } });
    await route.continue();
  });
  const panel = await professional(page);
  await panel.getByRole('button', { name: '预览重新应用术语', exact: true }).click();
  await expect(
    panel.getByRole('alert').filter({ hasText: '合成术语预览暂时失败。' }),
  ).toBeVisible();
  const result = await preview(page);
  expect(previews).toBe(2);
  await page.route(`**/api/tasks/${task.id}/terminology-apply`, async (route) => {
    applies++;
    if (applies === 1)
      return route.fulfill({ status: 503, json: { error: '合成术语应用暂时失败。' } });
    await route.continue();
  });
  await confirmPreview(page);
  await expect(
    panel.getByRole('alert').filter({ hasText: '合成术语应用暂时失败。' }),
  ).toBeVisible();
  expect((await readTask(request, task.id)).professional!.snapshot.id).toBe(
    task.professional!.snapshot.id,
  );
  await panel.getByRole('button', { name: '确认应用术语快照', exact: true }).click();
  await expect
    .poll(async () => (await readTask(request, task.id)).professional!.snapshot.id)
    .toBe(result.snapshot.id);
  expect(applies).toBe(2);
  expect(editableState(await readTask(request, task.id))).toEqual(editableState(task));
});

test('repeated preview clicks send one request and cancellation releases the form without reviving a late result', async ({
  page,
  request,
}) => {
  const task = await seedTask(request, projectName());
  await page.goto(`/?task=${task.id}`);
  let requests = 0,
    aborted = false;
  const entered = deferred(),
    release = deferred(),
    settled = deferred();
  page.on('requestfailed', (req) => {
    if (new URL(req.url()).pathname === `/api/tasks/${task.id}/terminology-preview`) aborted = true;
  });
  await page.route(`**/api/tasks/${task.id}/terminology-preview`, async (route) => {
    requests++;
    if (requests > 1) return route.continue();
    const response = await route.fetch();
    entered.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* Explicit cancellation discarded this preview. */
    } finally {
      settled.resolve();
    }
  });
  const panel = await professional(page);
  await panel
    .getByRole('button', { name: '预览重新应用术语', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await entered.promise;
  await expect(panel.getByLabel('当前任务项目', { exact: true })).toBeDisabled();
  expect(requests).toBe(1);
  await panel.getByRole('button', { name: '取消预览请求', exact: true }).click();
  await expect.poll(() => aborted).toBe(true);
  await expect(panel.getByLabel('当前任务项目', { exact: true })).toBeEnabled();
  release.resolve();
  await settled.promise;
  await expect(panel.getByRole('region', { name: '术语重新应用预览', exact: true })).toHaveCount(0);
  await preview(page);
  expect(requests).toBe(2);
});

for (const late of ['success', 'failure'] as const) {
  test(`switching tasks discards a pending terminology preview and its late ${late}`, async ({
    page,
    request,
  }) => {
    const first = await seedTask(request, projectName());
    const second = await seedTask(
      request,
      projectName(),
      'A second synthetic task.',
      'SECOND_SYNTHETIC_CONTEXT',
    );
    await page.goto(`/?task=${first.id}`);
    const entered = deferred(),
      release = deferred(),
      settled = deferred();
    let aborted = false;
    page.on('requestfailed', (req) => {
      if (new URL(req.url()).pathname === `/api/tasks/${first.id}/terminology-preview`)
        aborted = true;
    });
    await page.route(`**/api/tasks/${first.id}/terminology-preview`, async (route) => {
      const response = await route.fetch();
      entered.resolve();
      await release.promise;
      try {
        await route.fulfill(
          late === 'success'
            ? { response }
            : { status: 503, json: { error: '合成旧任务预览错误，不应出现在新任务。' } },
        );
      } catch {
        /* Switching tasks aborted the old component request. */
      } finally {
        settled.resolve();
      }
    });
    await (
      await professional(page)
    )
      .getByRole('button', { name: '预览重新应用术语', exact: true })
      .click();
    await entered.promise;
    await page.locator(`a[href="?task=${second.id}"]`).click();
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();
    await expect.poll(() => aborted).toBe(true);
    release.resolve();
    await settled.promise;
    const panel = await professional(page);
    await expect(panel.getByLabel('当前任务项目', { exact: true })).toHaveValue(
      second.professional!.snapshot.project,
    );
    await expect(panel.getByLabel('当前任务背景', { exact: true })).toHaveValue(
      'SECOND_SYNTHETIC_CONTEXT',
    );
    await expect(panel.getByRole('region', { name: '术语重新应用预览', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('alert').filter({ hasText: '合成旧任务预览错误' })).toHaveCount(0);
    expect((await readTask(request, first.id)).professional!.snapshot.id).toBe(
      first.professional!.snapshot.id,
    );
  });
}

test('DOCX project context and table findings persist while downloads contain only the latest saved translation', async ({
  page,
  request,
}, testInfo) => {
  const project = projectName(),
    source = sourceTerm();
  await createTerm(request, project, source, '项目收入');
  const context = `SYNTHETIC_CONTEXT_DO_NOT_EXPORT_${randomUUID()}`;
  const original = `${source} revenue was USD 12 million on 2026-10-26.`;
  const bytes = makeDocx(
    `<w:tbl><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc>${p(original)}</w:tc></w:tr></w:tbl>`,
  );
  await page.goto('/');
  await page.getByLabel('项目名称', { exact: true }).fill(project);
  await page.getByLabel('翻译背景', { exact: true }).fill(context);
  await page
    .getByLabel('上传 DOCX', { exact: true })
    .setInputFiles({ name: 'synthetic-professional.docx', mimeType: MIME, buffer: bytes });
  await page.getByRole('button', { name: '上传并预检查', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DOCX 预检查', exact: true })).toBeVisible();
  const warning = page.getByLabel('我已了解基础排版会变化，继续使用可编辑文档', { exact: true });
  if (await warning.count()) await warning.check();
  await page.getByRole('button', { name: '创建文档任务并翻译', exact: true }).click();
  await expect(page).toHaveURL(/task=/);
  const id = new URL(page.url()).searchParams.get('task')!;
  let task = await waitCompleted(request, id);
  expect(task.professional!.snapshot).toMatchObject({ project, context });
  const old = '项目收入为1300万元人民币，日期为2026年10月27日。';
  task = await editViaUi(page, request, task, 0, old);
  const findings = task.professional!.review.findings;
  expect(findings.map((finding) => finding.code)).toEqual(
    expect.arrayContaining(['CURRENCY_MISMATCH', 'DATE_MISMATCH']),
  );
  expect(task.paragraphs[0].location).toMatch(/表格/);
  for (const finding of findings)
    expect(finding.paragraphLocation).toBe(task.paragraphs[0].location);
  const panel = await review(page);
  await expect(panel.getByText(/原文位置 \[/).first()).toBeVisible();
  await expect(panel.getByText(/译文位置 \[/).first()).toBeVisible();
  await panel.getByRole('button', { name: '人工确认已复核此段', exact: true }).click();
  await expect
    .poll(async () => (await readTask(request, id)).professional!.review.approvals.length)
    .toBe(1);
  const latestText = '项目收入为1200万美元，日期为2026年10月26日；人工校订 & <核对>。';
  task = await editViaUi(page, request, await readTask(request, id), 0, latestText);
  expect(task.professional!.review.approvals).toEqual([]);
  const nextContext = `NEW_BACKGROUND_DO_NOT_EXPORT_${randomUUID()}`;
  const snapshot = await professional(page);
  await snapshot.getByLabel('当前任务背景', { exact: true }).fill(nextContext);
  const result = await preview(page);
  await confirmPreview(page);
  await expect
    .poll(async () => (await readTask(request, id)).professional!.snapshot.id)
    .toBe(result.snapshot.id);
  await page.reload();
  await expect(page.getByLabel('译文 1', { exact: true })).toHaveValue(latestText);
  const reopened = await professional(page);
  await expect(reopened.getByLabel('当前任务背景', { exact: true })).toHaveValue(nextContext);
  await expect(reopened.getByText(/当前没有启用独立的辅助解释服务/)).toBeVisible();
  for (const mode of ['中文', '双语'] as const) {
    const event = page.waitForEvent('download');
    await page.getByRole('button', { name: `导出${mode} DOCX`, exact: true }).click();
    const text = await docxText(
      await event,
      testInfo.outputPath(`synthetic-professional-${mode}.docx`),
    );
    expect(text).toContain(latestText);
    expect(text).not.toContain(old);
    expect(text).not.toContain(context);
    expect(text).not.toContain(nextContext);
    expect(text).not.toContain(project);
    expect(text).not.toContain('辅助解释');
    for (const finding of findings) expect(text).not.toContain(finding.reason);
    if (mode === '双语') expect(text).toContain(original);
  }
});

test('offline provider settings persist only nonsecret fields and never enable or contact a provider', async ({
  page,
  request,
}, testInfo) => {
  settingsBefore = (await (
    await request.get('/api/provider-settings')
  ).json()) as ProviderSettingsSummary;
  const reference = `IR_TRANSLATION_BROWSER_${randomUUID().replaceAll('-', '').toUpperCase()}_KEY`;
  const model = `synthetic-model-${randomUUID().slice(0, 8)}`;
  let providerRequests = 0,
    saves = 0;
  let submitted: Record<string, unknown> | null = null;
  await page.route('https://api.example.com/**', async (route) => {
    providerRequests++;
    await route.abort('blockedbyclient');
  });
  const committed = deferred(),
    release = deferred();
  await page.route('**/api/provider-settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    saves++;
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    const response = await route.fetch();
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto('/');
  let panel = await offlineSettings(page);
  await panel.getByLabel('服务设置模式', { exact: true }).selectOption('custom');
  await panel.getByLabel('服务协议', { exact: true }).selectOption('openai-compatible');
  await expect(
    panel.getByLabel('服务协议', { exact: true }).locator('option[value=other]'),
  ).toHaveJSProperty('disabled', true);
  await panel.getByLabel('服务基础地址', { exact: true }).fill('https://api.example.com/v1');
  await panel.getByLabel('模型标识', { exact: true }).fill(model);
  await panel.getByLabel('服务端凭据变量引用', { exact: true }).fill(reference);
  await expect(panel.locator('input[type=password]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /测试连接|连接测试/ })).toHaveCount(0);
  await panel
    .getByRole('button', { name: '保存离线设置', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await committed.promise;
  await expect(panel.getByLabel('服务基础地址', { exact: true })).toBeDisabled();
  await expect(panel.getByLabel('模型标识', { exact: true })).toBeDisabled();
  expect(saves).toBe(1);
  expect(Object.keys(submitted!).sort()).toEqual(
    ['mode', 'protocol', 'baseUrl', 'model', 'credentialRef', 'expectedRevision'].sort(),
  );
  release.resolve();
  await expect(panel.getByText('尚未完整配置', { exact: true })).toBeVisible();
  await expect(panel.getByText('服务端凭据变量未设置', { exact: true })).toBeVisible();
  await expect(panel.getByText(/设置已保存，尚未验证/)).toBeVisible();
  const summary = (await (
    await request.get('/api/provider-settings')
  ).json()) as ProviderSettingsSummary;
  expect(summary).toMatchObject({
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model,
    credentialRef: reference,
    credentialStatus: 'absent',
    state: 'unconfigured',
    realCallsEnabled: false,
    connectionTestAvailable: false,
    urlValidation: 'syntax-only-no-dns',
  });
  expect(summary).not.toHaveProperty('apiKey');
  expect((await (await request.get('/api/config')).json()).mode).toBe('mock');
  await page.reload();
  panel = await offlineSettings(page);
  await expect(panel.getByLabel('服务基础地址', { exact: true })).toHaveValue(
    'https://api.example.com/v1',
  );
  await expect(panel.getByLabel('模型标识', { exact: true })).toHaveValue(model);
  await expect(panel.getByLabel('服务端凭据变量引用', { exact: true })).toHaveValue(reference);
  await expect(panel.getByText('尚未完整配置', { exact: true })).toBeVisible();
  expect(providerRequests).toBe(0);
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  expect(Object.keys(storage.local).some((key) => /secret|api.?key|credential/i.test(key))).toBe(
    false,
  );
  expect(Object.keys(storage.session).some((key) => /secret|api.?key|credential/i.test(key))).toBe(
    false,
  );
  expect(JSON.stringify(storage)).not.toContain(reference);
  await panel.screenshot({ path: testInfo.outputPath('synthetic-offline-provider-settings.png') });
});

test('a stale offline settings save cannot overwrite a newer record and reload allows a safe retry', async ({
  page,
  request,
}) => {
  settingsBefore = (await (
    await request.get('/api/provider-settings')
  ).json()) as ProviderSettingsSummary;
  await page.goto('/');
  const panel = await offlineSettings(page);
  await panel.getByLabel('服务设置模式', { exact: true }).selectOption('custom');
  await panel.getByLabel('服务基础地址', { exact: true }).fill('https://api.example.com/v1');
  await panel.getByLabel('模型标识', { exact: true }).fill('synthetic-unsaved-local-model');
  await panel
    .getByLabel('服务端凭据变量引用', { exact: true })
    .fill('IR_TRANSLATION_BROWSER_TEST_KEY');
  const newer = await request.put('/api/provider-settings', {
    data: {
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'synthetic-newer-server-model',
      credentialRef: 'IR_TRANSLATION_BROWSER_TEST_KEY',
      expectedRevision: settingsBefore.revision,
    },
  });
  expect(newer.status()).toBe(200);
  await panel.getByRole('button', { name: '保存离线设置', exact: true }).click();
  await expect(panel.getByRole('alert').filter({ hasText: '设置已更新或版本无效' })).toBeVisible();
  expect((await (await request.get('/api/provider-settings')).json()).model).toBe(
    'synthetic-newer-server-model',
  );
  await expect(panel.getByLabel('模型标识', { exact: true })).toHaveValue(
    'synthetic-unsaved-local-model',
  );
  let discardAcknowledged = false;
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('未保存');
    expect(dialog.message()).toContain('放弃');
    discardAcknowledged = true;
    await dialog.accept();
  });
  await panel.getByRole('button', { name: '重新加载设置', exact: true }).click();
  expect(discardAcknowledged).toBe(true);
  await expect(panel.getByLabel('模型标识', { exact: true })).toHaveValue(
    'synthetic-newer-server-model',
  );
  await panel.getByLabel('模型标识', { exact: true }).fill('synthetic-retried-browser-model');
  await panel.getByRole('button', { name: '保存离线设置', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/provider-settings')).json()).model)
    .toBe('synthetic-retried-browser-model');
  expect((await (await request.get('/api/config')).json()).mode).toBe('mock');
});

test('collapsing and reopening offline settings preserves an unsaved draft without rereading the server', async ({
  page,
  request,
}) => {
  settingsBefore = (await (
    await request.get('/api/provider-settings')
  ).json()) as ProviderSettingsSummary;
  let reads = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/provider-settings') reads++;
  });
  await page.goto('/');
  const panel = await offlineSettings(page);
  await panel.getByLabel('服务设置模式', { exact: true }).selectOption('custom');
  await panel.getByLabel('服务基础地址', { exact: true }).fill('https://api.example.com/v1/draft');
  await panel.getByLabel('模型标识', { exact: true }).fill('synthetic-unsaved-toggle-model');
  await panel
    .getByLabel('服务端凭据变量引用', { exact: true })
    .fill('IR_TRANSLATION_BROWSER_TEST_KEY');
  for (let cycle = 0; cycle < 2; cycle++) {
    await panel.locator(':scope > summary').click();
    await expect(panel.getByLabel('模型标识', { exact: true })).not.toBeVisible();
    await panel.locator(':scope > summary').click();
    await expect(panel.getByLabel('服务基础地址', { exact: true })).toHaveValue(
      'https://api.example.com/v1/draft',
    );
    await expect(panel.getByLabel('模型标识', { exact: true })).toHaveValue(
      'synthetic-unsaved-toggle-model',
    );
    await expect(panel.getByLabel('服务端凭据变量引用', { exact: true })).toHaveValue(
      'IR_TRANSLATION_BROWSER_TEST_KEY',
    );
    await expect(panel.getByLabel('服务设置模式', { exact: true })).toHaveValue('custom');
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(reads).toBe(1);
  const stored = (await (
    await request.get('/api/provider-settings')
  ).json()) as ProviderSettingsSummary;
  expect(settingsFields(stored)).toEqual(settingsFields(settingsBefore));
});

test('a pending offline save survives collapse and reopen without an older read rolling back the saved revision', async ({
  page,
  request,
}) => {
  settingsBefore = (await (
    await request.get('/api/provider-settings')
  ).json()) as ProviderSettingsSummary;
  const oldSummary = settingsBefore;
  let reads = 0,
    saves = 0,
    waitingForPut = false;
  const committed = deferred(),
    releasePut = deferred(),
    releaseUnexpectedRead = deferred();
  let saved!: ProviderSettingsSummary;
  await page.route('**/api/provider-settings', async (route) => {
    if (route.request().method() === 'GET') {
      reads++;
      const stale = waitingForPut;
      const response = await route.fetch();
      if (stale) {
        await releaseUnexpectedRead.promise;
        await route.fulfill({ response, json: oldSummary });
      } else await route.fulfill({ response });
      return;
    }
    if (route.request().method() !== 'PUT') return route.continue();
    saves++;
    if (saves > 1) return route.continue();
    const response = await route.fetch();
    saved = (await response.json()) as ProviderSettingsSummary;
    waitingForPut = true;
    committed.resolve();
    await releasePut.promise;
    await route.fulfill({ response });
    waitingForPut = false;
  });
  try {
    await page.goto('/');
    const panel = await offlineSettings(page);
    await panel.getByLabel('服务设置模式', { exact: true }).selectOption('custom');
    await panel.getByLabel('服务基础地址', { exact: true }).fill('https://api.example.com/v1');
    await panel.getByLabel('模型标识', { exact: true }).fill('synthetic-committed-toggle-model');
    await panel
      .getByLabel('服务端凭据变量引用', { exact: true })
      .fill('IR_TRANSLATION_BROWSER_TEST_KEY');
    await panel.getByRole('button', { name: '保存离线设置', exact: true }).click();
    await committed.promise;
    await panel.locator(':scope > summary').click();
    await panel.locator(':scope > summary').click();
    await expect(panel.getByLabel('模型标识', { exact: true })).toBeDisabled();
    await expect(panel.getByLabel('模型标识', { exact: true })).toHaveValue(
      'synthetic-committed-toggle-model',
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(reads).toBe(1);
    releasePut.resolve();
    await expect(panel.getByText(/设置已保存，尚未验证/)).toBeVisible();
    await expect(panel.getByRole('button', { name: '保存离线设置', exact: true })).toBeEnabled();
    releaseUnexpectedRead.resolve();
    await expect(panel.getByLabel('模型标识', { exact: true })).toHaveValue(
      'synthetic-committed-toggle-model',
    );
    await panel.getByRole('button', { name: '重新加载设置', exact: true }).click();
    await expect.poll(() => reads).toBe(2);
    await expect(panel.getByLabel('模型标识', { exact: true })).toHaveValue(
      'synthetic-committed-toggle-model',
    );
    await expect(panel.getByRole('button', { name: '保存离线设置', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '保存离线设置', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get('/api/provider-settings')).json()).revision)
      .toBe(saved.revision + 1);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    expect(saves).toBe(2);
  } finally {
    releasePut.resolve();
    releaseUnexpectedRead.resolve();
  }
});
