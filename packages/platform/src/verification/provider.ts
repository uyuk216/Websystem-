/** 学生認証の審査の窓口。SheerID などの外部サービスはここを差し替えて使う（この計画では ManualProvider のみ実装）。 */
export interface VerificationSubmitInput {
  verificationId: string;
  accountId: string;
  uploadId: string;
}

export type VerificationDecision = { result: 'approved' } | { result: 'rejected'; reason: string };
export type VerificationRefStatus = 'pending' | 'approved' | 'rejected' | 'unknown';

export interface VerificationProvider {
  submit(input: VerificationSubmitInput): Promise<{ ref: string }>;
  decide(ref: string, decision: VerificationDecision): Promise<void>;
  status(ref: string): Promise<VerificationRefStatus>;
}
