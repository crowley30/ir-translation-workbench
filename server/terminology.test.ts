import { describe, expect, it } from 'vitest';
import {
  PROFESSIONAL_LIMITS,
  type TermInput,
  type TermLibrary,
  type TermRecord,
} from '../shared/professional.js';
import {
  createSnapshot,
  createTerminologySnapshot,
  EXAMPLE_TERMS,
  resolveTerms,
  resolveTerminology,
  TermValidationError,
  TERM_CANDIDATE_LIMIT,
  TERM_OCCURRENCE_LIMIT,
  validateTermInput,
} from './terminology.js';

const NOW = '2026-10-26T00:00:00.000Z';
function term(id: string, input: Partial<TermInput> = {}): TermRecord {
  return {
    id,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    layer: 'technical',
    project: '',
    source: 'AI',
    target: '人工智能',
    retainSource: false,
    note: '',
    priority: 50,
    enabled: true,
    caseSensitive: false,
    alternatives: [],
    ...input,
  };
}
function snapshot(entries: TermRecord[], project = '', context = 'Synthetic IR context') {
  return createSnapshot({ version: 3, entries }, project, context);
}

describe('bounded terminology validation', () => {
  it('validates explicit fields and supplies documented optional defaults', () => {
    expect(validateTermInput({ layer: 'fund', source: ' IRR ', target: ' 内部收益率 ' })).toEqual({
      layer: 'fund',
      project: '',
      source: 'IRR',
      target: '内部收益率',
      retainSource: false,
      note: '',
      priority: 50,
      enabled: true,
      caseSensitive: false,
      alternatives: [],
    });
    const result = validateTermInput({
      layer: 'project',
      project: ' Demo Project ',
      source: 'business   model',
      target: ' 商业模式 ',
      note: 'manual\napplicability',
      priority: 0,
      enabled: false,
      caseSensitive: true,
      alternatives: [' 业务模式 ', '业务模式'],
    });
    expect(result).toMatchObject({
      project: 'Demo Project',
      source: 'business model',
      note: 'manual\napplicability',
      priority: 0,
      enabled: false,
      caseSensitive: true,
      alternatives: ['业务模式'],
    });
  });
  it('requires exactly a preferred target or retain-source and preserves approved alternatives', () => {
    expect(
      validateTermInput({
        layer: 'technical',
        source: 'GPT-4',
        retainSource: true,
        alternatives: ['GPT 四代'],
      }),
    ).toMatchObject({ target: '', retainSource: true, alternatives: ['GPT 四代'] });
    for (const input of [
      { layer: 'fund', source: 'IRR' },
      { layer: 'fund', source: 'IRR', target: '内部收益率', retainSource: true },
    ])
      expect(() => validateTermInput(input)).toThrow(TermValidationError);
  });
  it.each([
    null,
    [],
    {},
    'not an object',
    { layer: 'unknown', source: 'AI', target: '人工智能' },
    { layer: 'project', source: 'AI', target: '人工智能' },
    { layer: 'fund', project: 'private project', source: 'AI', target: '人工智能' },
    { layer: 'fund', source: ' ', target: '人工智能' },
  ])('rejects malformed or inconsistent scope input %j', (input) => {
    expect(() => validateTermInput(input)).toThrow(TermValidationError);
  });
  it.each([-1, 101, 1.5, NaN, Infinity, '50', null])('rejects invalid priority %j', (priority) => {
    expect(() =>
      validateTermInput({ layer: 'fund', source: 'AI', target: '人工智能', priority }),
    ).toThrow(TermValidationError);
  });
  it.each(['enabled', 'caseSensitive', 'retainSource'])('rejects non-boolean %s', (key) => {
    expect(() =>
      validateTermInput({ layer: 'fund', source: 'AI', target: '人工智能', [key]: 'true' }),
    ).toThrow(TermValidationError);
  });
  it('bounds every user-authored field and alternatives without truncating', () => {
    for (const [key, limit] of Object.entries({
      source: PROFESSIONAL_LIMITS.source,
      target: PROFESSIONAL_LIMITS.target,
      note: PROFESSIONAL_LIMITS.note,
    }))
      expect(() =>
        validateTermInput({
          layer: 'technical',
          source: 'AI',
          target: '人工智能',
          [key]: 'x'.repeat(limit + 1),
        }),
      ).toThrow(TermValidationError);
    expect(() =>
      validateTermInput({
        layer: 'project',
        project: 'x'.repeat(PROFESSIONAL_LIMITS.project + 1),
        source: 'AI',
        target: '人工智能',
      }),
    ).toThrow(TermValidationError);
    for (const alternatives of [
      'not a list',
      Array(PROFESSIONAL_LIMITS.alternatives + 1).fill('译法'),
      [''],
      ['x'.repeat(PROFESSIONAL_LIMITS.target + 1)],
      [1],
    ])
      expect(() =>
        validateTermInput({ layer: 'fund', source: 'AI', target: '人工智能', alternatives }),
      ).toThrow(TermValidationError);
    expect(() =>
      validateTermInput({ layer: 'fund', source: 'AI\nmodel', target: '人工智能' }),
    ).toThrow(TermValidationError);
    expect(() => validateTermInput({ layer: 'fund', source: 'AI', target: '译法\u0000' })).toThrow(
      TermValidationError,
    );
  });
  it('does not echo source text into safe validation errors', () => {
    const secretMarker = 'SYNTHETIC_NOT_A_SECRET';
    try {
      validateTermInput({ layer: 'fund', source: secretMarker.repeat(20), target: '译法' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TermValidationError);
      expect(error).toMatchObject({ status: 400, code: 'INVALID_TERM' });
      expect((error as Error).message).not.toContain(secretMarker);
    }
  });
});

describe('scoped immutable terminology snapshots', () => {
  it('takes all active global and exactly scoped project entries, not only current-paragraph matches', () => {
    const entries = [
      term('global-fund', { layer: 'fund', source: 'IRR', target: '内部收益率' }),
      term('global-tech'),
      term('project-a', { layer: 'project', project: 'A' }),
      term('project-b', { layer: 'project', project: 'B' }),
      term('off', { enabled: false }),
      term('unmatched', { source: 'warehouse robotics', target: '仓储机器人' }),
    ];
    const result = snapshot(entries, 'A');
    expect(result.entries.map((entry) => entry.id)).toEqual([
      'global-fund',
      'global-tech',
      'project-a',
      'unmatched',
    ]);
    expect(result.libraryVersion).toBe(3);
    expect(result.project).toBe('A');
    expect(result.version).toBe(1);
    expect(result.id).toBeTruthy();
    expect(Number.isFinite(Date.parse(result.createdAt))).toBe(true);
    expect(snapshot(entries, 'a').entries.map((entry) => entry.id)).not.toContain('project-a');
  });
  it('makes deep copies so future library edits and disabling cannot change a task snapshot', () => {
    const original = term('first', { alternatives: ['旧备选'], note: '旧说明' });
    const library: TermLibrary = { version: 8, entries: [original] };
    const frozen = createSnapshot(library, '', '旧背景');
    original.target = '新译法';
    original.note = '新说明';
    original.enabled = false;
    original.alternatives.push('新备选');
    library.version = 9;
    library.entries.push(term('later'));
    expect(frozen.libraryVersion).toBe(8);
    expect(frozen.context).toBe('旧背景');
    expect(frozen.entries).toHaveLength(1);
    expect(frozen.entries[0]).toMatchObject({
      target: '人工智能',
      note: '旧说明',
      enabled: true,
      alternatives: ['旧备选'],
    });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.entries)).toBe(true);
    expect(Object.isFrozen(frozen.entries[0])).toBe(true);
    expect(Object.isFrozen(frozen.entries[0].alternatives)).toBe(true);
    expect(() => frozen.entries[0].alternatives.push('attempted mutation')).toThrow();
    expect(() => {
      frozen.context = 'attempted mutation';
    }).toThrow();
    expect(resolveTerms(frozen, 'AI').matches[0].entry.target).toBe('人工智能');
  });
  it('keeps context and applicability notes as manual guidance, without fake semantic filtering', () => {
    const state = snapshot(
      [
        term('conditional', {
          source: 'model',
          target: '模型',
          note: 'Only for AI engineering; check applicability manually.',
          alternatives: ['模式'],
        }),
      ],
      '',
      'This paragraph concerns a business model.',
    );
    const resolved = resolveTerms(state, 'The business model changed.');
    expect(resolved.matches[0].entry.note).toContain('check applicability manually');
    expect(resolved.matches[0].entry.alternatives).toEqual(['模式']);
    expect(state.context).toContain('business model');
  });
  it('rejects excessive libraries, duplicate IDs and invalid record metadata rather than silently omitting entries', () => {
    expect(() =>
      snapshot(Array.from({ length: PROFESSIONAL_LIMITS.terms + 1 }, (_, i) => term(String(i)))),
    ).toThrow(TermValidationError);
    expect(() => snapshot([term('duplicate'), term('duplicate')])).toThrow(TermValidationError);
    expect(() =>
      snapshot([term('bad', { createdAt: 'not a date' } as Partial<TermRecord>)]),
    ).toThrow(TermValidationError);
    expect(() => createSnapshot({ version: -1, entries: [] }, '', '')).toThrow(TermValidationError);
    expect(() =>
      createSnapshot({ version: 0, entries: [] }, '', 'x'.repeat(PROFESSIONAL_LIMITS.context + 1)),
    ).toThrow(TermValidationError);
  });
  it('exports aliases and only three disabled, clearly non-authoritative examples', () => {
    expect(createSnapshot).toBe(createTerminologySnapshot);
    expect(resolveTerms).toBe(resolveTerminology);
    expect(EXAMPLE_TERMS.map((entry) => entry.source)).toEqual([
      'IRR',
      'AI',
      'embodied intelligence',
    ]);
    expect(
      EXAMPLE_TERMS.every((entry) => !entry.enabled && entry.note.includes('非专业审定')),
    ).toBe(true);
    expect(snapshot(EXAMPLE_TERMS).entries).toEqual([]);
  });
});

