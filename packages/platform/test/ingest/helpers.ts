import { crc32, deflateRawSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import * as tar from 'tar';

export type ZipSpec = {
  name: string;
  data?: Buffer;
  symlink?: boolean;
  deflate?: boolean;
  declaredSize?: number;
};

export function makeZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const raw = s.data ?? Buffer.alloc(0);
    const comp = s.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(s.name);
    const size = s.declaredSize ?? raw.length;
    const method = s.deflate ? 8 : 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6);
    l.writeUInt16LE(method, 8); l.writeUInt32LE(crc32(raw), 14);
    l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(size, 22); l.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([l, name, comp]);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28);
    const mode = s.symlink ? 0o120777 : s.name.endsWith('/') ? 0o040755 : 0o100644;
    c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([c, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(specs.length, 8); e.writeUInt16LE(specs.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

export type TarSpec = { path: string; data?: Buffer; type?: 'File' | 'SymbolicLink' | 'Directory' | 'Link'; linkpath?: string };

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

/** Hand-built ustar so unsafe names survive (node-tar would sanitize on write). */
export function makeTarGz(specs: TarSpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const s of specs) {
    const data = s.data ?? Buffer.alloc(0);
    const h = Buffer.alloc(512);
    h.write(s.path, 0, 100); h.write(octal(0o644, 8), 100); h.write(octal(0, 8), 108);
    h.write(octal(0, 8), 116); h.write(octal(data.length, 12), 124); h.write(octal(0, 12), 136);
    h.write('        ', 148);
    const t = { File: '0', SymbolicLink: '2', Directory: '5', Link: '1' }[s.type ?? 'File'];
    h.write(t, 156); if (s.linkpath) h.write(s.linkpath, 157, 100);
    h.write('ustar\0' + '00', 257);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export const stream = (b: Buffer) => Readable.from([b]);
export { tar };
