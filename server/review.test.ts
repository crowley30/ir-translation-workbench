import { describe, expect, it } from 'vitest';
import { analyzeReview } from '../shared/review.js';
import type { ReviewCode, TermRecord, TermResolution } from '../shared/professional.js';
import type { Task } from '../shared/types.js';
import { createTerminologySnapshot, resolveTerminology } from './terminology.js';

function task(source: string, translation: string, mode: Task['mode'] = 'real'): Task {
  return {
    id: 'synthetic-review-task',
    title: 'Synthetic QA fixture',
    style: 'faithful',
    status: 'completed',
    mode,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    paragraphs: [
      {
        id: 'p1',
        source,
        translation,
        revision: 3,
        edited: true,
        status: 'done',
        error: null,
        location: '表格 1 / 第 2 行 / 第 1 列 / 段落 1',
      },
    ],
  };
}
const codes = (value: Task) => analyzeReview(value).map((finding) => finding.code);
const term = (changes: Partial<TermRecord> = {}): TermRecord => ({
  id: 'term-ai',
  layer: 'technical',
  project: '',
  source: 'AI',
  target: '人工智能',
  retainSource: false,
  note: '结合基金语境核对',
  priority: 1,
  enabled: true,
  caseSensitive: true,
  alternatives: ['AI'],
  revision: 1,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  ...changes,
});
function resolved(entry = term()): Record<string, TermResolution> {
  return {
    p1: { matches: [{ start: 4, end: 6, text: 'AI', entry, overriddenIds: [] }], conflicts: [] },
  };
}

describe('bounded saved-text equivalences', () => {
  it.each([
    ['The fund raised USD 12 million.', '该基金募资1,200万美元。'],
    ['Revenue was US$12 million, including fees.', '收入为1200万美元，其中含费用。'],
    ['Revenue was 12 million USD.', '收入为1200万美元。'],
    ['RMB 0.12 billion was invested.', '投资人民币1.2亿元。'],
    ['The count was 1,200.', '数量为1200。'],
    ['The adjustment was -1,200.50.', '调整为−1200.5。'],
    ['USD 0.000001 million was paid.', '支付1美元。'],
    ['The rate was 12%.', '比率为12％。'],
    ['The rate was 12 percent.', '比率为12%。'],
    ['The change was 12 percentage points.', '变化为12个百分点。'],
    ['The ratio was 3:1 and the multiple was 5x.', '比率为3比1，倍数为5倍。'],
    ['The date is 2026-10-26.', '日期为2026年10月26日。'],
    ['The date is October 26, 2026.', '日期为2026年10月26日。'],
    ['The date is 26 October 2026.', '日期为2026/10/26。'],
    ['The date is 2024-02-29.', '日期为2024年2月29日。'],
    ['There were 12 meetings and 13 investors.', '有13位投资者和12场会议。'],
    ['There were 12 millionaires.', '有12位百万富翁。'],
    ['There were 12 xylophones.', '有12台木琴。'],
  ])('does not flag a declared equivalent: %s → %s', (source, translation) => {
    expect(analyzeReview(task(source, translation))).toEqual([]);
  });

  it.each([
    ['The count was 12.', '数量为13。', 'NUMBER_MISMATCH'],
    ['Revenue was USD 12 million.', '收入为1200万元人民币。', 'CURRENCY_MISMATCH'],
    ['Revenue was USD 12 million.', '收入为1300万美元。', 'CURRENCY_MISMATCH'],
    ['Revenue was USD 12 million.', '收入为12000000。', 'CURRENCY_MISMATCH'],
    ['The date is 2026-10-26.', '日期为2026年10月27日。', 'DATE_MISMATCH'],
    ['The rate is 12%.', '比率为13%。', 'RATIO_MISMATCH'],
    ['The ratio is 3:1.', '比率为1比3。', 'RATIO_MISMATCH'],
    ['The multiple is 5x.', '倍数为6倍。', 'RATIO_MISMATCH'],
    ['The increase is 12 percentage points.', '增长为12%。', 'RATIO_MISMATCH'],
  ] as const)('flags a changed quantity: %s → %s', (source, translation, code) => {
    const findings = analyzeReview(task(source, translation));
    expect(findings.some((finding) => finding.code === code && finding.certainty === 'rule')).toBe(
      true,
    );
    expect(findings.every((finding) => finding.severity === 'review')).toBe(true);
  });

  it('compares multiplicity rather than only the set of numeric values', () => {
    const findings = analyzeReview(
      task('There were 12 investors and 12 meetings.', '有12位投资者。'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('NUMBER_MISMATCH');
    expect(findings[0].source?.text).toBe('12');
    expect(findings[0].translation).toBeNull();
  });

  it('reports a numeric addition with a precise translation location', () => {
    const source = 'Synthetic investor update.',
      translation = '合成投资者更新，新增12项。';
    const findings = analyzeReview(task(source, translation));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'NUMBER_MISMATCH',
      source: null,
      translation: { start: 10, end: 12, text: '12' },
    });
  });

  it.each([
    ['The rate is 12%.', '比率为百分之十二。'],
    ['Revenue is USD 12 million.', '收入为一千二百万美元。'],
    ['The date is 10/11/2026.', '日期为2026年11月10日。'],
    ['The date is 2026-02-29.', '日期为2026年2月28日。'],
    ['The amount is $12 million.', '金额为1200万美元。'],
    ['The amount is ¥12 million.', '金额为人民币1200万元。'],
    ['The amount is 1e6.', '金额为1000000。'],
    ['The amount is 1.200,50.', '金额为1200.5。'],
    ['The amount is 1,20.', '金额为120。'],
  ])('keeps unsupported or ambiguous formats as uncertainty: %s', (source, translation) => {
    const findings = analyzeReview(task(source, translation));
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.every(
        (finding) => finding.code === 'UNCERTAIN_FORMAT' && finding.certainty === 'uncertain',
      ),
    ).toBe(true);
  });

  it.each([
    ['The ratio is .5.', '比率为5。'],
    ['The ratio is -.5.', '比率为5。'],
    ['The ratio is .5.', '比率为0.5。'],
    ['The amount is (12).', '金额为12。'],
    ['The amount is 12.', '金额为（12）。'],
    ['The amount is (USD 12 million).', '金额为1200万美元。'],
  ])('does not reinterpret an unsupported numeric form: %s → %s', (source, translation) => {
    const findings = analyzeReview(task(source, translation));
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.every(
        (finding) => finding.code === 'UNCERTAIN_FORMAT' && finding.certainty === 'uncertain',
      ),
    ).toBe(true);
    for (const finding of findings)
      for (const field of ['source', 'translation'] as const) {
        const location = finding[field];
        if (location)
          expect(
            (field === 'source' ? source : translation).slice(location.start, location.end),
          ).toBe(location.text);
      }
  });
});

