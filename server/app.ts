import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_CHARACTERS, MAX_PARAGRAPHS } from '../shared/types.js';
import { TaskService, ApiError } from './service.js';
import { randomUUID } from 'node:crypto';
import { DOCX_LIMITS } from '../shared/docx.js';
import { DocxError, parseDocx } from './docx/parse.js';
import { ExportError, exportDocx } from './docx/export.js';
import { createProviderSettingsRouter } from './provider-settings.js';
import {
  createLiveProviderRouter,
  LiveProviderError,
  type LiveProviderRuntime,
} from './live-provider.js';
import { BudgetError } from './openai-budget.js';
import { TermValidationError } from './terminology.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function uploadFilename(header: string | undefined): string {
  if (!header || header.length > 1500)
    throw new ApiError(400, '请提供有效的 DOCX 文件名。', 'INVALID_DOCX_FILENAME');
  let filename: string;
  try {
    filename = decodeURIComponent(header);
  } catch {
    throw new ApiError(400, 'DOCX 文件名编码无效。', 'INVALID_DOCX_FILENAME');
  }
  if (
    filename.length > 255 ||
    filename !== filename.trim() ||
    !/^[^/\\]+\.docx$/i.test(filename) ||
    Array.from(filename).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new ApiError(400, '仅支持文件名合法的 .docx 文件。', 'INVALID_DOCX_FILENAME');
  }
  return filename;
}
function attachmentFilename(filename: string, mode: 'chinese' | 'bilingual'): string {
  const name = `${filename.replace(/\.docx$/i, '')}-${mode === 'chinese' ? '中文' : '双语'}.docx`;
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="ir-translation-${mode}.docx"; filename*=UTF-8''${encoded}`;
}

export function createApp(
  service: TaskService,
  extraOrigin?: string,
  runtime?: LiveProviderRuntime,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
      const origin = req.headers.origin;
      const allowed = new Set([
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        ...(extraOrigin ? [extraOrigin] : []),
      ]);
      if (origin && !allowed.has(origin))
        return next(new ApiError(403, '请求来源未获允许。', 'ORIGIN_REJECTED'));
      const docxUpload = req.method === 'POST' && req.path === '/docx/preflight';
      if (docxUpload ? !req.is(DOCX_MIME) : !req.is('application/json')) {
        return next(
          new ApiError(
            415,
            docxUpload ? '请上传 DOCX 原始文件内容。' : '请使用 JSON 请求。',
            'CONTENT_TYPE_REQUIRED',
          ),
        );
      }
    }
    next();
  });
  app.post(
    '/api/docx/preflight',
    express.raw({ type: DOCX_MIME, limit: DOCX_LIMITS.uploadBytes, inflate: false }),
    async (req, res) => {
      const filename = uploadFilename(req.get('X-Filename'));
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new ApiError(400, '请选择非空的 DOCX 文件。', 'EMPTY_DOCX_UPLOAD');
      }
      const parsed = await parseDocx(req.body, filename);
      const record = service.store.saveImport({
        id: randomUUID(),
        document: parsed.document,
        report: parsed.report,
      });
      res.status(201).json(record);
    },
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(
    '/api/provider-settings',
    createProviderSettingsRouter(
      service.store,
      runtime?.environment,
      runtime
        ? { beforeSave: () => runtime.beforeSave(), enabled: () => runtime.status().ready }
        : undefined,
    ),
  );
  if (runtime) app.use('/api/live-provider', createLiveProviderRouter(runtime, service));
  app.get('/api/config', (_req, res) =>
    res.json({
      mode: service.adapter.mode,
      ready: service.adapter.ready,
      label: service.adapter.label,
      maxCharacters: MAX_CHARACTERS,
      maxParagraphs: MAX_PARAGRAPHS,
    }),
  );
  app.get('/api/terminology', (_req, res) => res.json(service.listTerms()));
  app.post('/api/terminology', (req, res) => res.status(201).json(service.createTerm(req.body)));
  app.patch('/api/terminology/:id', (req, res) =>
    res.json(service.updateTerm(req.params.id, req.body)),
  );
  app.post('/api/tasks/:id/terminology-preview', (req, res) =>
    res.json(service.previewTerminology(req.params.id, req.body)),
  );
  app.post('/api/tasks/:id/terminology-apply', (req, res) =>
    res.json(service.applyTerminology(req.params.id, req.body)),
  );
  app.post('/api/tasks/:id/review', (req, res) =>
    res.json(service.confirmReview(req.params.id, req.body)),
  );
  app.get('/api/tasks', (_req, res) => res.json(service.store.list()));
  app.post('/api/tasks', (req, res) => res.status(201).json(service.create(req.body)));
  app.post('/api/tasks/docx', (req, res) => res.status(201).json(service.createFromDocx(req.body)));
  app.get('/api/tasks/:id/docx', async (req, res) => {
    const mode = req.query.mode;
    if (mode !== 'chinese' && mode !== 'bilingual') {
      throw new ApiError(400, '请选择中文或双语 DOCX 导出。', 'INVALID_EXPORT_MODE');
    }
    const task = service.get(req.params.id);
    if (!task.document)
      throw new ApiError(409, '该任务来自粘贴文本，没有 DOCX 结构。', 'DOCX_REQUIRED');
    if (
      !task.paragraphs.length ||
      task.paragraphs.some(
        (paragraph) => paragraph.status !== 'done' || !paragraph.translation.trim(),
      )
    ) {
      throw new ApiError(409, '请完成并保存所有段落后再导出 DOCX。', 'DOCX_INCOMPLETE');
    }
    const buffer = await exportDocx(task, mode);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', attachmentFilename(task.document.filename, mode));
    res.send(buffer);
  });
  app.get('/api/tasks/:id', (req, res) => res.json(service.get(req.params.id)));
  app.patch('/api/tasks/:id/paragraphs/:paragraphId', (req, res) =>
    res.json(service.edit(req.params.id, req.params.paragraphId, req.body)),
  );
  app.post('/api/tasks/:id/translate', (req, res) =>
    res.status(202).json(service.translate(req.params.id, req.body)),
  );
  app.post('/api/tasks/:id/cancel', (req, res) => res.json(service.cancel(req.params.id)));
  app.use('/api', (_req, _res, next) => next(new ApiError(404, '接口不存在。', 'NOT_FOUND')));
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*splat}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  const onError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    void next; // Keep Express error middleware arity without reflecting internal errors.
    if (
      error instanceof ApiError ||
      error instanceof LiveProviderError ||
      error instanceof BudgetError ||
      error instanceof DocxError ||
      error instanceof ExportError ||
      error instanceof TermValidationError
    ) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    // Never reflect provider bodies, source text, credentials, or raw exception messages.
    const status =
      typeof error === 'object' && error && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 500;
    res.status(status >= 400 && status < 500 ? status : 500).json({
      error:
        status === 413
          ? '请求内容过大。'
          : status === 400
            ? '请求格式错误。'
            : status === 415
              ? '不支持该请求编码或内容格式。'
              : '服务暂时不可用，请重试。',
      code:
        status === 413
          ? 'BODY_TOO_LARGE'
          : status === 400
            ? 'INVALID_JSON'
            : status === 415
              ? 'UNSUPPORTED_BODY_ENCODING'
              : 'INTERNAL_ERROR',
    });
  };
  app.use(onError);
  return app;
}
