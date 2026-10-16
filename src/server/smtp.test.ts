// Tests für den SMTP-Versand gegen einen kleinen Test-Mailserver (ohne Internet).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { loadConfig } from './config.ts';
import { createMailer } from './mail.ts';
import { buildMessage, encodeHeader, sendSmtp, type SmtpOptions } from './smtp.ts';

interface Received {
  commands: string[];
  data: string;
  auth: string | null;
  tlsAtAuth: boolean;
}

interface FakeOptions {
  implicitTls?: boolean;
  starttls?: boolean;
  auth?: 'PLAIN' | 'LOGIN';
  user?: string;
  password?: string;
}

// Selbst-signiertes Zertifikat für "localhost" (openssl ist auf Linux/macOS vorhanden).
let cert: { key: string; cert: string } | null = null;
let certDir = '';
before(() => {
  try {
    certDir = mkdtempSync(join(tmpdir(), 'smtp-test-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
    ], { stdio: 'ignore' });
    cert = { key: readFileSync(join(certDir, 'key.pem'), 'utf8'), cert: readFileSync(join(certDir, 'cert.pem'), 'utf8') };
  } catch {
    cert = null;
  }
});
after(() => certDir && rmSync(certDir, { recursive: true, force: true }));

function fakeServer(opts: FakeOptions): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const user = opts.user ?? 'tipp@gmail.com';
  const password = opts.password ?? 'abcdefghijklmnop';

  const handle = (start: Socket, encrypted: boolean) => {
    const r: Received = { commands: [], data: '', auth: null, tlsAtAuth: false };
    received.push(r);
    let sock = start;
    let buf = '';
    let mode: 'cmd' | 'data' | 'login-user' | 'login-pass' = 'cmd';
    let loginUser = '';
    const reply = (s: string) => sock.write(`${s}\r\n`);
    const caps = () => {
      const lines = ['localhost', 'SIZE 35882577', '8BITMIME'];
      if (opts.starttls && !encrypted) lines.push('STARTTLS');
      if (encrypted || !opts.starttls) lines.push(`AUTH ${opts.auth === 'LOGIN' ? 'LOGIN' : 'LOGIN PLAIN XOAUTH2'}`);
      return lines.map((l, i) => `250${i === lines.length - 1 ? ' ' : '-'}${l}`).join('\r\n');
    };
    const checkAuth = (u: string, p: string) => {
      r.auth = `${u}:${p}`;
      r.tlsAtAuth = encrypted;
      reply(u === user && p === password ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted');
    };
    const onLine = (line: string) => {
      if (mode === 'data') {
        if (line === '.') {
          mode = 'cmd';
          reply('250 2.0.0 OK queued');
        } else r.data += `${line}\r\n`;
        return;
      }
      if (mode === 'login-user') {
        loginUser = Buffer.from(line, 'base64').toString();
        mode = 'login-pass';
        return reply('334 UGFzc3dvcmQ6');
      }
      if (mode === 'login-pass') {
        mode = 'cmd';
        return checkAuth(loginUser, Buffer.from(line, 'base64').toString());
      }
      r.commands.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN …' : line);
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO') return reply(caps());
      if (cmd === 'STARTTLS') {
        reply('220 2.0.0 Ready to start TLS');
        sock.removeAllListeners('data');
        const secure = new TLSSocket(sock, { isServer: true, key: cert!.key, cert: cert!.cert });
        encrypted = true;
        sock = secure;
        buf = '';
        sock.on('data', onData);
        return;
      }
      if (cmd === 'AUTH') {
        const [, method, arg] = line.split(' ');
        if (method === 'PLAIN') {
          const [, u, p] = Buffer.from(arg, 'base64').toString().split('\0');
          return checkAuth(u, p);
        }
        mode = 'login-user';
        return reply('334 VXNlcm5hbWU6');
      }
      if (cmd === 'MAIL' || cmd === 'RCPT') return reply('250 OK');
      if (cmd === 'DATA') {
        mode = 'data';
        return reply('354 Go ahead');
      }
      if (cmd === 'QUIT') {
        reply('221 Bye');
        return sock.end();
      }
      reply('502 Unknown');
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
    reply('220 localhost ESMTP Test');
  };

  const server = opts.implicitTls
    ? createTlsServer({ key: cert!.key, cert: cert!.cert }, (s) => handle(s, true))
    : createServer((s) => handle(s, false));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, received });
    });
  });
}

const message = {
  from: 'tipp@gmail.com',
  fromName: 'Kronenrunde',
  to: 'anna@example.de',
  subject: 'Dein Anmelde-Link für Kronenrunde – Grüße',
  text: 'Hallo!\n.\nLink: https://x.ts.net/anmelden/bestaetigen?token=abc',
  html: '<p>Hallo Ä</p>',
};

