import { randomUUID } from 'node:crypto';
import {
  PROFESSIONAL_LIMITS,
  type TermConflict,
  type TermInput,
  type TermLibrary,
  type TermMatch,
  type TermRecord,
  type TermResolution,
  type TerminologySnapshot,
} from '../shared/professional.js';
import { MAX_CHARACTERS } from '../shared/types.js';

export class TermValidationError extends Error {
  readonly status = 400;
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TermValidationError';
  }
}

export const TERM_OCCURRENCE_LIMIT = 1000;
export const TERM_CANDIDATE_LIMIT = 10000;
const layers = new Set(['project', 'fund', 'technical']);
function invalid(message: string, code = 'INVALID_TERM'): never {
  throw new TermValidationError(code, message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('术语内容必须是有效对象。');
  return value as Record<string, unknown>;
}
function text(
  value: unknown,
  name: string,
  limit: number,
  multiline = false,
  fallback?: string,
): string {
  if (value === undefined && fallback !== undefined) value = fallback;
  if (typeof value !== 'string' || value.length > limit)
    return invalid(`${name}格式无效或超过长度上限。`);
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if ((point < 32 && !(multiline && [9, 10, 13].includes(point))) || point === 127)
      return invalid(`${name}不能包含控制字符。`);
  }
  return value.trim();
}
function flag(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') return invalid(`${name}必须为布尔值。`);
  return value;
}
function integer(value: unknown, name: string, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    return invalid(`${name}必须是允许范围内的整数。`);
  return value;
}

// Defaults are explicit. Alternatives are approved target alternatives, never source aliases.
export function validateTermInput(value: unknown): TermInput {
  const input = object(value);
  if (typeof input.layer !== 'string' || !layers.has(input.layer))
    return invalid('请选择项目、基金或技术术语层级。');
  const layer = input.layer as TermInput['layer'];
  const project = text(input.project, '项目名称', PROFESSIONAL_LIMITS.project, false, '');
  if (layer === 'project' && !project) return invalid('项目术语必须指定项目名称。');
  if (layer !== 'project' && project) return invalid('基金和技术术语为全局范围，请清空项目名称。');
  const source = text(input.source, '英文术语', PROFESSIONAL_LIMITS.source).replace(/\s+/gu, ' ');
  if (!source) return invalid('英文术语不能为空。');
  const target = text(input.target, '首选译法', PROFESSIONAL_LIMITS.target, false, '');
  const retainSource = flag(input.retainSource, '保留原文选项', false);
  if ((!retainSource && !target) || (retainSource && target))
    return invalid('请选择填写首选译法或保留原文，两者不能同时设置。');
  if (input.alternatives !== undefined && !Array.isArray(input.alternatives))
    return invalid('备选译法必须是列表。');
  const rawAlternatives = (input.alternatives ?? []) as unknown[];
  if (rawAlternatives.length > PROFESSIONAL_LIMITS.alternatives)
    return invalid('备选译法数量超过上限。');
  const alternatives = rawAlternatives.map((value) => {
    const alternative = text(value, '备选译法', PROFESSIONAL_LIMITS.target);
    if (!alternative) return invalid('备选译法不能为空。');
    return alternative;
  });
  return {
    layer,
    project,
    source,
    target,
    retainSource,
    note: text(input.note, '适用说明', PROFESSIONAL_LIMITS.note, true, ''),
    priority: integer(input.priority, '优先级', 100, 50),
    enabled: flag(input.enabled, '启用选项', true),
    caseSensitive: flag(input.caseSensitive, '大小写选项', false),
    alternatives: [...new Set(alternatives)],
  };
}

function record(value: unknown): TermRecord {
  const data = object(value);
  const input = validateTermInput(data);
  const id = text(data.id, '术语 ID', 120);
  if (!id) return invalid('术语 ID 不能为空。', 'INVALID_TERM_RECORD');
  const createdAt = text(data.createdAt, '创建时间', 80);
  const updatedAt = text(data.updatedAt, '更新时间', 80);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt)))
    return invalid('术语记录时间无效。', 'INVALID_TERM_RECORD');
  const result: TermRecord = {
    ...input,
    id,
    revision: integer(data.revision, '记录版本', Number.MAX_SAFE_INTEGER),
    createdAt,
    updatedAt,
  };
  Object.freeze(result.alternatives);
  return Object.freeze(result);
}
function records(values: unknown): TermRecord[] {
  if (!Array.isArray(values) || values.length > PROFESSIONAL_LIMITS.terms)
    return invalid('术语数量超过上限或记录列表无效。', 'TERM_LIMIT');
  const ids = new Set<string>();
  return values.map((value) => {
    const entry = record(value);
    if (ids.has(entry.id)) return invalid('术语 ID 重复。', 'INVALID_TERM_RECORD');
    ids.add(entry.id);
    return entry;
  });
}
function scoped(entry: TermRecord, project: string): boolean {
  return entry.enabled && (entry.layer !== 'project' || entry.project === project);
}

export function createTerminologySnapshot(
  library: TermLibrary,
  project: string,
  context: string,
): TerminologySnapshot {
  const data = object(library);
  const libraryVersion = integer(data.version, '术语库版本', Number.MAX_SAFE_INTEGER);
  const selectedProject = text(project, '项目名称', PROFESSIONAL_LIMITS.project);
  const selectedContext = text(context, '翻译背景', PROFESSIONAL_LIMITS.context, true);
  const entries = records(data.entries).filter((entry) => scoped(entry, selectedProject));
  Object.freeze(entries);
  const snapshot: TerminologySnapshot = {
    version: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    libraryVersion,
    project: selectedProject,
    context: selectedContext,
    entries,
  };
  return Object.freeze(snapshot);
}