describe('literal whole-token matching and deterministic precedence', () => {
  it('always prefers the selected project over both global layers regardless of global priority', () => {
    const state = snapshot(
      [
        term('project', {
          layer: 'project',
          project: 'Demo Project',
          priority: 0,
          target: '示例项目术语',
        }),
        term('fund', { layer: 'fund', priority: 100, target: '基金术语' }),
        term('technical', { priority: 100, target: '技术术语' }),
        term('other-project', {
          layer: 'project',
          project: 'Other',
          priority: 100,
          target: '其它项目',
        }),
      ],
      'Demo Project',
    );
    const result = resolveTerms(state, 'AI is here.');
    expect(result.conflicts).toEqual([]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      text: 'AI',
      entry: { id: 'project', target: '示例项目术语' },
      overriddenIds: ['fund', 'technical'],
    });
  });
  it('uses explicit priorities across global layers without an implicit fund/technical winner', () => {
    for (const [fundPriority, technicalPriority, winner] of [
      [10, 80, 'technical'],
      [90, 20, 'fund'],
    ] as const) {
      const result = resolveTerms(
        snapshot([
          term('fund', { layer: 'fund', priority: fundPriority, target: '基金译法' }),
          term('technical', { priority: technicalPriority, target: '技术译法' }),
        ]),
        'AI',
      );
      expect(result.matches.map((match) => match.entry.id)).toEqual([winner]);
      expect(result.conflicts).toEqual([]);
    }
  });
  it('surfaces equal-priority differing choices without choosing by layer, ID, insertion order or target', () => {
    const entries = [
      term('z', { layer: 'fund', target: '甲译法', priority: 50 }),
      term('a', { target: '乙译法', priority: 50 }),
      term('lower', { target: '低优先级', priority: 49 }),
    ];
    const left = resolveTerms(snapshot(entries), 'AI');
    const right = resolveTerms(snapshot([...entries].reverse()), 'AI');
    expect(left).toEqual(right);
    expect(left.matches).toEqual([]);
    expect(left.conflicts).toHaveLength(1);
    expect(left.conflicts[0]).toMatchObject({ start: 0, end: 2, text: 'AI' });
    expect(left.conflicts[0].entries.map((entry) => entry.id)).toEqual(['a', 'z']);
  });
  it('shows a retain-source versus translated-target tie as a conflict', () => {
    const result = resolveTerms(
      snapshot([term('keep', { retainSource: true, target: '' }), term('translate')]),
      'AI',
    );
    expect(result.matches).toEqual([]);
    expect(result.conflicts[0].entries.map((entry) => entry.id)).toEqual(['keep', 'translate']);
  });
  it('keeps every co-winning equivalent choice with its notes and approved alternatives', () => {
    const result = resolveTerms(
      snapshot([
        term('a', { note: '项目背景需复核', alternatives: ['人工智慧'] }),
        term('b', { layer: 'fund', note: '基金对外沟通说明', alternatives: ['AI技术'] }),
      ]),
      'AI',
    );
    expect(result.conflicts).toEqual([]);
    expect(
      result.matches.map((match) => [match.entry.id, match.entry.note, match.entry.alternatives]),
    ).toEqual([
      ['a', '项目背景需复核', ['人工智慧']],
      ['b', '基金对外沟通说明', ['AI技术']],
    ]);
  });
  it('prefers the longest contained phrase but still matches the generic term elsewhere', () => {
    const result = resolveTerms(
      snapshot(
        [
          term('generic', {
            source: 'model',
            target: '模型',
            layer: 'project',
            project: 'A',
            priority: 100,
          }),
          term('phrase', { source: 'business model', target: '商业模式', priority: 0 }),
        ],
        'A',
      ),
      'Our business model differs from the AI model.',
    );
    expect(result.matches.map((match) => [match.text, match.entry.id])).toEqual([
      ['business model', 'phrase'],
      ['model', 'generic'],
    ]);
    expect(result.matches.map((match) => [match.start, match.end])).toEqual([
      [4, 18],
      [39, 44],
    ]);
  });
  it('does not fall back to a contained generic term to conceal a conflicting longer phrase', () => {
    const result = resolveTerms(
      snapshot([
        term('generic', { source: 'model', target: '模型' }),
        term('long-a', { source: 'business model', target: '商业模式' }),
        term('long-b', { source: 'business model', target: '业务模型' }),
      ]),
      'business model',
    );
    expect(result.matches).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].text).toBe('business model');
  });
  it('retains partially overlapping literal phrases as guidance without arbitrary substring replacement', () => {
    const result = resolveTerms(
      snapshot([
        term('left', { source: 'business model', target: '商业模式' }),
        term('right', { source: 'model innovation', target: '模式创新' }),
      ]),
      'business model innovation',
    );
    expect(result.matches.map((match) => match.text)).toEqual([
      'business model',
      'model innovation',
    ]);
  });
  it('honors acronym case sensitivity and never matches inside larger tokens', () => {
    const result = resolveTerms(
      snapshot([term('sensitive', { caseSensitive: true })]),
      'AI, ai, XAI, chair, AIs, _AI, AI2, AI-based.',
    );
    expect(result.matches.map((match) => [match.start, match.text])).toEqual([
      [0, 'AI'],
      [35, 'AI'],
    ]);
    const insensitive = resolveTerms(snapshot([term('insensitive')]), 'AI ai Ai aI XAI chair');
    expect(insensitive.matches.map((match) => match.text)).toEqual(['AI', 'ai', 'Ai', 'aI']);
  });
  it('uses Unicode token boundaries and valid UTF-16 slice offsets', () => {
    const source = '👍 AI caféAI AIé AI\u0301 isolated AI.';
    const result = resolveTerms(snapshot([term('AI')]), source);
    expect(result.matches.map((match) => match.text)).toEqual(['AI', 'AI']);
    for (const match of result.matches)
      expect(source.slice(match.start, match.end)).toBe(match.text);
    expect(result.matches[0].start).toBe(3);
  });
  it('escapes punctuation and accepts phrase whitespace without using target alternatives as source aliases', () => {
    const state = snapshot([
      term('literal', { source: 'C++', target: 'C++语言', alternatives: ['CPP'] }),
      term('phrase', { source: 'business model', target: '商业模式' }),
    ]);
    const source = 'C++ and C-- and CPP; business\n  model and business-model.';
    const result = resolveTerms(state, source);
    expect(result.matches.map((match) => match.text)).toEqual(['C++', 'business\n  model']);
    expect(result.matches.some((match) => match.text === 'CPP')).toBe(false);
  });
  it('preserves source strings and never applies replacements even for a retain-source rule', () => {
    const source = 'AI powers robotics.';
    const state = snapshot([term('keep', { target: '', retainSource: true })]);
    const result = resolveTerms(state, source);
    expect(source).toBe('AI powers robotics.');
    expect(result.matches[0].text).toBe('AI');
    expect(result.matches[0].entry).toMatchObject({ target: '', retainSource: true });
  });
  it('returns no guidance for disabled or other-project entries in a restored snapshot', () => {
    const valid = snapshot([], 'Demo Project');
    const restored = {
      ...valid,
      entries: [
        term('off', { enabled: false }),
        term('other', { layer: 'project', project: 'Other' }),
      ],
    };
    expect(resolveTerms(restored, 'AI')).toEqual({ matches: [], conflicts: [] });
  });
  it('bounds occurrence and candidate output without reporting partially matched success', () => {
    expect(() =>
      resolveTerms(
        snapshot([term('short', { source: 'a', target: '甲' })]),
        Array(TERM_OCCURRENCE_LIMIT + 1)
          .fill('a')
          .join(' '),
      ),
    ).toThrowError(expect.objectContaining({ code: 'TERM_MATCH_LIMIT' }));
    const entries = Array.from({ length: 200 }, (_, i) =>
      term(String(i), { source: 'a', target: '甲' }),
    );
    expect(() =>
      resolveTerms(
        snapshot(entries),
        Array(Math.floor(TERM_CANDIDATE_LIMIT / 200) + 1)
          .fill('a')
          .join(' '),
      ),
    ).toThrowError(expect.objectContaining({ code: 'TERM_MATCH_LIMIT' }));
    expect(() => resolveTerms(snapshot([]), 'x'.repeat(20001))).toThrowError(
      expect.objectContaining({ code: 'TERM_SOURCE_LIMIT' }),
    );
  });
});
