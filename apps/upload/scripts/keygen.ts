import { generateRecipientKeyPair } from 'shared';

// 開発・テスト用の鍵ペアを作る。本番の秘密鍵は YubiKey の中で作り、ここには出さない。
const { publicKey, secretKey } = await generateRecipientKeyPair();
console.log(`ID_RECIPIENT_PUBLIC_KEY=${Buffer.from(publicKey).toString('base64')}`);
console.error('秘密鍵（開発用・管理画面のローカル復号ツール用。コミットしない）:');
console.error(Buffer.from(secretKey).toString('base64'));
