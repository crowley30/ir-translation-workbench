import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from './store.js';
import { ApiError, TaskService } from './service.js';
import {
  createMockAdapter,
  createRealAdapter,
  ProviderError,
  safeProviderMessage,
} from './adapter.js';

const open: TaskStore[] = [];
const services: TaskService[] = [];
function service(
  adapter = createMockAdapter({ delayMs: 0, timeoutMs: 1 }),
  timeout = 100,
): TaskService {
  const store = new TaskStore(':memory:');
  open.push(store);
  const value = new TaskService(store, adapter, timeout);
  services.push(value);
  return value;
}
function makeTask(
  value: TaskService,
  text = 'Synthetic Fund raised USD 10 million.\n\nWe invest in AI and robotics.',
) {
  return value.create({ text, style: 'faithful' });
}
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown();
  for (const db of open.splice(0)) db.close();
});

describe('task lifecycle, limits and persistence', () => {
  it('splits blank-line paragraphs, retaining single-line content and source', () => {
    const s = service();
    const task = makeTask(s, '  Hello\r\nworld\r\n \r\nAnother paragraph.  ');
    expect(task.paragraphs.map((p) => p.source)).toEqual(['Hello\nworld', 'Another paragraph.']);
    expect(task.mode).toBe('mock');
    expect(task.status).toBe('draft');
  });
  it.each([
    [{ text: '', style: 'faithful' }, 'EMPTY_INPUT'],
    [{ text: ' \n ', style: 'business' }, 'EMPTY_INPUT'],
    [{ text: 'a'.repeat(20001), style: 'faithful' }, 'TOO_LONG'],
    [{ text: Array(101).fill('x').join('\n\n'), style: 'faithful' }, 'TOO_MANY_PARAGRAPHS'],
    [{ text: 'x', style: 'invented' }, 'INVALID_STYLE'],
    [{ text: 'x', style: 'business', title: 'x'.repeat(121) }, 'INVALID_TITLE'],
  ])('rejects invalid inputs %#', (body, code) => {
    expect(() => service().create(body)).toThrow(expect.objectContaining({ code }));
  });
  it('persists edits and completed results across a new SQLite connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ir-store-'));
    const path = join(dir, 'work.sqlite');
    const store = new TaskStore(path);
    const s = new TaskService(store, createMockAdapter({ delayMs: 0 }));
    const task = makeTask(s);
    s.translate(task.id, {});
    await s.idle(task.id);
    const result = s.get(task.id);
    s.edit(task.id, result.paragraphs[0].id, {
      translation: '合成样本人工译文',
      expectedRevision: result.paragraphs[0].revision,
    });
    store.close();
    const restored = new TaskStore(path);
    expect(restored.get(task.id)?.paragraphs[0]).toMatchObject({
      translation: '合成样本人工译文',
      edited: true,
      revision: 2,
    });
    expect(restored.list()).toHaveLength(1);
    restored.close();
    rmSync(dir, { recursive: true });
  });
  it('recovers interrupted running tasks without retrying or losing completed work', () => {
    const s = service();
    const task = makeTask(s);
    task.status = 'running';
    task.paragraphs[0].status = 'done';
    task.paragraphs[0].translation = 'already saved';
    task.paragraphs[1].status = 'running';
    s.store.save(task);
    const translate = vi.fn();
    new TaskService(s.store, { mode: 'mock', ready: true, label: 'mock', translate });
    const recovered = s.get(task.id);
    expect(recovered.status).toBe('cancelled');
    expect(recovered.paragraphs[0].translation).toBe('already saved');
    expect(recovered.paragraphs[1]).toMatchObject({
      status: 'cancelled',
      error: expect.stringContaining('中断'),
    });
    expect(translate).not.toHaveBeenCalled();
  });
});

