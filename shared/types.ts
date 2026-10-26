import type { DocxDocument } from './docx';
import type { ProfessionalState } from './professional';

export type Style = 'faithful' | 'business';
export type ParagraphStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type TaskStatus = 'draft' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type MockScenario =
  'normal' | 'slow' | 'timeout' | 'rate-limit' | 'server-error' | 'partial' | 'malformed';
export interface Paragraph {
  id: string;
  source: string;
  translation: string;
  revision: number;
  edited: boolean;
  status: ParagraphStatus;
  error: string | null;
  location?: string;
}
export interface Task {
  revision?: number;
  id: string;
  title: string;
  style: Style;
  status: TaskStatus;
  mode: 'mock' | 'real';
  createdAt: string;
  updatedAt: string;
  paragraphs: Paragraph[];
  document?: DocxDocument;
  professional?: ProfessionalState;
}
export interface ServiceConfig {
  mode: 'mock' | 'real';
  ready: boolean;
  label: string;
  maxCharacters: number;
  maxParagraphs: number;
}
export const MAX_CHARACTERS = 20000;
export const MAX_PARAGRAPHS = 100;
// POST /api/tasks { text, style, title? } -> Task (201)
// GET /api/tasks -> Task[]; GET /api/tasks/:id -> Task
// POST /api/tasks/:id/translate { paragraphIds?: string[], scenario?: MockScenario } -> Task (202)
// Same task busy: 409. Explicit paragraph selection may retranslate an edited paragraph.
// Selection omitted: only unfinished, unedited paragraphs are eligible.
// POST /api/tasks/:id/cancel -> Task
// PATCH /api/tasks/:id/paragraphs/:paragraphId { translation, expectedRevision } -> Task
// Editing allowed during a run; compare revisions when applying model response.
// GET /api/config -> ServiceConfig; errors {error:string, code?:string}