describe('paragraph coverage, mode honesty and saved-state identity', () => {
  it('flags each meaningful empty paragraph and keeps its stable ID and DOCX cell location', () => {
    const value = task('Synthetic original.', '  ');
    value.paragraphs.push({ ...value.paragraphs[0], id: 'p2', source: '   ', translation: '' });
    expect(analyzeReview(value)).toMatchObject([
      {
        paragraphId: 'p1',
        code: 'EMPTY_TRANSLATION',
        paragraphLocation: '表格 1 / 第 2 行 / 第 1 列 / 段落 1',
        source: { text: 'Synthetic original.' },
      },
    ]);
  });

  it('uses only a limited omission prompt and does not certify semantic completeness', () => {
    const source = 'Synthetic investor paragraph with material business details. '.repeat(5);
    const findings = analyzeReview(task(source, '好的。'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'POSSIBLE_OMISSION', certainty: 'uncertain' });
    expect(findings[0].reason).toContain('长度启发式');
  });

  it('marks the actual mock placeholder and avoids presenting source echoes as a numeric pass', () => {
    const value = task(
      'USD 12 million on 2026-10-26.',
      '[模拟占位·非译文] USD 12 million on 2026-10-26.',
      'mock',
    );
    expect(codes(value)).toEqual(['MOCK_OUTPUT']);
    expect(analyzeReview(value, resolved()).map((finding) => finding.code)).toEqual([
      'MOCK_OUTPUT',
    ]);
  });

  it('still checks manually saved Chinese in a mock task', () => {
    expect(codes(task('USD 12 million.', '1300万美元。', 'mock'))).toContain('CURRENCY_MISMATCH');
  });

  it('flags an unmarked source echo only as a possible omission', () => {
    const findings = analyzeReview(task('Synthetic AI update.', 'Synthetic AI update.'));
    expect(findings).toMatchObject([{ code: 'POSSIBLE_OMISSION', certainty: 'uncertain' }]);
  });

  it('is pure and deterministic, with IDs tied to the saved paragraph revision', () => {
    const value = task('USD 12 million.', '1300万美元。');
    const before = JSON.stringify(value),
      first = analyzeReview(value);
    expect(analyzeReview(value)).toEqual(first);
    expect(JSON.stringify(value)).toBe(before);
    value.paragraphs[0].revision++;
    expect(analyzeReview(value)[0].id).not.toBe(first[0].id);
  });

  it('changes finding identity when the explicit terminology snapshot changes', () => {
    const value = task('USD 12 million.', '1300万美元。');
    value.professional = {
      snapshot: {
        version: 1,
        id: 'snapshot-a',
        createdAt: value.createdAt,
        libraryVersion: 1,
        project: '',
        context: '',
        entries: [],
      },
      snapshotHistory: [],
      review: { findings: [], approvals: [], events: [] },
    };
    const first = analyzeReview(value)[0];
    value.professional.snapshot.id = 'snapshot-b';
    expect(analyzeReview(value)[0].id).not.toBe(first.id);
  });

  it('reports UTF-16 offsets that recover exact source and translation substrings', () => {
    const value = task('🤖 Synthetic USD 12 million.', '🤖 合成1300万美元。');
    const [finding] = analyzeReview(value);
    expect(finding.source?.text).toBe('USD 12 million');
    expect(finding.translation?.text).toBe('1300万美元');
    for (const field of ['source', 'translation'] as const) {
      const location = finding[field]!;
      expect(value.paragraphs[0][field].slice(location.start, location.end)).toBe(location.text);
    }
  });

  it('bounds excessive prompts with an explicit manual-review notice', () => {
    const value = task('12 '.repeat(100), '13 '.repeat(100));
    const findings = analyzeReview(value);
    expect(findings).toHaveLength(81);
    expect(findings.at(-1)).toMatchObject({ code: 'UNCERTAIN_FORMAT', certainty: 'uncertain' });
    expect(findings.at(-1)?.reason).toContain('仅显示前 80 项');
  });

  it('bounds overview excerpts without splitting UTF-16 pairs or copying a long paragraph', () => {
    const source = 'a'.repeat(239) + '🤖' + 'Synthetic details. '.repeat(4000);
    const value = task(source, `[模拟占位·非译文] ${source}`, 'mock');
    const [finding] = analyzeReview(value);
    expect(finding.source).toEqual({ start: 0, end: 239, text: 'a'.repeat(239) });
    expect(finding.translation!.text.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(finding).length).toBeLessThan(1600);
    for (const field of ['source', 'translation'] as const) {
      const location = finding[field]!;
      expect(value.paragraphs[0][field].slice(location.start, location.end)).toBe(location.text);
    }
  });

  it('keeps the 80-prompt summary and individual spans bounded for a large paragraph', () => {
    const value = task(
      '12 '.repeat(100) + 's'.repeat(60000),
      '13 '.repeat(100) + 't'.repeat(60000),
    );
    const findings = analyzeReview(value);
    expect(findings).toHaveLength(81);
    expect(findings.at(-1)?.code).toBe('UNCERTAIN_FORMAT');
    for (const finding of findings)
      for (const field of ['source', 'translation'] as const) {
        const location = finding[field];
        if (!location) continue;
        expect(location.text.length).toBeLessThanOrEqual(240);
        expect(value.paragraphs[0][field].slice(location.start, location.end)).toBe(location.text);
      }
    expect(JSON.stringify(findings).length).toBeLessThan(80000);
  });
});

