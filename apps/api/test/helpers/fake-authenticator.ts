/** Software ES256 authenticator (attestation 'none') producing responses accepted by @simplewebauthn/server. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
const b64u = (b: Buffer): string => b.toString('base64url');

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}
type Cbor = number | Buffer | string | Map<number | string, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export interface FakeAuthenticator {
  credentialId: string;
  counter: number;
  register(options: { challenge: string }): unknown;
  assert(options: { challenge: string }, opts?: { counter?: number }): unknown;
}

export function fakeAuthenticator(cfg: { rpId: string; origin: string }): FakeAuthenticator {
  const { publicKey, privateKey }: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(new Map<number, Cbor>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  const credId = randomBytes(32);
  const rpIdHash = sha256(cfg.rpId);
  const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: cfg.origin, crossOrigin: false }));
  const self: FakeAuthenticator = {
    credentialId: b64u(credId),
    counter: 0,
    register(options) {
      const authData = Buffer.concat([
        rpIdHash, Buffer.from([0x45]), u32(0), Buffer.alloc(16), Buffer.from([credId.length >> 8, credId.length & 255]), credId, cose,
      ]);
      const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge)), attestationObject: b64u(attestationObject), transports: ['internal'] },
      };
    },
    assert(options, opts) {
      self.counter = opts?.counter ?? self.counter + 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), u32(self.counter)]);
      const cd = clientData('webauthn.get', options.challenge);
      const signature = sign('sha256', Buffer.concat([authData, sha256(cd)]), privateKey);
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) },
      };
    },
  };
  return self;
}
