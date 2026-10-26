import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Task } from '../shared/types.js';

export class TaskStore {
  private db: DatabaseSync;
  constructor(path = '.data/workbench.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL)',
    );
  }
  list(): Task[] {
    return this.db
      .prepare('SELECT payload FROM tasks ORDER BY updated_at DESC, id DESC')
      .all()
      .map((row) => JSON.parse(row.payload as string) as Task);
  }
  get(id: string): Task | undefined {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id);
    return row ? (JSON.parse(row.payload as string) as Task) : undefined;
  }
  save(task: Task): Task {
    task.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO tasks(id, updated_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, payload=excluded.payload',
      )
      .run(task.id, task.updatedAt, JSON.stringify(task));
    return task;
  }
  recoverInterrupted(): void {
    for (const task of this.list()) {
      if (task.status !== 'running') continue;
      task.status = 'cancelled';
      for (const p of task.paragraphs) {
        if (p.status === 'running' || p.status === 'pending') {
          p.status = 'cancelled';
          p.error = '服务曾中断，未完成段落已停止；可手动重试。';
        }
      }
      this.save(task);
    }
  }
  close(): void {
    this.db.close();
  }
}
