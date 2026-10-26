import type { ReviewCode, ReviewFinding, ReviewSpan, TermResolution } from './professional';
import type { Paragraph, Task } from './types';

type Kind = 'number' | 'currency' | 'date' | 'ratio' | 'percent' | 'multiple';
interface Token {
  kind: Kind;
  value: string;
  currency?: string;
  span: ReviewSpan;
}
interface Uncertain {
  span: ReviewSpan;
  reason: string;
  group: 'numeric' | 'date';
}
interface Scan {
  tokens: Token[];
  uncertain: Uncertain[];
}
const NUMBER = '[+\\-−]?\\d(?:\\d|[,，](?=\\d))*(?:\\.\\d+)?';
const SCALE = '(?:hundred|thousand|million|billion|trillion)(?![A-Za-z])|百|千|万|亿';
const CURRENCY =
  'US\\$|USD|U\\.S\\. dollars?|US dollars?|RMB|CNY|EUR|GBP|JPY|美元|人民币|元人民币|欧元|英镑|日元|元|[$¥￥]';
const scalePowers: Record<string, number> = {
  hundred: 2,
  thousand: 3,
  million: 6,
  billion: 9,
  trillion: 12,
  百: 2,
  千: 3,
  万: 4,
  亿: 8,
};
const months: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const span = (text: string, start: number, end: number): ReviewSpan => ({
  start,
  end,
  text: text.slice(start, end),
});

