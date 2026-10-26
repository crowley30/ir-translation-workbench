import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOCX_LIMITS, type DocxParagraph } from '../../shared/docx.js';
import { readArchive } from './archive.js';
import { parseDocx } from './parse.js';
import {
  documentXml,
  makeDocx,
  makeZip,
  p,
  supportedFixture,
  unsupportedFixture,
  warningFixture,
  WORD_NS,
  PACKAGE_REL_NS,
} from './fixtures.js';

const parse = (bytes: Buffer) => parseDocx(bytes, 'synthetic.docx');
function flatten(result: Awaited<ReturnType<typeof parse>>): DocxParagraph[] {
  return result.document.blocks.flatMap((block) =>
    block.kind === 'paragraph'
      ? [block]
      : block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs)),
  );
}
async function mutate(
  base: Buffer,
  changes: Record<string, string | Buffer>,
  stored = false,
): Promise<Buffer> {
  const archive = await readArchive(base);
  const method: 0 | 8 = stored ? 0 : 8;
  const entries = [...archive.entries].map(([name, data]) => ({
    name,
    data: changes[name] ?? data,
    method,
  }));
  for (const [name, data] of Object.entries(changes))
    if (!archive.entries.has(name)) entries.push({ name, data, method });
  return makeZip(entries);
}
const codes = (result: Awaited<ReturnType<typeof parse>>) =>
  result.report.issues.map((issue) => issue.code);

