import { t, type Locale, type MessageKey } from 'i18n';
import type { ClientAssets } from './client-build.js';

export const LOCALES: readonly Locale[] = ['ja', 'en'];

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MESSAGES = {
  Encrypting: 'upload.encrypting', Sending: 'upload.sending', Done: 'upload.done', ErrorToken: 'upload.errorToken', ErrorFormat: 'upload.errorFormat',
  ErrorTooLarge: 'upload.errorTooLarge', ErrorNetwork: 'upload.errorNetwork', ErrorUnavailable: 'upload.errorUnavailable', NoFile: 'upload.noFile',
} as const satisfies Record<string, MessageKey>;

/** 提出ページ。インラインのスクリプトとスタイルは使わず、文言は data 属性でスクリプトに渡す。 */
export function renderSubmitPage(locale: Locale, assets: ClientAssets, recipientPublicKeyB64: string): string {
  const data = Object.entries(MESSAGES).map(([k, key]) => `data-msg-${k.replace(/[A-Z]/g, (c, i: number) => (i ? '-' : '') + c.toLowerCase())}="${esc(t(locale, key))}"`).join(' ');
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="id-recipient-key" content="${esc(recipientPublicKeyB64)}">
<title>${esc(t(locale, 'upload.title'))}</title>
<link rel="stylesheet" href="${assets.style.path}">
</head>
<body>
<main ${data}>
<h1>${esc(t(locale, 'upload.title'))}</h1>
<p>${esc(t(locale, 'upload.lead'))}</p>
<p>${esc(t(locale, 'upload.purpose'))}</p>
<p class="notice" role="note">${esc(t(locale, 'verification.noEmailNotice'))}</p>
<form id="form" novalidate>
<label for="file">${esc(t(locale, 'upload.chooseFile'))}</label>
<input id="file" name="file" type="file" accept="image/jpeg,image/png,image/webp">
<button type="submit">${esc(t(locale, 'upload.submit'))}</button>
</form>
<p id="status" role="status" aria-live="polite"></p>
</main>
<script type="module" src="${assets.script.path}" integrity="${assets.script.integrity}" crossorigin="anonymous"></script>
</body>
</html>
`;
}
