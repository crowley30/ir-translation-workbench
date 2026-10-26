import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Response } from 'supertest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { TaskStore } from '../store.js';
import { TaskService } from '../service.js';
import { createMockAdapter } from '../adapter.js';
import {
  DOCX_LIMITS,
  type DocxDocument,
  type DocxImport,
  type DocxParagraph,
} from '../../shared/docx.js';
import type { Task } from '../../shared/types.js';
import { parseDocx } from './parse.js';
import { makeDocx, supportedFixture } from './fixtures.js';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const xml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
let store: TaskStore;
let service: TaskService;
let app: ReturnType<typeof createApp>;
const directories: string[] = [];

beforeEach(() => {
  store = new TaskStore(':memory:');
  service = new TaskService(store, createMockAdapter({ delayMs: 0, timeoutMs: 0 }), 1000);
  app = createApp(service);
});
afterEach(async () => {
  await service.shutdown();
  store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function upload(bytes: Buffer, filename = '合成样本.docx') {
  return request(app)
    .post('/api/docx/preflight')
    .set('Content-Type', MIME)
    .set('X-Filename', encodeURIComponent(filename))
    .send(bytes);
}
async function imported(bytes?: Buffer): Promise<DocxImport> {
  const response = await upload(bytes ?? (await supportedFixture())).expect(201);
  return response.body as DocxImport;
}
async function createImported(record: DocxImport): Promise<Task> {
  const response = await request(app)
    .post('/api/tasks/docx')
    .send({ importId: record.id, style: 'faithful', acknowledgeWarnings: true })
    .expect(201);
  return response.body as Task;
}
function sources(document: DocxDocument): DocxParagraph[] {
  return document.blocks.flatMap((block) =>
    block.kind === 'paragraph'
      ? [block]
      : block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs)),
  );
}
function binary(res: Response, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', callback);
}
async function translateTask(task: Task, scenario = 'normal') {
  await request(app).post(`/api/tasks/${task.id}/translate`).send({ scenario }).expect(202);
  await service.idle(task.id);
}

