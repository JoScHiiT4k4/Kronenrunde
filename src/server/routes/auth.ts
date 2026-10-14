// Anmelden (E-Mail + Passwort), Konto erstellen, Passwort vergessen/festlegen, Abmelden, Willkommen, Konto.

import type { Ctx } from '../app.ts';
import {
  consumeLoginToken,
  createSession,
  destroySession,
  findOrCreateUser,
  hashPassword,
  LOGIN_TOKEN_MINUTES,
  loginWithPassword,
  normalizeEmail,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblem,
  registrationAllowed,
  requestPasswordLink,
  safeNext,
  sessionCookieName,
  SESSION_DAYS,
  setPassword,
  hashToken,
  verifyPassword,
} from '../auth.ts';
import { PgError } from '../db/index.ts';
import { type Html, html, nothing } from '../html.ts';
import { htmlResponse, redirect, type Res, type Router, serializeCookie, withCookie } from '../http.ts';
import { csrfField, layout } from '../views/layout.ts';
import { cleanName, loginRedirect } from './common.ts';

const withNext = (path: string, next: string) => (next !== '/' ? `${path}?weiter=${encodeURIComponent(next)}` : path);

const passwordInput = (name: string, autocomplete: 'current-password' | 'new-password', label: string, hint?: string) =>
  html`<label class="field">
      <span>${label}${hint ? html` <small class="muted">${hint}</small>` : nothing}</span>
      <input type="password" name="${name}" required autocomplete="${autocomplete}"${autocomplete === 'new-password' ? html` minlength="${PASSWORD_MIN}"` : nothing} maxlength="${PASSWORD_MAX}">
    </label>`;

function page(ctx: Ctx, title: string, body: Html, error?: string): Res {
  return htmlResponse(layout(ctx, { title, body, error }), error ? 400 : 200);
}

function loginForm(ctx: Ctx, o: { email?: string; next: string; error?: string }): Res {
  return page(
    ctx,
    'Anmelden',
    html`<section class="panel narrow">
  <h1>Anmelden</h1>
  <form method="post" action="/anmelden" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="weiter" value="${o.next}">
    <label class="field">
      <span>E-Mail-Adresse</span>
      <input type="email" name="email" value="${o.email ?? ''}" required autocomplete="username" inputmode="email" maxlength="254" autofocus>
    </label>
    ${passwordInput('password', 'current-password', 'Passwort')}
    <button type="submit" class="btn btn-primary">Anmelden</button>
  </form>
  <p><a href="${withNext('/passwort-vergessen', o.next)}">Passwort vergessen?</a></p>
</section>
<section class="panel narrow">
  <h2>Neu hier?</h2>
  <p>Mit einem Konto tippst du in beliebig vielen Tipprunden mit.</p>
  <a class="btn" href="${withNext('/registrieren', o.next)}">Konto erstellen</a>
</section>`,
    o.error,
  );
}

function registerForm(ctx: Ctx, o: { email?: string; name?: string; next: string; error?: string }): Res {
  return page(
    ctx,
    'Konto erstellen',
    html`<section class="panel narrow">
  <h1>Konto erstellen</h1>
  <form method="post" action="/registrieren" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="weiter" value="${o.next}">
    <label class="field">
      <span>Dein Name <small class="muted">(so sehen dich die anderen in der Rangliste)</small></span>
      <input type="text" name="display_name" value="${o.name ?? ''}" required maxlength="40" autocomplete="nickname" autofocus>
    </label>
    <label class="field">
      <span>E-Mail-Adresse</span>
      <input type="email" name="email" value="${o.email ?? ''}" required autocomplete="username" inputmode="email" maxlength="254">
    </label>
    ${passwordInput('password', 'new-password', 'Passwort', `(mindestens ${PASSWORD_MIN} Zeichen)`)}
    <button type="submit" class="btn btn-primary">Konto erstellen</button>
  </form>
  <p class="muted">Schon ein Konto? <a href="${withNext('/anmelden', o.next)}">Anmelden</a></p>
</section>`,
    o.error,
  );
}

function forgotForm(ctx: Ctx, o: { email?: string; next: string; error?: string }): Res {
  return page(
    ctx,
    'Passwort vergessen',
    html`<section class="panel narrow">
  <h1>Passwort vergessen</h1>
  <p>Gib deine E-Mail-Adresse ein. Du bekommst einen Link, mit dem du ein neues Passwort festlegst.</p>
  <form method="post" action="/passwort-vergessen" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="weiter" value="${o.next}">
    <label class="field">
      <span>E-Mail-Adresse</span>
      <input type="email" name="email" value="${o.email ?? ''}" required autocomplete="username" inputmode="email" maxlength="254" autofocus>
    </label>
    <button type="submit" class="btn btn-primary">Link schicken</button>
  </form>
  <p class="muted"><a href="${withNext('/anmelden', o.next)}">Zurück zum Anmelden</a></p>
</section>`,
    o.error,
  );
}

