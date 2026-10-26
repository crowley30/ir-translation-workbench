// Bounded, user-authored terminology and saved review state. Examples are not authority.
export type TermLayer = 'project' | 'fund' | 'technical';
export interface TermInput {
  layer: TermLayer;
  project: string;
  source: string;
  target: string;
  retainSource: boolean;
  note: string;
  priority: number;
  enabled: boolean;
  caseSensitive: boolean;
  alternatives: string[];
}
export interface TermRecord extends TermInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface TermLibrary {
  version: number;
  entries: TermRecord[];
}
export interface TerminologySnapshot {
  version: 1;
  id: string;
  createdAt: string;
  libraryVersion: number;
  project: string;
  context: string;
  entries: TermRecord[];
}
export interface TermMatch {
  start: number;
  end: number;
  text: string;
  entry: TermRecord;
  overriddenIds: string[];
}
export interface TermConflict {
  start: number;
  end: number;
  text: string;
  entries: TermRecord[];
}
export interface TermResolution {
  matches: TermMatch[];
  conflicts: TermConflict[];
}
export type ReviewCode =
  | 'EMPTY_TRANSLATION'
  | 'NUMBER_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DATE_MISMATCH'
  | 'RATIO_MISMATCH'
  | 'POSSIBLE_OMISSION'
  | 'TERM_MISMATCH'
  | 'TERM_CONFLICT'
  | 'UNCERTAIN_FORMAT'
  | 'MOCK_OUTPUT';
export interface ReviewSpan {
  start: number;
  end: number;
  text: string;
}
export interface ReviewFinding {
  id: string;
  paragraphId: string;
  paragraphLocation: string;
  code: ReviewCode;
  severity: 'review';
  certainty: 'rule' | 'uncertain';
  reason: string;
  source: ReviewSpan | null;
  translation: ReviewSpan | null;
  termId?: string;
}
export interface ReviewApproval {
  paragraphId: string;
  revision: number;
  snapshotId: string;
  confirmedAt: string;
}
export interface ReviewEvent {
  type: 'confirmed' | 'revoked' | 'invalidated';
  paragraphId: string;
  revision: number;
  snapshotId: string;
  at: string;
}
export interface TaskReview {
  findings: ReviewFinding[];
  approvals: ReviewApproval[];
  events: ReviewEvent[];
}
export interface ProfessionalState {
  snapshot: TerminologySnapshot;
  snapshotHistory: TerminologySnapshot[];
  review: TaskReview;
}
export interface TermApplicationPreview {
  token: string;
  taskRevision: number;
  previousSnapshotId: string | null;
  snapshot: TerminologySnapshot;
  changedSources: string[];
  conflicts: { paragraphId: string; location: string; conflict: TermConflict }[];
  preservedEditedParagraphs: number;
}
export interface TranslationContext {
  project: string;
  context: string;
  snapshotId: string;
  terms: TermRecord[];
  location: string;
  previousSource: string;
  nextSource: string;
}
export const PROFESSIONAL_LIMITS = {
  terms: 200,
  source: 80,
  target: 160,
  project: 80,
  context: 2000,
  note: 400,
  alternatives: 8,
  snapshotHistory: 20,
} as const;
