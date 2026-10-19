// Anmelden (E-Mail + Passwort), Konto erstellen, Passwort vergessen/festlegen, Abmelden, Willkommen, Konto.

import { encodeQr } from '../../domain/qrcode.ts';
import type { Ctx } from '../app.ts';
import {
  calendarToken,
  consumeLoginToken,
  createSession,
  destroySession,
  findOrCreateUser,
  hashPassword,
  loginBlocked,
  LOGIN_TOKEN_MINUTES,
  loginWithPassword,
  newToken,
  normalizeEmail,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblem,
  recordLoginFailure,
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
import { formatDateTime } from '../format.ts';
import { type Html, html, nothing } from '../html.ts';
import { htmlResponse, redirect, type Res, type Router, serializeCookie, withCookie } from '../http.ts';
import { avatar, csrfField, layout, postButton, tabMenu } from '../views/layout.ts';
import { qrSvg } from '../views/qr-svg.ts';
import { leadLabel } from '../benachrichtigung.ts';
import { generateBackupCodes, generateTotpSecret, hashBackupCode, totpProvisioningUri, totpValid } from '../totp.ts';
import { loadVapid, validEndpoint } from '../webpush.ts';
import { cleanFirstName, cleanName, FIRST_NAME_HELP, FIRST_NAME_PATTERN, intField, loginRedirect } from './common.ts';

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

const firstNameField = (value: string) => html`<label class="field">
      <span>Vorname <small class="muted">(nur Buchstaben, ggf. mit Bindestrich; steht in deinem Profil)</small></span>
      <input type="text" name="first_name" value="${value}" required maxlength="40" autocomplete="given-name" pattern="${FIRST_NAME_PATTERN}" title="Nur Buchstaben und Bindestriche, keine Leerzeichen oder Zahlen">
    </label>`;

function registerForm(ctx: Ctx, o: { email?: string; name?: string; first?: string; next: string; error?: string }): Res {
  return page(
    ctx,
    'Konto erstellen',
    html`<section class="panel narrow">
  <h1>Konto erstellen</h1>
  <form method="post" action="/registrieren" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="weiter" value="${o.next}">
    <label class="field">
      <span>Anzeigename <small class="muted">(so sehen dich die anderen in der Rangliste)</small></span>
      <input type="text" name="display_name" value="${o.name ?? ''}" required maxlength="40" autocomplete="nickname" autofocus>
    </label>
    ${firstNameField(o.first ?? '')}
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

const TOTP_PENDING_MINUTES = 10;

function twoFactorForm(ctx: Ctx, o: { token: string; error?: string }): Res {
  return page(
    ctx,
    'Code aus der Authenticator-App',
    html`<section class="panel narrow">
  <h1>Code aus der Authenticator-App</h1>
  <p>Gib den 6-stelligen Code aus deiner Authenticator-App ein, oder einen deiner Backup-Codes.</p>
  <form method="post" action="/anmelden/2fa" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="token" value="${o.token}">
    <label class="field">
      <span>Code</span>
      <input type="text" name="code" required maxlength="20" inputmode="numeric" autocomplete="one-time-code" autofocus>
    </label>
    <button type="submit" class="btn btn-primary">Anmelden</button>
  </form>
</section>`,
    o.error,
  );
}

function invalidTwoFactorPage(ctx: Ctx): Res {
  return htmlResponse(
    layout(ctx, {
      title: 'Nicht mehr gültig',
      body: html`<section class="panel narrow">
  <h1>Nicht mehr gültig</h1>
  <p>Dieser Schritt ist abgelaufen oder wurde schon benutzt (er gilt nur ${TOTP_PENDING_MINUTES} Minuten). Bitte melde dich erneut an.</p>
  <p><a class="btn btn-primary" href="/anmelden">Zum Anmelden</a></p>
</section>`,
    }),
    400,
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
    if (result.ok) {
      const { db } = ctx.deps;
      const totpRow = await db.one<{ totp_enabled_at: Date | null }>('select totp_enabled_at from users where id = $1', [result.user.id]);
      if (totpRow?.totp_enabled_at) {
        const token = newToken();
        await db.run(
          `insert into totp_pending_logins (token_hash, user_id, next, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4))`,
          [hashToken(token), result.user.id, next, TOTP_PENDING_MINUTES],
        );
        await db.run(`delete from totp_pending_logins where expires_at < now()`);
        return redirect(`/anmelden/2fa?token=${token}`);
      }
      return signIn(ctx, result.user.id, next);
    }
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

  router.get('/anmelden/2fa', async (ctx) => {
    const token = ctx.query.get('token') ?? '';
    const pending = await ctx.deps.db.one(`select 1 from totp_pending_logins where token_hash = $1 and expires_at > now()`, [hashToken(token)]);
    if (!pending) return invalidTwoFactorPage(ctx);
    return twoFactorForm(ctx, { token });
  });

  router.post('/anmelden/2fa', async (ctx) => {
    const { db } = ctx.deps;
    const token = ctx.form.get('token') ?? '';
    const code = (ctx.form.get('code') ?? '').trim();
    const pending = await db.one<{ user_id: string; next: string }>(
      `select user_id, next from totp_pending_logins where token_hash = $1 and expires_at > now()`,
      [hashToken(token)],
    );
    if (!pending) return invalidTwoFactorPage(ctx);
    const rateKey = `2fa:${pending.user_id}`;
    if (await loginBlocked(db, rateKey, ctx.ip)) {
      return twoFactorForm(ctx, { token, error: 'Zu viele Fehlversuche. Warte 15 Minuten und versuche es dann erneut.' });
    }
    const user = await db.one<{ totp_secret: string | null }>('select totp_secret from users where id = $1', [pending.user_id]);
    const viaTotp = user?.totp_secret ? totpValid(user.totp_secret, code) : false;
    const viaBackup = !viaTotp
      ? await db.one(
          `update totp_backup_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null returning 1`,
          [pending.user_id, hashBackupCode(code)],
        )
      : null;
    if (!viaTotp && !viaBackup) {
      await recordLoginFailure(db, rateKey, ctx.ip);
      return twoFactorForm(ctx, { token, error: 'Der Code stimmt nicht.' });
    }
    await db.run('delete from totp_pending_logins where token_hash = $1', [hashToken(token)]);
    return signIn(ctx, pending.user_id, safeNext(pending.next));
  });

  router.get('/registrieren', async (ctx) => {
    const next = safeNext(ctx.query.get('weiter'));
    if (ctx.user) return redirect(next);
    return registerForm(ctx, { next });
  });

  router.post('/registrieren', async (ctx) => {
    const next = safeNext(ctx.form.get('weiter'));
    const rawEmail = ctx.form.get('email') ?? '';
    const rawName = ctx.form.get('display_name') ?? '';
    const rawFirst = ctx.form.get('first_name') ?? '';
    const email = normalizeEmail(rawEmail);
    const name = cleanName(rawName);
    const first = cleanFirstName(rawFirst);
    const password = ctx.form.get('password') ?? '';
    const back = (error: string) => registerForm(ctx, { email: rawEmail, name: rawName, first: rawFirst, next, error });
    if (!name) return back('Bitte wähle einen Anzeigenamen mit 1 bis 40 Zeichen.');
    if (!first) return back(FIRST_NAME_HELP);
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
        `insert into users (email, display_name, first_name, password_hash, password_changed_at) values ($1, $2, $3, $4, now()) returning id`,
        [email, name, first, await hashPassword(password)],
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
    const first = cleanFirstName(ctx.form.get('first_name'));
    const raw = ctx.form.get('first_name') ?? '';
    if (!name) return welcomePage(ctx, ctx.form.get('display_name') ?? '', next, 'Bitte wähle einen Anzeigenamen mit 1 bis 40 Zeichen.', raw);
    if (!first) return welcomePage(ctx, name, next, FIRST_NAME_HELP, raw);
    await ctx.deps.db.run('update users set display_name = $2, first_name = $3 where id = $1', [ctx.user.id, name, first]);
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

  // Namen sind nach der Registrierung gesperrt: nur der erste Vorname (bei älteren Konten) wird direkt gespeichert, alles andere ist eine Anfrage an den Spielleiter
  router.post('/konto/name', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { db } = ctx.deps;
    const name = cleanName(ctx.form.get('display_name'));
    const first = cleanFirstName(ctx.form.get('first_name'));
    if (!name) return accountPage(ctx, 'Bitte wähle einen Anzeigenamen mit 1 bis 40 Zeichen.', 'profil');
    if (!first) return accountPage(ctx, FIRST_NAME_HELP, 'profil');
    const current = await db.one<{ display_name: string; first_name: string | null }>('select display_name, first_name from users where id = $1', [ctx.user.id]);
    let currentFirst = current?.first_name ?? null;
    if (currentFirst === null) {
      await db.run('update users set first_name = $2 where id = $1', [ctx.user.id, first]);
      currentFirst = first;
    }
    if (name === current?.display_name && first === currentFirst) return redirect('/konto?bereich=profil&hinweis=name-gespeichert');
    await db.tx(async (q) => {
      await q.run(`delete from name_requests where user_id = $1 and status = 'pending'`, [ctx.user!.id]);
      await q.run('insert into name_requests (user_id, new_display_name, new_first_name) values ($1, $2, $3)', [ctx.user!.id, name, first]);
    });
    return redirect('/konto?bereich=profil&hinweis=aenderung-angefragt');
  });

  router.post('/konto/name/zurueckziehen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    await ctx.deps.db.run(`delete from name_requests where user_id = $1 and status = 'pending'`, [ctx.user.id]);
    return redirect('/konto?bereich=profil&hinweis=anfrage-zurueckgezogen');
  });

  router.post('/konto/benachrichtigung', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const h = intField(ctx.form.get('stunden') || '0', 0, 168);
    const m = intField(ctx.form.get('minuten') || '0', 0, 59);
    const minutes = h === null || m === null ? null : h * 60 + m;
    if (minutes === null || minutes < 5 || minutes > 10080) return accountPage(ctx, 'Bitte wähle eine Vorlaufzeit zwischen 5 Minuten und 7 Tagen.', 'benachrichtigungen');
    await ctx.deps.db.run(
      `insert into notification_prefs (user_id, email_enabled, push_enabled, lead_minutes) values ($1, $2, $3, $4)
       on conflict (user_id) do update set email_enabled = $2, push_enabled = $3, lead_minutes = $4, updated_at = now()`,
      [ctx.user.id, ctx.form.get('email') === 'ja', ctx.form.get('push') === 'ja', minutes],
    );
    return redirect('/konto?bereich=benachrichtigungen&hinweis=benachrichtigung-gespeichert');
  });

  // Dieses Gerät für Push an- oder abmelden (vom Browser-Skript aufgerufen)
  router.post('/konto/push', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const endpoint = ctx.form.get('endpoint') ?? '';
    const p256dh = ctx.form.get('p256dh') ?? '';
    const auth = ctx.form.get('auth') ?? '';
    if (!validEndpoint(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
      return { status: 400, headers: {}, body: 'ungültig' };
    }
    await ctx.deps.db.run(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = $1, p256dh = $3, auth = $4`,
      [ctx.user.id, endpoint, p256dh, auth],
    );
    await ctx.deps.db.run(
      `insert into notification_prefs (user_id, push_enabled) values ($1, true) on conflict (user_id) do update set push_enabled = true, updated_at = now()`,
      [ctx.user.id],
    );
    return { status: 204, headers: {}, body: '' };
  });

  router.post('/konto/chat', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    await ctx.deps.db.run(
      `insert into notification_prefs (user_id, chat_push, chat_filter) values ($1, $2, $3)
       on conflict (user_id) do update set chat_push = $2, chat_filter = $3, updated_at = now()`,
      [ctx.user.id, ctx.form.get('chat') === 'an', ctx.form.get('filter') !== 'aus'],
    );
    return redirect('/konto?bereich=einstellungen&hinweis=chat-gespeichert');
  });

  router.post('/konto/anzeige', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    await ctx.deps.db.run(
      `insert into notification_prefs (user_id, spoiler_protection) values ($1, $2)
       on conflict (user_id) do update set spoiler_protection = $2, updated_at = now()`,
      [ctx.user.id, ctx.form.get('spoiler') !== 'aus'],
    );
    return redirect('/konto?bereich=einstellungen&hinweis=anzeige-gespeichert');
  });

  // Chat laut/stumm (Lautsprecher im Chat); gleicht sich mit der Einstellung unter Benachrichtigungen ab
  router.post('/konto/chat-stumm', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const loud = ctx.form.get('stumm') === '0';
    await ctx.deps.db.run(
      `insert into notification_prefs (user_id, chat_push) values ($1, $2) on conflict (user_id) do update set chat_push = $2, updated_at = now()`,
      [ctx.user.id, loud],
    );
    return { status: 204, headers: {}, body: '' };
  });

  router.get('/konto/push-schluessel', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { publicKey } = await loadVapid(ctx.deps.db);
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ key: publicKey }) };
  });

  router.post('/konto/push/entfernen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    await ctx.deps.db.run('delete from push_subscriptions where user_id = $1 and endpoint = $2', [ctx.user.id, ctx.form.get('endpoint') ?? '']);
    return { status: 204, headers: {}, body: '' };
  });

  router.post('/konto/passwort', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { db } = ctx.deps;
    const row = await db.one<{ password_hash: string | null }>('select password_hash from users where id = $1', [ctx.user.id]);
    if (row?.password_hash && !(await verifyPassword(ctx.form.get('current') ?? '', row.password_hash))) {
      return accountPage(ctx, 'Das bisherige Passwort stimmt nicht.', 'konto');
    }
    const password = ctx.form.get('password') ?? '';
    if (password !== (ctx.form.get('password2') ?? '')) return accountPage(ctx, 'Die beiden neuen Passwörter sind nicht gleich.', 'sicherheit');
    const problem = passwordProblem(password, ctx.user.email);
    if (problem) return accountPage(ctx, problem, 'sicherheit');
    await setPassword(db, ctx.user.id, password);
    // Alle Sitzungen sind beendet (auch auf anderen Geräten) – hier gleich wieder anmelden
    return signIn(ctx, ctx.user.id, '/konto?bereich=konto&hinweis=passwort-gespeichert');
  });

  router.post('/konto/email', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { db, config, mailer } = ctx.deps;
    const row = await db.one<{ password_hash: string | null }>('select password_hash from users where id = $1', [ctx.user.id]);
    if (row?.password_hash && !(await verifyPassword(ctx.form.get('current') ?? '', row.password_hash))) {
      return accountPage(ctx, 'Das Passwort stimmt nicht.', 'sicherheit');
    }
    const email = normalizeEmail(ctx.form.get('email') ?? '');
    if (!email) return accountPage(ctx, 'Bitte gib eine gültige E-Mail-Adresse ein.', 'sicherheit');
    if (email === ctx.user.email.toLowerCase()) return accountPage(ctx, 'Das ist schon deine E-Mail-Adresse.', 'sicherheit');
    const recent = await db.one<{ n: number }>(`select count(*)::int as n from email_changes where user_id = $1 and created_at > now() - interval '1 hour'`, [ctx.user.id]);
    if ((recent?.n ?? 0) >= 3) return accountPage(ctx, 'Zu viele Anfragen. Bitte versuche es in einer Stunde noch einmal.', 'sicherheit');
    const taken = await db.one<{ x: number }>('select 1 as x from users where email = $1', [email]);
    // Ob die Adresse schon vergeben ist, verraten wir nicht – es wird dann einfach keine Mail verschickt
    if (!taken) {
      const token = newToken();
      await db.run(
        `insert into email_changes (token_hash, user_id, new_email, expires_at) values ($1, $2, $3, now() + interval '60 minutes')`,
        [hashToken(token), ctx.user.id, email],
      );
      const link = `${config.appUrl}/konto/email-bestaetigen?token=${token}`;
      const text = `Hallo!\n\nMit diesem Link bestätigst du deine neue E-Mail-Adresse für ${config.appName}:\n\n${link}\n\nDer Link gilt 60 Minuten. Falls du das nicht angefordert hast, ignoriere diese E-Mail einfach.`;
      const body = html`<p>Hallo!</p>
<p>Mit diesem Link bestätigst du deine neue E-Mail-Adresse für ${config.appName}:</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#c8aa6e;color:#1c1407;text-decoration:none;font-weight:bold">E-Mail-Adresse bestätigen</a></p>
<p style="color:#666">Der Link gilt 60 Minuten. Falls du das nicht angefordert hast, ignoriere diese E-Mail einfach.</p>`;
      await mailer.send({ to: email, subject: `Neue E-Mail-Adresse bestätigen – ${config.appName}`, text, html: body.value });
    }
    return redirect('/konto?bereich=konto&hinweis=email-gesendet');
  });

  router.get('/konto/email-bestaetigen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { db } = ctx.deps;
    const token = ctx.query.get('token') ?? '';
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return accountPage(ctx, 'Der Link ist ungültig oder abgelaufen.', 'sicherheit');
    const row = await db.one<{ new_email: string }>(
      `delete from email_changes where token_hash = $1 and user_id = $2 and expires_at > now() returning new_email`,
      [hashToken(token), ctx.user.id],
    );
    if (!row) return accountPage(ctx, 'Der Link ist ungültig oder abgelaufen.', 'sicherheit');
    try {
      await db.run('update users set email = $2 where id = $1', [ctx.user.id, row.new_email]);
    } catch (e) {
      if (e instanceof PgError && e.code === '23505') return accountPage(ctx, 'Diese E-Mail-Adresse ist inzwischen vergeben.', 'sicherheit');
      throw e;
    }
    return redirect('/konto?bereich=konto&hinweis=email-geaendert');
  });

  async function checkCurrentPassword(ctx: Ctx): Promise<string | null> {
    const row = await ctx.deps.db.one<{ password_hash: string | null }>('select password_hash from users where id = $1', [ctx.user!.id]);
    if (row?.password_hash && !(await verifyPassword(ctx.form.get('current') ?? '', row.password_hash))) {
      return 'Das Passwort stimmt nicht.';
    }
    return null;
  }

  router.post('/konto/2fa/einrichten', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const problem = await checkCurrentPassword(ctx);
    if (problem) return accountPage(ctx, problem, 'sicherheit');
    const secret = generateTotpSecret();
    await ctx.deps.db.run('update users set totp_secret = $2, totp_enabled_at = null where id = $1', [ctx.user.id, secret]);
    return accountPage(ctx, undefined, 'sicherheit');
  });

  router.post('/konto/2fa/abbrechen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    await ctx.deps.db.run('update users set totp_secret = null where id = $1 and totp_enabled_at is null', [ctx.user.id]);
    return redirect('/konto?bereich=konto');
  });

  router.post('/konto/2fa/bestaetigen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { db } = ctx.deps;
    const row = await db.one<{ totp_secret: string | null }>('select totp_secret from users where id = $1 and totp_enabled_at is null', [ctx.user.id]);
    if (!row?.totp_secret) return accountPage(ctx, 'Bitte starte die Einrichtung noch einmal.', 'sicherheit');
    const code = (ctx.form.get('code') ?? '').trim();
    if (!totpValid(row.totp_secret, code)) return accountPage(ctx, 'Der Code stimmt nicht. Bitte erneut versuchen.', 'sicherheit');
    const backupCodes = generateBackupCodes();
    await db.tx(async (q) => {
      await q.run('update users set totp_enabled_at = now() where id = $1', [ctx.user!.id]);
      await q.run('delete from totp_backup_codes where user_id = $1', [ctx.user!.id]);
      for (const c of backupCodes) await q.run('insert into totp_backup_codes (user_id, code_hash) values ($1, $2)', [ctx.user!.id, hashBackupCode(c)]);
    });
    return accountPage(ctx, undefined, 'sicherheit', backupCodes);
  });

  router.post('/konto/2fa/deaktivieren', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const problem = await checkCurrentPassword(ctx);
    if (problem) return accountPage(ctx, problem, 'sicherheit');
    const { db } = ctx.deps;
    await db.tx(async (q) => {
      await q.run('update users set totp_secret = null, totp_enabled_at = null where id = $1', [ctx.user!.id]);
      await q.run('delete from totp_backup_codes where user_id = $1', [ctx.user!.id]);
    });
    return redirect('/konto?bereich=konto&hinweis=2fa-deaktiviert');
  });

  router.post('/konto/2fa/backup-codes-neu', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const problem = await checkCurrentPassword(ctx);
    if (problem) return accountPage(ctx, problem, 'sicherheit');
    const { db } = ctx.deps;
    const enabled = await db.one('select 1 from users where id = $1 and totp_enabled_at is not null', [ctx.user.id]);
    if (!enabled) return accountPage(ctx, 'Zwei-Faktor-Authentifizierung ist nicht aktiv.', 'sicherheit');
    const backupCodes = generateBackupCodes();
    await db.tx(async (q) => {
      await q.run('delete from totp_backup_codes where user_id = $1', [ctx.user!.id]);
      for (const c of backupCodes) await q.run('insert into totp_backup_codes (user_id, code_hash) values ($1, $2)', [ctx.user!.id, hashBackupCode(c)]);
    });
    return accountPage(ctx, undefined, 'sicherheit', backupCodes);
  });

  router.post('/konto/loeschen', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    if (ctx.form.get('bestaetigt') !== 'ja') return accountPage(ctx, 'Bitte bestätige das Löschen mit dem Häkchen.', 'konto');
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

function welcomePage(ctx: Ctx, name: string, next: string, error?: string, first = ''): Res {
  const body = html`<section class="panel narrow">
  <h1>Willkommen!</h1>
  <p>Wie heißt du, und unter welchem Namen sollen dich die anderen in der Rangliste sehen?</p>
  <form method="post" action="/willkommen" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="weiter" value="${next}">
    <label class="field">
      <span>Anzeigename</span>
      <input type="text" name="display_name" value="${name}" required maxlength="40" autocomplete="nickname" autofocus>
    </label>
    ${firstNameField(first)}
    <button type="submit" class="btn btn-primary">Weiter</button>
  </form>
</section>`;
  return htmlResponse(layout(ctx, { title: 'Willkommen', body, error }), error ? 400 : 200);
}

// Reihenfolge: Häufiges zuerst, Verwandtes zusammen; Zugangsdaten, Abmelden und Löschen ganz hinten unter „Konto“.
// Höchstens fünf Reiter, damit sie am PC in eine Zeile passen.
const ACCOUNT_AREAS = [
  ['profil', 'Profil'],
  ['app', 'App & Kalender'],
  ['benachrichtigungen', 'Benachrichtigungen'],
  ['einstellungen', 'Einstellungen'],
  ['konto', 'Konto'],
] as const;

/** Frühere Reiter (Chat, Anzeige, E-Mail & Passwort) sind zusammengelegt – alte Links bleiben gültig. */
const ACCOUNT_ALIASES: Record<string, string> = { chat: 'einstellungen', anzeige: 'einstellungen', sicherheit: 'konto' };

async function accountPage(ctx: Ctx, error?: string, forced?: string, freshBackupCodes?: string[]): Promise<Res> {
  const user = ctx.user!;
  const { db } = ctx.deps;
  const asked = forced ?? ctx.query.get('bereich') ?? '';
  const wanted = ACCOUNT_ALIASES[asked] ?? asked;
  const area = ACCOUNT_AREAS.find(([k]) => k === wanted)?.[0] ?? 'profil';
  const tabs = tabMenu('sub-tabs', 'Bereiche', ACCOUNT_AREAS.map(([k, label]) => ({ href: `/konto?bereich=${k}`, label, current: k === area })));
  let content: Html = nothing;

  if (area === 'profil') {
    const row = await db.one<{ avatar_updated_at: Date | null; first_name: string | null }>('select avatar_updated_at, first_name from users where id = $1', [user.id]);
    const pending = await db.one<{ new_display_name: string; new_first_name: string }>(`select new_display_name, new_first_name from name_requests where user_id = $1 and status = 'pending'`, [user.id]);
    const lastDecision = await db.one<{ status: string }>(`select status from name_requests where user_id = $1 and status <> 'pending' and decided_at > now() - interval '14 days' order by decided_at desc limit 1`, [user.id]);
    content = html`<section class="panel">
  <h2>Profilbild</h2>
  <div class="avatar-edit">
    ${avatar(user.id, user.display_name, row?.avatar_updated_at ?? null, 'lg')}
    <div class="stack tight">
      <form method="post" action="/konto/avatar" class="stack tight" id="avatar-form" data-avatar-form>
        ${csrfField(ctx)}
        <input type="hidden" name="avatar" value="">
        <label class="field"><span>Neues Bild <small class="muted">(wird auf 128 × 128 Pixel verkleinert)</small></span>
          <input type="file" accept="image/*" data-avatar-file></label>
      </form>
      <div class="btn-row">
        <button type="submit" form="avatar-form" class="btn" data-avatar-submit disabled>Bild speichern</button>
        ${row?.avatar_updated_at ? html`<form method="post" action="/konto/avatar/loeschen">${csrfField(ctx)}<button type="submit" class="btn btn-quiet">Bild entfernen</button></form>` : nothing}
      </div>
    </div>
  </div>
</section>
<section class="panel">
  <h2>Namen</h2>
  ${
    row?.first_name
      ? html`<dl class="facts">
    <dt>Anzeigename</dt><dd>${user.display_name} <small class="muted">(so stehst du in der Rangliste)</small></dd>
    <dt>Vorname</dt><dd>${row.first_name} <small class="muted">(steht in deinem Profil)</small></dd>
  </dl>
  ${
    pending
      ? html`<p class="notice notice-warn">Änderung angefragt: <strong>${pending.new_display_name}</strong> (${pending.new_first_name}). Sie wird wirksam, sobald dein Spielleiter sie bestätigt.</p>
  ${postButton(ctx, '/konto/name/zurueckziehen', 'Anfrage zurückziehen', { cls: 'btn btn-quiet' })}`
      : html`${
          lastDecision?.status === 'rejected' ? html`<p class="notice notice-warn">Deine letzte Änderung wurde vom Spielleiter abgelehnt.</p>` : nothing
        }<details class="name-change">
    <summary>Änderung beantragen</summary>
    <p class="muted">Namen sind gesperrt. Eine Änderung muss dein Spielleiter erst bestätigen.</p>
    <form method="post" action="/konto/name" class="stack">
      ${csrfField(ctx)}
      <label class="field">
        <span>Neuer Anzeigename</span>
        <input type="text" name="display_name" value="${user.display_name}" required maxlength="40" autocomplete="off">
      </label>
      <label class="field">
        <span>Neuer Vorname <small class="muted">(nur Buchstaben, ggf. mit Bindestrich)</small></span>
        <input type="text" name="first_name" value="${row.first_name}" required maxlength="40" autocomplete="off" pattern="${FIRST_NAME_PATTERN}" title="Nur Buchstaben und Bindestriche, keine Leerzeichen oder Zahlen">
      </label>
      <button type="submit" class="btn">Änderung beantragen</button>
    </form>
  </details>`
  }`
      : html`<p class="muted">Dein Anzeigename ist <strong>${user.display_name}</strong>. Bitte trage jetzt deinen Vornamen ein – danach sind die Namen gesperrt.</p>
  <form method="post" action="/konto/name" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="display_name" value="${user.display_name}">
    <label class="field">
      <span>Vorname <small class="muted">(nur Buchstaben, ggf. mit Bindestrich; steht in deinem Profil)</small></span>
      <input type="text" name="first_name" value="" required maxlength="40" autocomplete="given-name" pattern="${FIRST_NAME_PATTERN}" title="Nur Buchstaben und Bindestriche, keine Leerzeichen oder Zahlen">
    </label>
    <button type="submit" class="btn">Vornamen speichern</button>
  </form>`
  }
</section>`;
  } else if (area === 'app') {
    const myLeagues = await db.query<{ slug: string; name: string }>(
      `select l.slug, l.name from league_members m join leagues l on l.id = m.league_id where m.user_id = $1 order by m.joined_at`,
      [user.id],
    );
    const calToken = myLeagues.length ? await calendarToken(db, user.id) : '';
    const calUrl = (slug: string) => `${ctx.deps.config.appUrl}/r/${slug}/kalender/${calToken}/spielplan.ics`;
    content = html`<section class="panel" data-install-section>
  <h2>Als App speichern</h2>
  <p class="muted">Leg die Kronenrunde auf den Startbildschirm deines Handys oder auf den Desktop deines PCs – dann startest du sie wie eine App.</p>
  <button type="button" class="btn btn-primary" data-install hidden>Desktop-App installieren</button>
  <p class="muted" data-install-done hidden>Du nutzt die Kronenrunde gerade schon als App.</p>
  <noscript><p class="muted">Im Browser-Menü (⋮ oder ⋯) „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.</p></noscript>
</section>
<section class="panel">
  <h2>Kalender-Abo</h2>
  ${
    myLeagues.length
      ? html`<p class="muted">Abonniere den Spielplan, um kein Spiel und keinen Tipp mehr zu verpassen.</p>
  <div class="stack">
    ${myLeagues.map(
      (l) => html`<a class="btn btn-primary" href="${calUrl(l.slug).replace(/^https?:/, 'webcal:')}">${myLeagues.length > 1 ? `${l.name}: ` : ''}Kalender abonnieren</a>`,
    )}
    <small class="muted">Öffnet die Kalender-App auf diesem Gerät.</small>
  </div>`
      : html`<p class="muted">Du bist noch in keiner Tipprunde.</p>`
  }
</section>`;
  } else if (area === 'benachrichtigungen') {
    const prefs = (await db.one<{ email_enabled: boolean; push_enabled: boolean; lead_minutes: number }>(
      'select email_enabled, push_enabled, lead_minutes from notification_prefs where user_id = $1',
      [user.id],
    )) ?? { email_enabled: false, push_enabled: false, lead_minutes: 120 };
    const devices = (await db.one<{ n: number }>('select count(*)::int as n from push_subscriptions where user_id = $1', [user.id]))?.n ?? 0;
    const vapid = await loadVapid(db);
    content = html`<section class="panel" id="benachrichtigungen">
  <h2>Benachrichtigungen</h2>
  <form method="post" action="/konto/benachrichtigung" class="stack">
    ${csrfField(ctx)}
    <p class="muted">Erinnerung, wenn für ein anstehendes Spiel noch dein Tipp fehlt.</p>
    <label class="check"><input type="checkbox" name="email" value="ja"${prefs.email_enabled ? html` checked` : nothing}> Per E-Mail an ${user.email}</label>
    <label class="check"><input type="checkbox" name="push" value="ja"${prefs.push_enabled ? html` checked` : nothing}> Als Push-Nachricht auf diesem Gerät (Handy oder PC)</label>
    <fieldset class="field lead-field">
      <legend>Wie lange vor dem Tippschluss?</legend>
      <div class="lead-row">
        <label><input type="number" name="stunden" min="0" max="168" value="${Math.floor(prefs.lead_minutes / 60)}" inputmode="numeric" aria-label="Stunden"> Std.</label>
        <label><input type="number" name="minuten" min="0" max="59" value="${prefs.lead_minutes % 60}" inputmode="numeric" aria-label="Minuten"> Min.</label>
      </div>
      <small class="muted">Aktuell: ${leadLabel(prefs.lead_minutes)} vorher, nur wenn Tipps fehlen.</small>
    </fieldset>
    <button type="submit" class="btn">Speichern</button>
  </form>
  <div class="push-box" data-push data-key="${vapid.publicKey}" hidden>
    <p class="muted" data-push-status>${devices ? `${devices} ${devices === 1 ? 'Gerät' : 'Geräte'} für Push angemeldet.` : 'Noch kein Gerät für Push angemeldet.'}</p>
    <button type="button" class="btn" data-push-on>Push auf diesem Gerät aktivieren</button>
    <button type="button" class="btn btn-quiet" data-push-off hidden>Push auf diesem Gerät abschalten</button>
    <input type="hidden" name="_csrf" value="${ctx.csrf}" data-push-csrf>
  </div>
</section>`;
  } else if (area === 'einstellungen') {
    const prefs = (await db.one<{ chat_push: boolean; chat_filter: boolean }>('select chat_push, chat_filter from notification_prefs where user_id = $1', [user.id])) ?? { chat_push: false, chat_filter: true };
    const display = await db.one<{ spoiler_protection: boolean }>('select spoiler_protection from notification_prefs where user_id = $1', [user.id]);
    const on = display?.spoiler_protection ?? true;
    content = html`<section class="panel">
  <h2>Anzeige</h2>
  <form method="post" action="/konto/anzeige" class="stack">
    ${csrfField(ctx)}
    <fieldset class="field lead-field">
      <legend>Spoilerschutz bei Ergebnissen</legend>
      <label class="check"><input type="radio" name="spoiler" value="an"${on ? html` checked` : nothing}> An: Ergebnisse sind verdeckt, bis du sie antippst <small class="muted">(Standard)</small></label>
      <label class="check"><input type="radio" name="spoiler" value="aus"${on ? nothing : html` checked`}> Aus: Ergebnisse immer sichtbar</label>
    </fieldset>
    <button type="submit" class="btn">Speichern</button>
  </form>
</section>
<section class="panel">
  <h2>Chat</h2>
  <form method="post" action="/konto/chat" class="stack">
    ${csrfField(ctx)}
    <fieldset class="field lead-field">
      <legend>Benachrichtigung bei neuen Nachrichten</legend>
      <label class="check"><input type="radio" name="chat" value="aus"${prefs.chat_push ? nothing : html` checked`}> Stummgeschaltet <small class="muted">(Standard)</small></label>
      <label class="check"><input type="radio" name="chat" value="an"${prefs.chat_push ? html` checked` : nothing}> Per Push informieren (Handy oder PC)</label>
      <small class="muted">Push musst du auf jedem Gerät unter „Benachrichtigungen“ einmal aktivieren. Im Chat selbst schaltest du mit dem Lautsprecher um.</small>
    </fieldset>
    <fieldset class="field lead-field">
      <legend>Schimpfwörter</legend>
      <label class="check"><input type="radio" name="filter" value="an"${prefs.chat_filter ? html` checked` : nothing}> Mit Sternen ausblenden <small class="muted">(Standard)</small></label>
      <label class="check"><input type="radio" name="filter" value="aus"${prefs.chat_filter ? nothing : html` checked`}> Anzeigen</label>
    </fieldset>
    <button type="submit" class="btn">Speichern</button>
  </form>
</section>`;
  } else {
    const hasPassword = !!(await db.one<{ x: number }>('select 1 as x from users where id = $1 and password_hash is not null', [user.id]));
    const totpRow = await db.one<{ totp_secret: string | null; totp_enabled_at: Date | null }>('select totp_secret, totp_enabled_at from users where id = $1', [user.id]);
    const totpEnabled = !!totpRow?.totp_enabled_at;
    const totpPending = !totpEnabled && !!totpRow?.totp_secret;
    let totpQr: Html = nothing;
    if (totpPending) {
      try {
        totpQr = html`<div class="qr-wrap">${qrSvg(encodeQr(totpProvisioningUri(totpRow!.totp_secret!, user.email, ctx.deps.config.appName)))}</div>`;
      } catch {
        // Bei einer sehr langen E-Mail-Adresse passt die otpauth://-URI nicht mehr in unseren
        // QR-Encoder (Version 1–6) – dann geht's eben nur mit dem Schlüssel von Hand.
        totpQr = html`<p class="notice notice-warn">Für deine E-Mail-Adresse lässt sich leider kein QR-Code erzeugen. Bitte gib den Schlüssel unten von Hand in deiner App ein.</p>`;
      }
    }
    content = html`<section class="panel">
  <h2>E-Mail-Adresse ändern</h2>
  <p class="muted">Aktuell: ${user.email}</p>
  <form method="post" action="/konto/email" class="stack">
    ${csrfField(ctx)}
    <label class="field">
      <span>Neue E-Mail-Adresse</span>
      <input type="email" name="email" required maxlength="254" autocomplete="email">
    </label>
    ${hasPassword ? passwordInput('current', 'current-password', 'Dein Passwort') : nothing}
    <button type="submit" class="btn">Bestätigungs-Mail senden</button>
  </form>
  <p class="muted">Die neue Adresse gilt erst, wenn du den Link in der Mail anklickst.</p>
</section>
<section class="panel">
  <h2>${hasPassword ? 'Passwort ändern' : 'Passwort festlegen'}</h2>
  <form method="post" action="/konto/passwort" class="stack">
    ${csrfField(ctx)}
    <input type="email" name="email" value="${user.email}" autocomplete="username" hidden>
    ${hasPassword ? passwordInput('current', 'current-password', 'Bisheriges Passwort') : nothing}
    ${passwordInput('password', 'new-password', 'Neues Passwort', `(mindestens ${PASSWORD_MIN} Zeichen)`)}
    ${passwordInput('password2', 'new-password', 'Neues Passwort wiederholen')}
    <button type="submit" class="btn">Passwort speichern</button>
  </form>
  <p class="muted">Danach bist du auf allen anderen Geräten abgemeldet.</p>
</section>
<section class="panel">
  <h2>Zwei-Faktor-Authentifizierung</h2>
  ${
    totpEnabled
      ? html`<p class="muted">Aktiv seit ${formatDateTime(totpRow!.totp_enabled_at!, ctx.deps.config.timeZone)} Uhr. Bei der Anmeldung brauchst du danach zusätzlich einen Code aus deiner Authenticator-App.</p>
  <details class="qr-details">
    <summary>Backup-Codes neu erzeugen</summary>
    <p class="muted">Für den Fall, dass die App mal nicht verfügbar ist. Die bisherigen Codes werden damit ungültig.</p>
    <form method="post" action="/konto/2fa/backup-codes-neu" class="stack">
      ${csrfField(ctx)}
      ${hasPassword ? passwordInput('current', 'current-password', 'Dein Passwort') : nothing}
      <button type="submit" class="btn btn-quiet">Neue Backup-Codes erzeugen</button>
    </form>
  </details>
  <form method="post" action="/konto/2fa/deaktivieren" class="stack">
    ${csrfField(ctx)}
    ${hasPassword ? passwordInput('current', 'current-password', 'Dein Passwort') : nothing}
    <button type="submit" class="btn btn-quiet">Ausschalten</button>
  </form>`
      : totpPending
        ? html`<p class="muted">Scanne den Code mit einer Authenticator-App (z. B. Google Authenticator, Aegis, 1Password) und bestätige mit dem angezeigten 6-stelligen Code.</p>
  ${totpQr}
  <p class="muted">Geht der Scan nicht? Schlüssel von Hand eingeben: <code>${totpRow!.totp_secret}</code></p>
  <form method="post" action="/konto/2fa/bestaetigen" class="stack">
    ${csrfField(ctx)}
    <label class="field">
      <span>6-stelliger Code aus der App</span>
      <input type="text" name="code" required maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" autofocus>
    </label>
    <button type="submit" class="btn">Bestätigen und aktivieren</button>
  </form>
  <form method="post" action="/konto/2fa/abbrechen">
    ${csrfField(ctx)}
    <button type="submit" class="btn btn-quiet">Abbrechen</button>
  </form>`
        : html`<p class="muted">Schützt dein Konto zusätzlich mit einem Code aus einer Authenticator-App bei jeder Anmeldung.</p>
  <form method="post" action="/konto/2fa/einrichten" class="stack">
    ${csrfField(ctx)}
    ${hasPassword ? passwordInput('current', 'current-password', 'Dein Passwort') : nothing}
    <button type="submit" class="btn">Einrichten</button>
  </form>`
  }
  ${
    freshBackupCodes
      ? html`<div class="notice notice-ok backup-codes">
    <p><strong>Deine Backup-Codes</strong> – jeder gilt einmal, falls die App mal nicht verfügbar ist. Jetzt notieren oder speichern, sie werden nicht noch einmal angezeigt:</p>
    <ul class="backup-code-list">${freshBackupCodes.map((c) => html`<li><code>${c}</code></li>`)}</ul>
  </div>`
      : nothing
  }
</section>
<section class="panel">
  <h2>Abmelden</h2>
  <p class="muted">Angemeldet als ${user.email}</p>
  <form method="post" action="/abmelden" class="stack">
    ${csrfField(ctx)}
    <button type="submit" class="btn">Abmelden</button>
  </form>
</section>
<section class="panel danger-zone">
  <h2>Konto löschen</h2>
  <p>Löscht dein Konto mit allen Tipps und Antworten. Das lässt sich nicht rückgängig machen. Tipprunden, die du leitest, gehen an ein anderes Mitglied über.</p>
  <form method="post" action="/konto/loeschen" class="stack">
    ${csrfField(ctx)}
    <label class="check"><input type="checkbox" name="bestaetigt" value="ja" required> Ja, mein Konto endgültig löschen</label>
    <button type="submit" class="btn btn-danger">Konto löschen</button>
  </form>
</section>`;
  }
  const body = html`<h1 class="small-title">Dein Konto</h1>
${tabs}
${content}`;
  return htmlResponse(layout(ctx, { title: 'Dein Konto', body, error }), error ? 400 : 200);
}
