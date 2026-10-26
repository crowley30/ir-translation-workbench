import * as yauzl from 'yauzl';
import { DOCX_LIMITS } from '../../shared/docx.js';

export class ArchiveError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export interface SafeArchive {
  entries: Map<string, Buffer>;
  expandedBytes: number;
  count: number;
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(name: string): boolean {
  if (
    !name ||
    name.length > 240 ||
    name.includes('\\') ||
    Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  )
    return false;
  const parts = name.replace(/\/$/, '').split('/');
  return parts.length <= 20 && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

// Read into bounded buffers only. No archive entry is ever written to a filesystem.
export async function readArchive(bytes: Buffer): Promise<SafeArchive> {
  if (bytes.length > DOCX_LIMITS.uploadBytes)
    throw new ArchiveError('UPLOAD_LIMIT', 'DOCX 文件超过 5 MiB 上限。', 413);
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
    throw new ArchiveError('INVALID_ZIP', '文件不是有效的 DOCX ZIP 包。');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
        autoClose: true,
      },
      (openError, zip) => {
        if (openError || !zip) {
          reject(new ArchiveError('INVALID_ZIP', 'DOCX ZIP 包损坏或格式不受支持。'));
          return;
        }
        const entries = new Map<string, Buffer>();
        const seen = new Set<string>();
        let count = 0;
        let expandedBytes = 0;
        let done = false;
        const fail = (error: ArchiveError) => {
          if (done) return;
          done = true;
          zip.close();
          reject(error);
        };
        if (zip.entryCount > DOCX_LIMITS.entries) {
          fail(new ArchiveError('ENTRY_LIMIT', 'DOCX 包条目过多。', 413));
          return;
        }
        zip.on('error', () => fail(new ArchiveError('INVALID_ZIP', 'DOCX ZIP 包读取失败。')));
        zip.on('entry', (entry: yauzl.Entry) => {
          count++;
          const key = entry.fileName.normalize('NFC').toLowerCase();
          if (count > DOCX_LIMITS.entries) {
            fail(new ArchiveError('ENTRY_LIMIT', 'DOCX 包条目过多。', 413));
            return;
          }
          if (!safeName(entry.fileName) || seen.has(key)) {
            fail(new ArchiveError('UNSAFE_PATH', 'DOCX 包含不安全或重复的路径。'));
            return;
          }
          seen.add(key);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            mode === 0xa000 ||
            (entry.generalPurposeBitFlag & 0x41) !== 0 ||
            ![0, 8].includes(entry.compressionMethod)
          ) {
            fail(new ArchiveError('UNSAFE_ZIP_ENTRY', 'DOCX 包含加密、链接或不支持的压缩条目。'));
            return;
          }
          const xml = /\.(xml|rels)$/i.test(entry.fileName);
          const entryLimit = xml ? DOCX_LIMITS.xmlBytes : DOCX_LIMITS.entryBytes;
          if (
            entry.uncompressedSize > entryLimit ||
            expandedBytes + entry.uncompressedSize > DOCX_LIMITS.expandedBytes
          ) {
            fail(new ArchiveError('EXPANSION_LIMIT', 'DOCX 解压内容超过安全限额。', 413));
            return;
          }
          if (
            entry.uncompressedSize > 0 &&
            (entry.compressedSize === 0 ||
              entry.uncompressedSize / entry.compressedSize > DOCX_LIMITS.compressionRatio)
          ) {
            fail(new ArchiveError('COMPRESSION_LIMIT', 'DOCX 压缩比超过安全限额。', 413));
            return;
          }
          if (entry.fileName.endsWith('/')) {
            if (entry.uncompressedSize !== 0) {
              fail(new ArchiveError('INVALID_ZIP', 'DOCX 目录条目异常。'));
              return;
            }
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(new ArchiveError('INVALID_ZIP', 'DOCX 压缩内容损坏。'));
              return;
            }
            const chunks: Buffer[] = [];
            let actual = 0;
            stream.on('data', (chunk: Buffer) => {
              actual += chunk.length;
              if (actual > entryLimit || expandedBytes + actual > DOCX_LIMITS.expandedBytes) {
                stream.destroy();
                fail(new ArchiveError('EXPANSION_LIMIT', 'DOCX 实际解压内容超过安全限额。', 413));
                return;
              }
              chunks.push(chunk);
            });
            stream.on('error', () => fail(new ArchiveError('INVALID_ZIP', 'DOCX 解压校验失败。')));
            stream.on('end', () => {
              if (done) return;
              const content = Buffer.concat(chunks);
              if (actual !== entry.uncompressedSize || crc32(content) !== entry.crc32 >>> 0) {
                fail(new ArchiveError('INVALID_ZIP', 'DOCX 包长度或 CRC 校验失败。'));
                return;
              }
              expandedBytes += actual;
              entries.set(entry.fileName, content);
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => {
          if (!done) {
            done = true;
            resolve({ entries, expandedBytes, count });
          }
        });
        zip.readEntry();
      },
    );
  });
}
