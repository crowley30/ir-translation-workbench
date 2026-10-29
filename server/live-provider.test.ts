import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Response } from 'supertest';
import { createApp } from './app.js';
import { TaskStore } from './store.js';
import { TaskService } from './service.js';
import { createMockAdapter } from './adapter.js';
import { LiveProviderRuntime } from './live-provider.js';
import {
  OpenAITransportError,
  type OpenAITransport,
  type OpenAITransportRequest,
  type OpenAITransportResponse,
} from './openai-transport.js';
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS } from '../shared/openai-models.js';
import type { Task } from '../shared/types.js';
import type { TermInput } from '../shared/professional.js';
import { makeDocx, p } from './docx/fixtures.js';
import { readArchive } from './docx/archive.js';

const KEY = 'synthetic-placeholder-not-a-key';
const CREDENTIAL = 'OPENAI_API_KEY';
const USAGE = { input_tokens: 100, output_tokens: 40, total_tokens: 140 };
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SOURCE = 'SyntheticRobot raised USD 12 million on October 29, 2026.';
const TARGET = '合成机器人于2026年10月29日融资1200万美元。';

interface Submitted {
  id: string;
  source: string;
  style: string;
  professional: {
    project: string;
    context: string;
    terms: { id: string; source: string; target: string }[];
    location: string;
    nextSource: string;
    previousSource: string;
  };
}

function submitted(value: OpenAITransportRequest): Submitted {
  const body = JSON.parse(value.body) as { input: { content: string }[] };
  return JSON.parse(body.input[0].content) as Submitted;
}

