import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { TaskStore } from './store.js';
import { TaskService } from './service.js';
import { createMockAdapter, type TranslationAdapter } from './adapter.js';
import type { Task } from '../shared/types.js';
import type {
  TermApplicationPreview,
  TermInput,
  TermLibrary,
  TermRecord,
} from '../shared/professional.js';
import { PROFESSIONAL_LIMITS } from '../shared/professional.js';
import type { DocxImport } from '../shared/docx.js';

let store: TaskStore;
let service: TaskService;
let app: ReturnType<typeof createApp>;
let translate: ReturnType<typeof vi.fn<TranslationAdapter['translate']>>;
const directories: string[] = [];

function open(path = ':memory:') {
  store = new TaskStore(path);
  translate = vi.fn(createMockAdapter({ delayMs: 0, timeoutMs: 0 }).translate);
  service = new TaskService(
    store,
    { mode: 'mock', ready: true, label: 'synthetic', translate },
    1000,
  );
  app = createApp(service);
}

beforeEach(() => open());
afterEach(async () => {
  await service.shutdown();
  store.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function termInput(overrides: Partial<TermInput> = {}): TermInput {
  return {
    layer: 'technical',
    project: '',
    source: 'SyntheticRobot',
    target: '合成机器人',
    retainSource: false,
    note: '仅用于合成测试。',
    priority: 10,
    enabled: true,
    caseSensitive: false,
    alternatives: [],
    ...overrides,
  };
}
async function addTerm(overrides: Partial<TermInput> = {}): Promise<TermRecord> {
  const response = await request(app)
    .post('/api/terminology')
    .send(termInput(overrides))
    .expect(201);
  return response.body as TermRecord;
}
async function library(): Promise<TermLibrary> {
  return (await request(app).get('/api/terminology').expect(200)).body as TermLibrary;
}
async function task(
  text = 'SyntheticRobot raised USD 10 million.',
  extra: Record<string, unknown> = {},
): Promise<Task> {
  return (
    await request(app)
      .post('/api/tasks')
      .send({
        text,
        style: 'faithful',
        project: 'Synthetic Project',
        context: 'Synthetic IR context.',
        ...extra,
      })
      .expect(201)
  ).body as Task;
}
async function edit(value: Task, index: number, translation: string): Promise<Task> {
  const paragraph = value.paragraphs[index];
  return (
    await request(app)
      .patch(`/api/tasks/${value.id}/paragraphs/${paragraph.id}`)
      .send({ translation, expectedRevision: paragraph.revision })
      .expect(200)
  ).body as Task;
}
async function preview(
  id: string,
  body: Record<string, unknown> = {},
): Promise<TermApplicationPreview> {
  return (await request(app).post(`/api/tasks/${id}/terminology-preview`).send(body).expect(200))
    .body as TermApplicationPreview;
}
async function apply(id: string, token: string): Promise<Task> {
  return (
    await request(app)
      .post(`/api/tasks/${id}/terminology-apply`)
      .send({ token, confirm: true })
      .expect(200)
  ).body as Task;
}
async function approve(value: Task, index = 0, confirmed = true): Promise<Task> {
  return (
    await request(app)
      .post(`/api/tasks/${value.id}/review`)
      .send({
        paragraphId: value.paragraphs[index].id,
        expectedRevision: value.paragraphs[index].revision,
        snapshotId: value.professional!.snapshot.id,
        confirmed,
      })
      .expect(200)
  ).body as Task;
}
async function run(value: Task, paragraphIds?: string[]): Promise<Task> {
  await request(app)
    .post(`/api/tasks/${value.id}/translate`)
    .send(paragraphIds ? { paragraphIds } : {})
    .expect(202);
  await service.idle(value.id);
  return service.get(value.id);
}

function normalizedImport(id = 'synthetic-import'): DocxImport {
  return {
    id,
    document: {
      version: 1,
      filename: 'synthetic.docx',
      blocks: [
        {
          kind: 'paragraph',
          id: 'doc-p-1',
          paragraphId: 'translated-p-1',
          source: '  SyntheticRobot source.  ',
          location: '正文第 1 段',
        },
      ],
    },
    report: {
      status: 'ready',
      issues: [],
      stats: {
        paragraphs: 1,
        translatableParagraphs: 1,
        emptyParagraphs: 0,
        tables: 0,
        cells: 0,
        characters: 26,
        entries: 3,
        expandedBytes: 300,
        uploadBytes: 200,
      },
    },
  };
}

describe('persisted user terminology API', () => {
  it('saves offline provider settings without activating the adapter and retains API origin guards', async () => {
    const initial = await request(app).get('/api/provider-settings').expect(200);
    expect(initial.body.realCallsEnabled).toBe(false);
    const settings = {
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://synthetic.example.com/v1',
      model: 'synthetic-model',
      credentialRef: 'IR_TRANSLATION_SYNTHETIC_KEY',
      expectedRevision: initial.body.revision,
    };
    const saved = await request(app).put('/api/provider-settings').send(settings).expect(200);
    expect(saved.body.connectionTestAvailable).toBe(false);
    expect(saved.body.realCallsEnabled).toBe(false);
    expect((await request(app).get('/api/config').expect(200)).body).toMatchObject({
      mode: 'mock',
      ready: true,
    });
    await request(app)
      .put('/api/provider-settings')
      .set('Origin', 'https://untrusted.example.com')
      .send({ ...settings, expectedRevision: saved.body.revision })
      .expect(403);
    await request(app)
      .put('/api/provider-settings')
      .type('text/plain')
      .send('synthetic')
      .expect(415);
    expect((await request(app).get('/api/provider-settings').expect(200)).body.revision).toBe(
      saved.body.revision,
    );
  });
  it('allows explicitly enabling and editing a version-zero disabled example without mutating history', async () => {
    const before = await library();
    const example = before.entries.find((entry) => entry.id === 'example-ai')!;
    expect(example.enabled).toBe(false);
    const historical = await task();
    const changed = await request(app)
      .patch(`/api/terminology/${example.id}`)
      .send({ ...example, enabled: true, expectedRevision: example.revision })
      .expect(200);
    expect(changed.body.revision).toBe(example.revision + 1);
    expect(changed.body.enabled).toBe(true);
    expect(
      (await request(app).get(`/api/tasks/${historical.id}`).expect(200)).body.professional,
    ).toEqual(historical.professional);
  });
  it('creates, reads, revises and disables terms with optimistic record revisions and library versions', async () => {
    const before = await library();
    const created = await addTerm();
    expect(created).toMatchObject({ ...termInput(), revision: 1 });
    expect(created.id).toBeTypeOf('string');
    expect((await library()).version).toBe(before.version + 1);
    const updated = (
      await request(app)
        .patch(`/api/terminology/${created.id}`)
        .send({
          ...termInput({ target: '合成机器人二版', enabled: false }),
          expectedRevision: created.revision,
        })
        .expect(200)
    ).body as TermRecord;
    expect(updated).toMatchObject({
      id: created.id,
      revision: 2,
      target: '合成机器人二版',
      enabled: false,
    });
    const after = await library();
    expect(after.version).toBe(before.version + 2);
    expect(after.entries.find((entry) => entry.id === created.id)).toEqual(updated);
    await request(app)
      .patch(`/api/terminology/${created.id}`)
      .send({ ...termInput({ target: '过期内容' }), expectedRevision: 1 })
      .expect(409);
    expect((await library()).version).toBe(after.version);
    expect((await library()).entries.find((entry) => entry.id === created.id)).toEqual(updated);
  });

  it.each([
    { source: '' },
    { target: '' },
    { layer: 'unknown' },
    { project: 'wrong-global-scope' },
    { layer: 'project', project: '' },
    { priority: 1.5 },
    { enabled: 'yes' },
    { source: 'x'.repeat(PROFESSIONAL_LIMITS.source + 1) },
    { target: 'x'.repeat(PROFESSIONAL_LIMITS.target + 1) },
    { alternatives: Array(PROFESSIONAL_LIMITS.alternatives + 1).fill('alternative') },
  ])('rejects invalid term fields without changing the library: %j', async (invalid) => {
    const before = await library();
    await request(app)
      .post('/api/terminology')
      .send({ ...termInput(), ...invalid })
      .expect(400);
    expect(await library()).toEqual(before);
  });

  it('guards terminology mutations with the same origin and JSON rules as other APIs', async () => {
    const before = await library();
    await request(app)
      .post('/api/terminology')
      .set('Origin', 'https://synthetic-outside.invalid')
      .send(termInput())
      .expect(403);
    await request(app).post('/api/terminology').type('text/plain').send('synthetic').expect(415);
    await request(app)
      .patch('/api/terminology/synthetic-missing')
      .send({ ...termInput(), expectedRevision: 1 })
      .expect(404);
    expect(await library()).toEqual(before);
  });

  it('enforces the global bounded library size without evicting older records', async () => {
    const initial = await library();
    for (let index = initial.entries.length; index < PROFESSIONAL_LIMITS.terms; index++) {
      await addTerm({ source: `SyntheticTerm${index}`, target: `合成术语${index}` });
    }
    const full = await library();
    expect(full.entries).toHaveLength(PROFESSIONAL_LIMITS.terms);
    const rejected = await request(app)
      .post('/api/terminology')
      .send(termInput({ source: 'OneExtraSyntheticTerm' }));
    expect([400, 409]).toContain(rejected.status);
    expect(await library()).toEqual(full);
  });
});

describe('immutable task terminology snapshots', () => {
  it('captures a text task snapshot once and never silently applies global edits or disabled terms', async () => {
    const created = await addTerm();
    const original = await task();
    expect(original.professional!.snapshot).toMatchObject({
      project: 'Synthetic Project',
      context: 'Synthetic IR context.',
    });
    expect(
      original.professional!.snapshot.entries.find((entry) => entry.id === created.id),
    ).toEqual(created);
    const frozen = structuredClone(original.professional);
    await request(app)
      .patch(`/api/terminology/${created.id}`)
      .send({
        ...termInput({ target: '新的全局译法', enabled: false }),
        expectedRevision: created.revision,
      })
      .expect(200);
    expect(
      (await request(app).get(`/api/tasks/${original.id}`).expect(200)).body.professional,
    ).toEqual(frozen);
    const newer = await task();
    expect(newer.professional!.snapshot.entries.some((entry) => entry.id === created.id)).toBe(
      false,
    );
    expect(newer.professional!.snapshot.libraryVersion).toBeGreaterThan(
      original.professional!.snapshot.libraryVersion,
    );
  });

  it('uses project scoping and the same immutable snapshot in DOCX tasks without touching their source mappings', async () => {
    const relevant = await addTerm({ layer: 'project', project: 'Synthetic Project' });
    const unrelated = await addTerm({
      layer: 'project',
      project: 'Another Project',
      target: '另一项目译法',
    });
    const record = normalizedImport();
    store.saveImport(record);
    const created = (
      await request(app)
        .post('/api/tasks/docx')
        .send({
          importId: record.id,
          style: 'business',
          acknowledgeWarnings: true,
          project: 'Synthetic Project',
          context: 'Synthetic DOCX context.',
        })
        .expect(201)
    ).body as Task;
    expect(created.document).toEqual(record.document);
    expect(created.paragraphs[0]).toMatchObject({
      id: 'translated-p-1',
      source: '  SyntheticRobot source.  ',
      location: '正文第 1 段',
    });
    expect(created.professional!.snapshot.entries.some((entry) => entry.id === relevant.id)).toBe(
      true,
    );
    expect(created.professional!.snapshot.entries.some((entry) => entry.id === unrelated.id)).toBe(
      false,
    );
    expect(created.professional!.snapshot.context).toBe('Synthetic DOCX context.');
  });

  it.each([
    { project: 'x'.repeat(PROFESSIONAL_LIMITS.project + 1) },
    { context: 'x'.repeat(PROFESSIONAL_LIMITS.context + 1) },
    { project: 42 },
    { context: [] },
  ])('rejects invalid task context at creation: %j', async (extra) => {
    await request(app)
      .post('/api/tasks')
      .send({ text: 'Synthetic input.', style: 'faithful', ...extra })
      .expect(400);
    expect(store.list()).toHaveLength(0);
  });

  it('keeps legacy tasks free of a newly introduced library until an explicit preview and apply', async () => {
    await addTerm();
    const now = new Date().toISOString();
    const legacy: Task = {
      id: 'legacy-synthetic-task',
      title: 'Legacy synthetic task',
      style: 'faithful',
      status: 'draft',
      mode: 'mock',
      createdAt: now,
      updatedAt: now,
      paragraphs: [
        {
          id: 'legacy-p-1',
          source: 'SyntheticRobot legacy source.',
          translation: '',
          revision: 0,
          edited: false,
          status: 'pending',
          error: null,
        },
      ],
    };
    store.save(legacy);
    const reopened = (await request(app).get(`/api/tasks/${legacy.id}`).expect(200)).body as Task;
    expect(reopened.professional).toBeUndefined();
    const proposed = await preview(legacy.id, {
      project: 'Synthetic Project',
      context: 'Legacy opt-in context.',
    });
    expect(proposed.previousSnapshotId).toBeNull();
    const applied = await apply(legacy.id, proposed.token);
    expect(applied.professional!.snapshot.id).toBe(proposed.snapshot.id);
    expect(
      applied.professional!.snapshot.entries.some((entry) => entry.source === 'SyntheticRobot'),
    ).toBe(true);
    expect(applied.paragraphs).toEqual(legacy.paragraphs);
  });
});

describe('explicit terminology reapplication and provenance', () => {
  it('previews then applies a new snapshot while preserving every paragraph and invalidating old approval', async () => {
    let original = await task('SyntheticRobot source one.\n\nA synthetic second source.');
    original = await edit(original, 0, '人工修改一');
    original = await edit(original, 1, '人工修改二');
    original = await approve(original, 0);
    const oldSnapshot = structuredClone(original.professional!.snapshot);
    await addTerm();
    const proposed = await preview(original.id, {
      project: 'Synthetic Project',
      context: 'New explicitly confirmed context.',
    });
    expect(proposed.taskRevision).toBe(original.revision);
    expect(proposed.previousSnapshotId).toBe(oldSnapshot.id);
    expect(proposed.preservedEditedParagraphs).toBe(2);
    expect(proposed.changedSources).toContain('SyntheticRobot');
    expect(service.get(original.id).professional!.snapshot).toEqual(oldSnapshot);
    const applied = await apply(original.id, proposed.token);
    expect(applied.paragraphs).toEqual(original.paragraphs);
    expect(applied.status).toBe(original.status);
    expect(applied.professional!.snapshot).toEqual(proposed.snapshot);
    expect(applied.professional!.snapshotHistory).toContainEqual(oldSnapshot);
    expect(applied.professional!.review.approvals).toHaveLength(0);
    expect(
      applied.professional!.review.events.some(
        (event) => event.type === 'invalidated' && event.paragraphId === original.paragraphs[0].id,
      ),
    ).toBe(true);
    expect(applied.revision).toBeGreaterThan(original.revision!);
    expect(translate).not.toHaveBeenCalled();
    const unchanged = structuredClone(applied);
    await request(app)
      .post(`/api/tasks/${original.id}/terminology-apply`)
      .send({ token: proposed.token, confirm: true })
      .expect(409);
    expect(service.get(original.id)).toEqual(unchanged);
  });

  it.each(['task edit', 'library edit'] as const)(
    'rejects a stale preview after a %s without changing its task snapshot',
    async (change) => {
      const original = await task();
      const proposed = await preview(original.id);
      if (change === 'task edit') await edit(original, 0, '新的人工内容');
      else await addTerm({ source: 'UnrelatedSyntheticTerm' });
      const before = service.get(original.id);
      await request(app)
        .post(`/api/tasks/${original.id}/terminology-apply`)
        .send({ token: proposed.token, confirm: true })
        .expect(409);
      expect(service.get(original.id)).toEqual(before);
    },
  );

  it('binds a preview to its task and requires an explicit confirmation', async () => {
    const first = await task();
    const second = await task();
    const proposed = await preview(first.id);
    await request(app)
      .post(`/api/tasks/${second.id}/terminology-apply`)
      .send({ token: proposed.token, confirm: true })
      .expect(409);
    await request(app)
      .post(`/api/tasks/${first.id}/terminology-apply`)
      .send({ token: proposed.token, confirm: false })
      .expect(400);
    const unknown = await request(app)
      .post(`/api/tasks/${first.id}/terminology-apply`)
      .send({ token: 'synthetic-unknown-token', confirm: true });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
    expect(service.get(first.id).professional!.snapshot.id).toBe(first.professional!.snapshot.id);
    expect(service.get(second.id).professional!.snapshot.id).toBe(second.professional!.snapshot.id);
    expect((await apply(first.id, proposed.token)).professional!.snapshot.id).toBe(
      proposed.snapshot.id,
    );
  });

  it('invalidates the older pending preview when another preview replaces it', async () => {
    const original = await task();
    const first = await preview(original.id, { context: 'First proposed context.' });
    const second = await preview(original.id, { context: 'Second proposed context.' });
    await request(app)
      .post(`/api/tasks/${original.id}/terminology-apply`)
      .send({ token: first.token, confirm: true })
      .expect(409);
    expect(service.get(original.id).professional!.snapshot.id).toBe(
      original.professional!.snapshot.id,
    );
    const applied = await apply(original.id, second.token);
    expect(applied.professional!.snapshot.context).toBe('Second proposed context.');
    expect(applied.professional!.snapshotHistory).toHaveLength(1);
  });

  it('retains immutable old and current snapshot entries through later global term revisions', async () => {
    const term = await addTerm({ target: '合成第一版' });
    const original = await task();
    const revised = (
      await request(app)
        .patch(`/api/terminology/${term.id}`)
        .send({ ...termInput({ target: '合成第二版' }), expectedRevision: term.revision })
        .expect(200)
    ).body as TermRecord;
    const proposed = await preview(original.id);
    const applied = await apply(original.id, proposed.token);
    const preserved = structuredClone(applied.professional);
    expect(
      applied.professional!.snapshotHistory[0].entries.find((entry) => entry.id === term.id)
        ?.target,
    ).toBe('合成第一版');
    expect(
      applied.professional!.snapshot.entries.find((entry) => entry.id === term.id)?.target,
    ).toBe('合成第二版');
    await request(app)
      .patch(`/api/terminology/${term.id}`)
      .send({ ...termInput({ target: '合成第三版' }), expectedRevision: revised.revision })
      .expect(200);
    expect(service.get(original.id).professional).toEqual(preserved);
  });

  it('expires previews after the bounded confirmation window', async () => {
    const original = await task();
    const proposed = await preview(original.id);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    await request(app)
      .post(`/api/tasks/${original.id}/terminology-apply`)
      .send({ token: proposed.token, confirm: true })
      .expect(409);
    expect(service.get(original.id).professional!.snapshot.id).toBe(
      original.professional!.snapshot.id,
    );
  });

  it('rejects snapshot-history overflow and preserves all existing provenance', async () => {
    const original = await task();
    original.professional!.snapshotHistory = Array.from(
      { length: PROFESSIONAL_LIMITS.snapshotHistory },
      (_, index) => ({
        ...structuredClone(original.professional!.snapshot),
        id: `historical-synthetic-${index}`,
      }),
    );
    store.save(original);
    const before = service.get(original.id);
    const proposed = await request(app)
      .post(`/api/tasks/${original.id}/terminology-preview`)
      .send({});
    if (proposed.status === 200)
      await request(app)
        .post(`/api/tasks/${original.id}/terminology-apply`)
        .send({ token: proposed.body.token, confirm: true })
        .expect(409);
    else expect(proposed.status).toBe(409);
    expect(service.get(original.id)).toEqual(before);
  });

  it('rejects context changes during an active translation instead of applying an old-context result', async () => {
    const original = await task();
    const proposed = await preview(original.id);
    await request(app)
      .post(`/api/tasks/${original.id}/translate`)
      .send({ scenario: 'slow' })
      .expect(202);
    await request(app)
      .post(`/api/tasks/${original.id}/terminology-preview`)
      .send({ context: 'Unsafe concurrent change.' })
      .expect(409);
    await request(app)
      .post(`/api/tasks/${original.id}/terminology-apply`)
      .send({ token: proposed.token, confirm: true })
      .expect(409);
    await request(app).post(`/api/tasks/${original.id}/cancel`).send({}).expect(200);
    await service.idle(original.id);
    expect(service.get(original.id).professional!.snapshot.id).toBe(
      original.professional!.snapshot.id,
    );
  });
});

describe('explicit human review and saved findings', () => {
  it('records and revokes confirmation only for a current saved paragraph and snapshot', async () => {
    let original = await task();
    original = await edit(original, 0, '合成机器人募集 USD 10 million。');
    expect(original.professional!.review.approvals).toHaveLength(0);
    const approved = await approve(original);
    expect(approved.professional!.review.approvals).toEqual([
      {
        paragraphId: original.paragraphs[0].id,
        revision: original.paragraphs[0].revision,
        snapshotId: original.professional!.snapshot.id,
        confirmedAt: expect.any(String),
      },
    ]);
    expect(approved.professional!.review.events.at(-1)).toMatchObject({
      type: 'confirmed',
      paragraphId: original.paragraphs[0].id,
    });
    expect(await approve(approved)).toEqual(approved);
    const revoked = await approve(approved, 0, false);
    expect(revoked.professional!.review.approvals).toHaveLength(0);
    expect(revoked.professional!.review.events.at(-1)?.type).toBe('revoked');
  });

  it('rejects blank, stale revision and stale snapshot confirmations without adding approvals', async () => {
    const original = await task();
    const empty = await request(app).post(`/api/tasks/${original.id}/review`).send({
      paragraphId: original.paragraphs[0].id,
      expectedRevision: 0,
      snapshotId: original.professional!.snapshot.id,
      confirmed: true,
    });
    expect([400, 409]).toContain(empty.status);
    const saved = await edit(original, 0, '合成样本人工内容');
    await request(app)
      .post(`/api/tasks/${original.id}/review`)
      .send({
        paragraphId: saved.paragraphs[0].id,
        expectedRevision: 0,
        snapshotId: saved.professional!.snapshot.id,
        confirmed: true,
      })
      .expect(409);
    await request(app)
      .post(`/api/tasks/${original.id}/review`)
      .send({
        paragraphId: saved.paragraphs[0].id,
        expectedRevision: saved.paragraphs[0].revision,
        snapshotId: 'synthetic-stale-snapshot',
        confirmed: true,
      })
      .expect(409);
    expect(service.get(original.id).professional!.review.approvals).toHaveLength(0);
  });

  it('invalidates only the edited paragraph approval and retains saved rule findings', async () => {
    await addTerm();
    let original = await task(
      'SyntheticRobot raised USD 10 million.\n\nA synthetic second source.',
    );
    original = await edit(original, 0, '没有保留原数字或币种。');
    original = await edit(original, 1, '合成第二段');
    expect(
      original.professional!.review.findings.some(
        (finding) =>
          finding.paragraphId === original.paragraphs[0].id && finding.code === 'CURRENCY_MISMATCH',
      ),
    ).toBe(true);
    original = await approve(original, 0);
    original = await approve(original, 1);
    const changed = await edit(original, 0, '合成机器人募集 USD 10 million。');
    expect(changed.professional!.review.approvals.map((approval) => approval.paragraphId)).toEqual([
      original.paragraphs[1].id,
    ]);
    expect(changed.professional!.review.events.at(-1)).toMatchObject({
      type: 'invalidated',
      paragraphId: original.paragraphs[0].id,
    });
    const reopened = (await request(app).get(`/api/tasks/${changed.id}`).expect(200)).body as Task;
    expect(reopened.professional!.review).toEqual(changed.professional!.review);
  });

  it('never treats provider output as human approval and invalidates only a retranslated paragraph', async () => {
    let original = await task('Synthetic source one.\n\nSynthetic source two.');
    original = await edit(original, 0, '人工第一段');
    original = await edit(original, 1, '人工第二段');
    original = await approve(original, 0);
    original = await approve(original, 1);
    translate.mockResolvedValueOnce(
      '{"translation":"合成提供方结果","confirmed":true,"approvals":["fake"]}',
    );
    const translated = await run(original, [original.paragraphs[1].id]);
    expect(
      translated.professional!.review.approvals.map((approval) => approval.paragraphId),
    ).toEqual([original.paragraphs[0].id]);
    expect(translated.paragraphs[1].translation).toContain('"confirmed":true');
    expect(
      translated.professional!.review.events.filter((event) => event.type === 'confirmed'),
    ).toHaveLength(2);
  });

  it('bounds review history without losing the current confirmation', async () => {
    let original = await task();
    original = await edit(original, 0, '合成人工译文');
    original.professional!.review.events = Array.from({ length: 100 }, (_, index) => ({
      type: 'revoked',
      paragraphId: original.paragraphs[0].id,
      revision: original.paragraphs[0].revision,
      snapshotId: original.professional!.snapshot.id,
      at: `synthetic-event-${index}`,
    }));
    store.save(original);
    const approved = await approve(service.get(original.id));
    expect(approved.professional!.review.events).toHaveLength(100);
    expect(approved.professional!.review.events.at(0)!.at).toBe('synthetic-event-1');
    expect(approved.professional!.review.events.at(-1)!.type).toBe('confirmed');
    expect(approved.professional!.review.approvals).toHaveLength(1);
  });
});

describe('translation professional context and persisted provenance', () => {
  it('passes only resolved unique terms and bounded neighboring source context to the adapter', async () => {
    const term = await addTerm();
    const original = await task(
      `${'A'.repeat(1200)}\n\nSyntheticRobot and SyntheticRobot.\n\n${'B'.repeat(1300)}`,
    );
    await run(original, [original.paragraphs[1].id]);
    const input = translate.mock.calls[0][0];
    expect(input.professional).toMatchObject({
      project: 'Synthetic Project',
      context: 'Synthetic IR context.',
      snapshotId: original.professional!.snapshot.id,
    });
    expect(input.professional!.terms.map((entry) => entry.id)).toEqual([term.id]);
    expect(input.professional!.previousSource.length).toBeLessThanOrEqual(1000);
    expect(input.professional!.nextSource.length).toBeLessThanOrEqual(1000);
    expect(input.professional!.previousSource).toBeTruthy();
    expect(input.professional!.nextSource).toBeTruthy();
    expect(input.professional!.location).toBeTypeOf('string');
    expect(input.professional!.location).toBeTruthy();
  });

  it('blocks only selected paragraphs with unresolved terminology conflicts before any provider call', async () => {
    await addTerm({ target: '合成译法一' });
    await addTerm({ target: '合成译法二' });
    const original = await task('Unrelated synthetic paragraph.\n\nSyntheticRobot conflict.');
    expect(
      original.professional!.review.findings.some((finding) => finding.code === 'TERM_CONFLICT'),
    ).toBe(true);
    const conflict = await request(app)
      .post(`/api/tasks/${original.id}/translate`)
      .send({})
      .expect(409);
    expect(conflict.body.code).toBe('TERM_CONFLICT');
    expect(translate).not.toHaveBeenCalled();
    const safe = await run(original, [original.paragraphs[0].id]);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(safe.paragraphs[0].status).toBe('done');
    expect(safe.paragraphs[1].status).toBe('pending');
  });

  it('persists library, immutable task snapshots, findings, human approvals and pending preview tokens across SQLite reopen', async () => {
    await service.shutdown();
    store.close();
    const directory = mkdtempSync(join(tmpdir(), 'ir-professional-api-'));
    directories.push(directory);
    const path = join(directory, 'workbench.sqlite');
    open(path);
    const term = await addTerm();
    let original = await task();
    original = await edit(original, 0, '合成机器人募集 USD 10 million。');
    original = await approve(original);
    const proposed = await preview(original.id, { context: 'Persisted explicit context.' });
    const beforeLibrary = await library();
    const beforeTask = service.get(original.id);
    const settingKey = "synthetic'; DROP TABLE tasks; --";
    expect(store.getSetting(settingKey)).toBeUndefined();
    store.setSetting(settingKey, { theme: 'synthetic-old' });
    store.setSetting(settingKey, { theme: 'synthetic-current' });
    expect(service.get(original.id)).toEqual(beforeTask);
    await service.shutdown();
    store.close();
    open(path);
    expect(await library()).toEqual(beforeLibrary);
    expect((await library()).entries.some((entry) => entry.id === term.id)).toBe(true);
    expect(service.get(original.id)).toEqual(beforeTask);
    expect(store.getSetting(settingKey)).toEqual({ theme: 'synthetic-current' });
    const applied = await apply(original.id, proposed.token);
    expect(applied.professional!.snapshot.context).toBe('Persisted explicit context.');
    expect(applied.paragraphs).toEqual(beforeTask.paragraphs);
    expect(applied.professional!.review.approvals).toHaveLength(0);
  });
});
