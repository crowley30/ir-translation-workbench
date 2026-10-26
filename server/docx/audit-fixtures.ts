import { readArchive } from './archive.js';
import {
  documentXml,
  makeDocx as makeBaseDocx,
  makeZip,
  p,
  WORD_NS,
  REL_NS,
  PACKAGE_REL_NS,
} from './fixtures.js';

function makeDocx(body: string, extraEntries: Record<string, string | Buffer> = {}): Buffer {
  // Bind both standard parts as Word would: style tests must not depend on orphan XML parts.
  return makeBaseDocx(body, {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="auditStyles" Type="${REL_NS}/styles" Target="styles.xml"/><Relationship Id="auditNumbering" Type="${REL_NS}/numbering" Target="numbering.xml"/></Relationships>`,
    ...extraEntries,
  });
}
export { makeDocx as makeAuditDocx };

export interface AuditSemanticFixture {
  name: string;
  bytes: Buffer;
  code: string;
}

// Every case is a complete synthetic package, not an isolated XML fragment.
export function auditSemanticFixtures(): AuditSemanticFixture[] {
  const fixtures: AuditSemanticFixture[] = [];
  const styles = (contents: string) => `<w:styles xmlns:w="${WORD_NS}">${contents}</w:styles>`;
  const text = 'Synthetic USD 12 million.';
  for (const property of ['strike', 'dstrike', 'vanish'] as const) {
    const code = property === 'vanish' ? 'HIDDEN_TEXT' : 'SEMANTIC_FORMATTING';
    const format = `<w:rPr><w:${property}/></w:rPr>`;
    const body = `<w:p><w:r>${format}<w:t>${text}</w:t></w:r></w:p>`;
    fixtures.push({ name: `direct run ${property}`, bytes: makeDocx(body), code });
    for (const type of ['paragraph', 'character'] as const) {
      const styled =
        type === 'paragraph'
          ? p(text, '<w:pStyle w:val="Child"/>')
          : `<w:p><w:r><w:rPr><w:rStyle w:val="Child"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
      fixtures.push({
        name: `inherited ${type} style ${property}`,
        bytes: makeDocx(styled, {
          'word/styles.xml': styles(
            `<w:style w:type="${type}" w:styleId="Base">${format}</w:style><w:style w:type="${type}" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>`,
          ),
        }),
        code,
      });
    }
    for (const mode of ['direct', 'inherited', 'conditional'] as const) {
      const appliedStyle = mode === 'inherited' ? 'Child' : 'Base';
      const styleFormat =
        mode === 'conditional'
          ? `<w:tblStylePr w:type="firstRow">${format}</w:tblStylePr>`
          : format;
      fixtures.push({
        name: `${mode} table style ${property}`,
        bytes: makeDocx(
          `<w:tbl><w:tblPr><w:tblStyle w:val="${appliedStyle}"/></w:tblPr><w:tr><w:tc>${p(text)}</w:tc></w:tr></w:tbl>`,
          {
            'word/styles.xml': styles(
              `<w:style w:type="table" w:styleId="Base">${styleFormat}</w:style><w:style w:type="table" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>`,
            ),
          },
        ),
        code,
      });
    }
    for (const value of ['on', 'true', '1']) {
      for (const type of ['paragraph', 'character']) {
        fixtures.push({
          name: `default ${type} ${property} boolean ${value}`,
          bytes: makeDocx(p(text), {
            'word/styles.xml': styles(
              `<w:style w:type="${type}" w:styleId="DefaultAudit" w:default="${value}">${format}</w:style>`,
            ),
          }),
          code,
        });
      }
    }
  }
  const numPr = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>';
  fixtures.push({
    name: 'section numbering restart extension',
    bytes: makeDocx(
      p('First section item', `${numPr}<w:sectPr/>`) + p('Second section item', numPr),
      {
        'word/numbering.xml': `<w:numbering xmlns:w="${WORD_NS}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w:abstractNum w:abstractNumId="4" w15:restartNumberingAfterBreak="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="4"/></w:num></w:numbering>`,
      },
    ),
    code: 'NUMBERING_RESTART',
  });
  fixtures.push({
    name: 'unknown unnamespaced run element',
    bytes: makeDocx(
      '<w:p><w:r><w:t>Visible synthetic text.</w:t><unknown xmlns="">LOST CONTENT</unknown></w:r></w:p>',
    ),
    code: 'FOREIGN_CONTENT',
  });
  return fixtures;
}

export async function undefinedEntitiesFixture(count = 600000): Promise<Buffer> {
  const archive = await readArchive(makeDocx(p('Synthetic entity boundary.')));
  const document = documentXml(`<w:p><w:r><w:t>${'&x;'.repeat(count)}</w:t></w:r></w:p>`);
  // Store rather than deflate: this must reach the XML boundary, not fail ZIP ratio checks first.
  return makeZip(
    [...archive.entries].map(([name, data]) => ({
      name,
      data: name === 'word/document.xml' ? document : data,
      method: 0,
    })),
  );
}