function decodeParts(data: string): string[] {
  return [...data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((m) =>
    Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'),
  );
}

test('SMTP: Kopfzeilen mit Umlauten und Nachricht im richtigen Format', () => {
  assert.equal(encodeHeader('Hallo'), 'Hallo');
  const long = 'Ä'.repeat(60);
  const encoded = encodeHeader(long);
  for (const line of encoded.split('\r\n ')) assert.ok(line.length <= 76, line);
  const decoded = encoded
    .split('\r\n ')
    .map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1], 'base64').toString('utf8'))
    .join('');
  assert.equal(decoded, long);

  const raw = buildMessage(message, new Date('2026-10-15T18:00:00Z'));
  assert.match(raw, /^From: "Kronenrunde" <tipp@gmail\.com>\r\n/);
  assert.match(raw, /\r\nDate: Thu, 15 Oct 2026 18:00:00 \+0000\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?/);
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 78, `Zeile zu lang: ${line}`);
  assert.throws(() => buildMessage({ ...message, subject: 'a\r\nBcc: x@y.de' }));
});

test('SMTP: Port 465 (gleich verschlüsselt), Anmeldung mit PLAIN, Gmail-App-Passwort mit Leerzeichen', async (t) => {
  if (!cert) return t.skip('openssl nicht vorhanden');
  const { server, port, received } = await fakeServer({ implicitTls: true });
  try {
    const opts: SmtpOptions = { host: 'localhost', port, implicitTls: true, user: 'tipp@gmail.com', password: 'abcd efgh ijkl mnop', ca: cert.cert };
    // Leerzeichen im App-Passwort entfernt der Client nur bei Gmail – hier also falsch:
    await assert.rejects(sendSmtp(opts, message), /App-Passwort/);
    await sendSmtp({ ...opts, password: 'abcdefghijklmnop' }, message);
    const r = received[1];
    assert.equal(r.auth, 'tipp@gmail.com:abcdefghijklmnop');
    assert.ok(r.tlsAtAuth);
    assert.deepEqual(r.commands.slice(2), ['MAIL FROM:<tipp@gmail.com>', 'RCPT TO:<anna@example.de>', 'DATA', 'QUIT']);
    const [text, html] = decodeParts(r.data);
    assert.equal(text, message.text);
    assert.match(html, /<p>Hallo Ä<\/p>/);
  } finally {
    server.close();
  }
});

test('SMTP: Port 587 mit STARTTLS, Anmeldung mit LOGIN erst nach der Verschlüsselung', async (t) => {
  if (!cert) return t.skip('openssl nicht vorhanden');
  const { server, port, received } = await fakeServer({ starttls: true, auth: 'LOGIN' });
  try {
    await sendSmtp({ host: 'localhost', port, user: 'tipp@gmail.com', password: 'abcdefghijklmnop', ca: cert.cert }, message);
    const r = received[0];
    assert.deepEqual(r.commands.slice(0, 3), ['EHLO lol-tippspiel', 'STARTTLS', 'EHLO lol-tippspiel']);
    assert.equal(r.auth, 'tipp@gmail.com:abcdefghijklmnop');
    assert.ok(r.tlsAtAuth, 'Passwort darf nur verschlüsselt gesendet werden');
  } finally {
    server.close();
  }
});

test('SMTP: ohne Verschlüsselung wird kein Passwort gesendet; falsches Zertifikat wird abgelehnt', async (t) => {
  const plain = await fakeServer({});
  try {
    await assert.rejects(
      sendSmtp({ host: '127.0.0.1', port: plain.port, user: 'tipp@gmail.com', password: 'abcdefghijklmnop' }, message),
      /keine Verschlüsselung/,
    );
    assert.equal(plain.received[0].auth, null);
  } finally {
    plain.server.close();
  }
  if (!cert) return t.skip('openssl nicht vorhanden');
  const tls = await fakeServer({ implicitTls: true });
  try {
    // Ohne unser Test-Zertifikat als vertrauenswürdig muss die Verbindung scheitern.
    await assert.rejects(sendSmtp({ host: 'localhost', port: tls.port, implicitTls: true, user: 'u@x.de', password: 'p' }, message), /fehlgeschlagen/);
  } finally {
    tls.server.close();
  }
});

test('SMTP: ungültige Adressen und nicht erreichbarer Server', async () => {
  await assert.rejects(sendSmtp({ host: 'localhost', port: 1, user: 'u', password: 'p' }, { ...message, to: 'a@b.de>\r\nRCPT TO:<x@y.de' }), /Ungültige/);
  await assert.rejects(sendSmtp({ host: '127.0.0.1', port: 1, user: 'u', password: 'p', timeoutMs: 3000 }, message), /fehlgeschlagen|antwortet nicht/);
});

test('E-Mail-Einstellungen: Gmail ist Standard für MAIL_MODE=smtp', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/x', MAIL_MODE: 'smtp', SMTP_USER: ' tipp@gmail.com ', SMTP_PASSWORD: 'x' });
  assert.deepEqual(config.mail.smtp, { host: 'smtp.gmail.com', port: 465, user: 'tipp@gmail.com', password: 'x' });
  assert.equal(config.mail.from, 'tipp@gmail.com');
  assert.throws(() => createMailer(loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/x', MAIL_MODE: 'smtp' })), /SMTP_USER/);
});
