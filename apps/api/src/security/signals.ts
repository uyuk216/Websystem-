import { createHash } from 'node:crypto';
import { canonicalEvidence, validateSignalShape } from 'shared';
import type { SecuritySignal, SignalError } from 'shared';

export class SignalRejected extends Error {
  constructor(readonly code: SignalError | 'untrusted_target' | 'digest_mismatch') {
    super(`security signal rejected: ${code}`);
    this.name = 'SignalRejected';
  }
}

/** 証拠の SHA-256（正規化 JSON）。検知器はこれを `evidenceDigest` に入れる。 */
export function digestEvidence(evidence: SecuritySignal['evidence']): string {
  return createHash('sha256').update(canonicalEvidence(evidence)).digest('hex');
}

/** 検知器用: 証拠からダイジェストを付けて信号を組み立てる。 */
export function buildSignal(s: Omit<SecuritySignal, 'evidenceDigest'>): SecuritySignal {
  return { ...s, evidenceDigest: digestEvidence(s.evidence) };
}

/** 形・許可リスト・ダイジェストの照合。対象が実在するか（偽 target）は `handleSecuritySignal` が DB で確かめる。 */
export function assertValidSignal(s: SecuritySignal): void {
  const bad = validateSignalShape(s);
  if (bad) throw new SignalRejected(bad);
  if (digestEvidence(s.evidence) !== s.evidenceDigest) throw new SignalRejected('digest_mismatch');
}
