// Anmelden, Abmelden, Willkommen (Name wählen), Konto.

import type { Ctx } from '../app.ts';
import {
  consumeLoginToken,
  createSession,
  destroySession,
  findOrCreateUser,
  LOGIN_TOKEN_MINUTES,
  normalizeEmail,
  requestLoginLink,
  safeNext,
  sessionCookieName,
  SESSION_DAYS,
} from '../auth.ts';
import { html, nothing } from '../html.ts';
import { htmlResponse, redirect, type Res, type Router, serializeCookie, withCookie } from '../http.ts';
import { csrfField, layout } from '../views/layout.ts';
import { cleanName, loginRedirect } from './common.ts';

function loginForm(ctx: Ctx, o: { email?: string; next: string; error?: string }): Res {
  const body = html`<section class="panel narrow">
  <h1>Anmelden</h1>
  <p>Gib deine E-Mail-Adresse ein. Du bekommst einen Link, mit dem du dich anmeldest – ganz ohne Passwort. Neu hier? Dann wird dein Konto dabei automatisch angelegt.</p>
  <form method="post" action="/anmelden" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="weiter" value="${o.next}">
    <label class="field">
      <span>E-Mail-Adresse</span>
      <input type="email" name="email" value="${o.email ?? ''}" required autocomplete="email" inputmode="email" maxlength="254" autofocus>
    </label>
    <button type="submit" class="btn btn-primary">Anmelde-Link schicken</button>
  </form>
</section>`;
  return htmlResponse(layout(ctx, { title: 'Anmelden', body, error: o.error }), o.error ? 400 : 200);
}

export function registerAuthRoutes(router: Router<Ctx>) {
  router.get('/anmelden', async (ctx) => {
    const next = safeNext(ctx.query.get('weiter'));
    if (ctx.user) return redirect(next);
    return loginForm(ctx, { next });
  });

  router.post('/anmelden', async (ctx) => {
    const next = safeNext(ctx.form.get('weiter'));
    const raw = ctx.form.get('email') ?? '';
    const email = normalizeEmail(raw);
    if (!email) return loginForm(ctx, { email: raw, next, error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });

    const result = await requestLoginLink(ctx.deps, email, next, ctx.ip);
    if (result === 'rate-limited') {
      return loginForm(ctx, { email, next, error: 'Es wurden gerade zu viele Links angefordert. Bitte warte eine Stunde und versuche es dann noch einmal.' });
    }
    const devHint = ctx.deps.config.mail.mode === 'console';
    const body = html`<section class="panel narrow">
  <h1>Schau in dein Postfach</h1>
  <p>Wir haben einen Anmelde-Link an <strong>${email}</strong> geschickt. Er gilt ${LOGIN_TOKEN_MINUTES} Minuten.</p>
  <p class="muted">Keine E-Mail da? Schau im Spam-Ordner nach oder <a href="/anmelden${next !== '/' ? `?weiter=${encodeURIComponent(next)}` : ''}">fordere einen neuen Link an</a>.</p>
  ${devHint ? html`<p class="notice notice-warn">Testbetrieb: Es wird keine echte E-Mail verschickt. Der Link steht im Protokoll des Servers.</p>` : nothing}
</section>`;
    return htmlResponse(layout(ctx, { title: 'Link verschickt', body }));
  });

  router.get('/anmelden/bestaetigen', async (ctx) => {
    const token = ctx.query.get('token') ?? '';
    const next = safeNext(ctx.query.get('weiter'));
    const body = html`<section class="panel narrow">
  <h1>Anmelden</h1>
  <p>Tippe auf den Knopf, um dich anzumelden.</p>
  <form method="post" action="/anmelden/bestaetigen" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="weiter" value="${next}">
    <button type="submit" class="btn btn-primary">Jetzt anmelden</button>
  </form>
</section>`;
    return htmlResponse(layout(ctx, { title: 'Anmelden', body }));
  });

  router.post('/anmelden/bestaetigen', async (ctx) => {
    const { db, config } = ctx.deps;
    const next = safeNext(ctx.form.get('weiter'));
    const email = await consumeLoginToken(db, ctx.form.get('token') ?? '');
    if (!email) {
      const body = html`<section class="panel narrow">
  <h1>Link nicht mehr gültig</h1>
  <p>Dieser Anmelde-Link ist abgelaufen oder wurde schon benutzt. Jeder Link funktioniert nur einmal und ${LOGIN_TOKEN_MINUTES} Minuten lang.</p>
  <p><a class="btn btn-primary" href="/anmelden${next !== '/' ? `?weiter=${encodeURIComponent(next)}` : ''}">Neuen Link anfordern</a></p>
</section>`;
      return htmlResponse(layout(ctx, { title: 'Link nicht mehr gültig', body }), 400);
    }
    if (ctx.sessionId) await destroySession(db, ctx.sessionId);
    const { user, created } = await findOrCreateUser(db, email);
    const token = await createSession(db, user.id);
    const target = created ? `/willkommen?weiter=${encodeURIComponent(next)}` : next;
    return withCookie(
      redirect(target),
      serializeCookie(sessionCookieName(config), token, { secure: config.secureCookies, maxAgeSeconds: SESSION_DAYS * 86_400 }),
    );
  });

  router.get('/willkommen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    return welcomePage(ctx, ctx.user.display_name, safeNext(ctx.query.get('weiter')));
  });

  router.post('/willkommen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const next = safeNext(ctx.form.get('weiter'));
    const name = cleanName(ctx.form.get('display_name'));
    if (!name) return welcomePage(ctx, ctx.form.get('display_name') ?? '', next, 'Bitte wähle einen Namen mit 1 bis 40 Zeichen.');
    await ctx.deps.db.run('update users set display_name = $2 where id = $1', [ctx.user.id, name]);
    return redirect(next);
  });

  router.post('/abmelden', async (ctx) => {
    if (ctx.sessionId) await destroySession(ctx.deps.db, ctx.sessionId);
    const { config } = ctx.deps;
    return withCookie(
      redirect('/?hinweis=abgemeldet'),
      serializeCookie(sessionCookieName(config), '', { secure: config.secureCookies, maxAgeSeconds: 0 }),
    );
  });

  router.get('/konto', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    return accountPage(ctx);
  });

  router.post('/konto/name', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const name = cleanName(ctx.form.get('display_name'));
    if (!name) return accountPage(ctx, 'Bitte wähle einen Namen mit 1 bis 40 Zeichen.');
    await ctx.deps.db.run('update users set display_name = $2 where id = $1', [ctx.user.id, name]);
    return redirect('/konto?hinweis=name-gespeichert');
  });

  router.post('/konto/loeschen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    if (ctx.form.get('bestaetigt') !== 'ja') return accountPage(ctx, 'Bitte bestätige das Löschen mit dem Häkchen.');
    const user = ctx.user;
    await ctx.deps.db.tx(async (q) => {
      // Eigene Tipprunden an das nächste Mitglied übergeben (zuerst Admins); leere Runden löschen.
      const owned = await q.query<{ id: string }>(
        `select l.id from leagues l join league_members m on m.league_id = l.id and m.user_id = $1 and m.role = 'owner'`,
        [user.id],
      );
      for (const { id } of owned) {
        const heir = await q.one<{ user_id: string }>(
          `select user_id from league_members where league_id = $1 and user_id <> $2
            order by (role = 'admin') desc, joined_at limit 1`,
          [id, user.id],
        );
        if (heir) {
          await q.run(`update league_members set role = 'owner' where league_id = $1 and user_id = $2`, [id, heir.user_id]);
          await q.run('update leagues set owner_id = $2 where id = $1', [id, heir.user_id]);
        } else {
          await q.run('delete from leagues where id = $1', [id]);
        }
      }
      await q.run('delete from login_tokens where email = $1', [user.email]);
      await q.run('delete from users where id = $1', [user.id]);
    });
    const { config } = ctx.deps;
    return withCookie(
      redirect('/?hinweis=konto-geloescht'),
      serializeCookie(sessionCookieName(config), '', { secure: config.secureCookies, maxAgeSeconds: 0 }),
    );
  });
}