function linkSentPage(ctx: Ctx, email: string, next: string, intro: string): Res {
  const devHint = ctx.deps.config.mail.mode === 'console';
  return page(
    ctx,
    'Schau in dein Postfach',
    html`<section class="panel narrow">
  <h1>Schau in dein Postfach</h1>
  <p>${intro} Der Link an <strong>${email}</strong> gilt ${LOGIN_TOKEN_MINUTES} Minuten.</p>
  <p class="muted">Keine E-Mail da? Schau im Spam-Ordner nach oder <a href="${withNext('/passwort-vergessen', next)}">fordere einen neuen Link an</a>.</p>
  ${devHint ? html`<p class="notice notice-warn">Testbetrieb: Es wird keine echte E-Mail verschickt. Der Link steht im Protokoll des Servers.</p>` : nothing}
</section>`,
  );
}

function newPasswordForm(ctx: Ctx, o: { token: string; next: string; error?: string }): Res {
  return page(
    ctx,
    'Passwort festlegen',
    html`<section class="panel narrow">
  <h1>Passwort festlegen</h1>
  <p>Damit meldest du dich ab jetzt zusammen mit deiner E-Mail-Adresse an.</p>
  <form method="post" action="/passwort-neu" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="token" value="${o.token}">
    <input type="hidden" name="weiter" value="${o.next}">
    ${passwordInput('password', 'new-password', 'Neues Passwort', `(mindestens ${PASSWORD_MIN} Zeichen)`)}
    <button type="submit" class="btn btn-primary">Passwort speichern und anmelden</button>
  </form>
</section>`,
    o.error,
  );
}

function invalidLinkPage(ctx: Ctx, next: string): Res {
  return htmlResponse(
    layout(ctx, {
      title: 'Link nicht mehr gültig',
      body: html`<section class="panel narrow">
  <h1>Link nicht mehr gültig</h1>
  <p>Dieser Link ist abgelaufen oder wurde schon benutzt. Jeder Link funktioniert nur einmal und ${LOGIN_TOKEN_MINUTES} Minuten lang.</p>
  <p><a class="btn btn-primary" href="${withNext('/passwort-vergessen', next)}">Neuen Link anfordern</a></p>
</section>`,
    }),
    400,
  );
}

