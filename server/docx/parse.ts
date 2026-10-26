import { posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import {
  DOCX_LIMITS,
  type DocxDocument,
  type DocxIssue,
  type DocxParagraph,
  type DocxReport,
  type DocxTable,
} from '../../shared/docx.js';
import { ArchiveError, readArchive } from './archive.js';

export class DocxError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
interface XNode {
  uri: string;
  local: string;
  attrs: Map<string, string>;
  children: XNode[];
  text: string;
}
interface Budget {
  nodes: number;
}
function a(node: XNode | undefined, local: string, uri = W): string | undefined {
  return node?.attrs.get(`${uri}|${local}`);
}
// ST_OnOff is shared by default-style flags, semantic toggles and numbering extensions.
// Unknown values cannot safely be interpreted as an inactive property.
function onOff(value: string | undefined, absent = false): boolean {
  if (value === undefined) return absent;
  if (['1', 'true', 'on'].includes(value)) return true;
  if (['0', 'false', 'off'].includes(value)) return false;
  throw new DocxError('INVALID_BOOLEAN', 'DOCX 包含无效的开关属性。');
}
function child(node: XNode | undefined, local: string): XNode | undefined {
  return node?.children.find((x) => x.uri === W && x.local === local);
}
function children(node: XNode, local: string): XNode[] {
  return node.children.filter((x) => x.uri === W && x.local === local);
}
function walk(node: XNode, visit: (node: XNode) => void) {
  visit(node);
  for (const c of node.children) walk(c, visit);
}
function nodes(node: XNode, local: string): XNode[] {
  const found: XNode[] = [];
  walk(node, (n) => {
    if (n.uri === W && n.local === local) found.push(n);
  });
  return found;
}
function xml(content: Buffer, budget: Budget): XNode {
  if (content.length > DOCX_LIMITS.xmlBytes)
    throw new DocxError('XML_LIMIT', 'DOCX XML 内容超过安全限额。', 413);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new DocxError('INVALID_XML', 'DOCX XML 必须是有效 UTF-8。');
  }
  if (
    /<!\s*(DOCTYPE|ENTITY)\b/i.test(source) ||
    /<\?xml[^?]*encoding\s*=\s*['"](?!utf-8['"])[^'"]+['"]/i.test(source)
  )
    throw new DocxError('UNSAFE_XML', 'DOCX 包含不允许的 DTD、实体声明或 XML 编码。');
  const parser = new SaxesParser({ xmlns: true });
  const stack: XNode[] = [];
  let root: XNode | undefined;
  parser.on('doctype', () => {
    throw new DocxError('UNSAFE_XML', 'DOCX 不允许 DTD 或实体声明。');
  });
  parser.on('error', () => {
    // Saxes can recover and emit an error for every later bad entity. Stop on the
    // first fatal error rather than synchronously scanning the remaining input.
    throw new DocxError('INVALID_XML', 'DOCX XML 损坏或命名空间无效。');
  });
  parser.on('opentag', (tag: SaxesTagNS) => {
    budget.nodes++;
    if (budget.nodes > DOCX_LIMITS.xmlNodes || stack.length >= DOCX_LIMITS.xmlDepth)
      throw new DocxError('XML_LIMIT', 'DOCX XML 节点或嵌套深度超过安全限额。', 413);
    const node: XNode = {
      uri: tag.uri,
      local: tag.local,
      attrs: new Map(
        Object.values(tag.attributes).map((value) => [`${value.uri}|${value.local}`, value.value]),
      ),
      children: [],
      text: '',
    };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) throw new DocxError('INVALID_XML', 'DOCX XML 有多个根节点。');
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => {
    if (stack.length) stack[stack.length - 1].text += value;
    else if (value.trim()) throw new DocxError('INVALID_XML', 'DOCX XML 根节点之外存在文字。');
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof DocxError) throw error;
    throw new DocxError('INVALID_XML', 'DOCX XML 损坏。');
  }
  if (!root || stack.length) throw new DocxError('INVALID_XML', 'DOCX XML 损坏或命名空间无效。');
  return root;
}
function relationshipSource(path: string): string {
  if (path === '_rels/.rels') return '';
  return path.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');
}
function targetPath(source: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new DocxError('UNSAFE_RELATIONSHIP', 'DOCX 内部关系路径无效。');
  }
  if (
    !decoded ||
    /[\\?#]/.test(decoded) ||
    Array.from(decoded).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    /^[a-z][a-z0-9+.-]*:/i.test(decoded)
  )
    throw new DocxError('UNSAFE_RELATIONSHIP', 'DOCX 内部关系路径不安全。');
  const resolved = posix.normalize(
    decoded.startsWith('/')
      ? decoded.slice(1)
      : posix.join(source ? posix.dirname(source) : '', decoded),
  );
  if (resolved.startsWith('../') || resolved === '..' || resolved.startsWith('/'))
    throw new DocxError('UNSAFE_RELATIONSHIP', 'DOCX 关系路径超出包范围。');
  return resolved;
}
interface Level {
  kind: 'bullet' | 'decimal';
  level: number;
  template: string;
  start: number;
}
interface Numbering {
  abstracts: Map<string, Map<number, Level>>;
  nums: Map<string, string>;
  overrides: Map<string, Map<number, number>>;
}

export async function parseDocx(
  buffer: Buffer,
  filename: string,
): Promise<{ document: DocxDocument; report: DocxReport }> {
  if (
    typeof filename !== 'string' ||
    !filename.toLowerCase().endsWith('.docx') ||
    filename.length > 180 ||
    /[/\\]/.test(filename) ||
    Array.from(filename).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new DocxError('INVALID_FILENAME', '请选择文件名有效的 .docx 文件。');
  let archive;
  try {
    archive = await readArchive(buffer);
  } catch (error) {
    if (error instanceof ArchiveError) throw new DocxError(error.code, error.message, error.status);
    throw new DocxError('INVALID_ZIP', 'DOCX 包读取失败。');
  }
  const issues: DocxIssue[] = [];
  const issue = (
    severity: DocxIssue['severity'],
    code: string,
    message: string,
    location: string,
  ) => {
    const existing = issues.find((x) => x.code === code && x.severity === severity);
    if (existing) {
      existing.count++;
      if (existing.locations.length < 20 && !existing.locations.includes(location))
        existing.locations.push(location);
    } else issues.push({ severity, code, message, locations: [location], count: 1 });
  };
  const budget = { nodes: 0 };
  const parts = new Map<string, XNode>();
  for (const [path, data] of archive.entries)
    if (/\.(xml|rels)$/i.test(path)) parts.set(path, xml(data, budget));
  const types = parts.get('[Content_Types].xml'),
    rels = parts.get('_rels/.rels'),
    main = parts.get('word/document.xml');
  if (
    !types ||
    types.uri !== CT ||
    types.local !== 'Types' ||
    !rels ||
    rels.uri !== R ||
    rels.local !== 'Relationships' ||
    !main ||
    main.uri !== W ||
    main.local !== 'document'
  )
    throw new DocxError(
      'INVALID_PACKAGE',
      '不是受支持的 Word DOCX 包：必需的内容类型、关系或正文缺失。',
    );
  const declaredParts = new Set<string>(),
    declaredExtensions = new Set<string>();
  if (types.text.trim()) throw new DocxError('INVALID_CONTENT_TYPE', 'DOCX 内容类型清单无效。');
  for (const declaration of types.children) {
    if (declaration.uri !== CT || !['Override', 'Default'].includes(declaration.local))
      throw new DocxError('INVALID_CONTENT_TYPE', 'DOCX 内容类型声明不受支持。');
    const key = a(declaration, declaration.local === 'Override' ? 'PartName' : 'Extension', '');
    const set = declaration.local === 'Override' ? declaredParts : declaredExtensions;
    if (!key || !a(declaration, 'ContentType', '') || set.has(key.toLowerCase()))
      throw new DocxError('INVALID_CONTENT_TYPE', 'DOCX 内容类型声明缺失或重复。');
    set.add(key.toLowerCase());
  }
  const contentTypes = types.children.filter((x) => x.uri === CT && x.local === 'Override');
  const docType = contentTypes.find((x) => a(x, 'PartName', '') === '/word/document.xml');
  if (
    a(docType, 'ContentType', '') !==
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  )
    throw new DocxError(
      'INVALID_CONTENT_TYPE',
      '仅支持普通 DOCX 正文，不支持宏启用或其它 Office 文件。',
    );
  const rootDocument = rels.children.filter(
    (x) =>
      x.uri === R &&
      x.local === 'Relationship' &&
      a(x, 'Type', '') === `${OFFICE_R}/officeDocument`,
  );
  if (
    rootDocument.length !== 1 ||
    a(rootDocument[0], 'TargetMode', '') === 'External' ||
    targetPath('', a(rootDocument[0], 'Target', '') ?? '') !== 'word/document.xml'
  )
    throw new DocxError('INVALID_PACKAGE', 'DOCX 主文档关系缺失、重复或暂不支持。');
  for (const [path, part] of parts) {
    if (path.endsWith('.rels')) {
      if (part.uri !== R || part.local !== 'Relationships')
        throw new DocxError('INVALID_RELATIONSHIPS', 'DOCX 关系清单损坏。');
      const seen = new Set<string>();
      for (const relationship of part.children) {
        if (relationship.uri !== R || relationship.local !== 'Relationship')
          throw new DocxError('INVALID_RELATIONSHIPS', 'DOCX 含无法识别的关系声明。');
        const id = a(relationship, 'Id', ''),
          target = a(relationship, 'Target', ''),
          mode = a(relationship, 'TargetMode', '');
        if (!id || !target || seen.has(id))
          throw new DocxError('INVALID_RELATIONSHIPS', 'DOCX 关系声明缺失或重复。');
        seen.add(id);
        if (mode === 'External') {
          issue(
            'blocking',
            'EXTERNAL_RELATIONSHIP',
            '包含外部关系或链接；不会访问外部 URL，当前不能完整保留链接含义。',
            path,
          );
          continue;
        }
        if (mode && mode !== 'Internal')
          throw new DocxError('INVALID_RELATIONSHIPS', 'DOCX 关系模式无效。');
        const resolved = targetPath(relationshipSource(path), target);
        if (!archive.entries.has(resolved))
          throw new DocxError('MISSING_PART', 'DOCX 关系指向缺失的内部内容。');
      }
    }
  }
  const allowed =
    /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:core|app|custom)\.xml|docProps\/thumbnail\.[A-Za-z0-9]+|word\/document\.xml|word\/styles(?:WithEffects)?\.xml|word\/numbering\.xml|word\/settings\.xml|word\/webSettings\.xml|word\/fontTable\.xml|word\/theme\/theme[0-9]*\.xml|word\/_rels\/(?:document|styles|numbering|settings|fontTable|webSettings)\.xml\.rels)$/;
  for (const path of archive.entries.keys()) {
    if (allowed.test(path)) continue;
    if (/^word\/_rels\/(?:footnotes|endnotes)\.xml\.rels$/.test(path)) {
      const noteRels = parts.get(path)!;
      if (
        noteRels.uri === R &&
        noteRels.local === 'Relationships' &&
        noteRels.children.length === 0 &&
        !noteRels.text.trim()
      )
        continue;
      issue('blocking', 'NOTES_RELATIONSHIPS', '注释部件包含关系，无法确认内容完整性。', path);
      continue;
    }
    if (/^word\/(footnotes|endnotes)\.xml$/.test(path)) {
      const note = parts.get(path)!;
      const noteAllowed = new Set([
        'footnotes',
        'endnotes',
        'footnote',
        'endnote',
        'p',
        'r',
        'separator',
        'continuationSeparator',
        'pPr',
        'rPr',
        'spacing',
        'rStyle',
        'footnoteRef',
        'endnoteRef',
      ]);
      let meaningful = false;
      walk(note, (value) => {
        if (value.uri !== W || !noteAllowed.has(value.local) || value.text.trim())
          meaningful = true;
      });
      // Word writers can emit separator-only note parts without user note content.
      if (
        !meaningful &&
        note.children.every(
          (x) =>
            x.uri === W &&
            ['footnote', 'endnote'].includes(x.local) &&
            ['separator', 'continuationSeparator'].includes(a(x, 'type') ?? ''),
        )
      ) {
        issue('warning', 'EMPTY_NOTES', '存在仅分隔符的注释部件，导出不保留分隔线。', path);
        continue;
      }
      issue('blocking', 'NOTES', '包含脚注或尾注；当前无法安全纳入完整翻译。', path);
      continue;
    }
    if (/^word\/(?:header|footer)[^/]*\.xml$/.test(path)) {
      const part = parts.get(path)!;
      const emptyAllowed = new Set([
        'hdr',
        'ftr',
        'p',
        'r',
        't',
        'pPr',
        'rPr',
        'pStyle',
        'rStyle',
        'jc',
        'spacing',
        'ind',
        'b',
        'i',
        'u',
        'color',
        'sz',
        'rFonts',
        'lang',
        'proofErr',
        'bookmarkStart',
        'bookmarkEnd',
      ]);
      let meaningful = false;
      walk(part, (value) => {
        if (value.uri !== W || !emptyAllowed.has(value.local) || value.text.trim())
          meaningful = true;
      });
      issue(
        meaningful ? 'blocking' : 'warning',
        meaningful ? 'HEADERS_FOOTERS' : 'EMPTY_HEADERS_FOOTERS',
        meaningful ? '包含页眉或页脚内容；当前不能完整翻译。' : '空页眉页脚的版式不保留。',
        path,
      );
      continue;
    }
    if (/comments/i.test(path)) {
      issue('blocking', 'COMMENTS', '包含批注或批注关系；当前无法安全处理审阅含义。', path);
      continue;
    }
    if (/(?:vba|macros|embeddings|activeX|oleObject)/i.test(path)) {
      issue(
        'blocking',
        'ACTIVE_CONTENT',
        '包含宏、嵌入或活动内容；不会执行，禁止完整文档翻译。',
        path,
      );
      continue;
    }
    if (/^word\/media\//.test(path)) {
      issue('blocking', 'GRAPHICS', '包含图形或图片，可能承载文字或含义；当前不会静默丢弃。', path);
      continue;
    }
    issue('blocking', 'UNSUPPORTED_PART', '包含当前不支持的文档部件，无法确认内容完整性。', path);
  }
  const body = child(main, 'body');
  if (!body || main.children.filter((x) => x.uri === W && x.local === 'body').length !== 1)
    throw new DocxError('INVALID_DOCUMENT', 'DOCX 正文结构缺失或重复。');
  const stylePart = parts.get('word/styles.xml');
  const styles = new Map<string, XNode>();
  const defaultStyles = new Map<string, string>();
  if (stylePart) {
    if (stylePart.uri !== W || stylePart.local !== 'styles')
      throw new DocxError('INVALID_STYLES', 'DOCX 样式清单无效。');
    for (const style of children(stylePart, 'style')) {
      const id = a(style, 'styleId');
      if (id) {
        if (styles.has(id)) throw new DocxError('INVALID_STYLES', 'DOCX 样式 ID 重复。');
        styles.set(id, style);
        if (onOff(a(style, 'default'))) {
          const type = a(style, 'type');
          if (!type || defaultStyles.has(type))
            throw new DocxError('INVALID_STYLES', 'DOCX 默认样式类型缺失或重复。');
          defaultStyles.set(type, id);
        }
      }
    }
  }
  const usedStyles = new Set<string>();
  function heading(styleId: string | undefined, seen = new Set<string>()): number | undefined {
    if (!styleId) return undefined;
    if (seen.has(styleId)) {
      issue('blocking', 'STYLE_CYCLE', '段落样式存在循环继承。', `样式 ${styleId}`);
      return undefined;
    }
    seen.add(styleId);
    usedStyles.add(styleId);
    const style = styles.get(styleId),
      outline = a(child(child(style, 'pPr'), 'outlineLvl'), 'val');
    if (outline !== undefined) {
      const n = Number(outline);
      if (Number.isInteger(n) && n >= 0 && n <= 5) return n + 1;
      if (n < 9)
        issue('blocking', 'HEADING_LEVEL', '标题级别超过当前支持的 1–6 级。', `样式 ${styleId}`);
      return undefined;
    }
    const name = a(child(style, 'name'), 'val') ?? styleId;
    const match = /^(?:heading|标题)\s*([1-9])$/i.exec(name);
    if (match) {
      const n = Number(match[1]);
      if (n <= 6) return n;
      issue('blocking', 'HEADING_LEVEL', '标题级别超过当前支持的 1–6 级。', `样式 ${styleId}`);
      return undefined;
    }
    return heading(a(child(style, 'basedOn'), 'val'), seen);
  }
  function inheritedNumValue(
    styleId: string | undefined,
    property: string,
    seen = new Set<string>(),
  ): string | undefined {
    if (!styleId) return undefined;
    if (seen.has(styleId)) {
      issue('blocking', 'STYLE_CYCLE', '列表样式存在循环继承。', `样式 ${styleId}`);
      return undefined;
    }
    seen.add(styleId);
    usedStyles.add(styleId);
    const style = styles.get(styleId);
    return (
      a(child(child(child(style, 'pPr'), 'numPr'), property), 'val') ??
      inheritedNumValue(a(child(style, 'basedOn'), 'val'), property, seen)
    );
  }
  const numbering: Numbering = { abstracts: new Map(), nums: new Map(), overrides: new Map() };
  const numPart = parts.get('word/numbering.xml');
  if (numPart) {
    if (numPart.uri !== W || numPart.local !== 'numbering')
      throw new DocxError('INVALID_NUMBERING', 'DOCX 编号清单无效。');
    for (const abstract of children(numPart, 'abstractNum')) {
      const id = a(abstract, 'abstractNumId');
      if (id === undefined || numbering.abstracts.has(id))
        throw new DocxError('INVALID_NUMBERING', 'DOCX 抽象编号 ID 无效。');
      const levels = new Map<number, Level>();
      for (const level of children(abstract, 'lvl')) {
        const index = Number(a(level, 'ilvl')),
          format = a(child(level, 'numFmt'), 'val'),
          template = a(child(level, 'lvlText'), 'val') ?? '',
          start = Number(a(child(level, 'start'), 'val') ?? '1');
        if (!Number.isInteger(index) || index < 0 || index > 8 || levels.has(index))
          throw new DocxError('INVALID_NUMBERING', 'DOCX 列表级别无效。');
        if (format === 'bullet' || format === 'decimal')
          levels.set(index, { kind: format, level: index, template, start });
      }
      numbering.abstracts.set(id, levels);
    }
    for (const num of children(numPart, 'num')) {
      const id = a(num, 'numId'),
        abstract = a(child(num, 'abstractNumId'), 'val');
      if (!id || !abstract || numbering.nums.has(id))
        throw new DocxError('INVALID_NUMBERING', 'DOCX 列表编号引用无效。');
      numbering.nums.set(id, abstract);
      const overrides = new Map<number, number>();
      for (const override of children(num, 'lvlOverride')) {
        const level = Number(a(override, 'ilvl')),
          value = Number(a(child(override, 'startOverride'), 'val'));
        if (child(override, 'lvl'))
          issue('blocking', 'NUMBERING_OVERRIDE', '列表级别覆写暂不支持。', 'word/numbering.xml');
        if (Number.isInteger(level) && Number.isInteger(value) && value >= 0)
          overrides.set(level, value);
      }
      numbering.overrides.set(id, overrides);
    }
  }
  const seenText = new Set<XNode>();
  let paragraphCount = 0,
    translatable = 0,
    empty = 0,
    characters = 0,
    tableCount = 0,
    cellCount = 0;
  const counters = new Map<string, number[]>();
  const blockedNodes: Record<string, [string, string]> = {
    drawing: ['GRAPHICS', '包含图形或图片，当前不能确认其中的文字和含义。'],
    pict: ['GRAPHICS', '包含旧式图形或文本框。'],
    object: ['ACTIVE_CONTENT', '包含嵌入对象。'],
    txbxContent: ['TEXTBOX', '包含文本框，当前无法保留其阅读顺序。'],
    ins: ['REVISIONS', '包含修订；必须先处理修订再导入。'],
    del: ['REVISIONS', '包含删除修订；必须先处理修订再导入。'],
    moveFrom: ['REVISIONS', '包含移动修订。'],
    moveTo: ['REVISIONS', '包含移动修订。'],
    delText: ['REVISIONS', '包含删除文字。'],
    commentReference: ['COMMENTS', '包含批注引用。'],
    commentRangeStart: ['COMMENTS', '包含批注范围。'],
    commentRangeEnd: ['COMMENTS', '包含批注范围。'],
    footnoteReference: ['NOTES', '包含脚注引用。'],
    endnoteReference: ['NOTES', '包含尾注引用。'],
    fldSimple: ['FIELDS', '包含域，当前不能保证动态文字含义。'],
    fldChar: ['FIELDS', '包含复杂域。'],
    instrText: ['FIELDS', '包含域指令。'],
    altChunk: ['ALTERNATE_CONTENT', '包含外部或嵌入正文内容。'],
    sdt: ['CONTENT_CONTROL', '包含内容控件，当前无法安全保留。'],
    customXml: ['CUSTOM_XML', '包含自定义 XML 内容。'],
    subDoc: ['ALTERNATE_CONTENT', '包含子文档。'],
    sym: ['SYMBOL', '包含符号字体字符，当前不能安全解码。'],
    softHyphen: ['SPECIAL_TEXT', '包含软连字符，当前无法准确保留。'],
    noBreakHyphen: ['SPECIAL_TEXT', '包含特殊连字符，当前无法准确保留。'],
    ruby: ['SPECIAL_TEXT', '包含注音或拼音结构。'],
    gridSpan: ['MERGED_CELLS', '包含跨列合并单元格。'],
    vMerge: ['MERGED_CELLS', '包含纵向合并单元格。'],
    hMerge: ['MERGED_CELLS', '包含合并单元格。'],
    tblpPr: ['FLOATING_TABLE', '包含浮动表格，阅读顺序不能确认。'],
    vanish: ['HIDDEN_TEXT', '包含隐藏文字格式，当前无法安全确认可见内容。'],
    webHidden: ['HIDDEN_TEXT', '包含隐藏文字格式。'],
    numPicBullet: ['PICTURE_BULLETS', '包含图片项目符号。'],
    lvlPicBulletId: ['PICTURE_BULLETS', '包含图片项目符号引用。'],
    lvlRestart: ['NUMBERING_RESTART', '列表含显式重启规则，当前不能安全保留。'],
    numStyleLink: ['NUMBERING_STYLE_LINK', '列表含编号样式链接，当前不能安全解析。'],
    styleLink: ['NUMBERING_STYLE_LINK', '列表含样式链接，当前不能安全解析。'],
    isLgl: ['NUMBERING_LEGAL', '列表含法律编号规则，当前不能安全保留。'],
    framePr: ['FLOATING_TEXT', '包含定位或浮动文字，当前不能确认阅读顺序。'],
    specVanish: ['HIDDEN_TEXT', '包含特殊隐藏文字格式。'],
    sectPrChange: ['REVISIONS', '包含节属性修订。'],
    pPrChange: ['REVISIONS', '包含段落属性修订。'],
    rPrChange: ['REVISIONS', '包含文字属性修订。'],
    tblPrChange: ['REVISIONS', '包含表格属性修订。'],
    trPrChange: ['REVISIONS', '包含表格行属性修订。'],
    tcPrChange: ['REVISIONS', '包含单元格属性修订。'],
    strike: ['SEMANTIC_FORMATTING', '包含删除线，简化后可能改变文字或金额含义。'],
    dstrike: ['SEMANTIC_FORMATTING', '包含双删除线，简化后可能改变文字含义。'],
    hidden: ['HIDDEN_TEXT', '包含隐藏行或隐藏内容。'],
    cellIns: ['REVISIONS', '包含单元格插入修订。'],
    cellDel: ['REVISIONS', '包含单元格删除修订。'],
    cellMerge: ['REVISIONS', '包含单元格合并修订。'],
    numberingChange: ['REVISIONS', '包含编号修订。'],
    tab: ['TAB', ''],
  };
  const audited = new Set<XNode>();
  const semanticToggles = new Set([
    'vanish',
    'webHidden',
    'specVanish',
    'strike',
    'dstrike',
    'hidden',
    'isLgl',
  ]);
  const propertyChildren: Record<string, Set<string>> = {
    pPr: new Set(
      'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange'.split(
        ' ',
      ),
    ),
    rPr: new Set(
      'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange'.split(
        ' ',
      ),
    ),
    tcPr: new Set(
      'cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText vAlign hideMark headers cellIns cellDel cellMerge tcPrChange'.split(
        ' ',
      ),
    ),
    trPr: new Set(
      'cnfStyle divId gridBefore gridAfter wBefore wAfter cantSplit trHeight tblHeader tblCellSpacing jc hidden ins del trPrChange'.split(
        ' ',
      ),
    ),
    tblPr: new Set(
      'tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize tblStyleColBandSize tblW jc tblCellSpacing tblInd tblBorders shd tblLayout tblCellMar tblLook tblCaption tblDescription tblPrChange'.split(
        ' ',
      ),
    ),
    sectPr: new Set(
      'headerReference footerReference footnotePr endnotePr type pgSz pgMar paperSrc pgBorders lnNumType pgNumType cols formProt vAlign noEndnote titlePg textDirection bidi rtlGutter docGrid printerSettings sectPrChange'.split(
        ' ',
      ),
    ),
  };
  function audit(node: XNode, location: string) {
    walk(node, (n) => {
      if (audited.has(n)) return;
      audited.add(n);
      const restartAfterBreak = a(n, 'restartNumberingAfterBreak', W15);
      if (restartAfterBreak !== undefined && onOff(restartAfterBreak))
        issue(
          'blocking',
          'NUMBERING_RESTART',
          '列表含跨节重启编号规则，当前不能安全保留。',
          location,
        );
      if (n.uri === W) {
        if (n.text.trim() && !['t', 'instrText', 'delText'].includes(n.local))
          issue(
            'blocking',
            'UNSUPPORTED_TEXT',
            '发现标准文字节点之外的文字，无法保证完整性。',
            location,
          );
        const allowedProperties = propertyChildren[n.local];
        if (allowedProperties)
          for (const value of n.children)
            if (value.uri !== W || !allowedProperties.has(value.local))
              issue(
                'blocking',
                'UNSUPPORTED_PROPERTY',
                '包含无法确认安全含义的格式或结构属性。',
                location,
              );
        if (n.local === 'position' && a(n, 'val') !== '0')
          issue(
            'blocking',
            'SEMANTIC_FORMATTING',
            '包含升降文字，简化后可能改变符号含义。',
            location,
          );
        if (n.local === 'vertAlign' && a(n, 'val') !== 'baseline')
          issue(
            'blocking',
            'SEMANTIC_FORMATTING',
            '含上标或下标，简化后可能改变数字或符号含义。',
            location,
          );
        if (n.local.endsWith('Change') && !blockedNodes[n.local])
          issue('blocking', 'REVISIONS', '包含暂不支持的属性修订。', location);
        const block = blockedNodes[n.local];
        if (
          block &&
          n.local !== 'tab' &&
          (!semanticToggles.has(n.local) || onOff(a(n, 'val'), true))
        )
          issue('blocking', block[0], block[1], location);
        if (n.local === 'br' && a(n, 'type') && a(n, 'type') !== 'textWrapping')
          issue(
            'warning',
            'PAGE_BREAKS',
            '分页或分栏符会转为基础段内换行，不保留原分页。',
            location,
          );
        if (
          [
            'b',
            'bCs',
            'iCs',
            'caps',
            'smallCaps',
            'outline',
            'shadow',
            'emboss',
            'imprint',
            'effect',
            'kern',
            'fitText',
            'tblHeader',
            'tblBorders',
            'tcBorders',
            'tblW',
            'tcW',
            'tblLayout',
            'tblCellMar',
            'tblCellSpacing',
            'i',
            'u',
            'color',
            'sz',
            'szCs',
            'rFonts',
            'highlight',
            'shd',
            'jc',
            'spacing',
            'ind',
            'bdr',
            'pBdr',
            'pgSz',
            'pgMar',
            'cols',
            'bidi',
            'rtl',
            'textDirection',
          ].includes(n.local)
        )
          issue(
            'warning',
            'VISUAL_FORMATTING',
            '字体、强调、颜色、方向或页面版式会简化；仅保证可编辑基础结构。',
            location,
          );
        if (n.local === 'hyperlink')
          issue(
            'warning',
            'INTERNAL_LINK_FORMAT',
            '超链接文字会保留，链接格式和跳转不保留。',
            location,
          );
      } else {
        // Relationship attributes are permitted; foreign elements may carry fallback text/graphics.
        issue(
          'blocking',
          'FOREIGN_CONTENT',
          '包含未知或无命名空间的内容，无法确认完整性。',
          location,
        );
      }
    });
  }
  function paragraph(node: XNode, id: string, location: string): DocxParagraph {
    paragraphCount++;
    if (paragraphCount > DOCX_LIMITS.paragraphs)
      throw new DocxError(
        'PARAGRAPH_LIMIT',
        'DOCX 超过 100 个段落（包括空段落和表格内段落）。',
        413,
      );
    audit(node, location);
    let source = '';
    function read(n: XNode) {
      if (n.uri !== W) {
        return;
      }
      if (n.local === 'pPr' || n.local === 'rPr') return;
      if (n.local === 't') {
        seenText.add(n);
        if (n.children.length)
          issue('blocking', 'INVALID_TEXT_NODE', '文字节点含不支持的子结构。', location);
        source += n.text;
        return;
      }
      if (n.local === 'tab') {
        source += '\t';
        return;
      }
      if (n.local === 'br' || n.local === 'cr') {
        source += '\n';
        return;
      }
      if (['p', 'r', 'hyperlink', 'smartTag'].includes(n.local)) {
        for (const c of n.children) read(c);
        return;
      }
      if (
        [
          'bookmarkStart',
          'bookmarkEnd',
          'proofErr',
          'lastRenderedPageBreak',
          'permStart',
          'permEnd',
        ].includes(n.local)
      )
        return;
      issue(
        'blocking',
        'UNSUPPORTED_PARAGRAPH_CONTENT',
        '段落包含暂不支持的内容，不能作为完整文档翻译。',
        location,
      );
    }
    read(node);
    characters += source.length;
    if (characters > DOCX_LIMITS.characters)
      throw new DocxError('CHARACTER_LIMIT', 'DOCX 可见正文超过 20,000 字符。', 413);
    const pPr = child(node, 'pPr');
    const normal = styles.get('Normal');
    const defaultStyle =
      defaultStyles.get('paragraph') ??
      (normal && a(normal, 'default') === undefined ? 'Normal' : undefined);
    const paragraphStyle = a(child(pPr, 'pStyle'), 'val') ?? defaultStyle;
    let headingLevel = heading(paragraphStyle);
    const outline = a(child(pPr, 'outlineLvl'), 'val');
    if (outline !== undefined) {
      const n = Number(outline);
      if (Number.isInteger(n) && n >= 0 && n <= 5) headingLevel = n + 1;
      else if (n !== 9) issue('blocking', 'HEADING_LEVEL', '标题级别暂不支持。', location);
    }
    const result: DocxParagraph = {
      kind: 'paragraph',
      id,
      paragraphId: source.trim() ? `p${String(++translatable).padStart(4, '0')}` : null,
      source,
      location,
      ...(headingLevel ? { headingLevel } : {}),
    };
    if (!source.trim()) empty++;
    const numPr = child(pPr, 'numPr');
    const styleId = paragraphStyle;
    const inheritedId = inheritedNumValue(styleId, 'numId');
    const inheritedLevel = inheritedNumValue(styleId, 'ilvl');
    if (numPr || inheritedId !== undefined || inheritedLevel !== undefined) {
      const numId = a(child(numPr, 'numId'), 'val') ?? inheritedId,
        levelIndex = Number(a(child(numPr, 'ilvl'), 'val') ?? inheritedLevel ?? '0');
      if (numId && numId !== '0') {
        const abstract = numbering.nums.get(numId),
          level = abstract ? numbering.abstracts.get(abstract)?.get(levelIndex) : undefined;
        if (
          !level ||
          !Number.isInteger(levelIndex) ||
          levelIndex < 0 ||
          levelIndex > 8 ||
          !Number.isInteger(level.start) ||
          level.start < 0 ||
          !level.template ||
          level.template.length > 80
        ) {
          issue(
            'blocking',
            'UNSUPPORTED_NUMBERING',
            '列表编号格式、级别或引用暂不支持。',
            location,
          );
        } else {
          const values = counters.get(numId) ?? [];
          const start = numbering.overrides.get(numId)?.get(levelIndex) ?? level.start;
          values[levelIndex] = values[levelIndex] === undefined ? start : values[levelIndex] + 1;
          values.splice(levelIndex + 1);
          counters.set(numId, values);
          let label =
            level.kind === 'bullet'
              ? level.template
              : level.template.replace(/%([1-9])/g, (_match: string, index: string) => {
                  const ancestorIndex = Number(index) - 1;
                  const ancestor = abstract
                    ? numbering.abstracts.get(abstract)?.get(ancestorIndex)
                    : undefined;
                  const initial =
                    numbering.overrides.get(numId)?.get(ancestorIndex) ?? ancestor?.start;
                  if (
                    ancestorIndex > levelIndex ||
                    initial === undefined ||
                    !Number.isInteger(initial) ||
                    initial < 0
                  ) {
                    issue(
                      'blocking',
                      'UNSUPPORTED_NUMBERING',
                      '列表引用未定义或未来级别的计数器。',
                      location,
                    );
                    return '?';
                  }
                  return String(values[ancestorIndex] ?? initial);
                });
          if (level.kind === 'decimal' && (!/%[1-9]/.test(level.template) || /%[0-9]/.test(label)))
            issue('blocking', 'UNSUPPORTED_NUMBERING', '列表编号模板暂不支持。', location);
          if (level.kind === 'bullet' && /[\uE000-\uF8FF]/.test(label)) {
            label = '•';
            issue('warning', 'BULLET_APPEARANCE', '字体专用项目符号会规范为普通圆点。', location);
          }
          result.list = { kind: level.kind, level: levelIndex, label };
          issue(
            'warning',
            'LIST_LABELS_FIXED',
            '列表编号以固定文字保留，导出后不会自动续编号。',
            location,
          );
        }
      } else if (!numId) issue('blocking', 'UNSUPPORTED_NUMBERING', '列表缺少编号引用。', location);
    }
    return result;
  }
  function table(node: XNode, id: string, location: string): DocxTable {
    tableCount++;
    if (tableCount > DOCX_LIMITS.tables)
      throw new DocxError('TABLE_LIMIT', 'DOCX 表格数量超过安全限额。', 413);
    audit(node, location);
    const tableStyle =
      a(child(child(node, 'tblPr'), 'tblStyle'), 'val') ?? defaultStyles.get('table');
    if (tableStyle) usedStyles.add(tableStyle);
    const rows = children(node, 'tr');
    if (!rows.length) issue('blocking', 'EMPTY_TABLE', '表格没有可识别的行。', location);
    let expected: number | undefined;
    const mapped = rows.map((row, r) => {
      const cells = children(row, 'tc');
      if (!cells.length || cells.length > DOCX_LIMITS.columns)
        throw new DocxError('TABLE_LIMIT', 'DOCX 表格列数超过支持范围。', 413);
      if (expected !== undefined && expected !== cells.length)
        issue(
          'blocking',
          'IRREGULAR_TABLE',
          '表格每行列数不一致，不能确认简单单元格映射。',
          location,
        );
      expected = cells.length;
      if (
        a(child(child(row, 'trPr'), 'gridBefore'), 'val') ||
        a(child(child(row, 'trPr'), 'gridAfter'), 'val')
      )
        issue('blocking', 'IRREGULAR_TABLE', '表格含省略单元格，不属于简单表格。', location);
      for (const c of row.children)
        if (c.uri !== W || !['trPr', 'tc'].includes(c.local))
          issue('blocking', 'UNSUPPORTED_TABLE_CONTENT', '表格行包含不支持的结构。', location);
      return {
        id: `${id}-r${String(r + 1).padStart(3, '0')}`,
        cells: cells.map((cell, c) => {
          cellCount++;
          if (cellCount > DOCX_LIMITS.cells)
            throw new DocxError('TABLE_LIMIT', 'DOCX 单元格数量超过安全限额。', 413);
          const cellId = `${id}-r${String(r + 1).padStart(3, '0')}-c${String(c + 1).padStart(3, '0')}`;
          const cellLocation = `${location} / 第 ${r + 1} 行第 ${c + 1} 列`;
          if (nodes(cell, 'tbl').length)
            issue(
              'blocking',
              'NESTED_TABLE',
              '包含嵌套表格，无法作为简单表格完整翻译。',
              cellLocation,
            );
          for (const n of cell.children)
            if (n.uri !== W || !['tcPr', 'p'].includes(n.local))
              issue(
                'blocking',
                'UNSUPPORTED_CELL_CONTENT',
                '单元格包含段落之外的不支持内容。',
                cellLocation,
              );
          const ps = children(cell, 'p');
          if (!ps.length)
            issue('blocking', 'MISSING_CELL_PARAGRAPH', '单元格缺少可识别段落。', cellLocation);
          return {
            id: cellId,
            paragraphs: ps.map((p, index) =>
              paragraph(
                p,
                `${cellId}-p${String(index + 1).padStart(3, '0')}`,
                `${cellLocation} / 第 ${index + 1} 段`,
              ),
            ),
          };
        }),
      };
    });
    for (const n of node.children)
      if (n.uri !== W || !['tblPr', 'tblGrid', 'tr'].includes(n.local))
        issue('blocking', 'UNSUPPORTED_TABLE_CONTENT', '表格包含当前不支持的内容。', location);
    return { kind: 'table', id, rows: mapped };
  }
  const document: DocxDocument = { version: 1, filename, blocks: [] };
  for (const [index, node] of body.children.entries()) {
    const id = `b${String(index + 1).padStart(4, '0')}`,
      location = `正文块 ${index + 1}`;
    if (node.uri === W && node.local === 'p') document.blocks.push(paragraph(node, id, location));
    else if (node.uri === W && node.local === 'tbl')
      document.blocks.push(table(node, id, `表格 ${tableCount + 1}`));
    else if (node.uri === W && node.local === 'sectPr') {
      audit(node, location);
    } else {
      audit(node, location);
      issue(
        'blocking',
        'UNSUPPORTED_BODY_CONTENT',
        '正文包含当前不支持的结构，不能静默忽略。',
        location,
      );
    }
  }
  // Independent coverage accounting catches visible Word text outside parsed supported paths.
  for (const text of nodes(main, 't'))
    if (!seenText.has(text) && text.text.length)
      issue(
        'blocking',
        'UNMAPPED_TEXT',
        '发现未映射的正文文字，禁止完整文档翻译。',
        'word/document.xml',
      );
  if (main.children.some((x) => x !== body))
    issue(
      'blocking',
      'UNSUPPORTED_DOCUMENT_CONTENT',
      '主文档包含正文之外的不支持内容。',
      'word/document.xml',
    );
  if (!translatable)
    issue('blocking', 'NO_TEXT', '没有可翻译的非空正文段落。', 'word/document.xml');
  audit(main, 'word/document.xml');
  if (stylePart) {
    const inspectedStyles = new Set<string>();
    const markStyle = (id: string | undefined, seen = new Set<string>()) => {
      if (!id) return;
      if (seen.has(id)) {
        issue('blocking', 'STYLE_CYCLE', '使用中的样式存在循环继承或引用。', `样式 ${id}`);
        return;
      }
      if (inspectedStyles.has(id)) return;
      const style = styles.get(id);
      if (!style) return;
      const path = new Set(seen);
      path.add(id);
      audit(style, `样式 ${id}`);
      markStyle(a(child(style, 'basedOn'), 'val'), path);
      for (const reference of ['pStyle', 'rStyle', 'tblStyle'])
        for (const node of nodes(style, reference)) markStyle(a(node, 'val'), path);
      inspectedStyles.add(id);
    };
    for (const id of usedStyles) markStyle(id);
    for (const style of nodes(main, 'rStyle')) markStyle(a(style, 'val'));
    if (nodes(main, 'r').length) markStyle(defaultStyles.get('character'));
    const defaults = child(stylePart, 'docDefaults');
    if (defaults) {
      audit(defaults, '默认样式');
      if (nodes(defaults, 'numPr').length)
        issue(
          'blocking',
          'NUMBERING_DEFAULT',
          '文档默认段落含编号规则，当前不能安全保留。',
          '默认样式',
        );
    }
  }
  if (numPart) audit(numPart, 'word/numbering.xml');
  return {
    document,
    report: {
      status: issues.some((x) => x.severity === 'blocking')
        ? 'blocked'
        : issues.length
          ? 'warning'
          : 'ready',
      issues,
      stats: {
        paragraphs: paragraphCount,
        translatableParagraphs: translatable,
        emptyParagraphs: empty,
        tables: tableCount,
        cells: cellCount,
        characters,
        entries: archive.count,
        expandedBytes: archive.expandedBytes,
        uploadBytes: buffer.length,
      },
    },
  };
}