describe('translation protection, locking and cancellation', () => {
  it('locks repeated starts until the active run ends', async () => {
    const s = service();
    const task = makeTask(s);
    s.translate(task.id, {});
    expect(() => s.translate(task.id, {})).toThrow(
      expect.objectContaining({ status: 409, code: 'TASK_BUSY' }),
    );
    await s.idle(task.id);
    expect(s.get(task.id).status).toBe('completed');
    expect(() => s.translate(task.id, {})).toThrow(
      expect.objectContaining({ code: 'NOTHING_TO_TRANSLATE' }),
    );
  });
  it('retranslates only explicitly selected paragraphs and protects other manual edits', async () => {
    const s = service();
    const task = makeTask(s);
    const [first, second] = task.paragraphs;
    s.edit(task.id, first.id, { translation: '人工修改一', expectedRevision: 0 });
    s.edit(task.id, second.id, { translation: '人工修改二', expectedRevision: 0 });
    s.translate(task.id, { paragraphIds: [second.id] });
    await s.idle(task.id);
    expect(s.get(task.id).paragraphs[0]).toMatchObject({
      translation: '人工修改一',
      edited: true,
      revision: 1,
    });
    expect(s.get(task.id).paragraphs[1]).toMatchObject({
      translation: expect.stringContaining('[模拟占位·非译文]'),
      edited: false,
      revision: 2,
    });
  });
  it('never applies stale results over in-flight or queued manual edits', async () => {
    let resolve!: (value: string) => void;
    const translate = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const s = service({ mode: 'mock', ready: true, label: 'test', translate });
    const task = makeTask(s);
    s.translate(task.id, {});
    await Promise.resolve();
    s.edit(task.id, task.paragraphs[0].id, { translation: '运行中人工修改', expectedRevision: 0 });
    s.edit(task.id, task.paragraphs[1].id, { translation: '排队时人工修改', expectedRevision: 0 });
    resolve('stale model result');
    await s.idle(task.id);
    expect(s.get(task.id).paragraphs.map((p) => p.translation)).toEqual([
      '运行中人工修改',
      '排队时人工修改',
    ]);
    expect(translate).toHaveBeenCalledTimes(1);
  });
  it('uses optimistic revision conflicts instead of overwriting newer edits', () => {
    const s = service();
    const task = makeTask(s);
    s.edit(task.id, task.paragraphs[0].id, { translation: 'new', expectedRevision: 0 });
    expect(() =>
      s.edit(task.id, task.paragraphs[0].id, { translation: 'old', expectedRevision: 0 }),
    ).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    expect(s.get(task.id).paragraphs[0].translation).toBe('new');
  });
  it('cancels an uncooperative adapter promptly and permits explicit retry', async () => {
    let hang = true;
    const translate = vi.fn(async () =>
      hang ? new Promise<string>(() => {}) : '[模拟占位·非译文] retry',
    );
    const s = service({ mode: 'mock', ready: true, label: 'test', translate }, 1000);
    const task = makeTask(s);
    s.translate(task.id, {});
    await Promise.resolve();
    s.cancel(task.id);
    await s.idle(task.id);
    expect(s.get(task.id).status).toBe('cancelled');
    expect(s.get(task.id).paragraphs.every((p) => p.status === 'cancelled')).toBe(true);
    hang = false;
    s.translate(task.id, {});
    await s.idle(task.id);
    expect(s.get(task.id).status).toBe('completed');
  });
  it('rejects unknown selection IDs before changing any status', () => {
    const s = service();
    const task = makeTask(s);
    expect(() => s.translate(task.id, { paragraphIds: ['missing'] })).toThrow(ApiError);
    expect(s.get(task.id).status).toBe('draft');
  });
});

