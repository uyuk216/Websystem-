import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
/** Server-side streaming decoration; tenant JS is never involved. */
export function reportResponse(response: Response, method: string, origin: string, appId: string): Response {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('invalid_report_origin');
  const ja = new URL(`/ja/report?app=${encodeURIComponent(appId)}`, base).href;
  const en = new URL(`/en/report?app=${encodeURIComponent(appId)}`, base).href;
  const headers = new Headers(response.headers);
  headers.append('Link', `<${ja}>; rel="help"; hreflang="ja", <${en}>; rel="help"; hreflang="en"`);
  if (!/\btext\/html\b/i.test(headers.get('content-type') ?? '') || method === 'HEAD' || [204, 304, 206].includes(response.status) || !response.body) return new Response(response.body, { status: response.status, headers });
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  let source: Readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null;
  if (encoding && encoding !== 'identity' && !decoder) { source.destroy(); return new Response('Unsupported upstream encoding', { status: 502, headers: { Link: headers.get('Link')!, 'Cache-Control': 'no-store' } }); }
  if (decoder) { source.on('error', e => decoder.destroy(e)); source = source.pipe(decoder); }
  for (const name of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest', 'content-digest', 'accept-ranges']) headers.delete(name);
  headers.set('Cache-Control', 'no-store');
  const footer = Buffer.from(`<footer><a href="${ja.replaceAll('&','&amp;')}">通報</a> / <a href="${en.replaceAll('&','&amp;')}">Report abuse</a></footer>`);
  const it = source[Symbol.asyncIterator](); let finished = false;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    try { const part = await it.next(); if (!part.done) controller.enqueue(part.value as Uint8Array); else { if (!finished) { finished = true; controller.enqueue(footer); } controller.close(); } } catch (e) { source.destroy(); controller.error(e); }
  }, cancel() { source.destroy(); } });
  return new Response(body, { status: response.status, headers });
}
