import { randomUUID } from 'node:crypto';
import type { VerificationDecision, VerificationProvider, VerificationRefStatus, VerificationSubmitInput } from './provider.js';

interface Entry {
  input: VerificationSubmitInput;
  state: VerificationRefStatus;
  reason?: string;
}

/** 運営者が手で審査する窓口。審査待ちのキューを持つ。 */
export class ManualProvider implements VerificationProvider {
  protected readonly entries = new Map<string, Entry>();

  async submit(input: VerificationSubmitInput): Promise<{ ref: string }> {
    const ref = randomUUID();
    this.entries.set(ref, { input, state: 'pending' });
    return { ref };
  }

  async decide(ref: string, decision: VerificationDecision): Promise<void> {
    const e = this.entries.get(ref);
    if (!e) throw new Error('unknown verification ref');
    if (e.state !== 'pending') throw new Error('verification already decided');
    e.state = decision.result;
    if (decision.result === 'rejected') e.reason = decision.reason;
  }

  async status(ref: string): Promise<VerificationRefStatus> {
    return this.entries.get(ref)?.state ?? 'unknown';
  }

  /** 審査待ちの提出（古い順）。 */
  pending(): { ref: string; input: VerificationSubmitInput }[] {
    return [...this.entries].filter(([, e]) => e.state === 'pending').map(([ref, e]) => ({ ref, input: e.input }));
  }
}

/** テスト用。自動では決めず、呼ばれた内容を記録して差し替えが効くことを確かめるために使う。 */
export class FakeProvider extends ManualProvider {
  readonly decisions: { ref: string; decision: VerificationDecision }[] = [];

  override async decide(ref: string, decision: VerificationDecision): Promise<void> {
    await super.decide(ref, decision);
    this.decisions.push({ ref, decision });
  }
}
