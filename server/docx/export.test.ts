import { describe, expect, it } from 'vitest';
import { fromBuffer } from 'yauzl';
import { SaxesParser } from 'saxes';
import { exportDocx, ExportError } from './export.js';
import type { DocxDocument, DocxParagraph } from '../../shared/docx.js';
import type { Task, TaskStatus } from '../../shared/types.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
interface XmlNode {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
}
async function packageFiles(buffer: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error);
        return;
      }
      const files = new Map<string, string>();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.readEntry();
    });
  });
}
function parse(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  let root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  parser.on('opentag', (tag) => {
    const node: XmlNode = { name: tag.local, uri: tag.uri, attrs: {}, children: [] };
    for (const value of Object.values(tag.attributes)) node.attrs[value.local] = value.value;
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on('text', (text) => stack.at(-1)?.children.push(text));
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.write(xml).close();
  return root!;
}
function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter(
    (value): value is XmlNode =>
      typeof value !== 'string' && value.uri === W && value.name === name,
  );
}
function text(node: XmlNode): string {
  if (node.uri !== W) return '';
  if (node.name === 'tab') return '\t';
  if (node.name === 'br' || node.name === 'cr') return '\n';
  return node.children
    .map((value) => (typeof value === 'string' ? (node.name === 't' ? value : '') : text(value)))
    .join('');
}
function body(xml: string): XmlNode[] {
  return children(parse(xml), 'body')[0].children.filter(
    (node): node is XmlNode => typeof node !== 'string' && ['p', 'tbl'].includes(node.name),
  );
}
function paragraphs(blocks: XmlNode[]): XmlNode[] {
  return blocks.flatMap((block) =>
    block.name === 'p'
      ? [block]
      : children(block, 'tr').flatMap((row) =>
          children(row, 'tc').flatMap((cell) => children(cell, 'p')),
        ),
  );
}
function paragraph(id: string, source: string, extra: Partial<DocxParagraph> = {}): DocxParagraph {
  return {
    kind: 'paragraph',
    id: `b-${id}`,
    paragraphId: source.trim() ? id : null,
    source,
    location: id,
    ...extra,
  };
}
function taskFixture(): Task {
  const document: DocxDocument = {
    version: 1,
    filename: 'synthetic-fund.docx',
    blocks: [
      paragraph('p1', 'Synthetic Technology Fund', { headingLevel: 1 }),
      paragraph('p2', 'Dear investor,\nUSD 12 million\t2026.'),
      paragraph('empty1', ''),
      paragraph('p3', 'Embodied AI', { list: { kind: 'bullet', level: 0, label: '•' } }),
      paragraph('p4', 'First milestone', { list: { kind: 'decimal', level: 1, label: '1.' } }),
      {
        kind: 'table',
        id: 'table1',
        rows: [
          {
            id: 'row1',
            cells: [
              {
                id: 'r1c1',
                paragraphs: [paragraph('p5', 'Company'), paragraph('p6', 'Warehouse robotics')],
              },
              { id: 'r1c2', paragraphs: [paragraph('p7', 'Investment USD 12 million')] },
            ],
          },
          {
            id: 'row2',
            cells: [
              { id: 'r2c1', paragraphs: [paragraph('p8', 'Synthetic Robotics')] },
              { id: 'r2c2', paragraphs: [paragraph('empty2', ''), paragraph('p9', 'Q4 2026')] },
            ],
          },
        ],
      },
    ],
  };
  const all = document.blocks.flatMap((block) =>
    block.kind === 'paragraph'
      ? [block]
      : block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs)),
  );
  const translations = [
    '合成科技基金',
    '尊敬的投资人：\n投资额 USD 12 million\t日期 2026。',
    '具身智能',
    '首个里程碑',
    '公司',
    '仓储机器人',
    '投资额 1,200 万美元',
    '合成机器人公司',
    '2026 年第四季度',
  ];
  return {
    id: 'synthetic-task',
    title: 'Synthetic export',
    style: 'business',
    mode: 'mock',
    status: 'completed',
    createdAt: '2026-10-26T00:00:00Z',
    updatedAt: '2026-10-26T00:00:00Z',
    document,
    paragraphs: all
      .filter((p) => p.paragraphId)
      .map((p, index) => ({
        id: p.paragraphId!,
        source: p.source,
        translation: translations[index],
        revision: index === 1 ? 7 : 1,
        edited: index === 1,
        status: 'done',
        error: null,
      })),
  };
}
function expected(task: Task, bilingual: boolean): string[] {
  const saved = new Map(task.paragraphs.map((p) => [p.id, p.translation]));
  const all = task.document!.blocks.flatMap((block) =>
    block.kind === 'paragraph'
      ? [block]
      : block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs)),
  );
  return all.flatMap((p) => {
    const prefix = p.list ? `${p.list.label} ` : '';
    if (p.paragraphId === null) return [p.source];
    return bilingual
      ? [prefix + p.source, prefix + saved.get(p.paragraphId)]
      : [prefix + saved.get(p.paragraphId)];
  });
}