describe('bounded failures and retry', () => {
  it.each(['rate-limit', 'server-error', 'timeout'] as const)(
    'limits %s to three attempts and permits user retry',
    async (scenario) => {
      const delegate = createMockAdapter({ delayMs: 0, timeoutMs: 0 });
      const translate = vi.fn(delegate.translate);
      const s = service({ ...delegate, translate });
      const task = makeTask(s, 'Synthetic USD amount.');
      s.translate(task.id, { scenario });
      await s.idle(task.id);
      expect(translate).toHaveBeenCalledTimes(3);
      expect(s.get(task.id).status).toBe('failed');
      s.translate(task.id, {});
      await s.idle(task.id);
      expect(s.get(task.id).status).toBe('completed');
    },
  );
  it('enforces timeout even if an adapter never settles', async () => {
    const translate = vi.fn(async () => new Promise<string>(() => {}));
    const s = service({ mode: 'mock', ready: true, label: 'test', translate }, 5);
    const task = makeTask(s, 'x');
    s.translate(task.id, {});
    await s.idle(task.id);
    expect(translate).toHaveBeenCalledTimes(3);
    expect(s.get(task.id).paragraphs[0].error).toContain('超时');
  });
  it('keeps successful paragraphs when a later paragraph fails', async () => {
    const s = service();
    const task = makeTask(s);
    s.translate(task.id, { scenario: 'partial' });
    await s.idle(task.id);
    const result = s.get(task.id);
    expect(result.status).toBe('partial');
    expect(result.paragraphs.map((p) => p.status)).toEqual(['done', 'failed']);
    const saved = result.paragraphs[0];
    s.translate(task.id, {});
    await s.idle(task.id);
    expect(s.get(task.id).paragraphs[0]).toEqual(saved);
    expect(s.get(task.id).status).toBe('completed');
  });
  it('rejects malformed output without retrying or replacing saved text', async () => {
    const translate = vi.fn(async () => '');
    const s = service({ mode: 'mock', ready: true, label: 'test', translate });
    const task = makeTask(s, 'x');
    s.edit(task.id, task.paragraphs[0].id, {
      translation: 'Saved human text',
      expectedRevision: 0,
    });
    s.translate(task.id, { paragraphIds: [task.paragraphs[0].id] });
    await s.idle(task.id);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(s.get(task.id).paragraphs[0]).toMatchObject({
      status: 'failed',
      translation: 'Saved human text',
      edited: true,
    });
  });
  it('redacts unexpected provider exceptions', async () => {
    const translate = vi.fn(async () => {
      throw new Error('sensitive provider response and credential');
    });
    const s = service({ mode: 'mock', ready: true, label: 'test', translate });
    const task = makeTask(s, 'x');
    s.translate(task.id, {});
    await s.idle(task.id);
    expect(s.get(task.id).paragraphs[0].error).not.toContain('credential');
  });
  it('redacts arbitrary messages on classified provider errors', async () => {
    const translate = vi.fn(async () => {
      throw new ProviderError('TIMEOUT', false, 'sensitive credential and provider body');
    });
    const s = service({ mode: 'mock', ready: true, label: 'test', translate });
    const task = makeTask(s, 'x');
    s.translate(task.id, {});
    await s.idle(task.id);
    expect(s.get(task.id).paragraphs[0].error).toContain('超时');
    expect(s.get(task.id).paragraphs[0].error).not.toContain('sensitive');
  });
  it('preserves real mode unconfigured and refuses calls, with no fallback', () => {
    const translate = vi.fn(async () => {
      throw new ProviderError('NOT_CONFIGURED', false);
    });
    const s = service({ mode: 'real', ready: false, label: 'unconfigured', translate });
    const task = makeTask(s);
    expect(task.mode).toBe('real');
    expect(() => s.translate(task.id, {})).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
    expect(translate).not.toHaveBeenCalled();
  });
});

