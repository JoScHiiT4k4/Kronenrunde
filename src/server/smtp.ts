// Schlanker SMTP-Versand ohne Zusatzpakete – z. B. über Gmail mit App-Passwort.
//
//   Port 465: Verbindung ist von Anfang an verschlüsselt (TLS)
//   Port 587: Verbindung wird mit STARTTLS verschlüsselt, bevor das Passwort gesendet wird
//
// Ohne Verschlüsselung wird nie ein Passwort gesendet (Ausnahme: insecure, nur für Tests).

import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Von Anfang an verschlüsselt (TLS) statt STARTTLS. Standard: nur bei Port 465. */
  implicitTls?: boolean;
  /** Nur für Tests: zusätzliches vertrauenswürdiges Zertifikat */
  ca?: string;
  /** Nur für Tests: ganz ohne Verschlüsselung */
  insecure?: boolean;
  timeoutMs?: number;
}

export interface SmtpMessage {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface Reply {
  code: number;
  text: string;
}

export class SmtpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const ADDRESS = /^[^\s<>()\[\]\\,;:"]+@[^\s<>()\[\]\\,;:"]+$/;

/** Verschickt eine E-Mail. Wirft einen Fehler mit verständlicher Meldung, wenn es nicht klappt. */
export async function sendSmtp(opts: SmtpOptions, msg: SmtpMessage): Promise<void> {
  for (const a of [msg.from, msg.to]) if (!ADDRESS.test(a)) throw new Error(`Ungültige E-Mail-Adresse: ${a}`);
  const password = opts.host.toLowerCase() === 'smtp.gmail.com' ? opts.password.replace(/\s+/g, '') : opts.password;
  const implicitTls = (opts.implicitTls ?? opts.port === 465) && !opts.insecure;

  const conn = await openConnection(opts, implicitTls);
  try {
    await conn.expect(220);
    let caps = await ehlo(conn);

    if (!conn.encrypted && !opts.insecure) {
      if (!/^STARTTLS$/im.test(caps)) {
        throw new Error('Der E-Mail-Server bietet keine Verschlüsselung an. Bitte Port 465 oder 587 verwenden.');
      }
      await conn.command('STARTTLS', 220);
      await conn.upgrade();
      caps = await ehlo(conn);
    }

    const authLine = /^AUTH[ =](.*)$/im.exec(caps)?.[1]?.toUpperCase() ?? '';
    try {
      if (/\bPLAIN\b/.test(authLine) || !/\bLOGIN\b/.test(authLine)) {
        await conn.command(`AUTH PLAIN ${b64(`\0${opts.user}\0${password}`)}`, 235);
      } else {
        await conn.command('AUTH LOGIN', 334);
        await conn.command(b64(opts.user), 334);
        await conn.command(b64(password), 235);
      }
    } catch (e) {
      if (e instanceof SmtpError && e.code === 535) {
        throw new Error(
          'Anmeldung beim E-Mail-Server abgelehnt. Stimmen SMTP_USER und SMTP_PASSWORD? ' +
            'Bei Gmail muss es ein App-Passwort sein, nicht das normale Passwort.',
        );
      }
      throw e;
    }

    await conn.command(`MAIL FROM:<${msg.from}>`, 250);
    await conn.command(`RCPT TO:<${msg.to}>`, [250, 251]);
    await conn.command('DATA', 354);
    const body = buildMessage(msg).replace(/^\./gm, '..');
    await conn.command(`${body}\r\n.`, 250);
    await conn.command('QUIT', 221).catch(() => {});
  } finally {
    conn.close();
  }
}

async function ehlo(conn: Connection): Promise<string> {
  return (await conn.command('EHLO lol-tippspiel', 250)).text;
}

interface Connection {
  readonly encrypted: boolean;
  expect(code: number | number[]): Promise<Reply>;
  command(line: string, code: number | number[]): Promise<Reply>;
  upgrade(): Promise<void>;
  close(): void;
}

function openConnection(opts: SmtpOptions, implicitTls: boolean): Promise<Connection> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    let socket: Socket;
    let encrypted = implicitTls;
    let buffer = '';
    const lines: string[] = [];
    let failure: Error | null = null;
    let wake: (() => void) | null = null;

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, i).replace(/\r$/, ''));
        buffer = buffer.slice(i + 1);
      }
      wake?.();
    };
    const fail = (e: Error) => {
      failure ??= e;
      wake?.();
    };
    const timer = setTimeout(() => {
      const e = new Error(`Der E-Mail-Server ${opts.host}:${opts.port} antwortet nicht (Zeitüberschreitung).`);
      fail(e);
      reject(e); // falls die Verbindung noch gar nicht stand
      socket?.destroy();
    }, timeoutMs);
    timer.unref();

    const attach = (s: Socket) => {
      socket = s;
      s.on('data', onData);
      s.on('error', (e) => fail(new Error(`Verbindung zum E-Mail-Server fehlgeschlagen: ${e.message}`)));
      s.on('close', () => fail(new Error('Der E-Mail-Server hat die Verbindung beendet.')));
    };

    async function readReply(): Promise<Reply> {
      const text: string[] = [];
      for (;;) {
        while (!lines.length) {
          if (failure) throw failure;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
        const line = lines.shift()!;
        const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
        if (!m) throw new Error(`Unerwartete Antwort vom E-Mail-Server: ${line.slice(0, 200)}`);
        text.push(m[3]);
        if (m[2] !== '-') return { code: Number(m[1]), text: text.join('\n') };
      }
    }

    const conn: Connection = {
      get encrypted() {
        return encrypted;
      },
      async expect(code) {
        const reply = await readReply();
        const ok = Array.isArray(code) ? code.includes(reply.code) : reply.code === code;
        if (!ok) throw new SmtpError(reply.code, `E-Mail-Versand fehlgeschlagen (SMTP ${reply.code}): ${reply.text.slice(0, 300)}`);
        return reply;
      },
      async command(line, code) {
        if (failure) throw failure;
        socket.write(`${line}\r\n`);
        return conn.expect(code);
      },
      upgrade() {
        return new Promise<void>((res, rej) => {
          const raw = socket;
          raw.removeListener('data', onData);
          raw.removeAllListeners('close');
          raw.removeAllListeners('error');
          const secure = tlsConnect({ socket: raw, servername: opts.host, ca: opts.ca ? [opts.ca] : undefined }, () => {
            encrypted = true;
            res();
          });
          secure.once('error', rej);
          attach(secure);
        });
      },
      close() {
        clearTimeout(timer);
        socket?.destroy();
      },
    };

    const onConnected = () => resolve(conn);
    const first = implicitTls
      ? tlsConnect({ host: opts.host, port: opts.port, servername: opts.host, ca: opts.ca ? [opts.ca] : undefined }, onConnected)
      : netConnect({ host: opts.host, port: opts.port }, onConnected);
    first.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Verbindung zum E-Mail-Server ${opts.host}:${opts.port} fehlgeschlagen: ${e.message}`));
    });
    attach(first);
  });
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/** Base64 in Zeilen zu 76 Zeichen (wie es der E-Mail-Standard verlangt). */
function b64Lines(s: string): string {
  return b64(s).replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/** Kopfzeile mit Umlauten: =?UTF-8?B?…?= in Stücken, die nie mitten in einem Zeichen trennen. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 39) {
      words.push(`=?UTF-8?B?${b64(chunk)}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${b64(chunk)}?=`);
  return words.join('\r\n ');
}

export function buildMessage(msg: SmtpMessage, date = new Date()): string {
  for (const v of [msg.fromName, msg.subject]) if (/[\r\n]/.test(v)) throw new Error('Zeilenumbruch in Kopfzeile');
  const boundary = `b_${randomBytes(12).toString('hex')}`;
  const domain = msg.from.split('@')[1];
  const name = /^[\w .-]*$/.test(msg.fromName) ? `"${msg.fromName}"` : encodeHeader(msg.fromName);
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${msg.html}</body></html>`;
  return [
    `From: ${name} <${msg.from}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(msg.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(html),
    `--${boundary}--`,
  ].join('\r\n');
}