for (const mode of ['chinese', 'bilingual'] as const) {
  describe(`${mode} OOXML saved-content export`, () => {
    it('preserves all block/cell/paragraph order and exact saved text with Unicode, tabs and line breaks', async () => {
      const task = taskFixture();
      task.paragraphs[1].translation = '最新人工保存：\n中文 & <公司> 😀\tUSD 12 million / 2026';
      const files = await packageFiles(await exportDocx(task, mode));
      const blocks = body(files.get('word/document.xml')!);
      expect(text(blocks[0])).toContain('[模拟文档·非实际翻译]');
      const exported = paragraphs(blocks.slice(1)).map(text);
      expect(exported).toEqual(expected(task, mode === 'bilingual'));
      expect(exported).toContain(task.paragraphs[1].translation);
      expect(exported.filter((value) => value === task.paragraphs[1].translation)).toHaveLength(1);
      expect(exported.filter((value) => value === '')).toHaveLength(2);
      expect(blocks.filter((block) => block.name === 'tbl')).toHaveLength(1);
      const table = blocks.at(-1)!;
      expect(children(table, 'tr')).toHaveLength(2);
      expect(children(children(table, 'tr')[0], 'tc')).toHaveLength(2);
      const firstCell = children(children(table, 'tr')[0], 'tc')[0];
      expect(children(firstCell, 'p').map(text)).toEqual(
        mode === 'bilingual'
          ? ['Company', '公司', 'Warehouse robotics', '仓储机器人']
          : ['公司', '仓储机器人'],
      );
      expect(files.get('word/document.xml')).not.toContain('最新人工保存：\\n');
    });
    it('uses readable explicit list labels and heading styles without automatic double numbering', async () => {
      const task = taskFixture();
      const files = await packageFiles(await exportDocx(task, mode));
      const xml = files.get('word/document.xml')!;
      const values = paragraphs(body(xml).slice(1)).map(text);
      expect(values).toContain('• 具身智能');
      expect(values).toContain('1. 首个里程碑');
      expect(xml).not.toContain('<w:numPr>');
      expect(xml).toContain('w:val="Heading1"');
      expect(xml).toContain('w:eastAsia="Noto Sans CJK SC"');
      expect(xml).toContain('w:ascii="Arial"');
      expect(values.filter((value) => value === '1. 首个里程碑')).toHaveLength(1);
    });
    it('creates a fresh safe package with no inherited macros, external relationships, headers or fields', async () => {
      const files = await packageFiles(await exportDocx(taskFixture(), mode));
      expect(files.has('[Content_Types].xml')).toBe(true);
      expect(files.has('_rels/.rels')).toBe(true);
      expect([...files.keys()].some((name) => /vba|embeddings|header|footer/i.test(name))).toBe(
        false,
      );
      for (const [name, content] of files) {
        if (name.endsWith('.rels')) expect(content).not.toContain('TargetMode="External"');
      }
      expect(files.get('word/document.xml')).not.toMatch(
        /<(?:w:)?(?:fldChar|instrText|hyperlink)\b/,
      );
    });
  });
}