describe('resolved terminology review prompts', () => {
  it.each(['人工智能基金', 'AI基金'])(
    'accepts a declared target or alternative: %s',
    (translation) => {
      expect(analyzeReview(task('Our AI fund.', translation), resolved())).toEqual([]);
    },
  );

  it('respects English token boundaries instead of matching AI inside TAIL', () => {
    const findings = analyzeReview(task('Our AI fund.', 'TAIL基金'), resolved());
    expect(findings).toMatchObject([
      {
        code: 'TERM_MISMATCH',
        termId: 'term-ai',
        certainty: 'uncertain',
        source: { start: 4, end: 6, text: 'AI' },
        translation: null,
      },
    ]);
    expect(findings[0].reason).toContain('语境或改写可能合理');
    expect(findings[0].reason).toContain('结合基金语境核对');
  });

  it.each(['éAI基金', 'AIé基金', 'αAI基金', 'e\u0301AI基金', 'AI\u0301基金', '1AI基金'])(
    'does not accept an acronym attached to a Unicode word: %s',
    (translation) => {
      expect(
        analyzeReview(task('Our AI fund.', translation), resolved())
          .map((finding) => finding.code)
          .filter((code) => code.startsWith('TERM_')),
      ).toEqual(['TERM_MISMATCH']);
    },
  );

  it('allows an explicitly retained English acronym adjacent to Chinese text', () => {
    expect(analyzeReview(task('Our AI fund.', '采用AI技术'), resolved())).toEqual([]);
  });

  it('uses source retention and case settings only as declared', () => {
    const entry = term({ target: '', alternatives: [], retainSource: true });
    expect(analyzeReview(task('Our AI fund.', 'AI基金'), resolved(entry))).toEqual([]);
    expect(
      analyzeReview(task('Our AI fund.', 'ai基金'), resolved(entry)).map((f) => f.code),
    ).toEqual(['TERM_MISMATCH']);
    expect(
      analyzeReview(task('Our AI fund.', 'ai基金'), resolved({ ...entry, caseSensitive: false })),
    ).toEqual([]);
  });

  it('consumes only resolved longer-phrase matches and does not rescan shadowed short terms', () => {
    const entry = term({ source: 'generative AI', target: '生成式人工智能', alternatives: [] });
    const resolutions = new Map([
      [
        'p1',
        {
          matches: [
            { start: 4, end: 17, text: 'generative AI', entry, overriddenIds: ['term-ai'] },
          ],
          conflicts: [],
        },
      ],
    ]);
    expect(
      analyzeReview(task('Our generative AI fund.', '生成式人工智能基金'), resolutions),
    ).toEqual([]);
  });

  it('reports conflicts without selecting a candidate or changing the supplied library', () => {
    const resolution: TermResolution = {
      matches: [],
      conflicts: [
        {
          start: 4,
          end: 6,
          text: 'AI',
          entries: [term(), term({ id: 'term-alt', target: '智能系统' })],
        },
      ],
    };
    const before = JSON.stringify(resolution);
    expect(analyzeReview(task('Our AI fund.', '智能基金'), { p1: resolution })).toMatchObject([
      { code: 'TERM_CONFLICT', certainty: 'uncertain' },
    ]);
    expect(JSON.stringify(resolution)).toBe(before);
  });

  it('reports a same-priority terminology conflict even when the translation is a mock placeholder', () => {
    const resolution = resolved().p1;
    resolution.conflicts.push({
      start: 4,
      end: 6,
      text: 'AI',
      entries: [term(), term({ id: 'term-conflicting', target: '智能系统' })],
    });
    const findings = analyzeReview(task('Our AI fund.', '[模拟占位·非译文] Our AI fund.', 'mock'), {
      p1: resolution,
    });
    expect(findings.map((finding) => finding.code)).toEqual(['MOCK_OUTPUT', 'TERM_CONFLICT']);
    expect(findings.find((finding) => finding.code === 'TERM_CONFLICT')).toMatchObject({
      certainty: 'uncertain',
      source: { start: 4, end: 6, text: 'AI' },
    });
    expect(findings.some((finding) => finding.code === 'TERM_MISMATCH')).toBe(false);
  });

  it.each([false, true])(
    'unions alternatives from real co-winning equivalent choices (retain=%s) without dropping either note',
    (retainSource) => {
      const entries = [
        term({
          id: 'term-a',
          retainSource,
          target: retainSource ? '' : '人工智能',
          alternatives: ['机器智能'],
          note: '第一条适用说明',
        }),
        term({
          id: 'term-b',
          retainSource,
          target: retainSource ? '' : '人工智能',
          alternatives: ['智能系统'],
          note: '第二条适用说明',
        }),
      ];
      const snapshot = createTerminologySnapshot(
        { version: 1, entries },
        '',
        'Synthetic same-choice test',
      );
      const source = 'Our AI fund.';
      const resolution = resolveTerminology(snapshot, source);
      expect(resolution.conflicts).toEqual([]);
      expect(resolution.matches.map((match) => match.entry.id)).toEqual(['term-a', 'term-b']);
      const before = JSON.stringify({ entries, snapshot, resolution });
      expect(analyzeReview(task(source, '机器智能基金'), { p1: resolution })).toEqual([]);
      expect(analyzeReview(task(source, '智能系统基金'), { p1: resolution })).toEqual([]);
      const findings = analyzeReview(task(source, '科技基金'), { p1: resolution });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'TERM_MISMATCH',
        certainty: 'uncertain',
        source: { start: 4, end: 6, text: 'AI' },
      });
      expect(findings[0].reason).toContain('第一条适用说明');
      expect(findings[0].reason).toContain('第二条适用说明');
      expect(JSON.stringify({ entries, snapshot, resolution })).toBe(before);
    },
  );

  it('does not include an approval or a quality score in its output', () => {
    const finding = analyzeReview(task('Our AI fund.', '科技基金'), resolved())[0];
    expect('approved' in finding).toBe(false);
    expect('score' in finding).toBe(false);
    expect(finding.code satisfies ReviewCode).toBe('TERM_MISMATCH');
  });
});
