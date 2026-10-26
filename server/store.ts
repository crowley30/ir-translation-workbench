import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Task } from '../shared/types.js';
import type { DocxImport } from '../shared/docx.js';
import type { TermApplicationPreview, TermLibrary } from '../shared/professional.js';
import { EXAMPLE_TERMS, resolveTerms } from './terminology.js';
import { analyzeReview } from '../shared/review.js';

export interface StoredTermPreview {
  taskId: string;
  taskRevision: number;
  libraryVersion: number;
  expiresAt: number;
  used: boolean;
  preview: TermApplicationPreview;
}

export class TaskStore {
  private db: DatabaseSync;
  constructor(path = '.data/workbench.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docx_imports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL, task_id TEXT REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS terminology_library (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terminology_previews (token TEXT PRIMARY KEY, task_id TEXT NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    );
    this.db
      .prepare('INSERT OR IGNORE INTO terminology_library(id, payload) VALUES (1, ?)')
      .run(JSON.stringify({ version: 1, entries: EXAMPLE_TERMS } satisfies TermLibrary));
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
    task.revision = (this.get(task.id)?.revision ?? 0) + 1;
    if (task.professional) {
      const resolutions = Object.fromEntries(
        task.paragraphs.map((paragraph) => [
          paragraph.id,
          resolveTerms(task.professional!.snapshot, paragraph.source),
        ]),
      );
      task.professional.review.findings = analyzeReview(task, resolutions);
    }
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
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT payload FROM app_settings WHERE key = ?').get(key);
    return row ? (JSON.parse(row.payload as string) as unknown) : undefined;
  }
  setSetting(key: string, value: unknown): void {
    const payload = JSON.stringify(value);
    if (typeof payload !== 'string') throw new Error('Setting must be JSON serializable');
    this.db
      .prepare(
        'INSERT INTO app_settings(key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',
      )
      .run(key, payload);
  }
  getTermLibrary(): TermLibrary {
    const row = this.db.prepare('SELECT payload FROM terminology_library WHERE id = 1').get()!;
    return JSON.parse(row.payload as string) as TermLibrary;
  }
  mutateTermLibrary<T>(mutate: (library: TermLibrary) => T): T {
    return this.transaction(() => {
      const library = this.getTermLibrary();
      const result = mutate(library);
      library.version += 1;
      this.db
        .prepare('UPDATE terminology_library SET payload = ? WHERE id = 1')
        .run(JSON.stringify(library));
      return result;
    });
  }
  saveTermPreview(record: StoredTermPreview): void {
    // One pending preview per task bounds storage and makes replacement explicit.
    this.db
      .prepare('DELETE FROM terminology_previews WHERE task_id = ? OR expires_at <= ?')
      .run(record.taskId, Date.now());
    this.db
      .prepare(
        'INSERT INTO terminology_previews(token, task_id, expires_at, payload) VALUES (?, ?, ?, ?)',
      )
      .run(record.preview.token, record.taskId, record.expiresAt, JSON.stringify(record));
  }
  getTermPreview(token: string): StoredTermPreview | undefined {
    const row = this.db
      .prepare('SELECT payload FROM terminology_previews WHERE token = ?')
      .get(token);
    return row ? (JSON.parse(row.payload as string) as StoredTermPreview) : undefined;
  }
  markTermPreviewUsed(token: string): void {
    const record = this.getTermPreview(token);
    if (!record) throw new Error('Missing terminology preview');
    record.used = true;
    this.db
      .prepare('UPDATE terminology_previews SET payload = ? WHERE token = ?')
      .run(JSON.stringify(record), token);
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
