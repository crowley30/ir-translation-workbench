import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_CHARACTERS, MAX_PARAGRAPHS } from '../shared/types.js';
import { TaskService, ApiError } from './service.js';

export function createApp(service: TaskService, extraOrigin?: string) {
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
      if (!req.is('application/json'))
        return next(new ApiError(415, '请使用 JSON 请求。', 'CONTENT_TYPE_REQUIRED'));
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/config', (_req, res) =>
    res.json({
      mode: service.adapter.mode,
      ready: service.adapter.ready,
      label: service.adapter.label,
      maxCharacters: MAX_CHARACTERS,
      maxParagraphs: MAX_PARAGRAPHS,
    }),
  );
  app.get('/api/tasks', (_req, res) => res.json(service.store.list()));
  app.post('/api/tasks', (req, res) => res.status(201).json(service.create(req.body)));
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
    if (error instanceof ApiError) {
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
            : '服务暂时不可用，请重试。',
      code: status === 413 ? 'BODY_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR',
    });
  };
  app.use(onError);
  return app;
}
