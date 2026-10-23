import { ADMIN_JA } from '../../../packages/i18n/src/admin.js';
import { LocalKeyDecryptor, parseEnvelope } from '../../../packages/shared/src/idcrypt/index.js';
import { LIMIT_SETTING_KEYS } from '../../../packages/shared/src/plans.js';
import { DecryptViewer } from './decrypt-viewer.js';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = el('screen'), status = el('status');
let viewer: DecryptViewer | undefined;
let selected: string | undefined;
let owner = false;
const clear = () => { viewer?.dispose(); viewer = undefined; selected = undefined; el('viewer').hidden = true; el<HTMLInputElement>('secret').value = ''; };
async function api(path: string, body?: unknown, method = 'POST'): Promise<Record<string, unknown>> {
  const res = await fetch('/admin' + path, { credentials: 'same-origin', cache: 'no-store', method: body === undefined ? 'GET' : method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    if ([401, 403, 404].includes(res.status)) clear();
    if (res.status === 401) { el('ops').hidden = true; el('login').hidden = false; }
    throw new Error(`操作できません (${res.status}): ` + JSON.stringify(await res.json()));
  }
  return res.json() as Promise<Record<string, unknown>>;
}
const run = (fn: () => Promise<void>) => { void fn().catch((e: unknown) => { status.textContent = e instanceof Error ? e.message : 'エラー'; }); };
function button(parent: HTMLElement, text: string, fn: () => Promise<void>, enabled = true): void {
  const b = document.createElement('button'); b.textContent = text; b.disabled = !enabled; b.onclick = () => run(fn); parent.append(b);
}
function input(parent: HTMLElement, label: string, type = 'text', value = ''): HTMLInputElement {
  const l = document.createElement('label'); l.textContent = label;
  const i = document.createElement('input'); i.type = type; i.value = value; l.append(i); parent.append(l); return i;
}
function card(value: unknown): HTMLElement {
  const a = document.createElement('article'), p = document.createElement('pre'); p.textContent = JSON.stringify(value, null, 2); a.append(p); screen.append(a); return a;
}
const rows = (data: Record<string, unknown>, key: string) => (data[key] ?? []) as Record<string, unknown>[];
async function load(name: string): Promise<void> {
  clear(); screen.replaceChildren();
  const h = document.createElement('h2'); h.textContent = (ADMIN_JA as Record<string, string>)[name] ?? ''; screen.append(h);
  if (name === 'reviews') {
    for (const r of rows(await api('/reviews'), 'reviews')) {
      const a = card(r), id = String(r.verificationId);
      button(a, '画像を開く', async () => { clear(); selected = id; el('viewer').hidden = false; });
      const confirmed = input(a, '新年度の書類を確認済み', 'checkbox');
      button(a, '承認', async () => { clear(); await api(`/reviews/${id}/approve`, { newFiscalYearDocConfirmed: confirmed.checked }); await load(name); });
      const reason = input(a, '差し戻し理由');
      button(a, '差し戻し', async () => { clear(); await api(`/reviews/${id}/reject`, { reason: reason.value }); await load(name); });
    }
  } else if (name === 'grants') {
    const form = card('Student の手動付与');
    const account = input(form, 'アカウントID'), until = input(form, '有効期限', 'datetime-local'), reason = input(form, '理由');
    button(form, 'Student を付与', async () => { await api('/grants/student', { accountId: account.value, validUntil: new Date(until.value).toISOString(), reason: reason.value }); await load(name); }, owner);
    const data = await api('/grants');
    for (const r of rows(data, 'grants')) {
      const a = card(r);
      if (r.kind === 'student' && !r.revokedAt) button(a, '取り消し', async () => { await api(`/grants/${r.id}/revoke`, {}); await load(name); }, owner);
    }
    for (const entry of rows(data, 'history')) card(entry);
    for (const kind of ['starter', 'boosts']) for (const r of rows(data, kind)) {
      const a = card(r), url = `/grants/${kind === 'starter' ? 'starter' : 'boost'}/${r.id}`;
      const end = kind === 'starter' ? input(a, '終了日時', 'datetime-local') : null;
      const transfer = kind === 'boosts' ? input(a, '追加転送量 (bytes)', 'number', '21474836480') : null;
      const memory = kind === 'boosts' ? input(a, '追加メモリ (MB)', 'number', '512') : null;
      button(a, '承認', async () => { await api(url + '/approve', end ? { endsAt: new Date(end.value).toISOString() } : { extraTransferBytes: Number(transfer!.value), extraMemoryMb: Number(memory!.value) }); await load(name); }, owner);
      const reject = input(a, '差し戻し理由');
      button(a, '差し戻し', async () => { await api(url + '/reject', { reason: reject.value }); await load(name); }, owner);
    }
  } else if (name === 'accounts') {
    const form = card('メールは完全一致で照合します。停止・ブロック・凍結は動的アプリに適用され、静的サイトとデータは維持されます。'), email = input(form, 'メールアドレス', 'email');
    button(form, '検索', async () => {
      const result = await api('/accounts/search', { email: email.value });
      for (const a of rows(result, 'accounts')) {
        const c = card(a);
        button(c, 'メールを表示（記録されます）', async () => { card(await api(`/accounts/${a.id}/email`)); });
        for (const o of (a.owners ?? []) as Record<string, unknown>[]) {
          for (const [event, label] of [['manual_block', 'ブロック'], ['manual_unblock', 'ブロック解除'], ['manual_suspend', '停止'], ['manual_resume', '停止解除'], ['manual_freeze', '凍結']]) {
            button(c, label!, async () => { card(await api(`/accounts/${o.id}/state`, { event })); });
          }
          button(c, '凍結解除を24時間後に予約', async () => { card(await api('/dangerous', { action: 'unfreeze_account', target: o.id })); });
        }
      }
    }, owner);
    for (const r of rows(await api('/dangerous'), 'actions')) {
      const a = card(r);
      if (r.status === 'scheduled') button(a, '予約を取り消す', async () => { await api(`/dangerous/${r.id}/cancel`, {}); await load(name); }, owner);
    }
  } else if (name === 'settings') {
    const data = rows(await api('/settings'), 'settings');
    for (const key of LIMIT_SETTING_KEYS) {
      const a = card(key), value = input(a, '上限値', 'number', String(data.find((r) => r.key === key)?.value ?? ''));
      value.min = '0';
      button(a, '保存', async () => { if (!value.value) throw new Error('上限値を入力してください'); await api('/settings/' + key, { value: Number(value.value) }, 'PUT'); status.textContent = '保存しました'; }, owner);
    }
  } else if (name === 'audit') {
    button(screen, 'ハッシュ連鎖を検証', async () => { card(await api('/audit/verify')); });
    for (const r of rows(await api('/audit'), 'entries')) card(r);
  }
}
const from64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const to64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
el('login').onclick = () => run(async () => {
  const start = await api('/session/start', {}), opts = start.options as Record<string, unknown>;
  const allow = (opts.allowCredentials ?? []) as { id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[] }[];
  const cred = await navigator.credentials.get({ publicKey: { ...opts, challenge: from64(String(opts.challenge)), allowCredentials: allow.map((c) => ({ ...c, id: from64(c.id) })) } as PublicKeyCredentialRequestOptions }) as PublicKeyCredential | null;
  if (!cred) throw new Error('パスキー認証を中止しました');
  const response = cred.response as AuthenticatorAssertionResponse;
  await api('/session/finish', { challengeId: start.challengeId, response: { id: cred.id, rawId: to64(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment, clientExtensionResults: cred.getClientExtensionResults(),
    response: { clientDataJSON: to64(response.clientDataJSON), authenticatorData: to64(response.authenticatorData), signature: to64(response.signature), userHandle: response.userHandle ? to64(response.userHandle) : undefined } } });
  await init();
});
el('logout').onclick = () => run(async () => { clear(); await api('/session/logout', {}); location.reload(); });
el('close-image').onclick = clear;
el('decrypt').onclick = () => run(async () => {
  if (!selected) return;
  const id = selected;
  viewer?.dispose(); viewer = undefined;
  const file = el<HTMLInputElement>('secret').files?.[0];
  el<HTMLInputElement>('secret').value = '';
  if (!file) throw new Error('ローカル鍵を選択してください');
  const key = from64((await file.text()).trim());
  try {
    const data = await api(`/reviews/${id}/image`);
    if (selected !== id) return;
    viewer = new DecryptViewer(el<HTMLImageElement>('image'), new LocalKeyDecryptor(key));
    await viewer.show({ envelope: parseEnvelope(from64(String(data.ciphertext))), uploadId: String(data.uploadId), accountId: String(data.accountId) });
  } finally { key.fill(0); }
});
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-screen]'))) b.onclick = () => run(() => load(b.dataset.screen!));
async function init(): Promise<void> {
  const me = await api('/me'); owner = me.role === 'owner';
  el('ops').hidden = false; el('login').hidden = true; el('logout').hidden = false; status.textContent = 'ログイン済み（30分で期限切れ）';
  setTimeout(() => { clear(); el('ops').hidden = true; el('login').hidden = false; status.textContent = '再ログインしてください'; }, Math.max(0, new Date(String(me.expiresAt)).getTime() - Date.now()));
  await load('reviews');
}
run(init);
