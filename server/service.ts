import { randomUUID } from 'node:crypto';
import {
  MAX_CHARACTERS,
  MAX_PARAGRAPHS,
  type MockScenario,
  type Style,
  type Task,
  type TaskStatus,
} from '../shared/types.js';
import { ProviderError, safeProviderMessage, type TranslationAdapter } from './adapter.js';
import { TaskStore } from './store.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
  }
}
const scenarios: MockScenario[] = [
  'normal',
  'slow',
  'timeout',
  'rate-limit',
  'server-error',
  'partial',
  'malformed',
];
const styles: Style[] = ['faithful', 'business'];
interface Run {
  controller: AbortController;
  promise: Promise<void>;
  ids: Set<string>;
  revisions: Map<string, number>;
}
function resultStatus(task: Task): TaskStatus {
  if (task.paragraphs.every((p) => p.status === 'done')) return 'completed';
  if (task.paragraphs.some((p) => p.status === 'done')) return 'partial';
  if (task.paragraphs.some((p) => p.status === 'failed')) return 'failed';
  if (task.paragraphs.some((p) => p.status === 'cancelled')) return 'cancelled';
  return 'draft';
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError('CANCELLED', false, '操作已取消。'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('CANCELLED', false, '操作已取消。'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export class TaskService {
  private runs = new Map<string, Run>();
  constructor(
    public store: TaskStore,
    public adapter: TranslationAdapter,
    private timeoutMs = 3000,
  ) {
    store.recoverInterrupted();
  }
  get(id: string): Task {
    const task = this.store.get(id);
    if (!task) throw new ApiError(404, '任务不存在。', 'NOT_FOUND');
    return task;
  }
  create(body: unknown): Task {
    if (!body || typeof body !== 'object')
      throw new ApiError(400, '请提供英文文本与文体。', 'INVALID_INPUT');
    const { text, style, title } = body as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim())
      throw new ApiError(400, '请输入英文文本。', 'EMPTY_INPUT');
    if (text.length > MAX_CHARACTERS)
      throw new ApiError(400, `文本不能超过 ${MAX_CHARACTERS} 字符。`, 'TOO_LONG');
    if (!styles.includes(style as Style))
      throw new ApiError(400, '请选择有效文体。', 'INVALID_STYLE');
    if (title !== undefined && (typeof title !== 'string' || title.length > 120))
      throw new ApiError(400, '任务名称不能超过 120 字符。', 'INVALID_TITLE');
    const chunks = text
      .replace(/\r\n?/g, '\n')
      .trim()
      .split(/\n[\t ]*\n+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (chunks.length > MAX_PARAGRAPHS)
      throw new ApiError(400, `文本不能超过 ${MAX_PARAGRAPHS} 段。`, 'TOO_MANY_PARAGRAPHS');
    const now = new Date().toISOString();
    return this.store.save({
      id: randomUUID(),
      title: typeof title === 'string' && title.trim() ? title.trim() : chunks[0].slice(0, 60),
      style: style as Style,
      status: 'draft',
      mode: this.adapter.mode,
      createdAt: now,
      updatedAt: now,
      paragraphs: chunks.map((source) => ({
        id: randomUUID(),
        source,
        translation: '',
        revision: 0,
        edited: false,
        status: 'pending',
        error: null,
      })),
    });
  }
  edit(id: string, paragraphId: string, body: unknown): Task {
    const task = this.get(id);
    const p = task.paragraphs.find((p) => p.id === paragraphId);
    if (!p) throw new ApiError(404, '段落不存在。', 'NOT_FOUND');
    if (!body || typeof body !== 'object')
      throw new ApiError(400, '无效保存内容。', 'INVALID_INPUT');
    const { translation, expectedRevision } = body as Record<string, unknown>;
    if (
      typeof translation !== 'string' ||
      translation.length > MAX_CHARACTERS * 3 ||
      !Number.isInteger(expectedRevision)
    )
      throw new ApiError(400, '保存内容或版本号无效。', 'INVALID_INPUT');
    if (p.revision !== expectedRevision)
      throw new ApiError(
        409,
        '该段落已更新，请重新打开后再保存。您的草稿仍保留在编辑框中。',
        'REVISION_CONFLICT',
      );
    p.translation = translation;
    p.edited = true;
    p.revision += 1;
    p.status = translation.trim() ? 'done' : 'pending';
    p.error = null;
    if (!this.runs.has(id)) task.status = resultStatus(task);
    return this.store.save(task);
  }
  translate(id: string, body: unknown): Task {
    const task = this.get(id);
    if (this.runs.has(id)) throw new ApiError(409, '该任务正在翻译，请等待或取消。', 'TASK_BUSY');
    if (!this.adapter.ready)
      throw new ApiError(503, '真实翻译服务尚未配置或未显式启用。', 'PROVIDER_UNAVAILABLE');
    if (task.mode !== this.adapter.mode)
      throw new ApiError(
        409,
        '该任务的服务模式与当前配置不同，请新建任务以避免混用模拟内容。',
        'MODE_MISMATCH',
      );
    const request = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const scenario = request.scenario ?? 'normal';
    if (!scenarios.includes(scenario as MockScenario))
      throw new ApiError(400, '无效模拟场景。', 'INVALID_SCENARIO');
    if (this.adapter.mode === 'real' && scenario !== 'normal')
      throw new ApiError(400, '真实模式不支持模拟场景。', 'INVALID_SCENARIO');
    let selected: string[];
    if (request.paragraphIds !== undefined) {
      const ids = request.paragraphIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some((x) => typeof x !== 'string') ||
        ids.length > MAX_PARAGRAPHS
      )
        throw new ApiError(400, '请选择有效段落。', 'INVALID_SELECTION');
      selected = [...new Set(ids as string[])];
      if (selected.some((id) => !task.paragraphs.some((p) => p.id === id)))
        throw new ApiError(400, '所选段落不存在。', 'INVALID_SELECTION');
    } else
      selected = task.paragraphs.filter((p) => !p.edited && p.status !== 'done').map((p) => p.id);
    if (!selected.length)
      throw new ApiError(
        400,
        '没有待翻译段落。人工修改段落仅可明确选择后重译。',
        'NOTHING_TO_TRANSLATE',
      );
    const controller = new AbortController();
    const run: Run = {
      controller,
      ids: new Set(selected),
      revisions: new Map(
        task.paragraphs.filter((p) => selected.includes(p.id)).map((p) => [p.id, p.revision]),
      ),
      promise: Promise.resolve(),
    };
    this.runs.set(id, run);
    task.status = 'running';
    for (const p of task.paragraphs)
      if (run.ids.has(p.id)) {
        p.status = 'pending';
        p.error = null;
      }
    this.store.save(task);
    // A microtask begins only after the request snapshot and lock are stored.
    run.promise = Promise.resolve().then(() => this.execute(id, run, scenario as MockScenario));
    return task;
  }
  cancel(id: string): Task {
    const task = this.get(id);
    const run = this.runs.get(id);
    if (!run) return task;
    run.controller.abort();
    for (const p of task.paragraphs)
      if (run.ids.has(p.id) && (p.status === 'pending' || p.status === 'running')) {
        p.status = 'cancelled';
        p.error = '已取消；保留已完成结果与人工修改。';
      }
    task.status = 'cancelled';
    return this.store.save(task);
  }
  private async callWithRetry(
    input: Parameters<TranslationAdapter['translate']>[0],
    signal: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new ProviderError('CANCELLED', false, '操作已取消。');
      const attemptController = new AbortController();
      const abort = () => attemptController.abort();
      signal.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            attemptController.abort();
            reject(new ProviderError('TIMEOUT', true, '翻译请求超时，请重试。'));
          }, this.timeoutMs);
        });
        const cancelled = new Promise<never>((_, reject) => {
          attemptController.signal.addEventListener(
            'abort',
            () =>
              reject(
                new ProviderError(
                  signal.aborted ? 'CANCELLED' : 'TIMEOUT',
                  !signal.aborted,
                  signal.aborted ? '操作已取消。' : '翻译请求超时，请重试。',
                ),
              ),
            { once: true },
          );
        });
        const value = await Promise.race([
          this.adapter.translate(input, attemptController.signal),
          timeout,
          cancelled,
        ]);
        if (typeof value !== 'string' || !value.trim() || value.length > MAX_CHARACTERS * 3)
          throw new ProviderError('INVALID_RESPONSE', false, '服务返回内容格式错误，请重试。');
        return value;
      } catch (error) {
        if (signal.aborted) throw new ProviderError('CANCELLED', false, '操作已取消。');
        const safe =
          error instanceof ProviderError
            ? error
            : new ProviderError('PROVIDER_ERROR', true, '翻译服务暂时不可用，请重试。');
        if (!safe.retryable || attempt === 2) throw safe;
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
      await wait(120 * (attempt + 1), signal);
    }
    throw new ProviderError('PROVIDER_ERROR', true, '翻译服务暂时不可用，请重试。');
  }
  private async execute(id: string, run: Run, scenario: MockScenario): Promise<void> {
    try {
      const initial = this.get(id);
      for (let index = 0; index < initial.paragraphs.length; index++) {
        const paragraphId = initial.paragraphs[index].id;
        if (!run.ids.has(paragraphId) || run.controller.signal.aborted) continue;
        const task = this.get(id);
        const p = task.paragraphs.find((p) => p.id === paragraphId)!;
        // Capture the revision at invocation, then compare before applying its result.
        const revision = run.revisions.get(paragraphId)!;
        if (p.revision !== revision) continue;
        p.status = 'running';
        this.store.save(task);
        try {
          const translation = await this.callWithRetry(
            { source: p.source, style: task.style, paragraphIndex: index, scenario },
            run.controller.signal,
          );
          if (run.controller.signal.aborted) break;
          const current = this.get(id);
          const target = current.paragraphs.find((p) => p.id === paragraphId)!;
          if (target.revision === revision) {
            target.translation = translation;
            target.revision += 1;
            target.edited = false;
            target.status = 'done';
            target.error = null;
            this.store.save(current);
          }
        } catch (error) {
          const current = this.get(id);
          const target = current.paragraphs.find((p) => p.id === paragraphId)!;
          if (target.revision !== revision) continue;
          if (run.controller.signal.aborted) {
            target.status = 'cancelled';
            target.error = '已取消；可手动重试。';
          } else {
            target.status = 'failed';
            target.error =
              error instanceof ProviderError
                ? safeProviderMessage(error.code)
                : '翻译服务暂时不可用，请重试。';
          }
          this.store.save(current);
        }
      }
    } finally {
      const current = this.get(id);
      if (run.controller.signal.aborted) {
        for (const p of current.paragraphs)
          if (run.ids.has(p.id) && (p.status === 'pending' || p.status === 'running')) {
            p.status = 'cancelled';
            p.error = '已取消；可手动重试。';
          }
      }
      current.status = run.controller.signal.aborted ? 'cancelled' : resultStatus(current);
      this.store.save(current);
      this.runs.delete(id);
    }
  }
  async idle(id: string): Promise<void> {
    await this.runs.get(id)?.promise;
  }
  async shutdown(): Promise<void> {
    for (const id of this.runs.keys()) this.cancel(id);
    await Promise.all([...this.runs.values()].map((run) => run.promise));
  }
}