describe('DOCX upload and normalized persistence boundary', () => {
  it('persists normalized preflight output and maps exact nonempty source paragraphs in document order', async () => {
    const bytes = makeDocx(
      xml(
        `${paragraph('  Synthetic AI fund USD 10 million.  ')}${paragraph('   ')}${paragraph('A second synthetic paragraph.')}`,
      ),
    );
    const record = await imported(bytes);
    expect(record.document.filename).toBe('合成样本.docx');
    expect(record.report.status).not.toBe('blocked');
    expect(record.report.stats.uploadBytes).toBe(bytes.length);
    expect(store.getImport(record.id)).toEqual(record);
    expect(Object.keys(record).sort()).toEqual(['document', 'id', 'report']);
    const task = await createImported(record);
    const expected = sources(record.document).filter((p) => p.source.trim());
    expect(task.document).toEqual(record.document);
    expect(task.paragraphs.map((p) => p.id)).toEqual(expected.map((p) => p.paragraphId));
    expect(task.paragraphs.map((p) => p.location)).toEqual(expected.map((p) => p.location));
    expect(task.paragraphs.map((p) => p.source)).toEqual([
      '  Synthetic AI fund USD 10 million.  ',
      'A second synthetic paragraph.',
    ]);
    expect(new Set(task.paragraphs.map((p) => p.id)).size).toBe(task.paragraphs.length);
    const reopened = await request(app).get(`/api/tasks/${task.id}`).expect(200);
    expect(reopened.body).toEqual(task);
  });

  it.each([
    undefined,
    '%invalid',
    'synthetic.txt',
    encodeURIComponent('../synthetic.docx'),
    encodeURIComponent('synthetic\n.docx'),
    'folder%5Csynthetic.docx',
    'synthetic%00.docx',
  ])('rejects missing, malformed or unsafe filename header %s', async (filename) => {
    let pending = request(app).post('/api/docx/preflight').set('Content-Type', MIME);
    if (filename !== undefined) pending = pending.set('X-Filename', filename);
    const response = await pending.send(await supportedFixture()).expect(400);
    expect(response.body.error).toBeTypeOf('string');
    expect(store.list()).toHaveLength(0);
  });

  it('requires explicit DOCX MIME on the upload route and JSON on other mutation routes', async () => {
    await request(app)
      .post('/api/docx/preflight')
      .set('X-Filename', 'synthetic.docx')
      .type('application/octet-stream')
      .send(await supportedFixture())
      .expect(415);
    await request(app)
      .post('/api/docx/preflight')
      .set('X-Filename', 'synthetic.docx')
      .send({ text: 'synthetic payload' })
      .expect(415);
    await request(app)
      .post('/api/tasks')
      .set('Content-Type', MIME)
      .send(await supportedFixture())
      .expect(415);
    await request(app)
      .post('/api/tasks/docx')
      .set('Content-Type', MIME)
      .send(await supportedFixture())
      .expect(415);
  });

  it('refuses HTTP body compression without treating the DOCX ZIP format as an HTTP encoding', async () => {
    const response = await request(app)
      .post('/api/docx/preflight')
      .set('Content-Type', MIME)
      .set('Content-Encoding', 'gzip')
      .set('X-Filename', 'synthetic.docx')
      .send(await supportedFixture())
      .expect(415);
    expect(response.body.code).toBe('UNSUPPORTED_BODY_ENCODING');
    expect(response.body.error).toBeTypeOf('string');
    expect(store.list()).toHaveLength(0);
  });

  it('rejects cross-origin DOCX uploads before processing bytes', async () => {
    await request(app)
      .post('/api/docx/preflight')
      .set('Origin', 'https://synthetic-external.invalid')
      .set('Content-Type', MIME)
      .set('X-Filename', 'synthetic.docx')
      .send(await supportedFixture())
      .expect(403);
    const response = await request(app)
      .post('/api/docx/preflight')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Content-Type', MIME)
      .set('X-Filename', 'synthetic.docx')
      .send(await supportedFixture())
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects an empty DOCX upload without creating a task', async () => {
    const response = await upload(Buffer.alloc(0)).expect(400);
    expect(response.body.error).toBeTypeOf('string');
    expect(store.list()).toHaveLength(0);
  });

  it('enforces the raw upload byte limit before parsing', async () => {
    const response = await upload(
      Buffer.alloc(DOCX_LIMITS.uploadBytes + 1),
      'synthetic.docx',
    ).expect(413);
    expect(response.body.error).toBeTypeOf('string');
    expect(store.list()).toHaveLength(0);
  });

  it('returns safe readable errors for invalid ZIP and malformed XML without reflecting their payload', async () => {
    for (const bytes of [
      Buffer.from('synthetic-sensitive-payload'),
      makeDocx(xml('<w:p><w:r><w:t>synthetic-sensitive-payload')),
    ]) {
      const response = await upload(bytes).expect(400);
      expect(response.body.error).toBeTypeOf('string');
      expect(response.body.error.length).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain('synthetic-sensitive-payload');
    }
    expect(store.list()).toHaveLength(0);
  });

  it('reports unsupported content as blocked and refuses task creation', async () => {
    const record = await imported(
      makeDocx(
        xml(`${paragraph('Synthetic text before drawing.')}<w:p><w:r><w:drawing/></w:r></w:p>`),
      ),
    );
    expect(record.report.status).toBe('blocked');
    expect(record.report.issues.some((issue) => issue.severity === 'blocking')).toBe(true);
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: record.id, style: 'faithful', acknowledgeWarnings: true })
      .expect(409);
    expect(store.list()).toHaveLength(0);
  });

  it('requires explicit acknowledgement of formatting warnings before creating a task', async () => {
    const record = await imported(
      makeDocx(
        xml('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Synthetic bold formatting.</w:t></w:r></w:p>'),
      ),
    );
    expect(record.report.status).toBe('warning');
    expect(record.report.issues.some((issue) => issue.severity === 'warning')).toBe(true);
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: record.id, style: 'business', acknowledgeWarnings: false })
      .expect(409);
    expect(store.list()).toHaveLength(0);
    const created = await request(app)
      .post('/api/tasks/docx')
      .send({ importId: record.id, style: 'business', acknowledgeWarnings: true })
      .expect(201);
    expect(created.body.document).toEqual(record.document);
  });
});