describe('supported DOCX structure and deterministic mapping', () => {
  it('preserves heading, lists, blank paragraphs, cells and multiple cell paragraphs in exact order', async () => {
    const first = await parse(await supportedFixture()),
      second = await parse(await supportedFixture());
    expect(first).toEqual(second);
    expect(first.report.status).toBe('warning');
    expect(codes(first)).toContain('LIST_LABELS_FIXED');
    const paragraphs = flatten(first);
    expect(paragraphs.map((value) => value.source)).toEqual([
      'Synthetic IR update',
      'Dear synthetic investor.',
      'Robotics platform.',
      'First milestone.',
      '',
      'Metric',
      'Quarter',
      'Value',
      'Revenue',
      'USD 12 million',
      'Synthetic estimate.',
    ]);
    expect(paragraphs[0].headingLevel).toBe(1);
    expect(paragraphs[2].list).toEqual({ kind: 'bullet', level: 0, label: '•' });
    expect(paragraphs[3].list).toEqual({ kind: 'decimal', level: 0, label: '1.' });
    expect(paragraphs[4].paragraphId).toBeNull();
    expect(
      paragraphs.filter((value) => value.paragraphId).map((value) => value.paragraphId),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(4, '0')}`));
    const table = first.document.blocks.find((block) => block.kind === 'table')!;
    expect(
      table.rows.map((row) =>
        row.cells.map((cell) => cell.paragraphs.map((value) => value.source)),
      ),
    ).toEqual([
      [['Metric', 'Quarter'], ['Value']],
      [['Revenue'], ['USD 12 million', 'Synthetic estimate.']],
    ]);
    expect(
      new Set([
        ...paragraphs.map((value) => value.id),
        ...table.rows.flatMap((row) => row.cells.map((cell) => cell.id)),
      ]).size,
    ).toBe(15);
    expect(first.report.stats).toMatchObject({
      paragraphs: 11,
      translatableParagraphs: 10,
      emptyParagraphs: 1,
      tables: 1,
      cells: 4,
      characters: 135,
    });
  });
  it('preserves whitespace, tabs, explicit line breaks and escaped Chinese/unicode text', async () => {
    const result = await parse(
      makeDocx(
        '<w:p><w:r><w:t xml:space="preserve">  AI &amp; 人民币 </w:t><w:tab/><w:t>USD</w:t><w:br/><w:t>next</w:t></w:r></w:p>',
      ),
    );
    expect(flatten(result)[0].source).toBe('  AI & 人民币 \tUSD\nnext');
    expect(result.report.status).toBe('ready');
  });
  it('classifies actual visual loss as warning rather than silently claiming ready', async () => {
    const result = await parse(await warningFixture());
    expect(result.report.status).toBe('warning');
    expect(codes(result)).toContain('VISUAL_FORMATTING');
    expect(flatten(result)[0].source).toBe('Visual emphasis is synthetic.');
  });
  it('resolves inherited custom heading and list properties, including paragraph-level partial numbering', async () => {
    const styles = `<w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:outlineLvl w:val="1"/><w:numPr><w:numId w:val="2"/><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/></w:style></w:styles>`;
    const result = await parse(
      makeDocx(p('Inherited', '<w:pStyle w:val="Child"/><w:numPr><w:ilvl w:val="0"/></w:numPr>'), {
        'word/styles.xml': styles,
      }),
    );
    expect(result.report.status).not.toBe('blocked');
    expect(flatten(result)[0]).toMatchObject({
      headingLevel: 2,
      list: { kind: 'decimal', level: 0, label: '1.' },
    });
  });
  it('uses declared ancestor numbering start, never guesses 1 for an uninitialized higher level', async () => {
    const numbering = `<w:numbering xmlns:w="${WORD_NS}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="5"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const result = await parse(
      makeDocx(p('Nested first', '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr>'), {
        'word/numbering.xml': numbering,
      }),
    );
    expect(result.report.status).not.toBe('blocked');
    expect(flatten(result)[0].list?.label).toBe('5.1.');
  });
  it('does not reject unused semantic character styles but blocks those actually applied', async () => {
    const styles = `<w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Normal"/><w:style w:type="character" w:styleId="Sup"><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>`;
    expect(
      (await parse(makeDocx(p('Ordinary'), { 'word/styles.xml': styles }))).report.status,
    ).toBe('ready');
    expect(
      (
        await parse(
          makeDocx('<w:p><w:r><w:rPr><w:rStyle w:val="Sup"/></w:rPr><w:t>2</w:t></w:r></w:p>', {
            'word/styles.xml': styles,
          }),
        )
      ).report.status,
    ).toBe('blocked');
  });
  it.each(['caps', 'smallCaps', 'outline'])(
    'warns when visual run formatting %s is normalized',
    async (prop) => {
      expect(
        codes(
          await parse(
            makeDocx(`<w:p><w:r><w:rPr><w:${prop}/></w:rPr><w:t>Visual</w:t></w:r></w:p>`),
          ),
        ),
      ).toContain('VISUAL_FORMATTING');
    },
  );
  it('does not double-count an unsupported node audited through table and paragraph paths', async () => {
    const result = await parse(
      makeDocx(
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Text</w:t><w:drawing/></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
    );
    expect(result.report.issues.find((issue) => issue.code === 'GRAPHICS')?.count).toBe(1);
  });
});