function welcomePage(ctx: Ctx, name: string, next: string, error?: string): Res {
  const body = html`<section class="panel narrow">
  <h1>Willkommen!</h1>
  <p>Unter welchem Namen sollen dich die anderen in der Rangliste sehen?</p>
  <form method="post" action="/willkommen" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="weiter" value="${next}">
    <label class="field">
      <span>Dein Name</span>
      <input type="text" name="display_name" value="${name}" required maxlength="40" autocomplete="nickname" autofocus>
    </label>
    <button type="submit" class="btn btn-primary">Weiter</button>
  </form>
</section>`;
  return htmlResponse(layout(ctx, { title: 'Willkommen', body, error }), error ? 400 : 200);
}

function accountPage(ctx: Ctx, error?: string): Res {
  const user = ctx.user!;
  const body = html`<section class="panel narrow">
  <h1>Dein Konto</h1>
  <p class="muted">Angemeldet als ${user.email}</p>
  <form method="post" action="/konto/name" class="stack">
    ${csrfField(ctx)}
    <label class="field">
      <span>Name in der Rangliste</span>
      <input type="text" name="display_name" value="${user.display_name}" required maxlength="40" autocomplete="nickname">
    </label>
    <button type="submit" class="btn">Name speichern</button>
  </form>
  <form method="post" action="/abmelden" class="stack">
    ${csrfField(ctx)}
    <button type="submit" class="btn">Abmelden</button>
  </form>
</section>
<section class="panel narrow danger-zone">
  <h2>Konto löschen</h2>
  <p>Löscht dein Konto mit allen Tipps und Antworten. Das lässt sich nicht rückgängig machen. Tipprunden, die du leitest, gehen an ein anderes Mitglied über.</p>
  <form method="post" action="/konto/loeschen" class="stack">
    ${csrfField(ctx)}
    <label class="check"><input type="checkbox" name="bestaetigt" value="ja" required> Ja, mein Konto endgültig löschen</label>
    <button type="submit" class="btn btn-danger">Konto löschen</button>
  </form>
</section>`;
  return htmlResponse(layout(ctx, { title: 'Dein Konto', body, error }), error ? 400 : 200);
}
