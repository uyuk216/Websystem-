/**
 * ブラウザ内の処理：画像を canvas に描き直して EXIF 等を落とし、運営者の公開鍵で暗号化してから、封筒だけを送る。
 * 暗号化前の画像は、この関数の外（ネットワーク・ストレージ・DOM の img など）に出さない。
 */
import { encryptIdImage, sanitizeIdImage } from 'shared/idcrypt/encrypt';
import { serializeEnvelope } from 'shared/idcrypt/envelope';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN_RE = new RegExp(`^(${UUID})\\.(${UUID})\\.[A-Za-z0-9_-]{43}$`, 'i');

const main = document.querySelector<HTMLElement>('main')!;
const form = document.querySelector<HTMLFormElement>('#form')!;
const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const button = form.querySelector<HTMLButtonElement>('button')!;
const status = document.querySelector<HTMLElement>('#status')!;
const msg = (k: string): string => main.dataset[`msg${k}`] ?? '';

function show(text: string, kind: 'info' | 'error' = 'info'): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

// The token travels in the address once; take it out of the address bar and the history right away.
let token: string | null = new URLSearchParams(location.search).get('token');
history.replaceState(null, '', location.pathname);
const ids = token && TOKEN_RE.exec(token);
const recipientKey = Uint8Array.from(atob(document.querySelector<HTMLMetaElement>('meta[name="id-recipient-key"]')!.content), (c) => c.charCodeAt(0));

if (!ids) {
  show(msg('ErrorToken'), 'error');
  button.disabled = true;
  fileInput.disabled = true;
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  void submit();
});

async function submit(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!ids || !token) return;
  if (!file) return show(msg('NoFile'), 'error');
  button.disabled = true;
  try {
    show(msg('Encrypting'));
    let image: Uint8Array;
    try {
      image = await sanitizeIdImage(file);
    } catch (e) {
      return show(msg(e instanceof Error && /too large/.test(e.message) ? 'ErrorTooLarge' : 'ErrorFormat'), 'error');
    }
    const envelope = await encryptIdImage({ image, recipientPublicKey: recipientKey, uploadId: ids[1]!.toLowerCase(), accountId: ids[2]!.toLowerCase() });
    image.fill(0);
    show(msg('Sending'));
    let res: Response;
    try {
      res = await fetch('/ingest/id-upload', {
        method: 'POST', body: serializeEnvelope(envelope) as Uint8Array<ArrayBuffer>, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
      });
    } catch {
      return show(msg('ErrorNetwork'), 'error');
    }
    if (res.status === 204) {
      token = null; // one-shot: it cannot be used again
      fileInput.value = '';
      fileInput.disabled = true;
      return show(msg('Done'));
    }
    if (res.status === 401 || res.status === 409) {
      button.disabled = true;
      return show(msg('ErrorToken'), 'error');
    }
    show(msg(res.status === 413 ? 'ErrorTooLarge' : res.status === 503 ? 'ErrorUnavailable' : 'ErrorNetwork'), 'error');
  } finally {
    if (token) button.disabled = false;
  }
}