describe('export integrity gates', () => {
  it.each(['draft', 'running', 'partial', 'failed', 'cancelled'] satisfies TaskStatus[])(
    'refuses task status %s',
    async (status) => {
      const task = taskFixture();
      task.status = status;
      await expect(exportDocx(task, 'chinese')).rejects.toMatchObject({
        status: 409,
        code: 'DOCX_INCOMPLETE',
      });
    },
  );
  it.each(['pending', 'running', 'failed', 'cancelled'] as const)(
    'refuses any %s nonempty paragraph even if task says completed',
    async (status) => {
      const task = taskFixture();
      task.paragraphs[2].status = status;
      await expect(exportDocx(task, 'bilingual')).rejects.toMatchObject({
        code: 'DOCX_INCOMPLETE',
      });
    },
  );
  it.each(['', ' \n\t '])('refuses blank saved translation', async (translation) => {
    const task = taskFixture();
    task.paragraphs[1].translation = translation;
    await expect(exportDocx(task, 'chinese')).rejects.toMatchObject({ code: 'DOCX_INCOMPLETE' });
  });
  it('refuses non-DOCX tasks and unsupported export modes', async () => {
    const task = taskFixture();
    delete task.document;
    await expect(exportDocx(task, 'chinese')).rejects.toMatchObject({
      status: 400,
      code: 'DOCX_TASK_REQUIRED',
    });
    await expect(exportDocx(taskFixture(), 'unsupported' as 'chinese')).rejects.toMatchObject({
      status: 400,
      code: 'DOCX_EXPORT_MODE',
    });
  });
  it.each([
    'missing',
    'extra',
    'duplicate',
    'changed-source',
    'duplicate-block',
    'empty-mapped',
  ] as const)('refuses %s mapping without omitting content', async (mutation) => {
    const task = taskFixture();
    if (mutation === 'missing') task.paragraphs.pop();
    if (mutation === 'extra') task.paragraphs.push({ ...task.paragraphs[0], id: 'unexpected' });
    if (mutation === 'duplicate') task.paragraphs[1].id = task.paragraphs[0].id;
    if (mutation === 'changed-source') task.paragraphs[1].source = 'Different source';
    if (mutation === 'duplicate-block') task.document!.blocks[1].id = task.document!.blocks[0].id;
    if (mutation === 'empty-mapped') (task.document!.blocks[2] as DocxParagraph).paragraphId = 'p1';
    await expect(exportDocx(task, 'chinese')).rejects.toMatchObject({
      status: 422,
      code: 'DOCX_MAPPING_INVALID',
    });
  });
  it('refuses duplicated references and malformed rectangular table structure', async () => {
    const task = taskFixture();
    (task.document!.blocks[1] as DocxParagraph).paragraphId = 'p1';
    await expect(exportDocx(task, 'chinese')).rejects.toBeInstanceOf(ExportError);
    const another = taskFixture();
    const table = another.document!.blocks.find((block) => block.kind === 'table')!;
    if (table.kind !== 'table') throw new Error('fixture');
    table.rows[1].cells.pop();
    await expect(exportDocx(another, 'chinese')).rejects.toMatchObject({
      code: 'DOCX_MAPPING_INVALID',
    });
  });
  it.each(['\u0000', '\u0001', '\ud800', '\r'])(
    'refuses unsupported XML characters instead of silently changing saved text',
    async (invalid) => {
      const task = taskFixture();
      task.paragraphs[1].translation = `中文${invalid}内容`;
      await expect(exportDocx(task, 'chinese')).rejects.toMatchObject({
        status: 422,
        code: 'DOCX_TEXT_INVALID',
      });
    },
  );
  it('bounds per-paragraph and aggregate translated bytes without truncating', async () => {
    const one = taskFixture();
    one.paragraphs[0].translation = 'x'.repeat(60001);
    await expect(exportDocx(one, 'chinese')).rejects.toMatchObject({
      status: 413,
      code: 'DOCX_EXPORT_TOO_LARGE',
    });
    const total = taskFixture();
    total.paragraphs.forEach((p) => {
      p.translation = '汉'.repeat(60000);
    });
    await expect(exportDocx(total, 'bilingual')).rejects.toMatchObject({
      status: 413,
      code: 'DOCX_EXPORT_TOO_LARGE',
    });
  });
  it('bounds generated XML expansion from escaped content even below the raw text byte cap', async () => {
    const task = taskFixture();
    task.paragraphs.forEach((p) => {
      p.translation = '&'.repeat(60000);
    });
    await expect(exportDocx(task, 'chinese')).rejects.toMatchObject({
      status: 413,
      code: 'DOCX_EXPORT_TOO_LARGE',
    });
  });
  it('keeps manual edits and revisions intact while exporting only the newest saved value', async () => {
    const task = taskFixture();
    const before = structuredClone(task);
    const files = await packageFiles(await exportDocx(task, 'chinese'));
    expect(paragraphs(body(files.get('word/document.xml')!)).map(text)).toContain(
      task.paragraphs[1].translation,
    );
    expect(task).toEqual(before);
  });
  it('marks real-service drafts as requiring review without claiming professional validation', async () => {
    const task = taskFixture();
    task.mode = 'real';
    const files = await packageFiles(await exportDocx(task, 'chinese'));
    expect(text(body(files.get('word/document.xml')!)[0])).toContain('[机器翻译草稿·请人工审校]');
  });
});
