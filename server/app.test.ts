import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { TaskStore } from './store.js';
import { TaskService } from './service.js';
import { createMockAdapter } from './adapter.js';

let store: TaskStore;
let service: TaskService;
beforeEach(() => {
  store = new TaskStore(':memory:');
  service = new TaskService(store, createMockAdapter({ delayMs: 0, timeoutMs: 0 }));
});
afterEach(async () => {
  await service.shutdown();
  store.close();
});

describe('HTTP integration boundary', () => {
  it('serves config and a complete create/translate/edit/reopen lifecycle', async () => {
    const app = createApp(service);
    const config = await request(app).get('/api/config').expect(200);
    expect(config.body).toMatchObject({
      mode: 'mock',
      ready: true,
      maxCharacters: 20000,
      maxParagraphs: 100,
    });
    expect(config.headers['cache-control']).toBe('no-store');
    const created = await request(app)
      .post('/api/tasks')
      .send({ text: 'Synthetic Fund USD 10m.\n\nAI robotics.', style: 'business' })
      .expect(201);
    const id = created.body.id as string;
    await request(app).post(`/api/tasks/${id}/translate`).send({}).expect(202);
    await service.idle(id);
    const task = service.get(id);
    expect(task.status).toBe('completed');
    await request(app)
      .patch(`/api/tasks/${id}/paragraphs/${task.paragraphs[0].id}`)
      .send({ translation: '合成样本编辑', expectedRevision: 1 })
      .expect(200);
    const reopened = await request(app).get(`/api/tasks/${id}`).expect(200);
    expect(reopened.body.paragraphs[0].translation).toBe('合成样本编辑');
    const list = await request(app).get('/api/tasks').expect(200);
    expect(list.body).toHaveLength(1);
  });
  it('returns useful errors for empty/oversized input, conflicts, missing tasks', async () => {
    const app = createApp(service);
    expect(
      (await request(app).post('/api/tasks').send({ text: ' ', style: 'faithful' }).expect(400))
        .body.code,
    ).toBe('EMPTY_INPUT');
    await request(app)
      .post('/api/tasks')
      .send({ text: 'a'.repeat(20001), style: 'faithful' })
      .expect(400);
    await request(app).get('/api/tasks/missing').expect(404);
    const task = service.create({ text: 'x', style: 'business' });
    service.translate(task.id, { scenario: 'slow' });
    const duplicate = await request(app)
      .post(`/api/tasks/${task.id}/translate`)
      .send({})
      .expect(409);
    expect(duplicate.body.code).toBe('TASK_BUSY');
    await request(app).post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
  });
  it('denies cross-site mutations and non-JSON bodies before creating a task', async () => {
    const app = createApp(service);
    await request(app)
      .post('/api/tasks')
      .set('Origin', 'https://external.invalid')
      .send({ text: 'x', style: 'faithful' })
      .expect(403);
    await request(app).post('/api/tasks').type('text/plain').send('x').expect(415);
    expect(store.list()).toHaveLength(0);
    await request(app)
      .post('/api/tasks')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({ text: 'x', style: 'faithful' })
      .expect(201);
  });
  it('never reflects malformed JSON contents or internal errors', async () => {
    const response = await request(createApp(service))
      .post('/api/tasks')
      .type('application/json')
      .send('{"secret":"sensitive"')
      .expect(400);
    expect(response.body).toMatchObject({ code: 'INVALID_JSON' });
    expect(JSON.stringify(response.body)).not.toContain('sensitive');
  });
});
