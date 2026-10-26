import { deflateRawSync } from 'node:zlib';
import { crc32 } from './archive.js';

export interface ZipFixtureEntry {
  name: string;
  data: string | Buffer;
  method?: 0 | 8;
  flags?: number;
  attributes?: number;
  declaredSize?: number;
  crc?: number;
}
// Synthetic-only ZIP authoring helper. It deliberately permits malformed metadata for negative tests.
export function makeZip(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const crc = entry.crc ?? crc32(raw);
    const flags = entry.flags ?? 0x800;
    const size = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
export const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export function documentXml(body: string): string {
  return `${XML}<w:document xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}
const contentTypes = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const rootRels = `${XML}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/></Relationships>`;
const styles = `${XML}<w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`;
const numbering = `${XML}<w:numbering xmlns:w="${WORD_NS}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
export function makeDocx(
  bodyOrDocument: string,
  extraEntries: Record<string, string | Buffer> = {},
): Buffer {
  const main = /<(?:\w+:)?document[\s>]/.test(bodyOrDocument)
    ? bodyOrDocument
    : documentXml(bodyOrDocument);
  const entries: Record<string, string | Buffer> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'word/document.xml': main,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering,
    ...extraEntries,
  };
  return makeZip(Object.entries(entries).map(([name, data]) => ({ name, data })));
}
export function p(text: string, properties = ''): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
}
export function supportedFixture(): Promise<Buffer> {
  return Promise.resolve(
    makeDocx(
      [
        p('Synthetic IR update', '<w:pStyle w:val="Heading1"/>'),
        p('Dear synthetic investor.'),
        p('Robotics platform.', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        p('First milestone.', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
        '<w:p/>',
        `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc>${p('Metric')}${p('Quarter')}</w:tc><w:tc>${p('Value')}</w:tc></w:tr><w:tr><w:tc>${p('Revenue')}</w:tc><w:tc>${p('USD 12 million')}${p('Synthetic estimate.')}</w:tc></w:tr></w:tbl>`,
      ].join(''),
    ),
  );
}
export function warningFixture(): Promise<Buffer> {
  return Promise.resolve(
    makeDocx(
      '<w:p><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>Visual emphasis is synthetic.</w:t></w:r></w:p>',
    ),
  );
}
export function unsupportedFixture(
  kind: 'drawing' | 'merged' | 'nested' | 'footnotes' | 'external' | 'revisions' = 'drawing',
): Promise<Buffer> {
  const text = p('Synthetic visible text.');
  if (kind === 'merged')
    return Promise.resolve(
      makeDocx(
        `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${text}</w:tc></w:tr></w:tbl>`,
      ),
    );
  if (kind === 'nested')
    return Promise.resolve(
      makeDocx(
        `<w:tbl><w:tr><w:tc>${text}<w:tbl><w:tr><w:tc>${text}</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>`,
      ),
    );
  if (kind === 'footnotes')
    return Promise.resolve(
      makeDocx(`<w:p><w:r><w:t>Reference</w:t><w:footnoteReference w:id="1"/></w:r></w:p>`, {
        'word/footnotes.xml': `<w:footnotes xmlns:w="${WORD_NS}"><w:footnote w:id="1">${text}</w:footnote></w:footnotes>`,
      }),
    );
  if (kind === 'external')
    return Promise.resolve(
      makeDocx(
        `<w:p><w:hyperlink r:id="rId1"><w:r><w:t>External synthetic link</w:t></w:r></w:hyperlink></w:p>`,
        {
          'word/_rels/document.xml.rels': `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/hyperlink" Target="https://example.invalid/do-not-fetch" TargetMode="External"/></Relationships>`,
        },
      ),
    );
  if (kind === 'revisions') return Promise.resolve(makeDocx(`<w:ins w:id="1">${text}</w:ins>`));
  return Promise.resolve(
    makeDocx(`<w:p><w:r><w:t>Graphic may contain meaning.</w:t><w:drawing/></w:r></w:p>`),
  );
}
