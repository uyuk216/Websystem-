import { createTransport } from 'nodemailer';

export interface Mailer {
  sendMail(to: string, subject: string, text: string): Promise<void>;
}

export function createMailer(smtpUrl: string, from: string): Mailer {
  const transport = createTransport(smtpUrl);
  return {
    async sendMail(to, subject, text) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
