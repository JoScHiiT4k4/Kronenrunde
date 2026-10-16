// GitHub-Webhook: GitHub meldet, wenn der Zweig "stabil" (= geprüfte Version) einen neuen Stand hat. Die App legt dann die
// Update-Anfrage ab (wie der Knopf im Administrator-Bereich), der Pi installiert sofort – ohne Abfrage alle paar Minuten.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Config } from './config.ts';
import { readRaw, type Res } from './http.ts';

const text = (status: number, body: string): Res => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body });

/** Stimmt die Signatur ("sha256=…") von GitHub mit dem gemeinsamen Geheimnis überein? */
export function signatureValid(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleGithubHook(req: IncomingMessage, config: Config, now: Date): Promise<Res> {
  if (!config.webhookSecret) return text(404, 'Diese Seite gibt es nicht.');
  const body = await readRaw(req);
  const sig = req.headers['x-hub-signature-256'];
  if (!signatureValid(config.webhookSecret, body, typeof sig === 'string' ? sig : undefined)) return text(401, 'Signatur stimmt nicht.');
  const event = req.headers['x-github-event'];
  if (event === 'ping') return text(200, 'pong');
  if (event !== 'push') return text(200, 'ignoriert');
  let ref = '';
  try {
    ref = String((JSON.parse(body.toString('utf8')) as { ref?: unknown }).ref ?? '');
  } catch {
    return text(400, 'Kein gültiges JSON.');
  }
  // Nur der Zweig "stabil" zählt: der wird erst nach grünen Prüfungen nachgezogen
  if (ref !== 'refs/heads/stabil') return text(200, 'ignoriert');
  try {
    writeFileSync(config.updateRequestFile, `${now.toISOString()}\n`);
  } catch {
    return text(500, 'Update-Anfrage konnte nicht abgelegt werden.');
  }
  return text(202, 'Update angefordert');
}