function decimal(raw: string, power = 0): string | undefined {
  const value = raw.replaceAll('，', ',').replace('−', '-');
  if (value.length > 64 || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value))
    return undefined;
  const sign = value.startsWith('-') ? '-' : '';
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').replaceAll(',', '').split('.');
  const digits = whole + fraction;
  const places = fraction.length - power;
  const padded = places > 0 ? digits.padStart(places + 1, '0') : digits + '0'.repeat(-places);
  const integer = (places > 0 ? padded.slice(0, -places) : padded).replace(/^0+(?=\d)/, '');
  const fractional = places > 0 ? padded.slice(-places).replace(/0+$/, '') : '';
  const canonical = integer + (fractional ? `.${fractional}` : '');
  return canonical === '0' ? '0' : sign + canonical;
}
function currency(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^(?:USD|US\$|U\.S\. dollars?|US dollars?|美元)$/i.test(raw)) return 'USD';
  if (/^(?:RMB|CNY|人民币|元人民币)$/i.test(raw)) return 'CNY';
  if (/^(?:EUR|欧元)$/i.test(raw)) return 'EUR';
  if (/^(?:GBP|英镑)$/i.test(raw)) return 'GBP';
  if (/^(?:JPY|日元)$/i.test(raw)) return 'JPY';
  return '?'; // $ / ¥ / ￥ / 元 do not identify one currency without context.
}
function dateValue(year: string, month: string | number, day: string): string | undefined {
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const result = new Date(Date.UTC(y, m - 1, d));
  if (result.getUTCFullYear() !== y || result.getUTCMonth() !== m - 1 || result.getUTCDate() !== d)
    return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function scan(text: string): Scan {
  const result: Scan = { tokens: [], uncertain: [] };
  const taken: ReviewSpan[] = [];
  function matches(pattern: RegExp, visit: (match: RegExpExecArray, location: ReviewSpan) => void) {
    for (const match of text.matchAll(pattern)) {
      const location = span(text, match.index, match.index + match[0].length);
      if (taken.some((old) => location.start < old.end && location.end > old.start)) continue;
      taken.push(location);
      visit(match, location);
    }
  }
  function uncertain(location: ReviewSpan, reason: string, group: Uncertain['group'] = 'numeric') {
    result.uncertain.push({ span: location, reason, group });
  }
  function date(match: RegExpExecArray, location: ReviewSpan, english = false) {
    const value = english
      ? dateValue(match[3], months[match[1].toLowerCase()], match[2])
      : dateValue(match[1], match[2], match[3]);
    if (value) result.tokens.push({ kind: 'date', value, span: location });
    else uncertain(location, '日期不在当前可验证的有效年月日范围内，请人工核对。', 'date');
  }
  matches(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g, date);
  matches(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g, date);
  const monthNames = Object.keys(months).join('|');
  matches(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'), (m, s) =>
    date(m, s, true),
  );
  matches(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})\\b`, 'gi'), (m, s) => {
    const value = dateValue(m[3], months[m[2].toLowerCase()], m[1]);
    if (value) result.tokens.push({ kind: 'date', value, span: s });
    else uncertain(s, '日期不在当前可验证的有效年月日范围内，请人工核对。', 'date');
  });
  matches(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, (_m, s) =>
    uncertain(s, '日/月顺序不明确，不按地区猜测日期，请人工核对。', 'date'),
  );
  matches(
    /百分之[零〇一二两三四五六七八九十百千万亿点\d.]{1,64}|(?<![\d.])[零〇一二两三四五六七八九十百千][零〇一二两三四五六七八九十百千万亿点]{0,63}(?:美元|人民币|元|％|%|个百分点)/g,
    (_m, s) => uncertain(s, '暂不解析中文数字或中文百分数写法，请人工核对数值和单位。'),
  );
  matches(
    /\b\d{1,64}(?:\.\d{1,64})?[eE][+-]?\d{1,4}\b|\b\d{1,3}(?:\.\d{3}){1,20},\d{1,64}\b/g,
    (_m, s) => uncertain(s, '科学计数法或地区小数写法暂不自动换算，请人工核对。'),
  );
  matches(
    new RegExp(
      `[（(]\\s*(?:(?:${CURRENCY})\\s*)?(?:${NUMBER}|[+\\-−]?\\.\\d{1,64})(?:\\s*(?:${SCALE}))?(?:\\s*(?:${CURRENCY}|%|％))?\\s*[）)]`,
      'gi',
    ),
    (_m, s) => uncertain(s, '括号内数字可能表示会计负数或普通注释，暂不按正数解释，请人工核对。'),
  );
  matches(/(?<![\d.])[+−-]?\.\d{1,64}/g, (_m, s) =>
    uncertain(s, '省略整数位的小数暂不解析，不把小数部分当作整数，请人工核对。'),
  );
  matches(new RegExp(`(${NUMBER})\\s*[:：比]\\s*(${NUMBER})`, 'g'), (m, s) => {
    const left = decimal(m[1]),
      right = decimal(m[2]);
    if (left !== undefined && right !== undefined)
      result.tokens.push({ kind: 'ratio', value: `${left}:${right}`, span: s });
    else uncertain(s, '比率中的数字格式暂不支持，请人工核对。');
  });
  const suffix = `${CURRENCY}|(?:percentage points?|percent|per cent|x)(?![A-Za-z])|个百分点|％|%|倍`;
  matches(
    new RegExp(`(?:(${CURRENCY})\\s*)?(${NUMBER})(?:\\s*(${SCALE}))?(?:\\s*(${suffix}))?`, 'gi'),
    (m, s) => {
      const value = decimal(m[2], m[3] ? scalePowers[m[3].toLowerCase()] : 0);
      if (value === undefined) {
        uncertain(s, '数字分组、位数或小数格式暂不支持，请人工核对。');
        return;
      }
      const unit = m[4] ?? '';
      if (/^(?:percentage points?|个百分点)$/i.test(unit)) {
        result.tokens.push({ kind: 'ratio', value: `${value}:percentage-point`, span: s });
        return;
      }
      if (/^(?:percent|per cent|％|%)$/i.test(unit)) {
        result.tokens.push({ kind: 'percent', value, span: s });
        return;
      }
      if (/^(?:倍|x)$/i.test(unit)) {
        result.tokens.push({ kind: 'multiple', value, span: s });
        return;
      }
      const before = currency(m[1]),
        after = currency(unit || undefined);
      const identified =
        before && after && before !== after && unit !== '元' ? '?' : (before ?? after);
      if (identified === '?') {
        uncertain(s, '货币符号或前后单位有歧义，未据上下文猜测币种，请人工核对。');
        return;
      }
      result.tokens.push({
        kind: identified ? 'currency' : 'number',
        value,
        ...(identified ? { currency: identified } : {}),
        span: s,
      });
    },
  );
  result.tokens.sort((a, b) => a.span.start - b.span.start);
  result.uncertain.sort((a, b) => a.span.start - b.span.start);
  return result;
}

function code(token: Token): ReviewCode {
  if (token.kind === 'currency') return 'CURRENCY_MISMATCH';
  if (token.kind === 'date') return 'DATE_MISMATCH';
  if (['percent', 'ratio', 'multiple'].includes(token.kind)) return 'RATIO_MISMATCH';
  return 'NUMBER_MISMATCH';
}
const key = (token: Token) => `${token.kind}|${token.currency ?? ''}|${token.value}`;
const label = (token: Token) => `${token.currency ? token.currency + ' ' : ''}${token.value}`;
function containsTerm(text: string, expected: string, caseSensitive: boolean): boolean {
  if (!expected) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Chinese commonly adjoins a retained English acronym without a separating space.
  const start = /^[A-Za-z0-9_]/.test(expected)
    ? '(?:(?<![\\p{L}\\p{M}\\p{N}_])|(?<=\\p{Script=Han}))'
    : '';
  const end = /[A-Za-z0-9_]$/.test(expected)
    ? '(?:(?![\\p{L}\\p{M}\\p{N}_])|(?=\\p{Script=Han}))'
    : '';
  return new RegExp(start + escaped + end, caseSensitive ? 'u' : 'iu').test(text);
}
function excerpt(value: ReviewSpan | null): ReviewSpan | null {
  if (!value || value.text.length <= 240) return value;
  let length = 240;
  const before = value.text.charCodeAt(length - 1),
    after = value.text.charCodeAt(length);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) length--;
  return { start: value.start, end: value.start + length, text: value.text.slice(0, length) };
}
function overview(value: string): ReviewSpan | null {
  return value ? excerpt(span(value, 0, value.length)) : null;
}

/** Deterministic review prompts over saved text. Empty findings never certify translation quality. */
export function analyzeReview(
  task: Task,
  resolvedByParagraph: ReadonlyMap<string, TermResolution> | Record<string, TermResolution> = {},
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const snapshotId = task.professional?.snapshot.id ?? 'none';
  for (const paragraph of task.paragraphs) {
    const local: ReviewFinding[] = [];
    const location = paragraph.location ?? `段落 ${task.paragraphs.indexOf(paragraph) + 1}`;
    function add(
      findingCode: ReviewCode,
      reason: string,
      source: ReviewSpan | null,
      translation: ReviewSpan | null,
      certainty: ReviewFinding['certainty'] = 'rule',
      termId?: string,
    ) {
      if (local.length >= 80) return;
      local.push({
        id: `${paragraph.id}:r${paragraph.revision}:s${snapshotId}:${findingCode}:${source?.start ?? 'x'}:${translation?.start ?? 'x'}:${local.length}`,
        paragraphId: paragraph.id,
        paragraphLocation: location,
        code: findingCode,
        severity: 'review',
        certainty,
        reason,
        source: excerpt(source),
        translation: excerpt(translation),
        ...(termId ? { termId } : {}),
      });
    }
    analyzeParagraph(paragraph, add);
    const resolution =
      resolvedByParagraph instanceof Map
        ? resolvedByParagraph.get(paragraph.id)
        : (resolvedByParagraph as Record<string, TermResolution>)[paragraph.id];
    for (const conflict of resolution?.conflicts ?? [])
      add(
        'TERM_CONFLICT',
        '同一原文存在未解决的术语候选；请结合项目语境选择，不自动替换。',
        { start: conflict.start, end: conflict.end, text: conflict.text },
        null,
        'uncertain',
      );
    if (!paragraph.translation.includes('[模拟占位·非译文]')) {
      const groups = new Map<string, TermResolution['matches']>();
      for (const match of resolution?.matches ?? []) {
        const choice = match.entry.retainSource ? 'retain-source' : `target:${match.entry.target}`;
        const key = JSON.stringify([match.start, match.end, choice]);
        const group = groups.get(key) ?? [];
        group.push(match);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const match = group[0];
        const candidates = group.flatMap(({ entry, text }) =>
          [entry.target, ...entry.alternatives, ...(entry.retainSource ? [text] : [])]
            .filter(Boolean)
            .map((value) => ({ value, caseSensitive: entry.caseSensitive })),
        );
        if (
          candidates.some(({ value, caseSensitive }) =>
            containsTerm(paragraph.translation, value, caseSensitive),
          )
        )
          continue;
        const choices = [...new Set(candidates.map(({ value }) => value))];
        const notes = group
          .filter(({ entry }) => entry.note)
          .map(({ entry }) => (group.length > 1 ? `${entry.id}：${entry.note}` : entry.note));
        add(
          'TERM_MISMATCH',
          `未找到术语候选「${choices.join(' / ')}」；语境或改写可能合理，请人工核对。${notes.length ? ` 备注：${notes.join('；')}` : ''}`,
          { start: match.start, end: match.end, text: match.text },
          null,
          'uncertain',
          match.entry.id,
        );
      }
    }
    if (local.length === 80)
      local.push({
        id: `${paragraph.id}:r${paragraph.revision}:s${snapshotId}:LIMIT`,
        paragraphId: paragraph.id,
        paragraphLocation: location,
        code: 'UNCERTAIN_FORMAT',
        severity: 'review',
        certainty: 'uncertain',
        reason: '本段检查提示较多，仅显示前 80 项；请人工完整核对本段。',
        source: overview(paragraph.source),
        translation: overview(paragraph.translation),
      });
    findings.push(...local);
  }
  return findings;
}

type Add = (
  code: ReviewCode,
  reason: string,
  source: ReviewSpan | null,
  translation: ReviewSpan | null,
  certainty?: ReviewFinding['certainty'],
  termId?: string,
) => void;
function analyzeParagraph(paragraph: Paragraph, add: Add) {
  const source = paragraph.source,
    translation = paragraph.translation;
  if (!source.trim()) return;
  if (!translation.trim()) {
    add(
      'EMPTY_TRANSLATION',
      '该非空原文段落尚无已保存译文；请补齐并核对段落覆盖。',
      overview(source),
      overview(translation),
    );
    return;
  }
  if (translation.includes('[模拟占位·非译文]')) {
    add(
      'MOCK_OUTPUT',
      '当前内容带有模拟占位标记，是流程样本，不是实际翻译；不据此报告专业质量通过。',
      overview(source),
      overview(translation),
    );
    return;
  }
  if (source.trim() === translation.trim() && /[A-Za-z]{3}/.test(source))
    add(
      'POSSIBLE_OMISSION',
      '已保存内容与英文原文相同，可能尚未翻译；专名原样保留也可能合理，请核对。',
      overview(source),
      overview(translation),
      'uncertain',
    );
  const significant = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '').length;
  if (significant(source) >= 120 && significant(translation) < 12)
    add(
      'POSSIBLE_OMISSION',
      '译文相对较短，可能有段落内容遗漏；这只是长度启发式，不能判断语义完整性。',
      overview(source),
      overview(translation),
      'uncertain',
    );
  const original = scan(source),
    translated = scan(translation);
  for (const uncertain of original.uncertain)
    add('UNCERTAIN_FORMAT', `原文：${uncertain.reason}`, uncertain.span, null, 'uncertain');
  for (const uncertain of translated.uncertain)
    add('UNCERTAIN_FORMAT', `译文：${uncertain.reason}`, null, uncertain.span, 'uncertain');
  const remaining = [...translated.tokens];
  const missing: Token[] = [];
  for (const token of original.tokens) {
    const index = remaining.findIndex((candidate) => key(candidate) === key(token));
    if (index >= 0) remaining.splice(index, 1);
    else missing.push(token);
  }
  for (const token of missing) {
    let index = remaining.findIndex(
      (candidate) =>
        candidate.value === token.value &&
        ['number', 'currency'].includes(candidate.kind) &&
        ['number', 'currency'].includes(token.kind),
    );
    if (index < 0) index = remaining.findIndex((candidate) => candidate.kind === token.kind);
    const counterpart = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    const group = token.kind === 'date' ? 'date' : 'numeric';
    if ([...original.uncertain, ...translated.uncertain].some((value) => value.group === group)) {
      add(
        'UNCERTAIN_FORMAT',
        '存在暂不支持或有歧义的写法，无法自动确认此项对应关系，请人工核对。',
        token.span,
        counterpart?.span ?? null,
        'uncertain',
      );
      continue;
    }
    const findingCode =
      token.kind === 'currency' || counterpart?.kind === 'currency'
        ? 'CURRENCY_MISMATCH'
        : code(token);
    add(
      findingCode,
      counterpart
        ? `原文「${label(token)}」与译文「${label(counterpart)}」按明确单位换算后不一致，请核对；不会自动改写。`
        : `译文未找到与原文「${label(token)}」等值且同类的项目，请核对是否遗漏或改写。`,
      token.span,
      counterpart?.span ?? null,
    );
  }
  for (const token of remaining) {
    const group = token.kind === 'date' ? 'date' : 'numeric';
    const uncertain = original.uncertain.some((value) => value.group === group);
    add(
      uncertain ? 'UNCERTAIN_FORMAT' : code(token),
      uncertain
        ? '原文存在暂不支持或有歧义的写法，无法确认新增数值的对应关系，请人工核对。'
        : `译文新增「${label(token)}」，未找到原文对应项目，请核对是否合理。`,
      null,
      token.span,
      uncertain ? 'uncertain' : 'rule',
    );
  }
}
