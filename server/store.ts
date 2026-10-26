import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Task } from '../shared/types.js';
import type { DocxImport } from '../shared/docx.js';

export class TaskStore {
  private db: DatabaseSync;
  constructor(path = '.data/workbench.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docx_imports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL, task_id TEXT REFERENCES tasks(id))`,
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
  saveImport(record: DocxImport): DocxImport {
    // Keep only normalized document/report JSON. Original uploads never enter SQLite.
    const normalized: DocxImport = {
      id: record.id,
      document: record.document,
      report: record.report,
    };
    this.db
      .prepare('INSERT INTO docx_imports(id, created_at, payload) VALUES (?, ?, ?)')
      .run(record.id, new Date().toISOString(), JSON.stringify(normalized));
    return normalized;
  }
  getImport(id: string): DocxImport | undefined {
    const row = this.db.prepare('SELECT payload FROM docx_imports WHERE id = ?').get(id);
    return row ? (JSON.parse(row.payload as string) as DocxImport) : undefined;
  }
  getTaskForImport(id: string): Task | undefined {
    const row = this.db.prepare('SELECT task_id FROM docx_imports WHERE id = ?').get(id);
    return row?.task_id ? this.get(row.task_id as string) : undefined;
  }
  createForImport(importId: string, task: Task): Task {
    // Consuming an import and storing its task are a single durable transaction.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getTaskForImport(importId);
      if (existing) {
        this.db.exec('COMMIT');
        return existing;
      }
      this.save(task);
      const result = this.db
        .prepare('UPDATE docx_imports SET task_id = ? WHERE id = ? AND task_id IS NULL')
        .run(task.id, importId);
      if (result.changes !== 1) throw new Error('Import consumption conflict');
      this.db.exec('COMMIT');
      return task;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