describe('real adapter completion validation at persistence boundary', () => {
  const config = {
    apiUrl: 'https://synthetic.example/v1/chat/completions',
    apiKey: 'synthetic-service-placeholder',
    model: 'synthetic-model',
    enabled: true,
  };
  const content = JSON.stringify({ translation: '合成样本：不得保存的不完整结果。' });
  const message = { role: 'assistant', content, refusal: null };
  const choice = { index: 0, finish_reason: 'stop', message };
  const rejected = [
    ['truncated valid JSON', { ...choice, finish_reason: 'length' }, 'INCOMPLETE_RESPONSE'],
    ['filtered valid JSON', { ...choice, finish_reason: 'content_filter' }, 'PROVIDER_REFUSAL'],
    [
      'refused valid JSON',
      { ...choice, message: { ...message, refusal: 'synthetic refusal body' } },
      'PROVIDER_REFUSAL',
    ],
    ['missing finish reason', { index: 0, message }, 'INVALID_RESPONSE'],
    ['null finish reason', { ...choice, finish_reason: null }, 'INVALID_RESPONSE'],
    [
      'unknown finish reason',
      { ...choice, finish_reason: 'synthetic_unknown' },
      'INVALID_RESPONSE',
    ],
    ['tool-call completion', { ...choice, finish_reason: 'tool_calls' }, 'INVALID_RESPONSE'],
    ['function-call completion', { ...choice, finish_reason: 'function_call' }, 'INVALID_RESPONSE'],
    [
      'non-assistant message',
      { ...choice, message: { ...message, role: 'user' } },
      'INVALID_RESPONSE',
    ],
    [
      'tool-call message',
      {
        ...choice,
        message: { ...message, tool_calls: [{ id: 'synthetic-call', type: 'function' }] },
      },
      'INVALID_RESPONSE',
    ],
    [
      'function-call message',
      {
        ...choice,
        message: { ...message, function_call: { name: 'synthetic_function', arguments: '{}' } },
      },
      'INVALID_RESPONSE',
    ],
    ['unsupported choice index', { ...choice, index: 1 }, 'INVALID_RESPONSE'],
  ] as const;

  describe.each([
    ['new paragraph', false],
    ['explicit retranslation of saved human work', true],
  ] as const)('%s', (_label, hasPreviousTranslation) => {
    it.each(rejected)(
      'rejects %s without persisting success or retrying',
      async (_name, providerChoice, code) => {
        const fetchImpl = vi.fn(
          async () => new Response(JSON.stringify({ choices: [providerChoice] })),
        );
        const s = service(createRealAdapter(config, fetchImpl), 1000);
        const task = makeTask(s, 'Synthetic AI investment: USD 10 million.');
        const paragraphId = task.paragraphs[0].id;
        const before = hasPreviousTranslation
          ? s.edit(task.id, paragraphId, {
              translation: '合成样本：已保存的人工译文。',
              expectedRevision: 0,
            }).paragraphs[0]
          : task.paragraphs[0];

        s.translate(task.id, hasPreviousTranslation ? { paragraphIds: [paragraphId] } : {});
        await s.idle(task.id);

        const persisted = s.store.get(task.id)!;
        expect(persisted.mode).toBe('real');
        expect(persisted.status).toBe('failed');
        expect(persisted.paragraphs[0]).toMatchObject({
          status: 'failed',
          translation: before.translation,
          revision: before.revision,
          edited: before.edited,
          error: safeProviderMessage(code),
        });
        expect(persisted.paragraphs[0].translation).not.toContain('不得保存');
        expect(persisted.paragraphs[0].error).not.toContain('synthetic refusal body');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('allows an explicit successful retry only after the provider reports a supported complete response', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ choices: [{ ...choice, finish_reason: 'length' }] })),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  ...choice,
                  message: {
                    ...message,
                    content: JSON.stringify({ translation: '合成样本：完整的中文译文。' }),
                  },
                },
              ],
            }),
          ),
      );
    const s = service(createRealAdapter(config, fetchImpl), 1000);
    const task = makeTask(s, 'Synthetic complete provider response.');
    s.translate(task.id, {});
    await s.idle(task.id);
    expect(s.get(task.id).status).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    s.translate(task.id, {});
    await s.idle(task.id);

    expect(s.get(task.id).status).toBe('completed');
    expect(s.get(task.id).paragraphs[0]).toMatchObject({
      status: 'done',
      translation: '合成样本：完整的中文译文。',
      revision: 1,
      edited: false,
      error: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
