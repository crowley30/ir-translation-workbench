import { describe, expect, it, vi } from 'vitest';
import { SaxesParser } from 'saxes';
import { parseDocx } from './parse.js';
import {
  auditSemanticFixtures,
  undefinedEntitiesFixture,
  makeAuditDocx as makeDocx,
} from './audit-fixtures.js';
import { p, WORD_NS } from './fixtures.js';

const parse = (bytes: Buffer) => parseDocx(bytes, 'synthetic-audit.docx');
const styles = (body: string) => `<w:styles xmlns:w="${WORD_NS}">${body}</w:styles>`;
const booleans = ['on', 'true', '1', 'off', 'false', '0'] as const;
const active = (value: string) => ['on', 'true', '1'].includes(value);

describe('P2 independent audit semantic regressions', () => {
  it.each(auditSemanticFixtures())('blocks $name with an explicit diagnostic', async (fixture) => {
    const result = await parse(fixture.bytes);
    expect(result.report.status).toBe('blocked');
    expect(result.report.issues).toContainEqual(
      expect.objectContaining({ code: fixture.code, severity: 'blocking' }),
    );
  });

  it.each(['strike', 'dstrike', 'vanish', 'webHidden', 'specVanish'])(
    'interprets all legal on/off values for direct %s',
    async (property) => {
      for (const value of booleans) {
        const result = await parse(
          makeDocx(
            `<w:p><w:r><w:rPr><w:${property} w:val="${value}"/></w:rPr><w:t>Synthetic amount</w:t></w:r></w:p>`,
          ),
        );
        expect(result.report.status, `${property}=${value}`).toBe(
          active(value) ? 'blocked' : 'ready',
        );
      }
    },
  );

  it.each(['paragraph', 'character', 'table'])(
    'interprets semantic toggles in an inherited %s style',
    async (type) => {
      for (const property of ['strike', 'dstrike', 'vanish']) {
        for (const value of booleans) {
          const body =
            type === 'table'
              ? `<w:tbl><w:tblPr><w:tblStyle w:val="Child"/></w:tblPr><w:tr><w:tc>${p('Synthetic amount')}</w:tc></w:tr></w:tbl>`
              : type === 'paragraph'
                ? p('Synthetic amount', '<w:pStyle w:val="Child"/>')
                : '<w:p><w:r><w:rPr><w:rStyle w:val="Child"/></w:rPr><w:t>Synthetic amount</w:t></w:r></w:p>';
          const result = await parse(
            makeDocx(body, {
              'word/styles.xml': styles(
                `<w:style w:type="${type}" w:styleId="Base"><w:rPr><w:${property} w:val="${value}"/></w:rPr></w:style>` +
                  `<w:style w:type="${type}" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>`,
              ),
            }),
          );
          expect(result.report.status, `${type} ${property}=${value}`).toBe(
            active(value) ? 'blocked' : 'ready',
          );
        }
      }
    },
  );

  it.each(['paragraph', 'character', 'table'])(
    'handles every legal default %s style flag, including inherited formatting',
    async (type) => {
      for (const value of booleans) {
        const body =
          type === 'table'
            ? `<w:tbl><w:tr><w:tc>${p('Synthetic amount')}</w:tc></w:tr></w:tbl>`
            : p('Synthetic amount');
        const result = await parse(
          makeDocx(body, {
            'word/styles.xml': styles(
              `<w:style w:type="${type}" w:styleId="Base"><w:rPr><w:vanish/></w:rPr></w:style>` +
                `<w:style w:type="${type}" w:styleId="CustomDefault" w:default="${value}"><w:basedOn w:val="Base"/></w:style>`,
            ),
          }),
        );
        expect(result.report.status, `${type} default=${value}`).toBe(
          active(value) ? 'blocked' : 'ready',
        );
      }
    },
  );

  it.each(booleans)(
    'handles cross-section restart flag %s without flattening enabled rules',
    async (value) => {
      const fixture = auditSemanticFixtures().find((x) => x.code === 'NUMBERING_RESTART')!;
      // Rebuild only the numbering part, preserving a complete package and both sections.
      const { readArchive } = await import('./archive.js');
      const { makeZip } = await import('./fixtures.js');
      const archive = await readArchive(fixture.bytes);
      const result = await parse(
        makeZip(
          [...archive.entries].map(([name, data]) => ({
            name,
            data:
              name === 'word/numbering.xml'
                ? data
                    .toString()
                    .replace(
                      'restartNumberingAfterBreak="1"',
                      `restartNumberingAfterBreak="${value}"`,
                    )
                : data,
          })),
        ),
      );
      expect(result.report.status).toBe(active(value) ? 'blocked' : 'warning');
      expect(result.report.issues.some((x) => x.code === 'NUMBERING_RESTART')).toBe(active(value));
      if (!active(value))
        expect(result.document.blocks.map((x) => x.kind === 'paragraph' && x.list?.label)).toEqual([
          '1.',
          '2.',
        ]);
    },
  );

  it.each(['', 'yes', 'TRUE', '2'])(
    'rejects invalid boolean %j rather than assuming inactive',
    async (value) => {
      for (const bytes of [
        makeDocx(p('Synthetic'), {
          'word/styles.xml': styles(
            `<w:style w:type="paragraph" w:styleId="Custom" w:default="${value}"><w:rPr><w:vanish/></w:rPr></w:style>`,
          ),
        }),
        makeDocx(
          `<w:p><w:r><w:rPr><w:strike w:val="${value}"/></w:rPr><w:t>Synthetic</w:t></w:r></w:p>`,
        ),
      ])
        await expect(parse(bytes)).rejects.toMatchObject({ code: 'INVALID_BOOLEAN', status: 400 });
    },
  );

  it('audits table style inheritance cycles and docDefaults numbering conservatively', async () => {
    const table = `<w:tbl><w:tblPr><w:tblStyle w:val="Child"/></w:tblPr><w:tr><w:tc>${p('Synthetic')}</w:tc></w:tr></w:tbl>`;
    const cycle = await parse(
      makeDocx(table, {
        'word/styles.xml': styles(
          '<w:style w:type="table" w:styleId="Child"><w:basedOn w:val="Base"/></w:style><w:style w:type="table" w:styleId="Base"><w:basedOn w:val="Child"/></w:style>',
        ),
      }),
    );
    expect(cycle.report.issues).toContainEqual(
      expect.objectContaining({ code: 'STYLE_CYCLE', severity: 'blocking' }),
    );
    const defaults = await parse(
      makeDocx(p('Synthetic'), {
        'word/styles.xml': styles(
          '<w:docDefaults><w:pPrDefault><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:pPrDefault></w:docDefaults>',
        ),
      }),
    );
    expect(defaults.report.status).toBe('blocked');
    expect(defaults.report.issues).toContainEqual(
      expect.objectContaining({ code: 'NUMBERING_DEFAULT' }),
    );
  });

  it('rejects unknown no-namespace elements even when they contain no Word text nodes', async () => {
    for (const unknown of ['<unknown xmlns="">LOST CONTENT</unknown>', '<unknown xmlns=""/>']) {
      const result = await parse(makeDocx(`<w:p><w:r><w:t>Synthetic</w:t>${unknown}</w:r></w:p>`));
      expect(result.report.status).toBe('blocked');
      expect(result.report.issues).toContainEqual(
        expect.objectContaining({ code: 'FOREIGN_CONTENT' }),
      );
    }
  });

  it('aborts on the first fatal XML error without scanning 600,000 undefined entities', async () => {
    const bytes = await undefinedEntitiesFixture();
    const original = SaxesParser.prototype.fail;
    let failures = 0;
    const fail = vi.spyOn(SaxesParser.prototype, 'fail').mockImplementation(function (
      this: SaxesParser,
      message: string,
    ) {
      // Bound this negative regression even if fail-fast is accidentally removed.
      if (++failures > 1) throw new Error('Parser continued after its first fatal error');
      return original.call(this, message);
    });
    const started = performance.now();
    try {
      await expect(parse(bytes)).rejects.toMatchObject({ code: 'INVALID_XML', status: 400 });
      expect(failures).toBe(1);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      fail.mockRestore();
    }
  });
});
