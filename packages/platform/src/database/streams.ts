import { Duplex, type Readable, type Writable } from 'node:stream';

/** One duplex stream over a separate readable (data in) and writable (data out), with backpressure both ways. */
export function joinStreams(readable: Readable, writable: Writable): Duplex {
  const d = new Duplex({
    read() { readable.resume(); },
    write(chunk: Buffer, _enc, cb) { writable.write(chunk, cb); },
    final(cb) { writable.end(); cb(); },
    destroy(err, cb) { readable.destroy(); writable.destroy(); cb(err); },
  });
  readable.on('data', (c: Buffer) => { if (!d.push(c)) readable.pause(); });
  readable.on('end', () => d.push(null));
  readable.on('error', (e) => d.destroy(e));
  writable.on('error', (e) => d.destroy(e));
  return d;
}
