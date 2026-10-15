import type { Mailer } from '../../src/mail/mailer.js';

export interface FakeMailer extends Mailer {
  sentTo(addr: string): number;
  lastBodyTo(addr: string): string | undefined;
  /** 6-digit code in the most recent mail. */
  lastCode(): string;
  /** Link token (`t=`) in the most recent mail. */
  lastLinkToken(): string;
  clear(): void;
}

export function createFakeMailer(): FakeMailer {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    async sendMail(to, subject, text) {
      sent.push({ to, subject, text });
    },
    sentTo: (addr) => sent.filter((m) => m.to === addr).length,
    lastBodyTo: (addr) => sent.filter((m) => m.to === addr).at(-1)?.text,
    lastCode: () => /\b(\d{6})\b/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '',
    lastLinkToken: () => /[?&]t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '',
    clear: () => {
      sent.length = 0;
    },
  };
}