describe('unsupported content is visible and blocks complete translation', () => {
  it.each(['drawing', 'merged', 'nested', 'footnotes', 'external', 'revisions'] as const)(
    'blocks %s fixture',
    async (kind) => {
      const result = await parse(await unsupportedFixture(kind));
      expect(result.report.status).toBe('blocked');
      expect(result.report.issues.some((issue) => issue.severity === 'blocking')).toBe(true);
    },
  );
  it.each(['pgNum', 'dayLong', 'annotationRef', 'unknownWordElement'])(
    'blocks unsupported empty/attribute-only run content %s',
    async (tag) => {
      const result = await parse(
        makeDocx(
          `<w:p><w:r><w:t>Before </w:t><w:${tag} w:val="meaning"/><w:t> after.</w:t></w:r></w:p>`,
        ),
      );
      expect(result.report.status).toBe('blocked');
      expect(codes(result)).toContain('UNSUPPORTED_PARAGRAPH_CONTENT');
    },
  );
  it.each(['sym', 'footnoteReference', 'pgNum'])(
    'blocks attribute-carried %s in otherwise empty headers',
    async (tag) => {
      const result = await parse(
        makeDocx(p('Body'), {
          'word/header1.xml': `<w:hdr xmlns:w="${WORD_NS}"><w:p><w:r><w:${tag} w:char="0041"/></w:r></w:p></w:hdr>`,
        }),
      );
      expect(result.report.status).toBe('blocked');
      expect(codes(result)).toContain('HEADERS_FOOTERS');
    },
  );
  it.each(['header', 'footer', 'endnotes', 'comments'])(
    'blocks text in unsupported %s package parts',
    async (kind) => {
      const root = kind === 'header' ? 'hdr' : kind === 'footer' ? 'ftr' : kind;
      const result = await parse(
        makeDocx(p('Body'), {
          [`word/${kind}${['header', 'footer'].includes(kind) ? '1' : ''}.xml`]: `<w:${root} xmlns:w="${WORD_NS}">${p('UNMAPPED MEANING')}</w:${root}>`,
        }),
      );
      expect(result.report.status).toBe('blocked');
    },
  );
  it.each(['vanish', 'webHidden', 'strike', 'dstrike', 'vertAlign'])(
    'blocks semantic or hidden run property %s',
    async (prop) => {
      const result = await parse(
        makeDocx(
          `<w:p><w:r><w:rPr><w:${prop} w:val="superscript"/></w:rPr><w:t>Amount 100</w:t></w:r></w:p>`,
        ),
      );
      expect(result.report.status).toBe('blocked');
    },
  );
  it.each(['cellIns', 'cellDel', 'cellMerge'])('blocks cell revision %s', async (prop) => {
    const result = await parse(
      makeDocx(
        `<w:tbl><w:tr><w:tc><w:tcPr><w:${prop} w:id="1"/></w:tcPr>${p('Changed cell')}</w:tc></w:tr></w:tbl>`,
      ),
    );
    expect(result.report.status).toBe('blocked');
    expect(codes(result)).toContain('REVISIONS');
  });
  it('blocks hidden rows and numbering revisions', async () => {
    for (const body of [
      `<w:tbl><w:tr><w:trPr><w:hidden/></w:trPr><w:tc>${p('Hidden')}</w:tc></w:tr></w:tbl>`,
      p(
        'Changed',
        '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/><w:numberingChange w:id="1"/></w:numPr>',
      ),
    ])
      expect((await parse(makeDocx(body))).report.status).toBe('blocked');
  });
  it('blocks complex restart rules and dangling list IDs rather than guessing', async () => {
    const base = await supportedFixture(),
      arc = await readArchive(base);
    const numbering = arc.entries
      .get('word/numbering.xml')!
      .toString()
      .replace('<w:start w:val="1"/>', '<w:start w:val="1"/><w:lvlRestart w:val="0"/>');
    expect(codes(await parse(await mutate(base, { 'word/numbering.xml': numbering })))).toContain(
      'NUMBERING_RESTART',
    );
    expect(
      (await parse(makeDocx(p('Missing', '<w:numPr><w:numId w:val="999"/></w:numPr>')))).report
        .status,
    ).toBe('blocked');
  });
  it('catches unparsed w:t, arbitrary mixed text, foreign math and unknown property semantics', async () => {
    for (const body of [
      `<w:sdt>${p('Lost text')}</w:sdt>`,
      `<w:p><w:r>raw text</w:r></w:p>`,
      `<w:p xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath><m:r><m:t>10^2</m:t></m:r></m:oMath></w:p>`,
      `<w:p><w:pPr><w:unknownSemantic w:val="100"/></w:pPr><w:r><w:t>Body</w:t></w:r></w:p>`,
    ])
      expect((await parse(makeDocx(body))).report.status).toBe('blocked');
  });
  it('accepts only genuinely empty headers as warning and rejects fake separator-note hidden content', async () => {
    const empty = await parse(
      makeDocx(p('Body'), { 'word/header1.xml': `<w:hdr xmlns:w="${WORD_NS}"><w:p/></w:hdr>` }),
    );
    expect(empty.report.status).toBe('warning');
    const unsafe = await parse(
      makeDocx(p('Body'), {
        'word/footnotes.xml': `<w:footnotes xmlns:w="${WORD_NS}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:pgNum/></w:r></w:p></w:footnote></w:footnotes>`,
      }),
    );
    expect(unsafe.report.status).toBe('blocked');
  });
});

