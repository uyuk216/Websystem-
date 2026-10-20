import { describe, expect, it } from 'vitest';
import {
  LocalKeyDecryptor,
  decryptIdImage,
  encryptIdImage,
  generateRecipientKeyPair,
  parseEnvelope,
  serializeEnvelope,
} from '../src/idcrypt/index.js';

const uploadId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const plain = new TextEncoder().encode('STUDENT-ID-PLAINTEXT-MARKER-0123456789'.repeat(20));

async function setup() {
  const kp = await generateRecipientKeyPair();
  const envelope = await encryptIdImage({ image: plain, recipientPublicKey: kp.publicKey, uploadId, accountId });
  return { kp, envelope };
}

describe('idcrypt', () => {
  it('往復できる', async () => {
    const { kp, envelope } = await setup();
    const out = await decryptIdImage({ envelope, secretKey: kp.secretKey, uploadId, accountId });
    expect(Buffer.from(out).equals(Buffer.from(plain))).toBe(true);
    const viaDec = await new LocalKeyDecryptor(kp.secretKey).decrypt({ envelope, uploadId, accountId });
    expect(viaDec.length).toBe(plain.length);
  });

  it('直列化しても復号できる', async () => {
    const { kp, envelope } = await setup();
    const back = parseEnvelope(serializeEnvelope(envelope));
    const out = await decryptIdImage({ envelope: back, secretKey: kp.secretKey, uploadId, accountId });
    expect(out.length).toBe(plain.length);
  });

  it('1 バイトの改ざんで失敗する（各部位）', async () => {
    const { kp, envelope } = await setup();
    const bytes = serializeEnvelope(envelope);
    for (const pos of [1, 40, 500, 1125 + 3, bytes.length - 1]) {
      const t = bytes.slice();
      t[pos] = t[pos]! ^ 1;
      await expect(decryptIdImage({ envelope: parseEnvelope(t), secretKey: kp.secretKey, uploadId, accountId })).rejects.toThrow();
    }
  });

  it('別の uploadId / accountId では失敗する', async () => {
    const { kp, envelope } = await setup();
    await expect(decryptIdImage({ envelope, secretKey: kp.secretKey, uploadId: accountId, accountId })).rejects.toThrow();
    await expect(decryptIdImage({ envelope, secretKey: kp.secretKey, uploadId, accountId: uploadId })).rejects.toThrow();
  });

  it('版が違うと失敗する', async () => {
    const { kp, envelope } = await setup();
    await expect(decryptIdImage({ envelope: { ...envelope, version: 2 }, secretKey: kp.secretKey, uploadId, accountId })).rejects.toThrow(/version/);
  });

  it('別の鍵では復号できない', async () => {
    const { envelope } = await setup();
    const other = await generateRecipientKeyPair();
    await expect(decryptIdImage({ envelope, secretKey: other.secretKey, uploadId, accountId })).rejects.toThrow();
  });

  it('封筒に平文の断片が含まれない', async () => {
    const { envelope } = await setup();
    const hay = Buffer.from(serializeEnvelope(envelope));
    expect(hay.includes(Buffer.from('STUDENT-ID'))).toBe(false);
    expect(hay.includes(Buffer.from(plain.slice(0, 8)))).toBe(false);
  });

  it('同じ入力でも毎回違う封筒になる', async () => {
    const kp = await generateRecipientKeyPair();
    const a = await encryptIdImage({ image: plain, recipientPublicKey: kp.publicKey, uploadId, accountId });
    const b = await encryptIdImage({ image: plain, recipientPublicKey: kp.publicKey, uploadId, accountId });
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('3MB を超える画像は拒否する', async () => {
    const kp = await generateRecipientKeyPair();
    await expect(
      encryptIdImage({ image: new Uint8Array(3 * 1024 * 1024 + 1), recipientPublicKey: kp.publicKey, uploadId, accountId }),
    ).rejects.toThrow();
  });
});