describe('DOCX task lifecycle, idempotency and export', () => {
  it('creates at most one task per import and rejects changing its consumed style', async () => {
    const record = await imported();
    const [first, repeated] = await Promise.all([createImported(record), createImported(record)]);
    expect(repeated.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: record.id, style: 'business', acknowledgeWarnings: true })
      .expect(409);
    const same = await request(app)
      .post('/api/tasks/docx')
      .send({ importId: record.id, style: 'faithful', acknowledgeWarnings: false })
      .expect(201);
    expect(same.body.id).toBe(first.id);
  });

  it('revalidates normalized document limits instead of trusting a stale ready report', async () => {
    const record = await imported(makeDocx(paragraph('Synthetic short source.')));
    const first = record.document.blocks[0];
    if (first.kind !== 'paragraph') throw new Error('Synthetic fixture must contain one paragraph');
    const oversized = {
      ...record,
      id: `${record.id}-oversized`,
      document: {
        ...record.document,
        blocks: [{ ...first, source: 'X'.repeat(DOCX_LIMITS.characters + 1) }],
      },
    };
    store.saveImport(oversized);
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: oversized.id, style: 'faithful', acknowledgeWarnings: true })
      .expect(409);
    expect(store.list()).toHaveLength(0);
  });

  it.each([
    'duplicate mapping',
    'missing mapping',
    'mapped empty source',
    'duplicate structural ID',
  ] as const)('rejects corrupt normalized %s without creating a task', async (corruption) => {
    const record = await imported(
      makeDocx(`${paragraph('Synthetic first source.')}${paragraph('Synthetic second source.')}`),
    );
    const corrupted = structuredClone(record);
    corrupted.id = `${record.id}-corrupt`;
    const mapped = sources(corrupted.document);
    if (corruption === 'duplicate mapping') mapped[1].paragraphId = mapped[0].paragraphId;
    if (corruption === 'missing mapping') mapped[0].paragraphId = null;
    if (corruption === 'mapped empty source') mapped[0].source = '   ';
    if (corruption === 'duplicate structural ID') mapped[1].id = mapped[0].id;
    store.saveImport(corrupted);
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: corrupted.id, style: 'faithful', acknowledgeWarnings: true })
      .expect(409);
    expect(store.list()).toHaveLength(0);
    expect(store.getTaskForImport(corrupted.id)).toBeUndefined();
  });

  it('validates task-creation fields and missing import IDs', async () => {
    const record = await imported();
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: record.id, style: 'faithful' })
      .expect(400);
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: record.id, style: 'other', acknowledgeWarnings: true })
      .expect(400);
    await request(app)
      .post('/api/tasks/docx')
      .send({ importId: 'synthetic-missing-import', style: 'faithful', acknowledgeWarnings: true })
      .expect(404);
    expect(store.list()).toHaveLength(0);
  });

  it('rejects export of unfinished or plain-text tasks and invalid modes', async () => {
    const task = await createImported(await imported());
    await request(app).get(`/api/tasks/${task.id}/docx?mode=chinese`).expect(409);
    await request(app).get(`/api/tasks/${task.id}/docx?mode=unknown`).expect(400);
    await request(app).get('/api/tasks/synthetic-missing/docx?mode=chinese').expect(404);
    const plain = service.create({ text: 'Synthetic plain-text task.', style: 'faithful' });
    await translateTask(plain);
    await request(app).get(`/api/tasks/${plain.id}/docx?mode=chinese`).expect(409);
  });

  it('retains stable mapping through cancellation and retry of a DOCX task', async () => {
    const task = await createImported(await imported());
    await request(app)
      .post(`/api/tasks/${task.id}/translate`)
      .send({ scenario: 'slow' })
      .expect(202);
    await request(app).post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    await service.idle(task.id);
    expect(service.get(task.id).status).toBe('cancelled');
    expect(service.get(task.id).document).toEqual(task.document);
    await translateTask(task);
    const complete = service.get(task.id);
    expect(complete.status).toBe('completed');
    expect(complete.paragraphs.map((p) => [p.id, p.source, p.location])).toEqual(
      task.paragraphs.map((p) => [p.id, p.source, p.location]),
    );
  });

  it('retains successful DOCX paragraphs after partial failure and retries only unfinished work', async () => {
    const task = await createImported(await imported());
    expect(task.paragraphs.length).toBeGreaterThan(1);
    await translateTask(task, 'partial');
    const partial = service.get(task.id);
    expect(partial.status).toBe('partial');
    const first = partial.paragraphs[0];
    expect(first.status).toBe('done');
    expect(partial.paragraphs[1].status).toBe('failed');
    await request(app).get(`/api/tasks/${task.id}/docx?mode=chinese`).expect(409);
    await translateTask(task);
    const complete = service.get(task.id);
    expect(complete.status).toBe('completed');
    expect(complete.paragraphs[0]).toEqual(first);
    expect(complete.document).toEqual(task.document);
  });

  it.each(['chinese', 'bilingual'] as const)(
    'exports the latest saved manual text in a safe %s DOCX attachment that reparses',
    async (mode) => {
      const task = await createImported(await imported());
      await translateTask(task);
      const complete = service.get(task.id);
      const target = complete.paragraphs[0];
      const latest = '合成样本：最新保存的人工修改，USD 10 million。';
      await request(app)
        .patch(`/api/tasks/${task.id}/paragraphs/${target.id}`)
        .send({ translation: latest, expectedRevision: target.revision })
        .expect(200);
      const response = await request(app)
        .get(`/api/tasks/${task.id}/docx?mode=${mode}`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(response.headers['content-type']).toContain(MIME);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('.docx');
      expect(response.headers['content-disposition']).toContain("filename*=UTF-8''");
      expect(response.headers['content-disposition']).not.toMatch(/[\r\n]/);
      expect(Buffer.isBuffer(response.body)).toBe(true);
      const reparsed = await parseDocx(response.body as Buffer, 'exported.docx');
      expect(reparsed.report.status, JSON.stringify(reparsed.report.issues)).not.toBe('blocked');
      const text = sources(reparsed.document)
        .map((p) => p.source)
        .join('\n');
      expect(text).toContain(latest);
      expect(text).toContain('模拟');
      if (mode === 'bilingual') expect(text).toContain(target.source);
      expect(service.get(task.id).paragraphs[0].translation).toBe(latest);
    },
  );

  it('reopens normalized imports, document mappings and manual edits from SQLite and recovers interrupted work', async () => {
    await service.shutdown();
    store.close();
    const directory = mkdtempSync(join(tmpdir(), 'ir-docx-api-'));
    directories.push(directory);
    const path = join(directory, 'workbench.sqlite');
    store = new TaskStore(path);
    service = new TaskService(store, createMockAdapter({ delayMs: 0 }));
    app = createApp(service);
    const record = await imported();
    const task = await createImported(record);
    const first = task.paragraphs[0];
    service.edit(task.id, first.id, {
      translation: '合成样本：重启后仍保留的人工译文。',
      expectedRevision: 0,
    });
    const interrupted = service.get(task.id);
    interrupted.status = 'running';
    interrupted.paragraphs[1].status = 'running';
    store.save(interrupted);
    store.close();
    store = new TaskStore(path);
    service = new TaskService(store, createMockAdapter({ delayMs: 0 }));
    app = createApp(service);
    expect(store.getImport(record.id)).toEqual(record);
    const reopened = await request(app).get(`/api/tasks/${task.id}`).expect(200);
    expect(reopened.body.status).toBe('cancelled');
    expect(reopened.body.document).toEqual(task.document);
    expect(reopened.body.paragraphs[0]).toMatchObject({
      translation: '合成样本：重启后仍保留的人工译文。',
      edited: true,
      revision: 1,
    });
    expect(reopened.body.paragraphs[1].status).toBe('cancelled');
    const repeated = await createImported(record);
    expect(repeated.id).toBe(task.id);
    expect(
      readdirSync(directory).every((name) => /^workbench\.sqlite(?:-wal|-shm)?$/.test(name)),
    ).toBe(true);
  });
});
