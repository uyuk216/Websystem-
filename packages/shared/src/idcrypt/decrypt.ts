import { ENVELOPE_VERSION, buildAad, type IdEnvelope } from './envelope.js';
import { hybridDecapsulate } from './hybrid-kem.js';
import { parseRecipientSecretKey } from './keys.js';

const b = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;

export async function decryptIdImage(input: {
  envelope: IdEnvelope;
  secretKey: Uint8Array;
  uploadId: string;
  accountId: string;
}): Promise<Uint8Array> {
  const { envelope } = input;
  if (envelope.version !== ENVELOPE_VERSION) throw new Error('envelope: unsupported version');
  const aad = buildAad(envelope.version, input.uploadId, input.accountId);
  const key = await hybridDecapsulate(parseRecipientSecretKey(input.secretKey), envelope.ephemeralPublicKey, envelope.kemCiphertext, aad);
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b(envelope.nonce), additionalData: b(aad) },
      key,
      b(envelope.ciphertext),
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error('envelope: decryption failed');
  }
}

/** 復号の差し替え口。本番は YubiKey、テストはローカル鍵。 */
export interface Decryptor {
  decrypt(input: { envelope: IdEnvelope; uploadId: string; accountId: string }): Promise<Uint8Array>;
}

export class LocalKeyDecryptor implements Decryptor {
  constructor(private readonly secretKey: Uint8Array) {}
  decrypt(input: { envelope: IdEnvelope; uploadId: string; accountId: string }): Promise<Uint8Array> {
    return decryptIdImage({ ...input, secretKey: this.secretKey });
  }
}

/**
 * YubiKey 用の薄い実装。外部コマンド（age-plugin-yubikey 相当）に
 * 封筒の直列化バイト列と uploadId / accountId を渡し、標準出力の平文を受け取る。
 * 実機での確認は運営者が行う。
 */
export class ExternalCommandDecryptor implements Decryptor {
  constructor(
    private readonly run: (args: { stdin: Uint8Array; env: Record<string, string> }) => Promise<Uint8Array>,
    private readonly serialize: (e: IdEnvelope) => Uint8Array,
  ) {}
  decrypt(input: { envelope: IdEnvelope; uploadId: string; accountId: string }): Promise<Uint8Array> {
    return this.run({
      stdin: this.serialize(input.envelope),
      env: { YS_UPLOAD_ID: input.uploadId, YS_ACCOUNT_ID: input.accountId },
    });
  }
}
