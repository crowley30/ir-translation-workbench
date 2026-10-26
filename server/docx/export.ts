import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph as WordParagraph,
  Tab,
  TextRun,
  Table,
  TableCell,
  TableRow,
  WidthType,
  type IParagraphOptions,
} from 'docx';
import { fromBuffer } from 'yauzl';
import { DOCX_LIMITS, type DocxDocument, type DocxParagraph } from '../../shared/docx.js';
import type { Task } from '../../shared/types.js';

export class ExportError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

export const MAX_EXPORT_TEXT_BYTES = 1024 * 1024;
const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Noto Sans CJK SC', cs: 'Arial' };
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];
const invalidMapping = () =>
  new ExportError(422, '文档结构与译文映射不完整，无法安全导出。', 'DOCX_MAPPING_INVALID');

function checkText(text: unknown): asserts text is string {
  if (typeof text !== 'string') throw invalidMapping();
  for (const character of text) {
    const point = character.codePointAt(0)!;
    // XML normalizes a literal CR. Refuse rather than silently changing saved content.
    if (
      point === 13 ||
      !(
        point === 9 ||
        point === 10 ||
        (point >= 32 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      )
    ) {
      throw new ExportError(
        422,
        '内容含无法无损导出的控制字符或回车，请在编辑器重新保存后再试。',
        'DOCX_TEXT_INVALID',
      );
    }
  }
}

function validate(
  task: Task,
  mode: string,
): { document: DocxDocument; translations: Map<string, string> } {
  if (mode !== 'chinese' && mode !== 'bilingual')
    throw new ExportError(400, '请选择中文或中英双语 DOCX。', 'DOCX_EXPORT_MODE');
  if (!task.document)
    throw new ExportError(400, '此任务没有 DOCX 结构，请使用文本导出。', 'DOCX_TASK_REQUIRED');
  if (
    task.status !== 'completed' ||
    !task.paragraphs.length ||
    task.paragraphs.some((p) => p.status !== 'done' || !p.translation.trim())
  )
    throw new ExportError(
      409,
      '文档尚未全部完成，请保存所有译文并处理失败段落后再导出。',
      'DOCX_INCOMPLETE',
    );
  const document = task.document;
  if (document.version !== 1 || !Array.isArray(document.blocks) || !document.blocks.length)
    throw invalidMapping();
  const paragraphs = new Map(task.paragraphs.map((p) => [p.id, p]));
  if (paragraphs.size !== task.paragraphs.length) throw invalidMapping();
  const structuralIds = new Set<string>();
  const references = new Set<string>();
  const translations = new Map<string, string>();
  let paragraphCount = 0,
    sourceCharacters = 0,
    tableCount = 0,
    cellCount = 0,
    outputBytes = 0;
  function id(value: unknown) {
    if (typeof value !== 'string' || !value || value.length > 200 || structuralIds.has(value))
      throw invalidMapping();
    structuralIds.add(value);
  }
  function paragraph(value: DocxParagraph) {
    if (value.kind !== 'paragraph') throw invalidMapping();
    id(value.id);
    checkText(value.source);
    paragraphCount++;
    sourceCharacters += value.source.length;
    if (
      value.headingLevel !== undefined &&
      (!Number.isInteger(value.headingLevel) || value.headingLevel < 1 || value.headingLevel > 6)
    )
      throw invalidMapping();
    if (value.list) {
      if (
        !['bullet', 'decimal'].includes(value.list.kind) ||
        !Number.isInteger(value.list.level) ||
        value.list.level < 0 ||
        value.list.level > 8 ||
        !value.list.label ||
        value.list.label.length > 100 ||
        /[\r\n\t]/.test(value.list.label)
      )
        throw invalidMapping();
      checkText(value.list.label);
      outputBytes += Buffer.byteLength(value.list.label) * (mode === 'bilingual' ? 2 : 1);
    }
    if (!value.source.trim()) {
      if (value.paragraphId !== null) throw invalidMapping();
      outputBytes += Buffer.byteLength(value.source);
      return;
    }
    if (typeof value.paragraphId !== 'string' || references.has(value.paragraphId))
      throw invalidMapping();
    const saved = paragraphs.get(value.paragraphId);
    if (!saved || saved.source !== value.source) throw invalidMapping();
    checkText(saved.translation);
    if (saved.translation.length > DOCX_LIMITS.characters * 3)
      throw new ExportError(413, '单段译文超出导出限额。', 'DOCX_EXPORT_TOO_LARGE');
    references.add(value.paragraphId);
    translations.set(value.paragraphId, saved.translation);
    outputBytes +=
      Buffer.byteLength(saved.translation) +
      (mode === 'bilingual' ? Buffer.byteLength(value.source) : 0);
  }
  for (const block of document.blocks) {
    if (block.kind === 'paragraph') paragraph(block);
    else if (block.kind === 'table') {
      id(block.id);
      tableCount++;
      if (!Array.isArray(block.rows) || !block.rows.length) throw invalidMapping();
      const columns = block.rows[0]?.cells?.length;
      if (!columns || columns > DOCX_LIMITS.columns) throw invalidMapping();
      for (const row of block.rows) {
        id(row.id);
        if (!Array.isArray(row.cells) || row.cells.length !== columns) throw invalidMapping();
        for (const cell of row.cells) {
          id(cell.id);
          cellCount++;
          if (!Array.isArray(cell.paragraphs) || !cell.paragraphs.length) throw invalidMapping();
          for (const p of cell.paragraphs) paragraph(p);
        }
      }
    } else throw invalidMapping();
  }
  if (references.size !== paragraphs.size) throw invalidMapping();
  if (
    paragraphCount > DOCX_LIMITS.paragraphs ||
    sourceCharacters > DOCX_LIMITS.characters ||
    tableCount > DOCX_LIMITS.tables ||
    cellCount > DOCX_LIMITS.cells ||
    outputBytes > MAX_EXPORT_TEXT_BYTES
  )
    throw new ExportError(
      413,
      '文档内容超出安全导出限额，请拆分任务或缩短译文。',
      'DOCX_EXPORT_TOO_LARGE',
    );
  return { document, translations };
}

function runs(text: string, source: boolean): TextRun[] {
  return text.split(/([\n\t])/).map(
    (part) =>
      new TextRun({
        ...(part === '\n'
          ? { break: 1 }
          : part === '\t'
            ? { children: [new Tab()] }
            : { text: part }),
        font: FONT,
        size: source ? 20 : 24,
        color: source ? '6B7280' : '223B32',
      }),
  );
}

function wordParagraphs(
  block: DocxParagraph,
  mode: 'chinese' | 'bilingual',
  translations: Map<string, string>,
): WordParagraph[] {
  const paragraph = (text: string, source: boolean) => {
    const children = block.list
      ? [
          new TextRun({ text: `${block.list.label} `, font: FONT, size: source ? 20 : 24 }),
          ...runs(text, source),
        ]
      : runs(text, source);
    const options: IParagraphOptions = {
      children,
      ...(block.headingLevel && !source ? { heading: HEADINGS[block.headingLevel - 1] } : {}),
      spacing: { after: source ? 40 : 120, line: 300 },
      ...(source ? { keepNext: true } : {}),
      ...(block.list
        ? { indent: { left: Math.min(block.list.level + 1, 4) * 240, hanging: 240 } }
        : {}),
    };
    return new WordParagraph(options);
  };
  if (block.paragraphId === null) return [paragraph(block.source, false)];
  const translated = translations.get(block.paragraphId)!;
  return mode === 'bilingual'
    ? [paragraph(block.source, true), paragraph(translated, false)]
    : [paragraph(translated, false)];
}

// Inspect our generated package's declared sizes before returning it. Source files,
// relationships and embedded data are never copied from the uploaded package.
async function boundOutput(buffer: Buffer): Promise<void> {
  if (buffer.length > DOCX_LIMITS.uploadBytes)
    throw new ExportError(413, '导出文件超过大小限额。', 'DOCX_EXPORT_TOO_LARGE');
  await new Promise<void>((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(new ExportError(500, '文档生成失败，请重试。', 'DOCX_EXPORT_FAILED'));
        return;
      }
      let expanded = 0,
        entries = 0;
      let settled = false;
      const fail = (reason: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(reason);
      };
      zip.on('error', () =>
        fail(new ExportError(500, '文档生成失败，请重试。', 'DOCX_EXPORT_FAILED')),
      );
      zip.on('entry', (entry) => {
        expanded += entry.uncompressedSize;
        entries++;
        if (
          entries > DOCX_LIMITS.entries ||
          expanded > DOCX_LIMITS.expandedBytes ||
          entry.uncompressedSize > DOCX_LIMITS.entryBytes ||
          (entry.fileName.endsWith('.xml') && entry.uncompressedSize > DOCX_LIMITS.xmlBytes)
        ) {
          fail(
            new ExportError(
              413,
              '导出结构超过安全资源限额，请缩短译文后再试。',
              'DOCX_EXPORT_TOO_LARGE',
            ),
          );
          return;
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zip.readEntry();
    });
  });
}

export async function exportDocx(task: Task, mode: 'chinese' | 'bilingual'): Promise<Buffer> {
  try {
    const { document, translations } = validate(task, mode);
    const notice =
      task.mode === 'mock'
        ? `[模拟文档·非实际翻译] ${mode === 'bilingual' ? '中英对照，每组先原文后译文。' : '中文译文。'}包含模拟占位内容，请勿作为正式材料使用。`
        : `[机器翻译草稿·请人工审校] ${mode === 'bilingual' ? '每组先原文后译文。' : '中文译文。'}本导出不代表专业翻译质量验收。`;
    const children: Array<WordParagraph | Table> = [
      new WordParagraph({
        children: [new TextRun({ text: notice, font: FONT, color: '8A5C2F', size: 20 })],
        spacing: { after: 220 },
      }),
    ];
    for (const block of document.blocks) {
      if (block.kind === 'paragraph') children.push(...wordParagraphs(block, mode, translations));
      else
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: block.rows.map(
              (row) =>
                new TableRow({
                  children: row.cells.map(
                    (cell) =>
                      new TableCell({
                        children: cell.paragraphs.flatMap((p) =>
                          wordParagraphs(p, mode, translations),
                        ),
                        margins: { top: 100, bottom: 100, left: 100, right: 100 },
                      }),
                  ),
                }),
            ),
          }),
        );
    }
    const output = await Packer.toBuffer(
      new Document({
        creator: 'IR Translation Workbench',
        title: task.mode === 'mock' ? '模拟文档导出' : '机器翻译审校稿',
        description:
          'Editable basic-structure document. Original pagination and formatting are not preserved.',
        styles: {
          default: {
            document: {
              run: { font: FONT, size: 24 },
              paragraph: { spacing: { after: 120, line: 300 } },
            },
          },
        },
        sections: [
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
              },
            },
            children,
          },
        ],
      }),
    );
    await boundOutput(output);
    return output;
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError(500, '文档生成失败，请重试。', 'DOCX_EXPORT_FAILED');
  }
}