interface Occurrence {
  start: number;
  end: number;
  text: string;
  entries: Map<string, TermRecord>;
}
function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function sourcePattern(source: string, sensitive: boolean): RegExp {
  const phrase = source.split(' ').map(escapePattern).join('\\s+');
  // Unicode letters/marks/digits and underscore belong to a token. No substring guessing.
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${phrase}(?![\\p{L}\\p{M}\\p{N}_])`,
    sensitive ? 'gu' : 'giu',
  );
}
function choice(entry: TermRecord): string {
  return entry.retainSource ? 'retain-source' : `target:${entry.target}`;
}
function stableEntries(entries: TermRecord[]): TermRecord[] {
  return entries.sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

// The context and applicability note are manual guidance for review/provider use. This
// deterministic matcher does not pretend to infer whether a prose condition is satisfied.
export function resolveTerminology(snapshot: TerminologySnapshot, source: string): TermResolution {
  const data = object(snapshot);
  if (data.version !== 1) return invalid('术语快照版本不受支持。', 'INVALID_TERM_SNAPSHOT');
  const project = text(data.project, '项目名称', PROFESSIONAL_LIMITS.project);
  text(data.context, '翻译背景', PROFESSIONAL_LIMITS.context, true);
  if (typeof source !== 'string' || source.length > MAX_CHARACTERS)
    return invalid('待匹配段落超过字符上限或格式无效。', 'TERM_SOURCE_LIMIT');
  const entries = records(data.entries).filter((entry) => scoped(entry, project));
  const occurrences = new Map<string, Occurrence>();
  let hits = 0;
  for (const entry of entries) {
    const pattern = sourcePattern(entry.source, entry.caseSensitive);
    for (const found of source.matchAll(pattern)) {
      if (++hits > TERM_CANDIDATE_LIMIT)
        return invalid('术语匹配候选过多，请缩短段落或精简术语库。', 'TERM_MATCH_LIMIT');
      const start = found.index;
      const end = start + found[0].length;
      const key = `${start}:${end}`;
      let occurrence = occurrences.get(key);
      if (!occurrence) {
        if (occurrences.size >= TERM_OCCURRENCE_LIMIT)
          return invalid('段落术语命中过多，请缩短段落。', 'TERM_MATCH_LIMIT');
        occurrence = { start, end, text: found[0], entries: new Map() };
        occurrences.set(key, occurrence);
      }
      occurrence.entries.set(entry.id, entry);
    }
  }
  const ordered = [...occurrences.values()].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  // Contained generic matches yield to a longer literal phrase. Equal spans retain all
  // candidates so layer/priority conflicts remain visible. Partially overlapping phrases
  // are retained as guidance: no substring replacement or arbitrary segmentation occurs.
  const selected = ordered.filter(
    (candidate) =>
      !ordered.some(
        (other) =>
          other !== candidate &&
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          (other.start < candidate.start || other.end > candidate.end),
      ),
  );
  const matches: TermMatch[] = [];
  const conflicts: TermConflict[] = [];
  for (const occurrence of selected) {
    const candidates = [...occurrence.entries.values()];
    const hasProject = candidates.some((entry) => entry.layer === 'project');
    const scopedCandidates = hasProject
      ? candidates.filter((entry) => entry.layer === 'project')
      : candidates;
    const priority = Math.max(...scopedCandidates.map((entry) => entry.priority));
    const winners = stableEntries(scopedCandidates.filter((entry) => entry.priority === priority));
    const overriddenIds = candidates
      .filter((entry) => !winners.includes(entry))
      .map((entry) => entry.id)
      .sort();
    if (new Set(winners.map(choice)).size > 1) {
      conflicts.push({
        start: occurrence.start,
        end: occurrence.end,
        text: occurrence.text,
        entries: winners,
      });
      continue;
    }
    // Co-winning equivalent choices all survive, including distinct notes/alternatives.
    // This prevents selecting a random note while discarding another equally ranked rule.
    for (const entry of winners)
      matches.push({
        start: occurrence.start,
        end: occurrence.end,
        text: occurrence.text,
        entry,
        overriddenIds: [...overriddenIds],
      });
  }
  return { matches, conflicts };
}

export const createSnapshot = createTerminologySnapshot;
export const resolveTerms = resolveTerminology;

const EXAMPLE_DATE = '2026-10-26T00:00:00.000Z';
export const EXAMPLE_TERMS: TermRecord[] = [
  { id: 'example-irr', layer: 'fund', source: 'IRR', target: '内部收益率', caseSensitive: true },
  { id: 'example-ai', layer: 'technical', source: 'AI', target: '人工智能', caseSensitive: true },
  {
    id: 'example-embodied-intelligence',
    layer: 'technical',
    source: 'embodied intelligence',
    target: '具身智能',
    caseSensitive: false,
  },
].map((entry) =>
  record({
    ...entry,
    project: '',
    retainSource: false,
    note: '可编辑的通用示例，非专业审定术语；请人工确认后启用。',
    priority: 50,
    enabled: false,
    alternatives: [],
    revision: 0,
    createdAt: EXAMPLE_DATE,
    updatedAt: EXAMPLE_DATE,
  }),
);
Object.freeze(EXAMPLE_TERMS);
