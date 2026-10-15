// Ablauf-Test der ganzen App gegen eine echte, LEERE PostgreSQL-Datenbank.
//
//   TEST_DATABASE_URL=postgres://… npm run test:app
//
// Ohne TEST_DATABASE_URL wird der Test übersprungen.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { runSync } from './abgleich.ts';
import { importTournament, type TournamentData } from './daten.ts';
import { fakeRiot, lolesports, worldsSchedule } from './testdaten/fake-riot.ts';
import { createDb, type Db, migrate } from './db/index.ts';
import { createMailer, type Mailer } from './mail.ts';

const DB_URL = process.env.TEST_DATABASE_URL;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let db: Db;
let server: Server;
let base: string;
let mailer: Mailer;

/** Ein Browser-Ersatz: merkt sich Cookies und das Formular-Token. */
class Client {
  cookies = new Map<string, string>();
  csrf = '';
  origin: string | null = null;

  async request(method: string, path: string, form?: Record<string, string> | URLSearchParams, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (form) {
      const params = form instanceof URLSearchParams ? form : new URLSearchParams(form);
      if (this.csrf && !params.has('_csrf')) params.set('_csrf', this.csrf);
      body = params.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = this.origin ?? base;
    }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => /max-age=0/i.test(a.trim()))) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(text);
    if (token) this.csrf = token[1];
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }

  get(path: string) {
    return this.request('GET', path);
  }

  post(path: string, form: Record<string, string> | URLSearchParams = {}) {
    return this.request('POST', path, form);
  }

  /** Anmelden mit Passwort; gibt es das Konto noch nicht, wird es erstellt (mit Namen). */
  async login(email: string, name?: string, next = '/') {
    const exists = await db.one('select 1 from users where email = $1', [email.toLowerCase()]);
    if (!exists) {
      const form = await this.get(`/registrieren?weiter=${encodeURIComponent(next)}`);
      assert.equal(form.status, 200);
      const r = await this.post('/registrieren', { display_name: name ?? email.split('@')[0], email, password: PASSWORT, weiter: next });
      assert.equal(r.status, 303, r.text);
      await this.refresh();
      return r;
    }
    const r = await this.post('/anmelden', { email, password: PASSWORT, weiter: next });
    assert.equal(r.status, 303, r.text);
    await this.refresh();
    return r;
  }

  /** Wie ein Browser nach der Anmeldung: eine Seite laden, damit das Formular-Token zur neuen Sitzung passt. */
  async refresh() {
    this.csrf = '';
    await this.get('/konto');
  }
}

const PASSWORT = 'richtig-geheim-123';

/** Link aus der zuletzt verschickten Mail an diese Adresse */
function lastLink(email: string): URL {
  const mail = [...mailer.sent!].reverse().find((m) => m.to === email);
  assert.ok(mail, `Keine E-Mail an ${email}`);
  return new URL(/https?:\/\/[^\s]+\/passwort-neu\?[^\s]+/.exec(mail.text)![0]);
}

function localInput(d: Date): string {
  // Zeit in Europe/Berlin für <input type="datetime-local">
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  return p.replace(' ', 'T');
}

const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

/**
 * Sonderfragen sind nur vor dem ersten Spiel offen. Damit die Tests nicht vom heutigen Datum abhängen,
 * wird ein Turnier hier "noch nicht begonnen" – die Rückgabe stellt die echten Zeiten wieder her.
 */
async function postponeTournament(tid: string): Promise<() => Promise<void>> {
  const saved = await db.query<{ id: string; scheduled_at: Date | null; live_at: Date | null }>(
    'select id, scheduled_at, live_at from matches where tournament_id = $1',
    [tid],
  );
  await db.run(
    `update matches set scheduled_at = scheduled_at + interval '30 days', live_at = live_at + interval '30 days' where tournament_id = $1`,
    [tid],
  );
  return async () => {
    for (const m of saved) await db.run('update matches set scheduled_at = $2, live_at = $3 where id = $1', [m.id, m.scheduled_at, m.live_at]);
  };
}