describe('ZIP/XML/package safety and limits', () => {
  it('rejects fake extension, damaged ZIP and missing OPC structure', async () => {
    await expect(parseDocx(await supportedFixture(), 'fake.zip')).rejects.toMatchObject({
      code: 'INVALID_FILENAME',
    });
    await expect(parse(Buffer.from('not a ZIP'))).rejects.toMatchObject({ code: 'INVALID_ZIP' });
    const valid = await supportedFixture();
    await expect(parse(valid.subarray(0, valid.length - 20))).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });
    await expect(parse(makeZip([{ name: 'random.xml', data: '<x/>' }]))).rejects.toMatchObject({
      code: 'INVALID_PACKAGE',
    });
  });
  it.each(['../outside', '/absolute', 'C:/drive', 'word/../outside', 'word\\outside'])(
    'rejects unsafe ZIP path %s without extraction',
    async (name) => {
      await expect(parse(makeZip([{ name, data: 'synthetic' }]))).rejects.toMatchObject({
        code: expect.stringMatching(/UNSAFE_PATH|INVALID_ZIP/),
      });
    },
  );
  it('rejects duplicate paths, symlinks, encrypted entries and bad CRC/actual size', async () => {
    await expect(
      parse(
        makeZip([
          { name: 'word/document.xml', data: 'a' },
          { name: 'WORD/document.xml', data: 'b' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    for (const entry of [
      { name: 'link', data: 'target', attributes: (0xa1ff << 16) >>> 0 },
      { name: 'encrypted', data: 'x', flags: 1 },
      { name: 'badcrc', data: 'x', crc: 0 },
      { name: 'badsize', data: 'x', declaredSize: 10 },
    ])
      await expect(parse(makeZip([entry]))).rejects.toMatchObject({
        code: expect.stringMatching(/UNSAFE_ZIP_ENTRY|INVALID_ZIP/),
      });
  });
  it('bounds non-XML entry size and total expanded bytes independently of upload/ratio limits', async () => {
    await expect(
      parse(
        makeZip([{ name: 'oversized.bin', data: 'x', declaredSize: DOCX_LIMITS.entryBytes + 1 }]),
      ),
    ).rejects.toMatchObject({ code: 'EXPANSION_LIMIT', status: 413 });
    const moderatelyCompressible = randomBytes(4 * 1024 * 1024);
    for (let index = 0; index < moderatelyCompressible.length; index++)
      moderatelyCompressible[index] = 65 + (moderatelyCompressible[index] & 1);
    const bytes = makeZip(
      Array.from({ length: 6 }, (_, index) => ({
        name: `resource${index}.bin`,
        data: moderatelyCompressible,
      })),
    );
    expect(bytes.length).toBeLessThan(DOCX_LIMITS.uploadBytes);
    await expect(parse(bytes)).rejects.toMatchObject({ code: 'EXPANSION_LIMIT', status: 413 });
  });
  it('rejects high compression ratios, uploaded bytes, entry count and per-XML declared expansion', async () => {
    await expect(
      parse(makeZip([{ name: 'bomb.bin', data: Buffer.alloc(200000) }])),
    ).rejects.toMatchObject({ code: 'COMPRESSION_LIMIT', status: 413 });
    await expect(parse(Buffer.alloc(DOCX_LIMITS.uploadBytes + 1))).rejects.toMatchObject({
      code: 'UPLOAD_LIMIT',
      status: 413,
    });
    await expect(
      parse(
        makeZip(
          Array.from({ length: DOCX_LIMITS.entries + 1 }, (_, i) => ({ name: `e${i}`, data: '' })),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENTRY_LIMIT', status: 413 });
    await expect(
      parse(makeZip([{ name: 'large.xml', data: '<x/>', declaredSize: DOCX_LIMITS.xmlBytes + 1 }])),
    ).rejects.toMatchObject({ code: 'EXPANSION_LIMIT', status: 413 });
  });
  it.each([
    '<!DOCTYPE w:document [<!ENTITY x "boom">]>',
    '<!DOCTYPE w:document SYSTEM "https://example.invalid/no-fetch">',
  ])('rejects DTD declarations before any expansion or external access', async (declaration) => {
    await expect(parse(makeDocx(`${declaration}${documentXml(p('Body'))}`))).rejects.toMatchObject({
      code: 'UNSAFE_XML',
    });
  });
  it('rejects unused XML entities, invalid UTF8, UTF16 and malformed XML everywhere in package', async () => {
    for (const extra of [
      Buffer.from('<!ENTITY x "bad"><x/>'),
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from('<?xml version="1.0" encoding="UTF-16"?><x/>', 'utf16le'),
      Buffer.from('<x><broken></x>'),
    ])
      await expect(
        parse(makeDocx(p('Body'), { 'docProps/custom.xml': extra })),
      ).rejects.toMatchObject({ code: expect.stringMatching(/UNSAFE_XML|INVALID_XML/) });
  });
  it('enforces XML depth and global node budgets across all XML parts', async () => {
    const base = await supportedFixture();
    await expect(
      parse(
        await mutate(
          base,
          { 'docProps/custom.xml': `${'<x>'.repeat(81)}${'</x>'.repeat(81)}` },
          true,
        ),
      ),
    ).rejects.toMatchObject({ code: 'XML_LIMIT', status: 413 });
    await expect(
      parse(
        await mutate(
          base,
          {
            'docProps/custom.xml': `<x>${'<v/>'.repeat(60000)}</x>`,
            'docProps/app.xml': `<x>${'<v/>'.repeat(60000)}</x>`,
          },
          true,
        ),
      ),
    ).rejects.toMatchObject({ code: 'XML_LIMIT', status: 413 });
  });
  it('rejects macro main content types, duplicate declarations and unsafe/missing internal targets', async () => {
    const base = await supportedFixture(),
      archive = await readArchive(base),
      types = archive.entries.get('[Content_Types].xml')!.toString();
    await expect(
      parse(
        await mutate(base, {
          '[Content_Types].xml': types.replace(
            'wordprocessingml.document.main+xml',
            'ms-word.document.macroEnabled.main+xml',
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT_TYPE' });
    const duplicate = types.replace(
      '</Types>',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
    );
    await expect(
      parse(await mutate(base, { '[Content_Types].xml': duplicate })),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT_TYPE' });
    for (const target of ['../../outside.xml', 'missing.xml', 'https://example.invalid/no-fetch'])
      await expect(
        parse(
          makeDocx(p('Body'), {
            'word/_rels/document.xml.rels': `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="x" Type="any" Target="${target}"/></Relationships>`,
          }),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/UNSAFE_RELATIONSHIP|MISSING_PART/) });
  });
  it('enforces total table and cell counts even when structures contain no text', async () => {
    await expect(parse(makeDocx('<w:tbl/>'.repeat(21)))).rejects.toMatchObject({
      code: 'TABLE_LIMIT',
      status: 413,
    });
    const row = '<w:tr>' + '<w:tc/>'.repeat(10) + '</w:tr>';
    await expect(parse(makeDocx('<w:tbl>' + row.repeat(21) + '</w:tbl>'))).rejects.toMatchObject({
      code: 'TABLE_LIMIT',
      status: 413,
    });
  });
  it('enforces paragraph, character and table column limits without a partial-success report', async () => {
    await expect(
      parse(makeDocx(Array.from({ length: 101 }, () => p('Synthetic')).join(''))),
    ).rejects.toMatchObject({ code: 'PARAGRAPH_LIMIT', status: 413 });
    await expect(parse(makeDocx(p(randomBytes(11000).toString('hex'))))).rejects.toMatchObject({
      code: 'CHARACTER_LIMIT',
      status: 413,
    });
    await expect(
      parse(
        makeDocx(
          `<w:tbl><w:tr>${Array.from({ length: 11 }, () => `<w:tc>${p('Cell')}</w:tc>`).join('')}</w:tr></w:tbl>`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'TABLE_LIMIT', status: 413 });
  });
});
