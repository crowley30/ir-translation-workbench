export const DOCX_LIMITS = {
  uploadBytes: 5 * 1024 * 1024,
  entries: 256,
  expandedBytes: 20 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  xmlBytes: 2 * 1024 * 1024,
  compressionRatio: 100,
  xmlDepth: 80,
  xmlNodes: 100000,
  paragraphs: 100,
  characters: 20000,
  tables: 20,
  cells: 200,
  columns: 10,
} as const;
export interface DocxIssue {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  locations: string[];
  count: number;
}
export interface DocxParagraph {
  kind: 'paragraph';
  id: string;
  paragraphId: string | null;
  source: string;
  location: string;
  headingLevel?: number;
  list?: { kind: 'bullet' | 'decimal'; level: number; label: string };
}
export interface DocxCell {
  id: string;
  paragraphs: DocxParagraph[];
}
export interface DocxRow {
  id: string;
  cells: DocxCell[];
}
export interface DocxTable {
  kind: 'table';
  id: string;
  rows: DocxRow[];
}
export interface DocxDocument {
  version: 1;
  filename: string;
  blocks: Array<DocxParagraph | DocxTable>;
}
export interface DocxReport {
  status: 'ready' | 'warning' | 'blocked';
  issues: DocxIssue[];
  stats: {
    paragraphs: number;
    translatableParagraphs: number;
    emptyParagraphs: number;
    tables: number;
    cells: number;
    characters: number;
    entries: number;
    expandedBytes: number;
    uploadBytes: number;
  };
}
export interface DocxImport {
  id: string;
  document: DocxDocument;
  report: DocxReport;
}
// POST /api/docx/preflight — raw DOCX bytes; Content-Type application/vnd.openxmlformats-officedocument.wordprocessingml.document;
// X-Filename encodeURIComponent(filename). Returns DocxImport persisted on server.
// POST /api/tasks/docx {importId,style,acknowledgeWarnings:boolean} -> Task. Idempotent per importId; blocks unsupported/limits.
// GET /api/tasks/:id/docx?mode=chinese|bilingual -> attachment. DOCX tasks only; all nonempty source paragraphs must be done.
