// Profilbilder: Der Browser verkleinert das Bild auf 128x128 (JPEG) und schickt es als data:-URL; hier wird es geprüft und gespeichert.

import type { Ctx } from '../app.ts';
import { HttpError, redirect, type Res, type Router } from '../http.ts';
import { isUuid, loginRedirect } from './common.ts';

const MAX_BYTES = 50_000;

/** Prüft eine data:-URL und gibt den Base64-Teil zurück (nur JPEG, nicht zu groß). */
export function parseAvatar(value: string): string | null {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) return null;
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length < 100 || bytes.length > MAX_BYTES) return null;
  // JPEG beginnt mit FF D8 FF und endet mit FF D9
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  return m[1];
}

export function registerAvatarRoutes(router: Router<Ctx>) {
  router.get('/avatar/:id', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Diese Seite gibt es nicht.');
    const row = await ctx.deps.db.one<{ avatar_b64: string | null }>('select avatar_b64 from users where id = $1', [ctx.params.id]);
    if (!row?.avatar_b64) throw new HttpError(404, 'Diese Seite gibt es nicht.');
    const res: Res = {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        // Die Adresse enthält ?v=Zeitstempel – ändert sich das Bild, ändert sich die Adresse
        'cache-control': 'private, max-age=31536000, immutable',
      },
      body: Buffer.from(row.avatar_b64, 'base64'),
    };
    return res;
  });

  router.post('/konto/avatar', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const b64 = parseAvatar(ctx.form.get('avatar') ?? '');
    if (!b64) return redirect('/konto?hinweis=avatar-fehler');
    await ctx.deps.db.run('update users set avatar_b64 = $2, avatar_updated_at = now() where id = $1', [ctx.user.id, b64]);
    return redirect('/konto?hinweis=avatar-gespeichert');
  });

  router.post('/konto/avatar/loeschen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    await ctx.deps.db.run('update users set avatar_b64 = null, avatar_updated_at = null where id = $1', [ctx.user.id]);
    return redirect('/konto?hinweis=avatar-geloescht');
  });
}