/** Neue Sitzung starten (die alte endet) und weiterleiten. */
async function signIn(ctx: Ctx, userId: string, target: string): Promise<Res> {
  const { db, config } = ctx.deps;
  if (ctx.sessionId) await destroySession(db, ctx.sessionId);
  const token = await createSession(db, userId);
  return withCookie(
    redirect(target),
    serializeCookie(sessionCookieName(config), token, { secure: config.secureCookies, maxAgeSeconds: SESSION_DAYS * 86_400 }),
  );
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
    const password = ctx.form.get('password') ?? '';
    if (!email) return loginForm(ctx, { email: raw, next, error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
    if (!password) return loginForm(ctx, { email, next, error: 'Bitte gib dein Passwort ein.' });

    const result = await loginWithPassword(ctx.deps.db, email, password.slice(0, PASSWORD_MAX), ctx.ip);
    if (result.ok) return signIn(ctx, result.user.id, next);
    if (result.reason === 'blocked') {
      return loginForm(ctx, { email, next, error: 'Zu viele Fehlversuche. Warte 15 Minuten oder nutze „Passwort vergessen“.' });
    }
    if (result.reason === 'no-password') {
      // Konto aus der Zeit der Anmelde-Links: Passwort jetzt per Mail-Link festlegen
      const sent = await requestPasswordLink(ctx.deps, email, next, ctx.ip);
      if (sent === 'rate-limited') {
        return loginForm(ctx, { email, next, error: 'Es wurden gerade zu viele Links angefordert. Bitte warte eine Stunde.' });
      }
      return linkSentPage(ctx, email, next, 'Für dein Konto gibt es noch kein Passwort. Mit dem Link, den wir dir gerade geschickt haben, legst du es fest.');
    }
    return loginForm(ctx, { email, next, error: 'E-Mail-Adresse oder Passwort stimmt nicht.' });
  });

  // Alte Anmelde-Links (vor der Umstellung auf Passwörter) führen zum Anmelden
  router.get('/anmelden/bestaetigen', async () => redirect('/anmelden'));

  router.get('/registrieren', async (ctx) => {
    const next = safeNext(ctx.query.get('weiter'));
    if (ctx.user) return redirect(next);
    return registerForm(ctx, { next });
  });

  router.post('/registrieren', async (ctx) => {
    const next = safeNext(ctx.form.get('weiter'));
    const rawEmail = ctx.form.get('email') ?? '';
    const rawName = ctx.form.get('display_name') ?? '';
    const email = normalizeEmail(rawEmail);
    const name = cleanName(rawName);
    const password = ctx.form.get('password') ?? '';
    const back = (error: string) => registerForm(ctx, { email: rawEmail, name: rawName, next, error });
    if (!name) return back('Bitte wähle einen Namen mit 1 bis 40 Zeichen.');
    if (!email) return back('Bitte gib eine gültige E-Mail-Adresse ein.');
    const problem = passwordProblem(password, email);
    if (problem) return back(problem);
    if (!registrationAllowed(ctx.ip)) return back('Von hier wurden gerade sehr viele Konten erstellt. Bitte versuche es später noch einmal.');

    const { db } = ctx.deps;
    if (await db.one('select 1 from users where email = $1', [email])) {
      return back('Für diese E-Mail-Adresse gibt es schon ein Konto. Melde dich an – oder nutze „Passwort vergessen“.');
    }
    let user: { id: string } | null;
    try {
      user = await db.one<{ id: string }>(
        `insert into users (email, display_name, password_hash, password_changed_at) values ($1, $2, $3, now()) returning id`,
        [email, name, await hashPassword(password)],
      );
    } catch (e) {
      if (e instanceof PgError && e.code === '23505') return back('Für diese E-Mail-Adresse gibt es schon ein Konto.');
      throw e;
    }
    return signIn(ctx, user!.id, next);
  });

  router.get('/passwort-vergessen', async (ctx) => forgotForm(ctx, { next: safeNext(ctx.query.get('weiter')) }));

  router.post('/passwort-vergessen', async (ctx) => {
    const next = safeNext(ctx.form.get('weiter'));
    const raw = ctx.form.get('email') ?? '';
    const email = normalizeEmail(raw);
    if (!email) return forgotForm(ctx, { email: raw, next, error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
    const result = await requestPasswordLink(ctx.deps, email, next, ctx.ip);
    if (result === 'rate-limited') {
      return forgotForm(ctx, { email, next, error: 'Es wurden gerade zu viele Links angefordert. Bitte warte eine Stunde und versuche es dann noch einmal.' });
    }
    return linkSentPage(ctx, email, next, 'Falls es ein Konto mit dieser Adresse gibt, ist jetzt ein Link zum Festlegen eines neuen Passworts unterwegs.');
  });

  router.get('/passwort-neu', async (ctx) => {
    const token = ctx.query.get('token') ?? '';
    const next = safeNext(ctx.query.get('weiter'));
    // Nur nachsehen, nicht einlösen – Link-Vorschauen von Mail-Programmen sollen ihn nicht verbrauchen
    const valid =
      /^[A-Za-z0-9_-]{20,100}$/.test(token) &&
      !!(await ctx.deps.db.one(`select 1 from login_tokens where token_hash = $1 and used_at is null and expires_at > now()`, [hashToken(token)]));
    if (!valid) return invalidLinkPage(ctx, next);
    return newPasswordForm(ctx, { token, next });
  });

  router.post('/passwort-neu', async (ctx) => {
    const { db } = ctx.deps;
    const token = ctx.form.get('token') ?? '';
    const next = safeNext(ctx.form.get('weiter'));
    const password = ctx.form.get('password') ?? '';
    const problem = passwordProblem(password);
    if (problem) return newPasswordForm(ctx, { token, next, error: problem });
    const email = await consumeLoginToken(db, token);
    if (!email) return invalidLinkPage(ctx, next);
    const prob2 = passwordProblem(password, email);
    if (prob2) return newPasswordForm(ctx, { token: '', next, error: `${prob2} Bitte fordere einen neuen Link an.` });
    const { user, created } = await findOrCreateUser(db, email);
    await setPassword(db, user.id, password);
    return signIn(ctx, user.id, created ? `/willkommen?weiter=${encodeURIComponent(next)}` : next);
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

  router.post('/konto/passwort', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { db } = ctx.deps;
    const row = await db.one<{ password_hash: string | null }>('select password_hash from users where id = $1', [ctx.user.id]);
    if (row?.password_hash && !(await verifyPassword(ctx.form.get('current') ?? '', row.password_hash))) {
      return accountPage(ctx, 'Das bisherige Passwort stimmt nicht.');
    }
    const password = ctx.form.get('password') ?? '';
    const problem = passwordProblem(password, ctx.user.email);
    if (problem) return accountPage(ctx, problem);
    await setPassword(db, ctx.user.id, password);
    // Alle Sitzungen sind beendet (auch auf anderen Geräten) – hier gleich wieder anmelden
    return signIn(ctx, ctx.user.id, '/konto?hinweis=passwort-gespeichert');
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
      await q.run('delete from login_failures where email = $1', [user.email]);
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

async function accountPage(ctx: Ctx, error?: string): Promise<Res> {
  const user = ctx.user!;
  const hasPassword = !!(await ctx.deps.db.one<{ x: number }>('select 1 as x from users where id = $1 and password_hash is not null', [user.id]));
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
<section class="panel narrow">
  <h2>${hasPassword ? 'Passwort ändern' : 'Passwort festlegen'}</h2>
  <form method="post" action="/konto/passwort" class="stack">
    ${csrfField(ctx)}
    <input type="email" name="email" value="${user.email}" autocomplete="username" hidden>
    ${hasPassword ? passwordInput('current', 'current-password', 'Bisheriges Passwort') : nothing}
    ${passwordInput('password', 'new-password', 'Neues Passwort', `(mindestens ${PASSWORD_MIN} Zeichen)`)}
    <button type="submit" class="btn">Passwort speichern</button>
  </form>
  <p class="muted">Danach bist du auf allen anderen Geräten abgemeldet.</p>
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
