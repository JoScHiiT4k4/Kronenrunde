// E-Mails verschicken. Austauschbar über MAIL_MODE:
//   console – Link nur im Server-Protokoll ausgeben (zum Ausprobieren)
//   brevo   – über Brevo (kostenlos bis 300 Mails/Tag, Absender-Adresse bestätigen genügt)
//   resend  – über Resend (eigene Domain nötig)
//   memory  – nur für automatische Tests

import type { Config } from './config.ts';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Nur bei MAIL_MODE=memory: verschickte Mails (für Tests). */
  sent?: Mail[];
}

export function createMailer(config: Config, log: (msg: string) => void = console.log): Mailer {
  const { mode, from, fromName, apiKey } = config.mail;

  if (mode === 'memory') {
    const sent: Mail[] = [];
    return { sent, send: async (m) => void sent.push(m) };
  }

  if (mode === 'console') {
    return {
      send: async (m) => log(`\n[E-Mail an ${m.to}] ${m.subject}\n${m.text}\n`),
    };
  }

  if (!from || !apiKey) throw new Error('MAIL_FROM und MAIL_API_KEY müssen gesetzt sein (siehe .env.example)');

  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`E-Mail-Versand fehlgeschlagen (${r.status}): ${(await r.text()).slice(0, 300)}`);
  };

  if (mode === 'brevo') {
    return {
      send: (m) =>
        post('https://api.brevo.com/v3/smtp/email', { 'api-key': apiKey }, {
          sender: { name: fromName, email: from },
          to: [{ email: m.to }],
          subject: m.subject,
          textContent: m.text,
          htmlContent: m.html,
        }),
    };
  }

  return {
    send: (m) =>
      post('https://api.resend.com/emails', { authorization: `Bearer ${apiKey}` }, {
        from: `${fromName} <${from}>`,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        html: m.html,
      }),
  };
}