function success(
  value: OpenAITransportRequest,
  translation = TARGET,
  id = submitted(value).id,
): OpenAITransportResponse {
  const body = JSON.parse(value.body) as { model: string };
  return {
    status: 200,
    body: JSON.stringify({
      object: 'response',
      id: 'resp_synthetic_cross_api',
      model: body.model,
      service_tier: 'default',
      status: 'completed',
      error: null,
      incomplete_details: null,
      usage: USAGE,
      output: [
        {
          id: 'msg_synthetic',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: JSON.stringify({ paragraphs: [{ id, translation }] }) },
          ],
        },
      ],
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let store: TaskStore;
let service: TaskService;
let runtime: LiveProviderRuntime;
let app: ReturnType<typeof createApp>;
let environment: NodeJS.ProcessEnv;
let transport: ReturnType<typeof vi.fn<OpenAITransport>>;

function open(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  environment = options.env ?? {
    ALLOW_REAL_TRANSLATION: 'true',
    TRANSLATION_MAX_BUDGET_USD: '1',
    [CREDENTIAL]: KEY,
  };
  transport = vi.fn(async (value) => success(value));
  runtime = new LiveProviderRuntime(
    store,
    environment,
    transport,
    createMockAdapter({ delayMs: 0 }),
  );
  service = new TaskService(store, runtime.adapter, options.timeoutMs ?? 1000);
  app = createApp(service, undefined, runtime);
}

beforeEach(() => {
  store = new TaskStore(':memory:');
  open();
});
afterEach(async () => {
  await service.shutdown();
  store.close();
  vi.restoreAllMocks();
});

async function saveSettings(overrides: Record<string, unknown> = {}) {
  const current = (await request(app).get('/api/provider-settings').expect(200)).body as {
    revision: number;
  };
  return request(app)
    .put('/api/provider-settings')
    .send({
      mode: 'custom',
      protocol: 'openai-responses',
      baseUrl: '',
      model: OPENAI_DEFAULT_MODEL,
      credentialRef: CREDENTIAL,
      expectedRevision: current.revision,
      ...overrides,
    });
}

async function start(overrides: Record<string, unknown> = {}, expected = 200) {
  const settings = (await request(app).get('/api/provider-settings').expect(200)).body as {
    revision: number;
  };
  return request(app)
    .post('/api/live-provider/start')
    .send({
      expectedRevision: settings.revision,
      acknowledgeCosts: true,
      confirmDataTransfer: true,
      budgetMicros: 1_000_000,
      maxOutputTokens: 256,
      ...overrides,
    })
    .expect(expected);
}

async function ready(overrides: Record<string, unknown> = {}) {
  expect((await saveSettings()).status).toBe(200);
  const saved = await request(app).get('/api/provider-settings').expect(200);
  expect(saved.body.protocol).toBe('openai-responses');
  await start(overrides);
}

async function task(text = SOURCE, extra: Record<string, unknown> = {}): Promise<Task> {
  return (
    await request(app)
      .post('/api/tasks')
      .send({
        text,
        style: 'faithful',
        project: 'Synthetic Project',
        context: 'Synthetic review context.',
        ...extra,
      })
      .expect(201)
  ).body as Task;
}

async function translate(value: Task, body: Record<string, unknown> = {}): Promise<Task> {
  await request(app).post(`/api/tasks/${value.id}/translate`).send(body).expect(202);
  await service.idle(value.id);
  return (await request(app).get(`/api/tasks/${value.id}`).expect(200)).body as Task;
}

function binary(res: Response, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', callback);
}

describe('offline settings and live activation gates', () => {
  it('loads, saves, creates a draft and arms without sending a provider request or exposing a key', async () => {
    const first = await request(app).get('/api/live-provider').expect(200);
    expect(first.body).toMatchObject({ mode: 'mock', ready: false, budget: { armed: false } });
    const saved = await saveSettings();
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      credentialRef: CREDENTIAL,
      credentialStatus: 'present',
      state: 'configured-unverified',
      realCallsEnabled: false,
      connectionTestAvailable: false,
    });
    const before = await task();
    expect(before.mode).toBe('mock');
    const active = await start();
    expect(active.body).toMatchObject({
      mode: 'live',
      ready: true,
      budget: { armed: true, spentMicros: 0, reservedMicros: 0 },
    });
    expect((await request(app).get('/api/config').expect(200)).body).toMatchObject({
      mode: 'real',
      ready: true,
    });
    const current = await request(app).get('/api/provider-settings').expect(200);
    expect(current.body.realCallsEnabled).toBe(true);
    expect(transport).not.toHaveBeenCalled();
    for (const value of [
      first.body,
      saved.body,
      active.body,
      current.body,
      store.getSetting('provider-settings-v1'),
    ])
      expect(JSON.stringify(value)).not.toContain(KEY);
  });

  it.each([
    [{ acknowledgeCosts: false }, 400, 'LIVE_CONSENT_REQUIRED'],
    [{ confirmDataTransfer: false }, 400, 'LIVE_CONSENT_REQUIRED'],
    [{ apiKey: KEY }, 400, 'LIVE_CONSENT_REQUIRED'],
    [{ expectedRevision: 0 }, 409, 'LIVE_SETTINGS_CONFLICT'],
    [{ budgetMicros: 1_000_001 }, 403, 'BUDGET_OPERATOR_GATE'],
    [{ budgetMicros: 0 }, 400, 'INVALID_BUDGET_AMOUNT'],
    [{ maxOutputTokens: 255 }, 400, 'INVALID_OUTPUT_LIMIT'],
    [{ maxOutputTokens: 8193 }, 400, 'INVALID_OUTPUT_LIMIT'],
  ])('rejects invalid activation %j', async (override, status, code) => {
    expect((await saveSettings()).status).toBe(200);
    const response = await start(override, status);
    expect(response.body.code).toBe(code);
    expect(runtime.status().ready).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 'LIVE_OPERATOR_GATE'],
    [
      { ALLOW_REAL_TRANSLATION: 'false', TRANSLATION_MAX_BUDGET_USD: '1', [CREDENTIAL]: KEY },
      'LIVE_OPERATOR_GATE',
    ],
    [
      { ALLOW_REAL_TRANSLATION: 'true', TRANSLATION_MAX_BUDGET_USD: '0', [CREDENTIAL]: KEY },
      'LIVE_OPERATOR_GATE',
    ],
    [{ ALLOW_REAL_TRANSLATION: 'true', TRANSLATION_MAX_BUDGET_USD: '1' }, 'CREDENTIAL_MISSING'],
  ])('missing operator approval or credentials %j prevents calls', async (env, code) => {
    await service.shutdown();
    open({ env });
    expect((await saveSettings()).status).toBe(200);
    const response = await start({}, code === 'CREDENTIAL_MISSING' ? 400 : 403);
    expect(response.body.code).toBe(code);
    expect(transport).not.toHaveBeenCalled();
  });

  it('unknown model prices and compatible custom endpoints cannot enable live transport', async () => {
    expect((await saveSettings({ model: 'unpriced-synthetic-model' })).status).toBe(200);
    expect((await start({}, 400)).body.code).toBe('UNPRICED_MODEL');
    expect(
      (
        await saveSettings({
          protocol: 'openai-compatible',
          baseUrl: 'https://api.vendor-example.org/v1',
        })
      ).status,
    ).toBe(200);
    expect((await start({}, 400)).body.code).toBe('OFFICIAL_PROVIDER_REQUIRED');
    const customOfficial = await saveSettings({ baseUrl: 'https://api.vendor-example.org/v1' });
    expect(customOfficial.status).toBe(400);
    expect(customOfficial.body.code).toBe('OFFICIAL_ENDPOINT_REQUIRED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('duplicate activation and editing active settings cannot reset or switch a budget', async () => {
    await ready();
    expect((await start({}, 409)).body.code).toBe('LIVE_ALREADY_ACTIVE');
    const attempt = await saveSettings({ model: OPENAI_MODELS[1].id });
    expect(attempt.status).toBe(409);
    expect(attempt.body.code).toBe('LIVE_SETTINGS_BUSY');
    expect(runtime.status().model).toBe(OPENAI_DEFAULT_MODEL);
    expect(transport).not.toHaveBeenCalled();
  });

  it('same-origin and JSON mutation guards also protect live control endpoints', async () => {
    await request(app)
      .post('/api/live-provider/start')
      .set('Origin', 'https://synthetic-attacker.example.com')
      .send({})
      .expect(403);
    await request(app).post('/api/live-provider/mock').type('text').send('synthetic').expect(415);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('Responses translation through persisted text and DOCX workflows', () => {
  it('sends stable paragraph IDs/context/terms, preserves numerical equivalents and never marks human approval', async () => {
    const term: TermInput = {
      layer: 'project',
      project: 'Synthetic Project',
      source: 'SyntheticRobot',
      target: '合成机器人',
      retainSource: false,
      note: 'Only synthetic project context.',
      priority: 10,
      enabled: true,
      caseSensitive: true,
      alternatives: [],
    };
    const termResponse = await request(app).post('/api/terminology').send(term).expect(201);
    await ready();
    const created = await task(`${SOURCE}\n\nSyntheticRobot is a synthetic robotics platform.`);
    const completed = await translate(created);
    expect(completed.status).toBe('completed');
    expect(completed.mode).toBe('real');
    expect(completed.provider).toEqual({
      provider: 'openai-responses',
      model: OPENAI_DEFAULT_MODEL,
    });
    expect(completed.paragraphs.map((paragraph) => paragraph.id)).toEqual(
      created.paragraphs.map((paragraph) => paragraph.id),
    );
    expect(completed.paragraphs.map((paragraph) => paragraph.translation)).toEqual([
      TARGET,
      TARGET,
    ]);
    const first = submitted(transport.mock.calls[0][0]);
    expect(first).toMatchObject({
      id: created.paragraphs[0].id,
      style: 'faithful',
      source: SOURCE,
      professional: {
        project: 'Synthetic Project',
        context: 'Synthetic review context.',
        terms: [{ id: termResponse.body.id, source: 'SyntheticRobot', target: '合成机器人' }],
        nextSource: created.paragraphs[1].source,
        previousSource: '',
      },
    });
    const findings = completed.professional!.review.findings.filter(
      (finding) => finding.paragraphId === created.paragraphs[0].id,
    );
    expect(
      findings.some((finding) => /NUMBER|CURRENCY|DATE|TERM_MISMATCH/.test(finding.code)),
    ).toBe(false);
    expect(completed.professional!.review.approvals).toEqual([]);
    expect(runtime.status().budget).toMatchObject({ spentMicros: 90, reservedMicros: 0 });
    expect((await request(app).get(`/api/tasks/${created.id}`).expect(200)).body).toEqual(
      completed,
    );
  });

  it('keeps visible numeric and terminology findings from live-shaped fake output for user review', async () => {
    await request(app)
      .post('/api/terminology')
      .send({
        layer: 'technical',
        project: '',
        source: 'SyntheticRobot',
        target: '合成机器人',
        retainSource: false,
        note: 'Synthetic only.',
        priority: 10,
        enabled: true,
        caseSensitive: true,
        alternatives: [],
      })
      .expect(201);
    transport.mockImplementation(async (value) => success(value, '该公司融资1300万美元。'));
    await ready();
    const completed = await translate(await task());
    expect(
      completed.professional!.review.findings.some(
        (finding) => finding.code === 'CURRENCY_MISMATCH',
      ),
    ).toBe(true);
    const terminology = completed.professional!.review.findings.find(
      (finding) => finding.code === 'TERM_MISMATCH',
    );
    expect(terminology).toMatchObject({
      paragraphId: completed.paragraphs[0].id,
      source: { text: 'SyntheticRobot' },
    });
    expect(completed.professional!.review.approvals).toEqual([]);
    const approved = await request(app)
      .post(`/api/tasks/${completed.id}/review`)
      .send({
        paragraphId: completed.paragraphs[0].id,
        expectedRevision: completed.paragraphs[0].revision,
        snapshotId: completed.professional!.snapshot.id,
        confirmed: true,
      })
      .expect(200);
    expect(approved.body.professional.review.approvals).toHaveLength(1);
    const edited = await request(app)
      .patch(`/api/tasks/${completed.id}/paragraphs/${completed.paragraphs[0].id}`)
      .send({
        expectedRevision: completed.paragraphs[0].revision,
        translation: TARGET,
      })
      .expect(200);
    expect(edited.body.professional.review.approvals).toEqual([]);
  });

  it('prevents a wrong returned paragraph ID from completing or applying a result', async () => {
    transport.mockImplementation(async (value) => success(value, TARGET, 'unrelated-synthetic-id'));
    await ready();
    const completed = await translate(await task());
    expect(completed.status).toBe('failed');
    expect(completed.paragraphs[0]).toMatchObject({
      status: 'failed',
      translation: '',
      revision: 0,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    // The paid-shaped response still reports valid usage; parsing failure is not a free retry.
    expect(runtime.status().budget).toMatchObject({ spentMicros: 45, reservedMicros: 0 });
  });

  it('preserves edits saved during a pending fake request and leaves other manual paragraphs untouched', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    transport.mockImplementation(async (value) => {
      entered.resolve();
      await release.promise;
      return success(value);
    });
    await ready();
    const created = await task(`${SOURCE}\n\nA second synthetic paragraph.`);
    await request(app)
      .patch(`/api/tasks/${created.id}/paragraphs/${created.paragraphs[1].id}`)
      .send({
        expectedRevision: 0,
        translation: '第二段人工保留。',
      })
      .expect(200);
    await request(app)
      .post(`/api/tasks/${created.id}/translate`)
      .send({ paragraphIds: [created.paragraphs[0].id] })
      .expect(202);
    await entered.promise;
    await request(app)
      .patch(`/api/tasks/${created.id}/paragraphs/${created.paragraphs[0].id}`)
      .send({
        expectedRevision: 0,
        translation: '等待中的人工修改。',
      })
      .expect(200);
    release.resolve();
    await service.idle(created.id);
    const completed = (await request(app).get(`/api/tasks/${created.id}`).expect(200)).body as Task;
    expect(completed.paragraphs.map((paragraph) => paragraph.translation)).toEqual([
      '等待中的人工修改。',
      '第二段人工保留。',
    ]);
    expect(completed.paragraphs.every((paragraph) => paragraph.edited)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('translates a simple DOCX table with stable cell mapping and exports latest saved text without auxiliary context', async () => {
    await ready();
    const bytes = makeDocx(
      p('Synthetic title', '<w:pStyle w:val="Heading1"/>') +
        '<w:p/>' +
        `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc>${p(SOURCE)}${p('Synthetic second cell paragraph.')}</w:tc></w:tr></w:tbl>`,
    );
    const imported = await request(app)
      .post('/api/docx/preflight')
      .set('Content-Type', MIME)
      .set('X-Filename', 'synthetic-live.docx')
      .send(bytes)
      .expect(201);
    expect(imported.body.report.status).not.toBe('blocked');
    const created = (
      await request(app)
        .post('/api/tasks/docx')
        .send({
          importId: imported.body.id,
          style: 'business',
          acknowledgeWarnings: true,
          project: 'Synthetic Project',
          context: 'Never export this synthetic auxiliary context.',
        })
        .expect(201)
    ).body as Task;
    const completed = await translate(created);
    expect(completed.status).toBe('completed');
    expect(completed.document).toEqual(created.document);
    expect(completed.paragraphs.map((paragraph) => paragraph.id)).toEqual(
      created.paragraphs.map((paragraph) => paragraph.id),
    );
    expect(transport.mock.calls.map(([value]) => submitted(value).id)).toEqual(
      created.paragraphs.map((paragraph) => paragraph.id),
    );
    expect(transport.mock.calls.map(([value]) => submitted(value).professional.location)).toEqual(
      created.paragraphs.map((paragraph) => paragraph.location),
    );
    const last = completed.paragraphs.at(-1)!;
    await request(app)
      .patch(`/api/tasks/${created.id}/paragraphs/${last.id}`)
      .send({
        expectedRevision: last.revision,
        translation: '最新人工译文 & <核对>。',
      })
      .expect(200);
    for (const mode of ['chinese', 'bilingual']) {
      const exported = await request(app)
        .get(`/api/tasks/${created.id}/docx?mode=${mode}`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      const files = await readArchive(exported.body as Buffer);
      const xml = files.entries.get('word/document.xml')!.toString();
      expect(xml).toContain('最新人工译文 &amp; &lt;核对&gt;。');
      expect(xml).not.toContain('Never export this synthetic auxiliary context.');
      expect(xml).not.toContain('Synthetic Project');
      expect(xml).not.toContain(KEY);
      if (mode === 'bilingual') expect(xml).toContain(SOURCE);
    }
  });
});

describe('finite failures, cancellation, provenance and persisted cumulative budget', () => {
  it.each([429, 503])(
    'retries HTTP %s at most three times while retaining every unknown reservation',
    async (status) => {
      transport.mockResolvedValue({
        status,
        retryAfter: '0',
        body: '{"error":{"message":"synthetic provider detail"}}',
      });
      await ready();
      const created = await task();
      const completed = await translate(created);
      expect(completed.status).toBe('failed');
      expect(transport).toHaveBeenCalledTimes(3);
      expect(runtime.ledger.summary()).toMatchObject({
        attempts: 3,
        unknownAttempts: 3,
        spentMicros: 0,
      });
      expect(runtime.ledger.summary().reservedMicros).toBeGreaterThan(0);
      expect(JSON.stringify(completed)).not.toContain('synthetic provider detail');
      expect(JSON.stringify(completed)).not.toContain(KEY);
    },
  );

  it('insufficient budget blocks sending and cannot be bypassed by manual retry', async () => {
    await ready({ budgetMicros: 1 });
    const created = await task();
    const failed = await translate(created);
    expect(failed.status).toBe('failed');
    await translate(failed);
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.ledger.summary()).toMatchObject({
      budgetMicros: 1,
      attempts: 0,
      reservedMicros: 0,
    });
  });

  it('budget insufficiency stops retries after an uncertain charged-shaped attempt', async () => {
    transport.mockResolvedValue({ status: 503, retryAfter: '0', body: '{}' });
    await ready({ budgetMicros: 2_500 });
    const completed = await translate(await task());
    expect(completed.status).toBe('failed');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.ledger.summary()).toMatchObject({
      attempts: 1,
      unknownAttempts: 1,
      spentMicros: 0,
    });
    expect(runtime.ledger.summary().reservedMicros).toBeGreaterThan(0);
  });

  it('timeouts abort each fake transport, bound retries and preserve unknown usage', async () => {
    await service.shutdown();
    open({ timeoutMs: 20 });
    let aborted = 0;
    transport.mockImplementation(
      (value) =>
        new Promise((_resolve, reject) => {
          value.signal.addEventListener(
            'abort',
            () => {
              aborted++;
              reject(new OpenAITransportError('CANCELLED'));
            },
            { once: true },
          );
        }),
    );
    await ready();
    expect((await translate(await task())).status).toBe('failed');
    expect(aborted).toBe(3);
    expect(runtime.ledger.summary()).toMatchObject({ attempts: 3, unknownAttempts: 3 });
  });

  it.each(['/stop', '/mock'])(
    '%s disarms first, cancels active tasks and prevents queued paragraphs from sending',
    async (path) => {
      const entered = deferred<void>();
      let aborted = false;
      transport.mockImplementation(
        (value) =>
          new Promise((_resolve, reject) => {
            entered.resolve();
            value.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new OpenAITransportError('CANCELLED'));
              },
              { once: true },
            );
          }),
      );
      await ready();
      const created = await task(`${SOURCE}\n\nSecond queued synthetic paragraph.`);
      await request(app).post(`/api/tasks/${created.id}/translate`).send({}).expect(202);
      await entered.promise;
      const stopped = await request(app).post(`/api/live-provider${path}`).send({}).expect(200);
      expect(stopped.body).toMatchObject({ ready: false, budget: { armed: false } });
      expect(stopped.body.mode).toBe(path === '/mock' ? 'mock' : 'real-disabled');
      await service.idle(created.id);
      expect(aborted).toBe(true);
      const saved = (await request(app).get(`/api/tasks/${created.id}`).expect(200)).body as Task;
      expect(saved.status).toBe('cancelled');
      expect(saved.paragraphs.every((paragraph) => !paragraph.translation)).toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(runtime.ledger.summary()).toMatchObject({ unknownAttempts: 1, spentMicros: 0 });
    },
  );

  it('rejects duplicate run requests and prevents activating live while a mock run is pending', async () => {
    expect((await saveSettings()).status).toBe(200);
    const created = await task();
    await request(app)
      .post(`/api/tasks/${created.id}/translate`)
      .send({ scenario: 'slow' })
      .expect(202);
    expect((await start({}, 409)).body.code).toBe('LIVE_TASK_BUSY');
    const duplicate = await request(app)
      .post(`/api/tasks/${created.id}/translate`)
      .send({})
      .expect(409);
    expect(duplicate.body.code).toBe('TASK_BUSY');
    await request(app).post(`/api/tasks/${created.id}/cancel`).send({}).expect(200);
    await service.idle(created.id);
    expect(transport).not.toHaveBeenCalled();
  });

  it('restart disarms and rearming preserves both spent and uncertain reservations', async () => {
    await ready();
    await translate(await task());
    transport.mockResolvedValue({ status: 401, body: '{}' });
    await translate(await task('A second synthetic source.'));
    const before = runtime.ledger.summary();
    expect(before.spentMicros).toBe(45);
    expect(before.reservedMicros).toBeGreaterThan(0);
    await service.shutdown();
    open();
    expect(runtime.status()).toMatchObject({
      mode: 'mock',
      ready: false,
      budget: {
        armed: false,
        spentMicros: before.spentMicros,
        reservedMicros: before.reservedMicros,
      },
    });
    expect(transport).not.toHaveBeenCalled();
    const restarted = await start();
    expect(restarted.body.budget).toMatchObject({
      spentMicros: before.spentMicros,
      reservedMicros: before.reservedMicros,
      remainingMicros: before.remainingMicros,
    });
    await request(app).post('/api/live-provider/stop').send({}).expect(200);
    expect((await start({ budgetMicros: 999_999 }, 409)).body.code).toBe('BUDGET_IMMUTABLE');
  });

  it('does not mix mock tasks or tasks from another saved model into a live run', async () => {
    const mockTask = await task();
    await ready();
    const wrongMode = await request(app)
      .post(`/api/tasks/${mockTask.id}/translate`)
      .send({})
      .expect(409);
    expect(wrongMode.body.code).toBe('MODE_MISMATCH');
    const oldModel = await task();
    await request(app).post('/api/live-provider/stop').send({}).expect(200);
    expect((await saveSettings({ model: OPENAI_MODELS[1].id })).status).toBe(200);
    await start();
    const wrongModel = await request(app)
      .post(`/api/tasks/${oldModel.id}/translate`)
      .send({})
      .expect(409);
    expect(wrongModel.body.code).toBe('MODEL_MISMATCH');
    expect(transport).not.toHaveBeenCalled();
  });
});
