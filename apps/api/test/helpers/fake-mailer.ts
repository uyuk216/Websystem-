import type { Mailer } from '../../src/mail/mailer.js';

export interface FakeMailer extends Mailer {
  sentTo(addr: string): number;
  lastBodyTo(addr: string): string | undefined;
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
    clear: () => {
      sent.length = 0;
    },
  };
}