describe('Web-App (mit Datenbank)', { skip: !DB_URL && 'TEST_DATABASE_URL nicht gesetzt' }, () => {
  before(async () => {
    db = createDb(DB_URL!, { max: 4 });
    const tables = await db.one<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    if (tables!.n !== 0) throw new Error('Abbruch: Die Test-Datenbank ist nicht leer. Bitte eine LEERE Datenbank verwenden.');
    await migrate(db, join(root, 'db', 'migrations'));

    const config = loadConfig({
      DATABASE_URL: DB_URL,
      PORT: '0',
      APP_URL: 'http://127.0.0.1',
      ADMIN_EMAILS: 'admin@example.de',
      SUGGESTIONS_TO: 'vorschlaege@example.de',
      MAIL_MODE: 'memory',
      APP_SECRET: 'test-geheimnis',
    });
    mailer = createMailer(config);
    const app = createApp({
      db, config, mailer, publicDir: join(root, 'public'), fetchJson: fakeRiot(),
      log: process.env.TEST_LOG ? (m) => console.error(m) : () => {},
    });
    server = createServer(app.listener);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config.appUrl = base;
  });

  after(async () => {
    server?.close();
    if (db) {
      await db.exec('drop schema public cascade; create schema public;');
      await db.end();
    }
  });

  const admin = new Client();
  const anna = new Client();
  const ben = new Client();
  const stranger = new Client();
  let tournamentId = '';
  const team: Record<string, string> = {};
  const match: Record<string, string> = {};
  let slug = '';
  let invite = '';

  test('Startseite, Sicherheits-Header, statische Dateien', async () => {
    const r = await stranger.get('/');
    assert.equal(r.status, 200);
    assert.match(r.text, /Tippt die Worlds zusammen/);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const css = /href="(\/static\/app\.css\?v=[0-9a-f]+)"/.exec(r.text)![1];
    const c = await stranger.get(css);
    assert.equal(c.status, 200);
    assert.match(c.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await stranger.get('/manifest.webmanifest')).status, 200);
    assert.equal((await stranger.get('/gibt-es-nicht')).status, 404);
    assert.equal((await stranger.get('/gesund')).text, 'ok');
    // Handy-App: Service Worker im Hauptverzeichnis, Hinweisseite ohne Internet
    const sw = await stranger.get('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type') ?? '', /javascript/);
    assert.match(sw.text, /addEventListener\('fetch'/);
    const offline = await stranger.get('/offline');
    assert.match(offline.text, /Keine Verbindung/);
    assert.match(offline.text, /\/static\/app\.css\?v=/);
  });

  test('Anmeldung: Konto erstellen, Passwort, Fehlversuche, Passwort vergessen, alte Konten', async () => {
    const bad = await anna.post('/registrieren', { display_name: 'Anna', email: 'kein-at-zeichen', password: PASSWORT });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /gültige E-Mail-Adresse/);
    const short = await anna.post('/registrieren', { display_name: 'Anna', email: 'anna@example.de', password: 'kurz' });
    assert.match(short.text, /mindestens 8 Zeichen/);

    const r = await anna.login('Anna@Example.de', 'Anna');
    assert.equal(r.location, '/');
    const home = await anna.get('/');
    assert.match(home.text, /Deine Tipprunden/);
    assert.match(home.text, />Anna</);
    const dup = await new Client().post('/registrieren', { display_name: 'Anna 2', email: 'anna@example.de', password: PASSWORT });
    assert.match(dup.text, /gibt es schon ein Konto/);

    // In der Datenbank steht nur ein Hash, nicht das Passwort
    const stored = (await db.one<{ password_hash: string }>(`select password_hash from users where email = 'anna@example.de'`))!;
    assert.match(stored.password_hash, /^scrypt\$/);
    assert.ok(!stored.password_hash.includes(PASSWORT));

    // Falsches Passwort, dann richtig
    const wrong = await new Client().post('/anmelden', { email: 'anna@example.de', password: 'falsch-falsch' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /E-Mail-Adresse oder Passwort stimmt nicht/);
    assert.equal((await new Client().login('anna@example.de')).location, '/');

    // Nach 10 Fehlversuchen ist 15 Minuten Pause – auch mit richtigem Passwort
    const victim = new Client();
    await victim.login('sperre@example.de', 'Sperre');
    for (let i = 0; i < 10; i++) await new Client().post('/anmelden', { email: 'sperre@example.de', password: `rate-mal-${i}` });
    const blocked = await new Client().post('/anmelden', { email: 'sperre@example.de', password: PASSWORT });
    assert.match(blocked.text, /Zu viele Fehlversuche/);

    // Passwort vergessen: Link per Mail, nur einmal gültig; Unbekannte bekommen dieselbe Antwort, aber keine Mail
    const before = mailer.sent!.length;
    const unknown = await new Client().post('/passwort-vergessen', { email: 'niemand@example.de' });
    assert.match(unknown.text, /Falls es ein Konto mit dieser Adresse gibt/);
    assert.equal(mailer.sent!.length, before);
    const forgot = await new Client().post('/passwort-vergessen', { email: 'anna@example.de' });
    assert.match(forgot.text, /Falls es ein Konto mit dieser Adresse gibt/);
    const link = lastLink('anna@example.de');
    const reset = new Client();
    assert.match((await reset.get(link.pathname + link.search)).text, /Passwort festlegen/);
    const token = link.searchParams.get('token')!;
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from login_tokens where token_hash = $1', [token]))!.n, 0, 'nur der Hash wird gespeichert');
    const tooShort = await reset.post('/passwort-neu', { token, password: 'kurz' });
    assert.match(tooShort.text, /mindestens 8 Zeichen/);
    const set = await reset.post('/passwort-neu', { token, password: 'ganz-neues-passwort' });
    assert.equal(set.status, 303);
    assert.equal(set.location, '/');
    assert.equal((await reset.get('/konto')).status, 200);
    assert.match((await new Client().post('/passwort-neu', { token, password: 'noch-ein-passwort' })).text, /nicht mehr gültig/);
    // Altes Passwort gilt nicht mehr, alte Sitzungen sind beendet
    assert.equal((await new Client().post('/anmelden', { email: 'anna@example.de', password: PASSWORT })).status, 400);
    assert.equal((await anna.get('/konto')).status, 303);
    // Passwort im Konto zurückändern (braucht das bisherige)
    const wrongCurrent = await reset.post('/konto/passwort', { current: 'falsch', password: PASSWORT, password2: PASSWORT });
    assert.match(wrongCurrent.text, /bisherige Passwort stimmt nicht/);
    const mismatch = await reset.post('/konto/passwort', { current: 'ganz-neues-passwort', password: PASSWORT, password2: PASSWORT + 'x' });
    assert.match(mismatch.text, /nicht gleich/);
    const changed = await reset.post('/konto/passwort', { current: 'ganz-neues-passwort', password: PASSWORT, password2: PASSWORT });
    assert.equal(changed.location, '/konto?hinweis=passwort-gespeichert');
    anna.cookies.clear();
    assert.equal((await anna.login('anna@example.de')).location, '/');

    // E-Mail-Adresse ändern: erst nach Klick auf den Link in der Mail an die neue Adresse
    const konto = await anna.get('/konto');
    assert.match(konto.text, /E-Mail-Adresse ändern/);
    assert.match(konto.text, /class="top-logout"/);
    assert.match(konto.text, /name="password2"/);
    assert.match((await anna.post('/konto/email', { email: 'anna.neu@example.de', current: 'falsch' })).text, /Passwort stimmt nicht/);
    assert.match((await anna.post('/konto/email', { email: 'kaputt', current: PASSWORT })).text, /gültige E-Mail/);
    await db.run(`insert into users (email, display_name) values ('vergeben@example.de', 'Vergeben')`);
    const sentBefore = mailer.sent!.length;
    assert.equal((await anna.post('/konto/email', { email: 'vergeben@example.de', current: PASSWORT })).location, '/konto?hinweis=email-gesendet');
    assert.equal(mailer.sent!.length, sentBefore, 'vergebene Adresse: keine Mail, aber auch kein Hinweis darauf');
    assert.equal((await anna.post('/konto/email', { email: 'anna.neu@example.de', current: PASSWORT })).location, '/konto?hinweis=email-gesendet');
    const cm = [...mailer.sent!].reverse().find((m) => m.to === 'anna.neu@example.de')!;
    const confirm = new URL(/https?:\/\/[^\s]+\/konto\/email-bestaetigen\?[^\s]+/.exec(cm.text)![0]);
    assert.equal((await new Client().get(confirm.pathname + confirm.search)).status, 303, 'ohne Anmeldung nicht einlösbar');
    assert.equal((await anna.get(confirm.pathname + confirm.search)).location, '/konto?hinweis=email-geaendert');
    assert.equal((await anna.get(confirm.pathname + confirm.search)).status, 400, 'Link gilt nur einmal');
    assert.equal((await new Client().post('/anmelden', { email: 'anna.neu@example.de', password: PASSWORT })).status, 303);
    assert.equal((await new Client().post('/anmelden', { email: 'anna@example.de', password: PASSWORT })).status, 400);
    // zurück, damit die weiteren Tests mit der alten Adresse laufen
    await db.run(`update users set email = 'anna@example.de' where email = 'anna.neu@example.de'`);
    await db.run(`delete from users where email = 'vergeben@example.de'`);

    // Konto aus der Zeit der Anmelde-Links (ohne Passwort): Anmelden schickt einen Link zum Festlegen
    await db.run(`insert into users (email, display_name) values ('alt@example.de', 'Alt')`);
    const old = await new Client().post('/anmelden', { email: 'alt@example.de', password: 'irgendwas-langes' });
    assert.match(old.text, /noch kein Passwort/);
    const oldLink = lastLink('alt@example.de');
    const oldClient = new Client();
    await oldClient.get(oldLink.pathname + oldLink.search);
    const oldSet = await oldClient.post('/passwort-neu', { token: oldLink.searchParams.get('token')!, password: 'jetzt-mit-passwort' });
    assert.equal(oldSet.location, '/');
    assert.equal((await new Client().post('/anmelden', { email: 'alt@example.de', password: 'jetzt-mit-passwort' })).status, 303);
  });

  test('Formularschutz: ohne Token und von fremder Seite abgelehnt', async () => {
    const noToken = await anna.request('POST', '/konto/name', new URLSearchParams({ display_name: 'X', _csrf: 'falsch' }), {});
    assert.equal(noToken.status, 403);
    const foreign = new Client();
    foreign.cookies = anna.cookies;
    foreign.csrf = anna.csrf;
    foreign.origin = 'https://boese.example';
    const r = await foreign.post('/konto/name', { display_name: 'Hacker' });
    assert.equal(r.status, 403);
    const name = await db.one<{ display_name: string }>(`select display_name from users where email = 'anna@example.de'`);
    assert.equal(name!.display_name, 'Anna');
  });

  test('Admin legt Teams, Turnier und Spiele an; andere kommen nicht in den Admin-Bereich', async () => {
    assert.equal((await anna.get('/admin')).status, 404);
    await admin.login('admin@example.de', 'Admin');
    assert.equal((await admin.get('/admin')).status, 200);

    for (const [name, short] of [['Gen.G', 'GEN'], ['T1', 'T1'], ['G2 Esports', 'G2'], ['Karmine Corp', 'KC']]) {
      const r = await admin.post('/admin/team', { name, short_name: short, region: 'X' });
      assert.equal(r.status, 303, r.text);
    }
    // Neue Tipprunden: anfangs nur Admins – für andere ist „Tipprunde erstellen“ ausgeblendet und gesperrt
    assert.doesNotMatch((await anna.get('/')).text, /href="\/neu"/);
    assert.equal((await anna.get('/neu')).status, 403);
    assert.equal((await anna.post('/neu', { name: 'Heimlich' })).status, 403);
    assert.match((await admin.get('/')).text, /href="\/neu"/);
    assert.match((await admin.get('/admin')).text, /name="league_creation" value="admins" checked/);
    assert.equal((await anna.post('/admin/einstellungen', { league_creation: 'alle' })).status, 404);
    assert.equal((await admin.post('/admin/einstellungen', { league_creation: 'alle' })).location, '/admin?hinweis=gespeichert');
    assert.match((await anna.get('/')).text, /href="\/neu"/);
    assert.equal((await anna.get('/neu')).status, 200);

    const dup = await admin.post('/admin/team', { name: 'T1' });
    assert.equal(dup.status, 400);
    for (const t of await db.query<{ id: string; short_name: string }>('select id, short_name from teams')) team[t.short_name] = t.id;

    const t = await admin.post('/admin/turnier', { name: 'Testturnier 2026', starts_on: '2026-10-15', ends_on: '2026-11-14', stages: 'Swiss\nFinale' });
    assert.equal(t.status, 303);
    tournamentId = /\/admin\/turnier\/([0-9a-f-]+)/.exec(t.location!)![1];

    const add = (a: string | null, b: string | null, bo: number, at: Date | null) =>
      admin.post(`/admin/turnier/${tournamentId}/spiel`, {
        team_a_id: a ? team[a] : '', team_b_id: b ? team[b] : '', best_of: String(bo), scheduled_at: at ? localInput(at) : '', stage_id: '',
      });
    assert.equal((await add('GEN', 'T1', 5, hours(24))).status, 303);
    assert.equal((await add('G2', 'KC', 3, hours(26))).status, 303); // gleicher Spieltag (< 6 h)
    assert.equal((await add('T1', 'KC', 1, hours(72))).status, 303);
    assert.equal((await add(null, null, 5, hours(96))).status, 303); // Teams noch offen
    const same = await add('T1', 'T1', 1, hours(80));
    assert.equal(same.status, 400);

    const rows = await db.query<{ id: string; a: string | null; b: string | null; matchday_starts_at: Date }>(
      `select m.id, ta.short_name as a, tb.short_name as b, m.matchday_starts_at
         from matches m left join teams ta on ta.id = m.team_a_id left join teams tb on tb.id = m.team_b_id`,
    );
    for (const r of rows) match[r.a && r.b ? `${r.a}-${r.b}` : 'offen'] = r.id;
    const day = rows.find((r) => r.a === 'GEN')!.matchday_starts_at.getTime();
    assert.equal(rows.find((r) => r.a === 'G2')!.matchday_starts_at.getTime(), day, 'G2–KC gehört zum Spieltag von GEN–T1');
  });

  test('Tipprunde erstellen und per Einladungslink beitreten', async () => {
    const r = await anna.post('/neu', { name: 'Die Rift-Runde', tournament_id: tournamentId, points_winner: '1', points_exact: '1', lock_mode: 'matchday' });
    assert.equal(r.status, 303, r.text);
    slug = /\/r\/([^/]+)\//.exec(r.location!)![1];
    assert.equal(slug, 'die-rift-runde');
    const manage = await anna.get(`/r/${slug}/verwalten`);
    assert.equal(manage.status, 200);
    invite = /\/beitreten\/([0-9a-f]+)/.exec(manage.text)![1];

    // Fremde sehen die Runde nicht
    await stranger.login('fremd@example.de', 'Fremd');
    assert.equal((await stranger.get(`/r/${slug}/tippen`)).status, 404);

    // Ben öffnet den Link, meldet sich an und landet wieder beim Beitreten
    const open = await ben.get(`/beitreten/${invite}`);
    assert.equal(open.status, 303);
    const login = await ben.login('ben@example.de', 'Ben', new URL(open.location!, base).searchParams.get('weiter')!);
    assert.equal(login.location, `/beitreten/${invite}`);
    const page = await ben.get(`/beitreten/${invite}`);
    assert.match(page.text, /Die Rift-Runde/);
    const joined = await ben.post(`/beitreten/${invite}`);
    assert.equal(joined.location, `/r/${slug}/tippen?hinweis=beigetreten`);
    assert.equal((await ben.get(`/r/${slug}/tippen`)).status, 200);

    // Beitritt über das Feld auf der Startseite (ganzer Link eingefügt)
    const viaField = await stranger.post('/beitreten', { code: `${base}/beitreten/${invite}` });
    assert.equal(viaField.location, `/beitreten/${invite}`);
  });

  test('Tippen: speichern, Format prüfen, Tipps der anderen erst ab Tippschluss', async () => {
    const page = await anna.get(`/r/${slug}/tippen`);
    assert.match(page.text, /Tipps speichern/);
    assert.match(page.text, new RegExp(`name="tipp_${match['GEN-T1']}" value="A-3-1"`));
    // Spiele ohne feststehende Teams werden nicht gezeigt, nur ein Hinweis
    assert.match(page.text, /Ein weiteres Spiel dieser Phase erscheint hier, sobald die Teams feststehen/);
    assert.doesNotMatch(page.text, /Steht noch nicht fest/);

    const saved = await anna.post(`/r/${slug}/tippen`, {
      [`tipp_${match['GEN-T1']}`]: 'A-3-1',
      [`tipp_${match['G2-KC']}`]: 'B-2-0',
      [`tipp_${match['T1-KC']}`]: 'A',
      [`tipp_${match.offen}`]: 'A-3-0', // Teams offen → wird abgelehnt
    });
    assert.equal(saved.location, `/r/${slug}/tippen?hinweis=tipps-teilweise`);
    const bad = await anna.post(`/r/${slug}/tippen`, { [`tipp_${match['T1-KC']}`]: 'A-2-1' }); // Bo1 mit Ergebnis → ignoriert
    assert.equal(bad.location, `/r/${slug}/tippen?hinweis=keine-aenderung`);
    const n = await db.one<{ n: number }>('select count(*)::int as n from predictions');
    assert.equal(n!.n, 3);

    await ben.post(`/r/${slug}/tippen`, { [`tipp_${match['GEN-T1']}`]: 'B-3-2', [`tipp_${match['G2-KC']}`]: 'B-2-1' });
    const again = await anna.get(`/r/${slug}/tippen`);
    assert.match(again.text, new RegExp(`value="A-3-1" checked`));

    const hidden = await anna.get(`/r/${slug}/spiel/${match['GEN-T1']}`);
    assert.match(hidden.text, /ab Tippschluss/);
    assert.doesNotMatch(hidden.text, /Ben/);
    // Reiter "Alle Tipps": vor dem Tippschluss noch leer
    const all = await anna.get(`/r/${slug}/alle-tipps`);
    assert.equal(all.status, 200);
    assert.match(all.text, /Noch sind keine Tipps zu sehen/);
    assert.match(all.text, /aria-current="page">Alle Tipps</);
    assert.doesNotMatch(all.text, /Ben/);
    assert.equal((await stranger.get(`/r/${slug}/alle-tipps`)).status, 404);
  });

  test('Nach Tippschluss: keine Änderung mehr, alle Tipps sichtbar, Ergebnis zählt', async () => {
    // Admin verlegt das Spiel in die Vergangenheit → Spieltag ist geschlossen
    const edit = await admin.post(`/admin/spiel/${match['GEN-T1']}`, {
      team_a_id: team.GEN, team_b_id: team.T1, best_of: '5', scheduled_at: localInput(hours(-3)), stage_id: '', ergebnis: '', status: 'live',
    });
    assert.equal(edit.status, 303, edit.text);
    await admin.post(`/admin/spiel/${match['G2-KC']}`, {
      team_a_id: team.G2, team_b_id: team.KC, best_of: '3', scheduled_at: localInput(hours(-1)), stage_id: '', ergebnis: '', status: 'scheduled',
    });

    const late = await anna.post(`/r/${slug}/tippen`, { [`tipp_${match['GEN-T1']}`]: 'B-3-0' });
    assert.equal(late.location, `/r/${slug}/tippen?hinweis=tipps-teilweise`);
    const still = await db.one<{ winner: string }>('select winner from predictions where match_id = $1 and user_id = (select id from users where email = $2)', [match['GEN-T1'], 'anna@example.de']);
    assert.equal(still!.winner, 'A');

    const visible = await anna.get(`/r/${slug}/spiel/${match['GEN-T1']}`);
    assert.match(visible.text, /Ben/);
    assert.match(visible.text, /T1 3:2/);

    // Ergebnisse: GEN 3:1 (Anna exakt → 2 Punkte), KC 2:1 (Ben exakt → 2, Anna Sieger → 1)
    assert.equal((await admin.post(`/admin/spiel/${match['GEN-T1']}/ergebnis`, { ergebnis: 'A-3-1' })).status, 303);
    assert.equal((await admin.post(`/admin/spiel/${match['G2-KC']}/ergebnis`, { ergebnis: 'B-2-1' })).status, 303);
    const invalid = await admin.post(`/admin/spiel/${match['G2-KC']}/ergebnis`, { ergebnis: 'B-3-1' });
    assert.equal(invalid.status, 400);

    const status = await db.one<{ status: string; wins_a: number; wins_b: number }>('select status, wins_a, wins_b from matches where id = $1', [match['G2-KC']]);
    assert.deepEqual(status, { status: 'finished', wins_a: 1, wins_b: 2 });

    const table = await anna.get(`/r/${slug}/rangliste`);
    const rows = [...table.text.matchAll(/<td class="num rank">(\d+)<\/td>\s*<td><span class="who">(?:<img[^>]*>|<span class="avatar[^"]*"[^>]*>[^<]*<\/span>)<span>([^<]+)<\/span><\/span><\/td>[\s\S]*?<td class="num total">(\d+)<\/td>/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(rows, [['1', 'Anna', '3'], ['2', 'Ben', '2']]);

    const tips = await anna.get(`/r/${slug}/tippen`);
    assert.match(tips.text, /Vorbei/);
    assert.match(tips.text, /pts pts-hit pts-exact">\+2</);
    assert.match(tips.text, new RegExp(`href="/r/${slug}/spiel/${match['GEN-T1']}">Tipps zu diesem Spiel</a>`));

    // Reiter "Alle Tipps": beide geschlossenen Spiele mit allen Tipps und Punkten – offene Spiele nicht
    const all = await ben.get(`/r/${slug}/alle-tipps`);
    assert.equal(all.status, 200);
    for (const id of [match['GEN-T1'], match['G2-KC']]) assert.match(all.text, new RegExp(`id="tipps-${id}"`));
    assert.doesNotMatch(all.text, new RegExp(match['T1-KC']));
    const block = (id: string) => all.text.slice(all.text.indexOf(`id="tipps-${id}"`)).split('</article>')[0];
    const rowsOf = (id: string) => [...block(id).matchAll(/<tr( class="me")?>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td class="num( hit)?">(\d*)<\/td>/g)].map((r) => [r[2], r[3], r[5], !!r[1]]);
    assert.deepEqual(rowsOf(match['GEN-T1']), [['Anna', 'GEN 3:1', '2', false], ['Ben', 'T1 3:2', '0', true]]);
    assert.deepEqual(rowsOf(match['G2-KC']), [['Anna', 'KC 2:0', '1', false], ['Ben', 'KC 2:1', '2', true]]);
  });

  test('Kopfzeile: Countdown vor dem Start, danach Livestream-Links', async () => {
    const restore = await postponeTournament(tournamentId);
    const before = await anna.get(`/r/${slug}/tippen`);
    assert.match(before.text, /data-countdown="/);
    assert.doesNotMatch(before.text, /twitch\.tv/);
    await restore();
    const after = await anna.get(`/r/${slug}/tippen`);
    assert.doesNotMatch(after.text, /data-countdown/);
    assert.match(after.text, /href="https:\/\/www\.twitch\.tv\/lolesports"/);
    assert.match(after.text, /href="https:\/\/www\.youtube\.com\/@lolesports"/);
  test('Rechtliches: Impressum/Datenschutz öffentlich, Angaben nur vom Admin', async () => {
    const pub = await new Client().get('/impressum');
    assert.equal(pub.status, 200);
    assert.match(pub.text, /Name fehlt noch/);
    assert.match(pub.text, /href="\/datenschutz"/, 'Footer-Links');
    assert.equal((await new Client().get('/datenschutz')).status, 200);
    assert.equal((await anna.get('/admin/rechtliches')).status, 404, 'normale Nutzer: nicht vorhanden');
    assert.equal((await anna.post('/admin/rechtliches', { name: 'X' })).status, 404);
    const adm = await admin.post('/admin/rechtliches', { name: 'Max <b>Muster', email: 'kontakt@example.de', street: 'Weg 1', city: '12345 Stadt', country: 'Deutschland', hosting: 'Eigener Server' });
    assert.equal(adm.location, '/admin/rechtliches?hinweis=gespeichert');
    const after = (await new Client().get('/impressum')).text;
    assert.match(after, /Max &lt;b&gt;Muster/);
    assert.doesNotMatch(after, /Name fehlt noch/);
    await db.run(`delete from app_settings where key like 'legal\\_%'`);
  });

  test('Avatare: Upload, Rangliste, Abruf nur angemeldet', async () => {
    // kleines gültiges JPEG-Gerüst (Prüfung nur auf Kopf/Ende und Größe)
    const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1), Buffer.from([0xff, 0xd9])]);
    const url = `data:image/jpeg;base64,${body.toString('base64')}`;
    assert.equal((await anna.post('/konto/avatar', { avatar: 'data:image/png;base64,AAAA' })).location, '/konto?hinweis=avatar-fehler');
    assert.equal((await anna.post('/konto/avatar', { avatar: 'data:image/jpeg;base64,' + Buffer.alloc(60_000, 7).toString('base64') })).location, '/konto?hinweis=avatar-fehler', 'zu groß / kein JPEG');
    assert.equal((await anna.post('/konto/avatar', { avatar: url })).location, '/konto?hinweis=avatar-gespeichert');
    const id = (await db.one<{ id: string }>(`select id from users where email = 'anna@example.de'`))!.id;
    const img = await anna.get(`/avatar/${id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await new Client().get(`/avatar/${id}`)).status, 303, 'nicht ohne Anmeldung');
    assert.match((await anna.get(`/r/${slug}/rangliste`)).text, new RegExp(`src="/avatar/${id}\\?v=\\d+"`));
    assert.equal((await anna.post('/konto/avatar/loeschen')).location, '/konto?hinweis=avatar-geloescht');
    assert.equal((await anna.get(`/avatar/${id}`)).status, 404);
  });

  test('Sonderfragen: anlegen, beantworten, Frist, Auflösung', async () => {
    const add = await anna.post(`/r/${slug}/verwalten/typische-fragen`, { tournament_id: tournamentId });
    assert.equal(add.status, 303);
    const qs = await db.query<{ id: string; question: string; answer_type: string }>('select id, question, answer_type from bonus_questions order by position');
    assert.equal(qs.length, 6);
    const champ = qs.find((q) => q.question.includes('Weltmeister'))!;
    const mvp = qs.find((q) => q.question.includes('MVP'))!;

    // Frist = Start des ersten Spiels; hier noch in der Zukunft
  test('Sonderfragen: auswählen, beantworten, Frist, Auflösung', async () => {
    // Frist = Start des ersten Spiels; hier noch in der Zukunft, damit die Auswahl offen ist
    const restore = await postponeTournament(tournamentId);
    const manage = await anna.get(`/r/${slug}/verwalten`);
    assert.match(manage.text, /name="frage" value="weltmeister"/);
    assert.doesNotMatch(manage.text, /<fieldset class="field" disabled>/);
    assert.doesNotMatch(manage.text, /name="answer_type"|name="choices"|name="hint"|bonus_deadline_at/, 'keine komplizierten Felder mehr');
    assert.doesNotMatch(manage.text, /Neue Sonderfrage|action="[^"]*\/verwalten\/frage"/, 'niemand legt selbst Fragen an');
    const all = new URLSearchParams([['tournament_id', tournamentId], ...['weltmeister', 'finals-mvp', 'meistgebannt', 'kuerzestes-spiel', 'pentakill-team', 'pentakill-spieler'].map((k) => ['frage', k])]);
    const add = await anna.post(`/r/${slug}/verwalten/fragen-auswahl`, all);
    assert.equal(add.status, 303);
    const qs = await db.query<{ id: string; question: string; answer_type: string; catalog_key: string }>('select id, question, answer_type, catalog_key from bonus_questions order by position');
    assert.equal(qs.length, 6);
    assert.deepEqual(qs.map((q) => q.answer_type), ['team', 'player', 'champion', 'team', 'team', 'player']);
    const champ = qs.find((q) => q.catalog_key === 'weltmeister')!;
    const mvp = qs.find((q) => q.catalog_key === 'finals-mvp')!;
    // Abwählen löscht die Frage, Wiederholen ändert nichts
    const less = new URLSearchParams(all);
    less.delete('frage', 'pentakill-spieler');
    await anna.post(`/r/${slug}/verwalten/fragen-auswahl`, less);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from bonus_questions'))!.n, 5);
    await anna.post(`/r/${slug}/verwalten/fragen-auswahl`, all);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from bonus_questions'))!.n, 6);
    // Nur die Leitung darf wählen
    assert.equal((await ben.post(`/r/${slug}/verwalten/fragen-auswahl`, all)).status, 403);

    // Vorschlag für neue Fragen geht per E-Mail an den Betreiber
    assert.equal((await anna.post(`/r/${slug}/verwalten/frage-vorschlag`, { vorschlag: '   ' })).status, 400);
    const sug = await anna.post(`/r/${slug}/verwalten/frage-vorschlag`, { vorschlag: 'Wer holt den ersten Baron?' });
    assert.equal(sug.location, `/r/${slug}/verwalten?hinweis=vorschlag-gesendet#fragen`);
    const mail = [...mailer.sent!].reverse().find((m) => m.to === 'vorschlaege@example.de')!;
    assert.match(mail.text, /Wer holt den ersten Baron\?/);
    assert.match(mail.text, /Anna/);
    const form = await ben.get(`/r/${slug}/sonderfragen`);
    assert.match(form.text, /Antworten bis zum Start des ersten Spiels/);
    assert.match(form.text, /Antworten speichern/);
    assert.match(form.text, /<option value="Gen.G">Gen.G<\/option>/);
    const saved = await ben.post(`/r/${slug}/sonderfragen`, { [`antwort_${champ.id}`]: 'Gen.G', [`antwort_${mvp.id}`]: '  chovy ' });
    assert.equal(saved.location, `/r/${slug}/sonderfragen?hinweis=antworten-gespeichert`);
    await anna.post(`/r/${slug}/sonderfragen`, { [`antwort_${champ.id}`]: 'T1', [`antwort_${mvp.id}`]: '<script>alert(1)</script>' });

    // Vor der Frist sieht man die Antworten der anderen nicht
    assert.doesNotMatch((await anna.get(`/r/${slug}/sonderfragen`)).text, /chovy/);

    // Erstes Spiel hat begonnen → keine Änderungen mehr, Antworten aller sichtbar (und maskiert)
    await restore();
    const locked = await anna.get(`/r/${slug}/verwalten`);
    assert.match(locked.text, /<fieldset class="field" disabled>/);
    assert.match(locked.text, /Die Auswahl ist gesperrt/);
    assert.match(locked.text, /Frage löschen/);
    const refused = await anna.post(`/r/${slug}/verwalten/fragen-auswahl`, less);
    assert.equal(refused.status, 400);
    assert.match(refused.text, /schon begonnen/);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from bonus_questions'))!.n, 6);
    const late = await ben.post(`/r/${slug}/sonderfragen`, { [`antwort_${champ.id}`]: 'T1' });
    assert.equal(late.location, `/r/${slug}/sonderfragen?hinweis=antworten-zu-spaet`);
    const closed = await ben.get(`/r/${slug}/sonderfragen`);
    assert.match(closed.text, /chovy/);
    assert.match(closed.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(closed.text, /<script>alert/);

    // Auflösen: Weltmeister Gen.G (5 Punkte), MVP "Chovy" – Schreibweise egal (3 Punkte)
    const q = (id: string) => db.one<Record<string, unknown>>('select * from bonus_questions where id = $1', [id]);
    await anna.post(`/r/${slug}/verwalten/frage/${champ.id}`, { aktion: 'speichern', points: '5', correct_answers: 'Gen.G' });
    await anna.post(`/r/${slug}/verwalten/frage/${mvp.id}`, { aktion: 'speichern', points: '3', correct_answers: 'Chovy' });
    assert.equal((await q(champ.id))!.question, 'Wer wird Weltmeister?', 'Frage und Antwortart bleiben fest');
    // Nach dem Start lässt sich eine Frage nur noch über ihre Einstellungen löschen
    const weg = qs.find((x) => x.catalog_key === 'kuerzestes-spiel')!;
    await anna.post(`/r/${slug}/verwalten/frage/${weg.id}`, { aktion: 'loeschen' });
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from bonus_questions'))!.n, 5);
    const table = await ben.get(`/r/${slug}/rangliste`);
    const rows = [...table.text.matchAll(/<td class="num rank">(\d+)<\/td>\s*<td><span class="who">(?:<img[^>]*>|<span class="avatar[^"]*"[^>]*>[^<]*<\/span>)<span>([^<]+)<\/span><\/span><\/td>[\s\S]*?<td class="num total">(\d+)<\/td>/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(rows, [['1', 'Ben', '10'], ['2', 'Anna', '3']]);
  });

  test('Verwalten: nur Leitung; Einladungslink erneuern; Mitglied zur Mitleitung machen', async () => {
    assert.equal((await ben.get(`/r/${slug}/verwalten`)).status, 403);
    const renew = await anna.post(`/r/${slug}/verwalten/einladung-neu`);
    assert.equal(renew.status, 303);
    assert.equal((await stranger.get(`/beitreten/${invite}`)).status, 404);
    const benId = (await db.one<{ id: string }>(`select id from users where email = 'ben@example.de'`))!.id;
    await anna.post(`/r/${slug}/verwalten/mitglied/${benId}`, { aktion: 'admin' });
    assert.equal((await ben.get(`/r/${slug}/verwalten`)).status, 200);
    // Mitleitung darf keine Rollen ändern
    const annaId = (await db.one<{ id: string }>(`select id from users where email = 'anna@example.de'`))!.id;
    assert.equal((await ben.post(`/r/${slug}/verwalten/mitglied/${annaId}`, { aktion: 'entfernen' })).status, 403);
  });

  test('Konto löschen: Leitung geht an Mitleitung über, Daten sind weg', async () => {
    const r = await anna.post('/konto/loeschen', { bestaetigt: 'ja' });
    assert.equal(r.location, '/?hinweis=konto-geloescht');
    assert.equal(anna.cookies.size, 0);
    const gone = await db.one<{ n: number }>(`select count(*)::int as n from users where email = 'anna@example.de'`);
    assert.equal(gone!.n, 0);
    const preds = await db.one<{ n: number }>(`select count(*)::int as n from predictions p join users u on u.id = p.user_id where u.email = 'anna@example.de'`);
    assert.equal(preds!.n, 0);
    const owner = await db.one<{ role: string }>(
      `select lm.role from league_members lm join users u on u.id = lm.user_id where u.email = 'ben@example.de'`,
    );
    assert.equal(owner!.role, 'owner');
  });

  test('Abmelden beendet die Sitzung', async () => {
    const r = await ben.post('/abmelden');
    assert.equal(r.location, '/?hinweis=abgemeldet');
    const home = await ben.get('/');
    assert.match(home.text, /Tippt die Worlds zusammen/);
    assert.equal((await ben.get(`/r/${slug}/tippen`)).status, 303);
  });

  test('Turnierdaten einspielen: mehrfach ausführbar, Einträge aus dem Admin-Bereich bleiben', async () => {
    const data = JSON.parse(readFileSync(join(root, 'db', 'daten', 'worlds-2026.json'), 'utf8')) as TournamentData;
    const first = await importTournament(db, data);
    // Gen.G, T1, G2 Esports und Karmine Corp hat der Admin schon angelegt
    assert.deepEqual([first.tournamentNew, first.teamsNew, first.teamsKnown, first.matchesNew], [true, 15, 4, 46]);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from teams'))!.n, 19);
    const tid = (await db.one<{ id: string }>(`select id from tournaments where external_id = 'worlds-2026'`))!.id;
    const get = (key: string) =>
      db.one<{ a: string | null; b: string | null; wins_a: number | null; status: string; scheduled_at: Date; matchday_starts_at: Date; stage: string }>(
        `select ta.short_name as a, tb.short_name as b, m.wins_a, m.status, m.scheduled_at, m.matchday_starts_at, s.name as stage
           from matches m left join teams ta on ta.id = m.team_a_id left join teams tb on tb.id = m.team_b_id
           left join stages s on s.id = m.stage_id
          where m.tournament_id = $1 and m.external_id = $2`,
        [tid, key],
      ).then((r) => r!);

    // Alle 19 Teams stehen bei Sonderfragen zur Auswahl, auch ohne feststehende Spiele
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from tournament_teams where tournament_id = $1', [tid]))!.n, 19);
    const league = (await db.one<{ id: string }>('select id from leagues where slug = $1', [slug]))!.id;
    const adminId = (await db.one<{ id: string }>(`select id from users where email = 'admin@example.de'`))!.id;
    await db.run(`insert into league_members (league_id, user_id) values ($1, $2) on conflict do nothing`, [league, adminId]);
    await db.run(`insert into league_tournaments (league_id, tournament_id) values ($1, $2)`, [league, tid]);
    const restoreWorlds = await postponeTournament(tid); // Sonderfragen nur vor dem ersten Spiel offen
    await db.run(`insert into bonus_questions (league_id, tournament_id, question, points, answer_type) values ($1, $2, 'Wer wird Weltmeister?', 5, 'team')`, [league, tid]);
    const bonus = await admin.get(`/r/${slug}/sonderfragen`);
    assert.equal(bonus.status, 200);
    for (const name of ['Bilibili Gaming', 'Gen.G', 'LOS', 'Team Secret Whales']) assert.match(bonus.text, new RegExp(`<option[^>]*>${name}</option>`), name);
    await restoreWorlds();

    // Admin: Teams abwählen – wer schon ein Spiel hat, bleibt
    const ids = await db.query<{ id: string; short_name: string }>('select id, short_name from teams');
    const gen = ids.find((x) => x.short_name === 'GEN')!.id;
    const page = await admin.get(`/admin/turnier/${tid}`);
    assert.match(page.text, /Teams im Turnier \(19\)/);
    const saved = await admin.post(`/admin/turnier/${tid}/teams`, new URLSearchParams([['team', gen]]));
    assert.equal(saved.status, 303, saved.text);
    const left = await db.query<{ short_name: string }>(
      'select t.short_name from tournament_teams tt join teams t on t.id = tt.team_id where tt.tournament_id = $1 order by 1', [tid]);
    assert.deepEqual(left.map((r) => r.short_name), ['C9', 'FUR', 'GEN', 'KC', 'MVK']);
    await importTournament(db, data); // stellt alle wieder her

    const kc = await get('pi-oh-1');
    assert.deepEqual([kc.a, kc.b, kc.stage, kc.scheduled_at.toISOString()], ['KC', 'C9', 'Play-In: oberes Halbfinale', '2026-10-15T18:00:00.000Z']);
    assert.equal((await get('pi-oh-2')).matchday_starts_at.toISOString(), '2026-10-15T18:00:00.000Z', 'beide Spiele am 15.10. = ein Spieltag');
    assert.equal((await get('pi-of')).matchday_starts_at.toISOString(), '2026-10-16T18:00:00.000Z');

    // Zweiter Lauf: nichts doppelt, nichts geändert
    const again = await importTournament(db, data);
    assert.deepEqual([again.tournamentNew, again.teamsNew, again.matchesNew, again.matchesChanged, again.matchesUnchanged], [false, 0, 0, 0, 46]);

    // Im Admin-Bereich eingetragen: Teams fürs obere Finale, Ergebnis des ersten Spiels
    await db.run(`update matches set team_a_id = $2, team_b_id = $3 where tournament_id = $1 and external_id = 'pi-of'`, [tid, team.KC, team.T1]);
    await db.run(`update matches set wins_a = 3, wins_b = 1, status = 'finished' where tournament_id = $1 and external_id = 'pi-oh-1'`, [tid]);
    // Neue Datei-Version: Finale eine Stunde später
    const newer = structuredClone(data);
    newer.matches.find((m) => m.key === 'finale')!.scheduled_at = '2026-11-14T15:00:00-05:00';
    const third = await importTournament(db, newer);
    assert.deepEqual([third.matchesNew, third.matchesChanged, third.matchesUnchanged], [0, 1, 45]);
    assert.deepEqual([(await get('pi-of')).a, (await get('pi-of')).b], ['KC', 'T1']);
    assert.deepEqual([(await get('pi-oh-1')).wins_a, (await get('pi-oh-1')).status], [3, 'finished']);
    assert.equal((await get('finale')).scheduled_at.toISOString(), '2026-11-14T20:00:00.000Z');

    // Wurde schon getippt, tauscht ein Import die Teams nicht mehr (sonst landeten Tipps beim anderen Team)
    const kcMatch = (await db.one<{ id: string }>(`select id from matches where tournament_id = $1 and external_id = 'pi-oh-2'`, [tid]))!.id;
    await db.tx(async (q) => {
      await q.exec(`set local app.bypass_lock = 'on'`);
      await q.run(`insert into predictions (league_id, match_id, user_id, winner, winner_wins, loser_wins) values ($1, $2, $3, 'A', 3, 1)`, [league, kcMatch, adminId]);
    });
    const swapped = structuredClone(newer);
    const m2 = swapped.matches.find((m) => m.key === 'pi-oh-2')!;
    [m2.team_a, m2.team_b] = [m2.team_b, m2.team_a];
    const fourth = await importTournament(db, swapped);
    assert.equal(fourth.matchesChanged, 0);
    assert.deepEqual([(await get('pi-oh-2')).a, (await get('pi-oh-2')).b], ['FUR', 'MVK']);

    // Fehlerhafte Datei: abgelehnt, bevor etwas passiert
    const broken = structuredClone(data);
    broken.matches[0].team_b = 'XYZ';
    await assert.rejects(importTournament(db, broken), /team_b "XYZ"/);
    // Fehler mitten im Import (gleiches Team auf beiden Seiten): alles wird zurückgenommen
    const clash = structuredClone(newer);
    clash.teams.push({ key: 'NEU', name: 'Ganz neues Team' });
    clash.matches.find((m) => m.key === 'pi-of')!.team_b = 'KC';
    await assert.rejects(importTournament(db, clash));
    assert.equal((await db.one<{ n: number }>(`select count(*)::int as n from teams where name = 'Ganz neues Team'`))!.n, 0);

    // Ein von Hand angelegtes Turnier mit gleichem Namen wird übernommen statt verdoppelt
    const manual = await db.one<{ id: string }>(`insert into tournaments (name) values ('Hand Cup') returning id`);
    const adopted = await importTournament(db, { tournament: { key: 'hand-cup', name: 'Hand Cup' }, teams: [], matches: [] });
    assert.equal(adopted.tournamentNew, false);
    assert.equal((await db.one<{ external_id: string }>('select external_id from tournaments where id = $1', [manual!.id]))!.external_id, 'hand-cup');
  });

  test('Datenabgleich: Champions und Kader; Sonderfragen mit Champion- und Spielerauswahl', async () => {
    // Worlds 2026 ist aus dem vorigen Test eingespielt; die Tipprunde hat das Turnier und den Admin als Mitglied
    const tid = (await db.one<{ id: string }>(`select id from tournaments where external_id = 'worlds-2026'`))!.id;
    const league = (await db.one<{ id: string }>('select id from leagues where slug = $1', [slug]))!.id;
    const before = await admin.get('/admin');
    assert.match(before.text, /Datenabgleich mit Riot/);
    assert.match(before.text, /noch nie/);

    const r = await admin.post('/admin/abgleich');
    assert.equal(r.status, 303, r.text);
    assert.equal(r.location, '/admin?hinweis=abgeglichen');
    const n = (await db.one<{ c: number; p: number; t: number }>(
      `select (select count(*)::int from champions) as c, (select count(*)::int from players where active) as p,
              (select count(*)::int from teams where external_id is not null) as t`,
    ))!;
    // Die vier Teams aus dem Admin-Test haben die Region "X" – sie werden trotzdem über Name und Kürzel gefunden
    assert.deepEqual([n.c, n.t], [120, 19]);
    assert.ok(n.p > 19 * 5, `${n.p} Spieler`);
    assert.match((await admin.get('/admin')).text, /Spieler aus 19 von 19 Teams/);

    // Fragen mit Spieler- und Champion-Auswahl
    const mvp = (await db.one<{ id: string }>(
      `insert into bonus_questions (league_id, tournament_id, question, points, answer_type) values ($1, $2, 'Wer wird Finals-MVP?', 3, 'player') returning id`,
      [league, tid],
    ))!.id;
    const champ = (await db.one<{ id: string }>(
      `insert into bonus_questions (league_id, tournament_id, question, points, answer_type, choices) values ($1, $2, 'Meistgebannt?', 3, 'champion', '{}') returning id`,
      [league, tid],
    ))!.id;
    const restoreAgain = await postponeTournament(tid);
    const page = await admin.get(`/r/${slug}/sonderfragen`);
    assert.match(page.text, /<optgroup label="T1">/);
    assert.match(page.text, /<option value="Faker">Faker \(Mid\)<\/option>/);
    assert.match(page.text, /<option value="Wukong">Wukong<\/option>/);
    assert.match(page.text, /<option value="Kai&#39;Sa">Kai&#39;Sa<\/option>/);
    const saved = await admin.post(`/r/${slug}/sonderfragen`, { [`antwort_${mvp}`]: 'Faker', [`antwort_${champ}`]: 'Wukong' });
    assert.equal(saved.location, `/r/${slug}/sonderfragen?hinweis=antworten-gespeichert`);

    // Faker verlässt den Kader: nicht mehr in der Liste, die abgegebene Antwort bleibt
    const changed = structuredClone(lolesports);
    const t1 = changed.data.teams.find((t: { slug: string }) => t.slug === 't1');
    t1.players = t1.players.filter((p: { summonerName: string }) => p.summonerName !== 'Faker');
    const base = fakeRiot();
    await runSync(db, async (url, headers) => (url.includes('/getTeams') ? changed : base(url, headers)));
    const after = await admin.get(`/r/${slug}/sonderfragen`);
    assert.doesNotMatch(after.text, /Faker \(Mid\)/);
    assert.match(after.text, /<option value="Faker" selected>Faker<\/option>/);

    // Quelle nicht erreichbar: Fehler wird angezeigt, vorhandene Listen bleiben
    const failed = await runSync(db, async () => {
      throw new Error('offline');
    });
    assert.ok(failed.every((x) => !x.ok));
    assert.equal((await db.one<{ c: number }>('select count(*)::int as c from champions'))!.c, 120);
    assert.match((await admin.get('/admin')).text, /Fehler: offline/);
    await restoreAgain();
  });

  test('Spielplan-Abgleich: Paarungen, Ergebnisse (richtig herum), Anstoßzeiten; Admin-Einträge bleiben', async () => {
    const tid = (await db.one<{ id: string }>(`select id from tournaments where external_id = 'worlds-2026'`))!.id;
    // Test unabhängig vom heutigen Datum: Turnier läuft noch
    await db.run(`update tournaments set ends_on = current_date + 30 where id = $1`, [tid]);
    assert.equal((await db.one<{ source: string }>('select source from tournaments where id = $1', [tid]))!.source, 'lolesports:worlds');
    const get = (key: string) =>
      db.one<{ a: string | null; b: string | null; wins_a: number | null; wins_b: number | null; status: string; scheduled_at: Date; source_id: string | null }>(
        `select ta.short_name as a, tb.short_name as b, m.wins_a, m.wins_b, m.status, m.scheduled_at, m.source_id
           from matches m left join teams ta on ta.id = m.team_a_id left join teams tb on tb.id = m.team_b_id
          where m.tournament_id = $1 and m.external_id = $2`,
        [tid, key],
      ).then((r) => r!);

    // Stand heute: alle 40 Spiele werden über Anstoßzeit und Format verknüpft, sonst ändert sich nichts
    const first = await runSync(db, fakeRiot(), 'haeufig');
    assert.ok(first[0].ok, first[0].details);
    assert.match(first[0].details, /40 Spiele bei lolesports/);
    const linked = (await db.one<{ n: number }>('select count(*)::int as n from matches where tournament_id = $1 and source_id is not null', [tid]))!.n;
    assert.equal(linked, 40); // alle Spiele aus den Testdaten (Play-In bis Viertelfinale 1)
    assert.equal((await get('pi-oh-1')).source_id, '115660588583171786');

    // Ein paar Tage später: Ergebnisse, neue Paarung, verschobene Anstoßzeit
    const later = structuredClone(worldsSchedule);
    const ev = later.data.schedule.events as { startTime: string; state: string; match: { id: string; teams: { name: string; code: string; result: unknown }[] } }[];
    const byId = (id: string) => ev.find((e) => e.match.id === id)!;
    // pi-oh-1 (C9–KC): hat schon ein Ergebnis aus dem Admin-Bereich (3:1 für KC) – Riot meldet etwas anderes
    Object.assign(byId('115660588583171786'), { state: 'completed' });
    byId('115660588583171786').match.teams[0].result = { outcome: 'win', gameWins: 3 };
    byId('115660588583171786').match.teams[1].result = { outcome: 'loss', gameWins: 0 };
    // pi-oh-2: Riot führt MVK zuerst, bei uns ist FURIA Team A – Ergebnis muss richtig herum landen
    const e2 = byId('115660588583040710');
    e2.state = 'completed';
    e2.match.teams = [
      { name: 'MVK Esports', code: 'MVK', result: { outcome: 'loss', gameWins: 2 } },
      { name: 'FURIA', code: 'FUR', result: { outcome: 'win', gameWins: 3 } },
    ];
    // unteres Halbfinale am 16.10. (bei uns noch offen): jetzt C9 gegen MVK
    ev[2].match.teams = [
      { name: 'Cloud9 Kia', code: 'C9', result: { outcome: null, gameWins: 0 } },
      { name: 'MVK Esports', code: 'MVK', result: { outcome: null, gameWins: 0 } },
    ];
    // oberes Finale: bei uns schon von Hand KC–T1 eingetragen, Riot meldet KC–FURIA → nicht überschreiben, melden
    ev[3].match.teams = [
      { name: 'Karmine Corp', code: 'KC', result: null },
      { name: 'FURIA', code: 'FUR', result: null },
    ];
    // Swiss-Auftakt 30 Minuten später
    const swiss = ev.find((e) => e.startTime === '2026-10-23T17:00:00Z')!;
    swiss.startTime = '2026-10-23T17:30:00Z';

    const second = await runSync(db, fakeRiot(120, later), 'haeufig');
    assert.ok(second[0].ok, second[0].details);
    assert.match(second[0].details, /1 Paarungen eingetragen, 1 Ergebnisse eingetragen, 1 Anstoßzeiten geändert/);
    assert.match(second[0].details, /1 mit abweichenden Teams/);
    assert.deepEqual(Object.values(await get('pi-oh-2')).slice(0, 5), ['FUR', 'MVK', 3, 2, 'finished']);
    assert.deepEqual([(await get('pi-oh-1')).wins_a, (await get('pi-oh-1')).wins_b], [3, 1], 'Admin-Ergebnis bleibt');
    assert.deepEqual([(await get('pi-uh')).a, (await get('pi-uh')).b], ['C9', 'MVK']);
    assert.deepEqual([(await get('pi-of')).a, (await get('pi-of')).b], ['KC', 'T1']);
    assert.equal((await get('swiss-1-1')).scheduled_at.toISOString(), '2026-10-23T17:30:00.000Z');

    // Nochmal: nichts Neues
    const third = await runSync(db, fakeRiot(120, later), 'haeufig');
    assert.doesNotMatch(third[0].details, /eingetragen|geändert|verknüpft/);

    // Tippseite: Knöpfe für die Phasen, nur bekannte Paarungen
    const tipPage = await admin.get(`/r/${slug}/tippen?phase=play-in`);
    assert.match(tipPage.text, /<nav class="phase-tabs"/);
    assert.match(tipPage.text, /<a href="\/r\/[a-z0-9-]+\/tippen\?phase=play-in" aria-current="page">Play-In/);
    assert.match(tipPage.text, /phase=swiss" class="later">Swiss/);
    assert.match(tipPage.text, /Cloud9/);
    assert.match(tipPage.text, /weitere Spiele dieser Phase erscheinen hier/);
    const swissPage = await admin.get(`/r/${slug}/tippen?phase=swiss`);
    assert.match(swissPage.text, /Die Paarungen für Swiss stehen noch nicht fest/);
    assert.match(swissPage.text, /Freitag, 23\. Oktober/);
    assert.doesNotMatch(swissPage.text, /class="match/);
  });

  test('Layout: Werbeflächen links und rechts', async () => {
    const pub = await new Client().get('/impressum');
    assert.equal((pub.text.match(/class="ad ad-(left|right)"/g) ?? []).length, 2);
  });

  test('Turnierbaum: Phasen, Begegnungen, ausgeschiedene Teams grau', async () => {
    const tid = (await db.one<{ id: string }>(`select id from tournaments where external_id = 'worlds-2026'`))!.id;
    const matchId = async (key: string) => (await db.one<{ id: string }>(`select id from matches where tournament_id = $1 and external_id = $2`, [tid, key]))!.id;
    const path = `/r/${slug}/turnierbaum`;

    // Nur Mitglieder; Reiter neben "Alle Tipps"
    assert.equal((await stranger.get(path)).status, 404);
    assert.equal((await new Client().get(path)).status, 303);
    const first = await admin.get(path);
    assert.equal(first.status, 200);
    assert.match(first.text, /<a href="\/r\/[a-z0-9-]+\/alle-tipps">Alle Tipps<\/a>\s*<a href="\/r\/[a-z0-9-]+\/turnierbaum" aria-current="page">Turnierbaum<\/a>/);
    // Zwei Turniere in der Tipprunde: Auswahl oben; fremde Turnier-Nummern werden ignoriert
    assert.match(first.text, /<nav class="phase-tabs" aria-label="Turniere">/);
    assert.equal((await admin.get(`${path}?turnier=${tid}x`)).status, 200);

    const play = await admin.get(`${path}?turnier=${tid}&phase=play-in`);
    assert.equal(play.status, 200);
    assert.match(play.text, /<h1 class="bk-title">Worlds 2026<\/h1>/);
    assert.match(play.text, /<nav class="phase-tabs" aria-label="Phasen">/);
    assert.match(play.text, /phase=swiss"/);
    assert.match(play.text, /phase=k-o-phase"/);
    for (const round of ['Oberes Halbfinale', 'Unteres Halbfinale', 'Oberes Finale', 'Unteres Finale', 'Finale']) {
      assert.match(play.text, new RegExp(`<h3 class="bk-round-title">${round}</h3>`));
    }
    assert.match(play.text, /Doppeltes K\.o\./);
    assert.match(play.text, new RegExp(`href="/r/${slug}/spiel/${await matchId('pi-oh-1')}"`));
    // Noch ist niemand ausgeschieden (alle haben höchstens eine Niederlage)
    assert.doesNotMatch(play.text, /bk-out/);
    // Offene Paarungen ohne Link
    assert.match(play.text, /class="bk-match bk-open"/);

    // Unteres Halbfinale C9 – MVK endet 3:0: MVK hat zwei Niederlagen und ist ausgeschieden
    await db.run(`update matches set wins_a = 3, wins_b = 0, status = 'finished' where id = $1`, [await matchId('pi-uh')]);
    const after = await admin.get(`${path}?turnier=${tid}&phase=play-in`);
    assert.match(after.text, /bk-team bk-b bk-lost bk-out"[^]*?title="MVK Esports">MVK<\/span>[^]*?\(ausgeschieden\)/);
    assert.match(after.text, /<li class="bk-chip bk-out" title="MVK Esports">MVK/);
    assert.doesNotMatch(after.text, /<li class="bk-chip bk-out" title="Cloud9[^"]*">/, 'C9 hat erst eine Niederlage');
    assert.match(after.text, /bk-legend/);

    // Swiss: Runden stehen schon, die Paarungen sind noch offen
    const swiss = await admin.get(`${path}?turnier=${tid}&phase=swiss`);
    assert.match(swiss.text, /Schweizer System/);
    assert.match(swiss.text, /<h3 class="bk-round-title">Runde 5<\/h3>/);
    assert.doesNotMatch(swiss.text, /bk-table/);
    // K.-o.-Phase: Viertelfinale, Halbfinale, Finale als Spalten
    const ko = await admin.get(`${path}?turnier=${tid}&phase=k-o-phase`);
    for (const round of ['Viertelfinale', 'Halbfinale', 'Finale']) assert.match(ko.text, new RegExp(`<h3 class="bk-round-title">${round}</h3>`));
    // Unbekannte Phase → die aktuelle wird gezeigt
    assert.equal((await admin.get(`${path}?turnier=${tid}&phase=gibt-es-nicht`)).status, 200);
  });
});
