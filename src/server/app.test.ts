// Ablauf-Test der ganzen App gegen eine echte, LEERE PostgreSQL-Datenbank.
//
//   TEST_DATABASE_URL=postgres://… npm run test:app
//
// Ohne TEST_DATABASE_URL wird der Test übersprungen.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { notifyDue } from './benachrichtigung.ts';
import { purgeOldMessages } from './routes/chat.ts';

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
      const r = await this.post('/registrieren', { display_name: name ?? email.split('@')[0], first_name: 'Test', email, password: PASSWORT, weiter: next });
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

const UPDATE_FILE = join(tmpdir(), `tippspiel-update-anfrage-${process.pid}`);
const BACKUP_FILE = join(tmpdir(), `tippspiel-sicherung-anfrage-${process.pid}`);
const BACKUP_DIR = join(tmpdir(), `tippspiel-sicherungen-${process.pid}`);

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
      UPDATE_REQUEST_FILE: UPDATE_FILE,
      BACKUP_REQUEST_FILE: BACKUP_FILE,
      BACKUP_DIR,
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
    const bad = await anna.post('/registrieren', { display_name: 'Anna', first_name: 'Anna', email: 'kein-at-zeichen', password: PASSWORT });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /gültige E-Mail-Adresse/);
    const short = await anna.post('/registrieren', { display_name: 'Anna', first_name: 'Anna', email: 'anna@example.de', password: 'kurz' });
    assert.match(short.text, /mindestens 8 Zeichen/);

    const r = await anna.login('Anna@Example.de', 'Anna');
    assert.equal(r.location, '/');
    const home = await anna.get('/');
    assert.match(home.text, /Deine Tipprunden/);
    assert.match(home.text, />Anna</);
    const dup = await new Client().post('/registrieren', { display_name: 'Anna 2', first_name: 'Anna', email: 'anna@example.de', password: PASSWORT });
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
    assert.equal(changed.location, '/konto?bereich=sicherheit&hinweis=passwort-gespeichert');
    anna.cookies.clear();
    assert.equal((await anna.login('anna@example.de')).location, '/');

    // E-Mail-Adresse ändern: erst nach Klick auf den Link in der Mail an die neue Adresse
    const konto = await anna.get('/konto?bereich=sicherheit');
    assert.match(konto.text, /E-Mail-Adresse ändern/);
    assert.match(konto.text, /class="top-logout"/);
    assert.match(konto.text, /name="password2"/);
    assert.match((await anna.post('/konto/email', { email: 'anna.neu@example.de', current: 'falsch' })).text, /Passwort stimmt nicht/);
    assert.match((await anna.post('/konto/email', { email: 'kaputt', current: PASSWORT })).text, /gültige E-Mail/);
    await db.run(`insert into users (email, display_name) values ('vergeben@example.de', 'Vergeben')`);
    const sentBefore = mailer.sent!.length;
    assert.equal((await anna.post('/konto/email', { email: 'vergeben@example.de', current: PASSWORT })).location, '/konto?bereich=sicherheit&hinweis=email-gesendet');
    assert.equal(mailer.sent!.length, sentBefore, 'vergebene Adresse: keine Mail, aber auch kein Hinweis darauf');
    assert.equal((await anna.post('/konto/email', { email: 'anna.neu@example.de', current: PASSWORT })).location, '/konto?bereich=sicherheit&hinweis=email-gesendet');
    const cm = [...mailer.sent!].reverse().find((m) => m.to === 'anna.neu@example.de')!;
    const confirm = new URL(/https?:\/\/[^\s]+\/konto\/email-bestaetigen\?[^\s]+/.exec(cm.text)![0]);
    assert.equal((await new Client().get(confirm.pathname + confirm.search)).status, 303, 'ohne Anmeldung nicht einlösbar');
    assert.equal((await anna.get(confirm.pathname + confirm.search)).location, '/konto?bereich=sicherheit&hinweis=email-geaendert');
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
    assert.equal((await admin.post('/admin/einstellungen', { league_creation: 'alle' })).location, '/admin?bereich=uebersicht&hinweis=gespeichert');
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
    const manage = await anna.get(`/r/${slug}/verwalten?bereich=mitglieder`);
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
    assert.match(page.text, new RegExp(`class="brand" href="/r/${slug}/tippen"`)); // Logo führt zu „Tippen“
    assert.doesNotMatch(page.text, /league-switch/); // nur eine Tipprunde → kein Dropdown
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
    assert.doesNotMatch(hidden.text, /<td>Ben<\/td>/, 'Tipps der anderen stehen noch nicht in der Tabelle');
    // Reiter "Alle Tipps": vor dem Tippschluss noch leer
    const all = await anna.get(`/r/${slug}/alle-tipps`);
    assert.equal(all.status, 200);
    assert.match(all.text, /Noch sind keine Tipps zu sehen/);
    assert.match(all.text, /aria-current="page">Alle Tipps</);
    assert.doesNotMatch(all.text, /<td>Ben<\/td>|B-3-2/);
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
    const rows = [...table.text.matchAll(/<td class="num rank">(\d+)<\/td>\s*<td><a class="who who-link"[^>]*>(?:<img[^>]*>|<span class="avatar[^"]*"[^>]*>[^<]*<\/span>)<span>([^<]+)<\/span><\/a>[\s\S]*?<td class="num total">(\d+)<\/td>/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(rows, [['1', 'Anna', '3'], ['2', 'Ben', '2']]);

    const tips = await anna.get(`/r/${slug}/tippen`);
    assert.match(tips.text, /Vorbei/);
    assert.doesNotMatch(tips.text, /pts-exact/, 'Punkte der Spiele verraten sonst das Ergebnis – sie stehen nur in der aufklappbaren Tipp-Liste');
    assert.match(tips.text, /<td class="num hit">2<\/td>/);
    // Gewinnchance aus den Tipps: GEN–T1 je einer (50/50), G2–KC beide auf KC (100/0); offene Spiele zeigen nichts
    assert.equal((tips.text.match(/class="pct pct-[ab] pct-even"/g) ?? []).length, 2);
    assert.match(tips.text, /class="pct pct-[ab] pct-up"[^>]*>100 %</);
    assert.match(tips.text, /class="pct pct-[ab] pct-down"[^>]*>0 %</);
    assert.match(tips.text, /class="tipped">\(\d+\/\d+ Spieler getippt\)/);
    // Gewonnene Spiele je Team mit Spoilerschutz (GEN 3:1, G2–KC 1:2)
    assert.equal((tips.text.match(/<button type="button" class="score" data-spoiler/g) ?? []).length, 2, 'ein Block je Begegnung');
    assert.match(tips.text, /class="score-num">3<\/span>/);
    assert.doesNotMatch(tips.text, /<summary><span>[^<]*<\/span><span class="pts/, 'keine Tagespunkte in der Kopfzeile');
    // Spoilerschutz ist abschaltbar (Standard: an)
    assert.match((await anna.get('/konto?bereich=anzeige')).text, /Spoilerschutz bei Ergebnissen/);
    assert.match((await anna.post('/konto/anzeige', { spoiler: 'aus' })).location ?? '', /anzeige-gespeichert/);
    const open = (await anna.get(`/r/${slug}/tippen`)).text;
    assert.match(open, /class="score revealed plain"/);
    assert.doesNotMatch(open, /data-spoiler/);
    await anna.post('/konto/anzeige', { spoiler: 'an' });
    assert.doesNotMatch(tips.text, /class="match-foot"[^>]*>[^]*?Ergebnis:/, 'Ergebnis steht nur hinter dem Spoilerschutz');
    assert.match(tips.text, /class="foot-version">Version: [^]*?<br>Letztes Update: /);
    assert.equal((tips.text.match(/class="pct /g) ?? []).length, 4);
    assert.equal((tips.text.match(/<details class="tips-fold">/g) ?? []).length, 2, 'aufklappbare Tipps nur bei den zwei begonnenen Spielen');
    assert.match(tips.text, /<summary>Tipps der Mitspieler<\/summary>[^]*?<td>Ben<\/td>/);
    // Rangliste in der Seitenleiste, klickbar zur Rangliste
    assert.match(tips.text, new RegExp(`<a class="rank-stretch rank-title" href="/r/${slug}/rangliste">`));

    // Reiter "Alle Tipps": beide geschlossenen Spiele mit allen Tipps und Punkten – offene Spiele nicht
    const all = await ben.get(`/r/${slug}/alle-tipps`);
    assert.equal(all.status, 200);
    for (const id of [match['GEN-T1'], match['G2-KC']]) assert.match(all.text, new RegExp(`id="tipps-${id}"`));
    assert.doesNotMatch(all.text, new RegExp(match['T1-KC']));
    const block = (id: string) => all.text.slice(all.text.indexOf(`id="tipps-${id}"`)).split('</article>')[0];
    const rowsOf = (id: string) => [...block(id).matchAll(/<tr( class="me")?>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td class="num( hit)?">(\d*)<\/td>/g)].map((r) => [r[2], r[3], r[5], !!r[1]]);
    assert.deepEqual(rowsOf(match['GEN-T1']), [['Anna', 'GEN 3:1', '2', false], ['Ben', 'T1 3:2', '0', true]]);
    assert.deepEqual(rowsOf(match['G2-KC']), [['Ben', 'KC 2:1', '2', true], ['Anna', 'KC 2:0', '1', false]]); // nach Punkten absteigend
  });

  test('Kopfzeile: Countdown vor dem Start, danach Livestream-Links', async () => {
    const restore = await postponeTournament(tournamentId);
    const before = await anna.get(`/r/${slug}/tippen`);
    assert.match(before.text, /data-countdown="/);
    assert.match(before.text, /twitch\.tv/, 'Links gibt es schon vor dem Start');
    await restore();
    const after = await anna.get(`/r/${slug}/tippen`);
    assert.doesNotMatch(after.text, /data-countdown/);
    assert.match(after.text, /class="tbar-label">[^<]+<\/span>/, 'läuft: nur der Turniername');
    assert.doesNotMatch(after.text, /class="tbar-label">[^<]* in<\/span>/);
    assert.match(after.text, /href="https:\/\/www\.twitch\.tv\/riotgames"/);
    assert.match(after.text, /href="https:\/\/www\.youtube\.com\/@lolesports"/);
  });

  test('Administrator: Reiter, keine Turnier-Bearbeitung auf der Startseite', async () => {
    const home = await admin.get('/admin');
    assert.match(home.text, /class="sub-tabs"/);
    assert.doesNotMatch(home.text, /Neues Turnier|Teams \(\d+\)/);
    for (const area of ['uebersicht', 'nutzer', 'abgleich', 'impressum', 'datenschutz']) {
      assert.equal((await admin.get(`/admin?bereich=${area}`)).status, 200, area);
    }
    assert.match((await admin.get('/admin?bereich=nutzer')).text, /admin@example\.de/);
    assert.match((await admin.get('/admin?bereich=datenschutz')).text, /name="hosting"/);
    assert.doesNotMatch((await admin.get('/admin?bereich=datenschutz')).text, /name="street"/);
  });

  test('Rechtliches: Impressum/Datenschutz öffentlich, Angaben nur vom Admin', async () => {
    const pub = await new Client().get('/impressum');
    assert.equal(pub.status, 200);
    assert.match(pub.text, /Name fehlt noch/);
    assert.match(pub.text, /href="\/datenschutz"/, 'Footer-Links');
    assert.equal((await new Client().get('/datenschutz')).status, 200);
    assert.equal((await anna.get('/admin/rechtliches')).status, 404, 'normale Nutzer: nicht vorhanden');
    assert.equal((await anna.post('/admin/rechtliches', { name: 'X' })).status, 404);
    const adm = await admin.post('/admin/rechtliches', { name: 'Max <b>Muster', email: 'kontakt@example.de', street: 'Weg 1', city: '12345 Stadt', country: 'Deutschland', hosting: 'Eigener Server' });
    assert.equal(adm.location, '/admin?bereich=impressum&hinweis=gespeichert');
    const after = (await new Client().get('/impressum')).text;
    assert.match(after, /Max &lt;b&gt;Muster/);
    assert.doesNotMatch(after, /Name fehlt noch/);
    await db.run(`delete from app_settings where key like 'legal\\_%'`);
  });

  test('Avatare: Upload, Rangliste, Abruf nur angemeldet', async () => {
    // kleines gültiges JPEG-Gerüst (Prüfung nur auf Kopf/Ende und Größe)
    const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1), Buffer.from([0xff, 0xd9])]);
    const url = `data:image/jpeg;base64,${body.toString('base64')}`;
    assert.equal((await anna.post('/konto/avatar', { avatar: 'data:image/png;base64,AAAA' })).location, '/konto?bereich=profil&hinweis=avatar-fehler');
    assert.equal((await anna.post('/konto/avatar', { avatar: 'data:image/jpeg;base64,' + Buffer.alloc(60_000, 7).toString('base64') })).location, '/konto?bereich=profil&hinweis=avatar-fehler', 'zu groß / kein JPEG');
    assert.equal((await anna.post('/konto/avatar', { avatar: url })).location, '/konto?bereich=profil&hinweis=avatar-gespeichert');
    const id = (await db.one<{ id: string }>(`select id from users where email = 'anna@example.de'`))!.id;
    const img = await anna.get(`/avatar/${id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await new Client().get(`/avatar/${id}`)).status, 303, 'nicht ohne Anmeldung');
    assert.match((await anna.get(`/r/${slug}/rangliste`)).text, new RegExp(`src="/avatar/${id}\\?v=\\d+"`));
    assert.equal((await anna.post('/konto/avatar/loeschen')).location, '/konto?bereich=profil&hinweis=avatar-geloescht');
    assert.equal((await anna.get(`/avatar/${id}`)).status, 404);
  });

  test('Verwalten: Untermenü und Übersicht "Noch nicht getippt" ohne Tipp-Inhalte', async () => {
    const start = await anna.get(`/r/${slug}/verwalten`);
    assert.match(start.text, /class="sub-tabs"/);
    assert.match(start.text, /\d+\/\d+ Teilnehmer haben getippt/);
    assert.doesNotMatch(start.text, /id="turniere"|id="fragen"/, 'andere Bereiche stehen auf eigenen Seiten');
    for (const area of ['einstellungen', 'turniere', 'fragen', 'mitglieder']) {
      const r = await anna.get(`/r/${slug}/verwalten?bereich=${area}`);
      assert.equal(r.status, 200, area);
      assert.doesNotMatch(r.text, /\d+\/\d+ Teilnehmer haben getippt/);
    }
    assert.match((await anna.get(`/r/${slug}/verwalten?bereich=mitglieder`)).text, /Mitglieder \(\d+\)/);
    // Mit offenem Spiel in der Zukunft taucht Ben ohne Tipp auf – nur mit Anzahl und Frist
    const restore = await postponeTournament(tournamentId);
    const open = await anna.get(`/r/${slug}/verwalten`);
    assert.match(open.text, /Nächster Tippschluss/);
    assert.match(open.text, /Ben/);
    assert.match(open.text, /progress-bad">\d+\/\d+ Teilnehmer haben getippt/, 'offene Tipps rot');
    await restore();
  });

  test('Sonderfragen: auswählen, beantworten, Frist, Auflösung', async () => {
    // Frist = Start des ersten Spiels; hier noch in der Zukunft, damit die Auswahl offen ist
    const restore = await postponeTournament(tournamentId);
    const manage = await anna.get(`/r/${slug}/verwalten?bereich=fragen`);
    assert.match(manage.text, /name="frage" value="weltmeister"/);
    assert.doesNotMatch(manage.text, /name="frage"[^>]*disabled/);
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
    // Einstellungen stehen in derselben Liste und werden mit der Auswahl gespeichert
    const withSettings = new URLSearchParams(all);
    withSettings.set('punkte_weltmeister', '7');
    withSettings.set('antworten_weltmeister', 'Gen.G\nT1');
    assert.equal((await anna.post(`/r/${slug}/verwalten/fragen-auswahl`, withSettings)).status, 303);
    const wm = (await db.one<{ points: number; correct_answers: string[] }>(`select points, correct_answers from bonus_questions where catalog_key = 'weltmeister'`))!;
    assert.deepEqual([wm.points, wm.correct_answers], [7, ['Gen.G', 'T1']]);
    await db.run(`update bonus_questions set points = 5, correct_answers = '{}' where catalog_key = 'weltmeister'`);

    // Vorschlag für neue Fragen geht per E-Mail an den Betreiber
    assert.equal((await anna.post(`/r/${slug}/verwalten/frage-vorschlag`, { vorschlag: '   ' })).status, 400);
    const sug = await anna.post(`/r/${slug}/verwalten/frage-vorschlag`, { vorschlag: 'Wer holt den ersten Baron?' });
    assert.equal(sug.location, `/r/${slug}/verwalten?bereich=fragen&hinweis=vorschlag-gesendet`);
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

    // Vor der Frist sieht man die Antworten der anderen nicht; Fortschritt zählt alle Teilnehmer, Fragen sind einklappbar
    const before = (await anna.get(`/r/${slug}/sonderfragen`)).text;
    assert.doesNotMatch(before, /chovy/);
    assert.match(before, /\(\d\/\d+ haben die Fragen beantwortet\)/);
    assert.match(before, /<details class="q-fold">/);

    // Erstes Spiel hat begonnen → keine Änderungen mehr, Antworten aller sichtbar (und maskiert)
    await restore();
    const locked = await anna.get(`/r/${slug}/verwalten?bereich=fragen`);
    assert.match(locked.text, /name="frage"[^>]*disabled/);
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
    const rows = [...table.text.matchAll(/<td class="num rank">(\d+)<\/td>\s*<td><a class="who who-link"[^>]*>(?:<img[^>]*>|<span class="avatar[^"]*"[^>]*>[^<]*<\/span>)<span>([^<]+)<\/span><\/a>[\s\S]*?<td class="num total">(\d+)<\/td>/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(rows, [['1', 'Ben', '10'], ['2', 'Anna', '3']]);
  });

  test('Tippen: begonnene Spiele zeigen Gewinnchance und Tipps der anderen auch an einem Tag mit noch offenem Spiel', async () => {
    const saved = await db.one<{ scheduled_at: Date }>('select scheduled_at from matches where id = $1', [match['T1-KC']]);
    const mode = await db.one<{ lock_mode: string }>('select lock_mode from leagues where slug = $1', [slug]);
    await db.run(`update leagues set lock_mode = 'match' where slug = $1`, [slug]);
    await db.run(`update matches set scheduled_at = now() + interval '2 hours' where id = $1`, [match['T1-KC']]);
    const page = await anna.get(`/r/${slug}/tippen`);
    assert.match(page.text, new RegExp(`name="tipp_${match['T1-KC']}"`), 'T1–KC ist noch tippbar');
    assert.equal((page.text.match(/<details class="tips-fold">/g) ?? []).length, 2, 'Tipps der anderen bei den zwei begonnenen Spielen');
    assert.match(page.text, /class="pct pct-[ab] pct-up"/);
    await db.run(`update matches set scheduled_at = $2 where id = $1`, [match['T1-KC'], saved!.scheduled_at]);
    await db.run('update leagues set lock_mode = $2 where slug = $1', [slug, mode!.lock_mode]);
  });

  test('Verwalten: nur Spielleiter; Einladungslink erneuern; Mitglied zum Mit-Spielleiter machen', async () => {
    assert.equal((await ben.get(`/r/${slug}/verwalten`)).status, 403);
    const renew = await anna.post(`/r/${slug}/verwalten/einladung-neu`);
    assert.match(renew.location ?? "", /bereich=mitglieder&hinweis=link-erneuert/);
    assert.equal((await stranger.get(`/beitreten/${invite}`)).status, 404);
    const benId = (await db.one<{ id: string }>(`select id from users where email = 'ben@example.de'`))!.id;
    await anna.post(`/r/${slug}/verwalten/mitglied/${benId}`, { aktion: 'admin' });
    assert.equal((await ben.get(`/r/${slug}/verwalten`)).status, 200);
    // Mit-Spielleiter darf keine Rollen ändern
    const annaId = (await db.one<{ id: string }>(`select id from users where email = 'anna@example.de'`))!.id;
    assert.equal((await ben.post(`/r/${slug}/verwalten/mitglied/${annaId}`, { aktion: 'entfernen' })).status, 403);
  });

  test('Benachrichtigungen: Einstellung im Konto, Push-Gerät, Erinnerung nur bei fehlenden Tipps und nur einmal', async () => {
    const page = await ben.get('/konto?bereich=benachrichtigungen');
    assert.match(page.text, /Benachrichtigungen/);
    assert.match(page.text, /name="stunden"/);
    assert.match(page.text, /data-push data-key="[A-Za-z0-9_-]{80,100}"/);

    const bad = await ben.post('/konto/benachrichtigung', { email: 'ja', stunden: '0', minuten: '2' });
    assert.equal(bad.status, 400);
    const ok = await ben.post('/konto/benachrichtigung', { email: 'ja', stunden: '200', minuten: '0' });
    assert.equal(ok.status, 400, 'mehr als 7 Tage');
    const saved = await ben.post('/konto/benachrichtigung', { email: 'ja', stunden: '168', minuten: '0' });
    assert.match(saved.location ?? '', /hinweis=benachrichtigung-gespeichert/);
    const prefs = await db.one<{ email_enabled: boolean; push_enabled: boolean; lead_minutes: number }>(
      `select p.* from notification_prefs p join users u on u.id = p.user_id where u.email = 'ben@example.de'`,
    );
    assert.deepEqual([prefs!.email_enabled, prefs!.push_enabled, prefs!.lead_minutes], [true, false, 10080]);
    assert.match((await ben.get('/konto?bereich=benachrichtigungen')).text, /Aktuell: 7 Std\. 0 Min|Aktuell: 168 Std\./);

    // Push-Gerät: nur gültige https-Adressen
    assert.equal((await ben.post('/konto/push', { endpoint: 'http://127.0.0.1/x', p256dh: 'a', auth: 'b' })).status, 400);
    const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
    const sub = await ben.post('/konto/push', { endpoint: 'https://push.example.com/abc', p256dh: key, auth: Buffer.alloc(16, 1).toString('base64url') });
    assert.equal(sub.status, 204);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from push_subscriptions'))!.n, 1);
    assert.equal((await ben.post('/konto/push/entfernen', { endpoint: 'https://push.example.com/abc' })).status, 204);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from push_subscriptions'))!.n, 0);
    await db.run(`update notification_prefs set push_enabled = false`);

    // Erinnerung: Ben hat noch offene Spiele ohne Tipp → eine Mail, beim zweiten Lauf keine weitere
    const config = loadConfig({ DATABASE_URL: DB_URL!, APP_URL: base, MAIL_MODE: 'memory', APP_SECRET: 'x' });
    const before = mailer.sent!.length;
    const first = await notifyDue(db, config, mailer, new Date());
    const mails = mailer.sent!.slice(before).filter((m) => m.to === 'ben@example.de');
    assert.equal(first, mails.length);
    const again = await notifyDue(db, config, mailer, new Date());
    assert.equal(again, 0, 'pro Tippschluss nur eine Erinnerung');
    assert.ok(mails.length, 'Ben hat offene Spiele ohne Tipp');
    assert.match(mails[0].subject, /Tipp/);
    // Anna hat nichts aktiviert → keine Mail
    assert.equal(mailer.sent!.slice(before).filter((m) => m.to !== 'ben@example.de').length, 0);
  });

  test('Vorname, Konto-Reiter und Profil eines Mitspielers', async () => {
    for (const bad of ['', 'Anna Lena', 'Anna2', 'An_na', '-Anna', 'Anna-', 'Anna--Lena', 'Anna!']) {
      const r = await new Client().post('/registrieren', { display_name: 'Neu', first_name: bad, email: 'neu@example.de', password: PASSWORT });
      assert.equal(r.status, 400, `"${bad}" muss abgelehnt werden`);
    }
    assert.equal((await db.one<{ n: number }>(`select count(*)::int as n from users where email = 'neu@example.de'`))!.n, 0);
    // Reiter im Konto
    for (const [k, text] of [['profil', 'Profilbild'], ['benachrichtigungen', 'Benachrichtigungen'], ['sicherheit', 'Passwort ändern'], ['konto', 'Konto löschen']]) {
      const r = await anna.get(`/konto?bereich=${k}`);
      assert.match(r.text, new RegExp(text), k);
      assert.match(r.text, new RegExp(`<a href="/konto\\?bereich=${k}" aria-current="page">`), k);
    }
    // Namen sind gesperrt: Änderung wird beantragt und vom Spielleiter entschieden
    assert.equal((await anna.post('/konto/name', { display_name: 'Anna', first_name: 'Anna Lena' })).status, 400);
    const asked = await anna.post('/konto/name', { display_name: 'Anna', first_name: 'Anna-Lena' });
    assert.match(asked.location ?? '', /hinweis=aenderung-angefragt/);
    assert.equal((await db.one<{ first_name: string }>(`select first_name from users where display_name = 'Anna'`))!.first_name, 'Test', 'noch unverändert');
    assert.match((await anna.get('/konto')).text, /Änderung angefragt: <strong>Anna<\/strong> \(Anna-Lena\)/);
    const inbox = await anna.get(`/r/${slug}/verwalten?bereich=anfragen`);
    assert.match(inbox.text, /Test → <strong>Anna-Lena<\/strong>/);
    assert.match(inbox.text, /class="tab-badge"/);
    assert.equal((await stranger.get(`/r/${slug}/verwalten?bereich=anfragen`)).status, 404, 'Fremde sehen keine Anfragen');
    const reqId = (await db.one<{ id: string }>(`select id from name_requests where status = 'pending'`))!.id;
    assert.equal((await stranger.post(`/r/${slug}/verwalten/anfrage/${reqId}/bestaetigen`)).status, 404);
    assert.equal((await anna.post(`/r/${slug}/verwalten/anfrage/${reqId}/bestaetigen`)).status, 303);
    assert.equal((await db.one<{ first_name: string }>(`select first_name from users where display_name = 'Anna'`))!.first_name, 'Anna-Lena');
    // Ablehnen: Name bleibt, Anfrage ist erledigt
    await ben.post('/konto/name', { display_name: 'Benny', first_name: 'Ben' });
    const benReq = (await db.one<{ id: string }>(`select id from name_requests where status = 'pending'`))!.id;
    assert.equal((await anna.post(`/r/${slug}/verwalten/anfrage/${benReq}/ablehnen`)).status, 303);
    assert.equal((await db.one<{ n: number }>(`select count(*)::int as n from users where display_name = 'Ben'`))!.n, 1);
    assert.match((await ben.get('/konto')).text, /vom Spielleiter abgelehnt/);
    // Zurückziehen
    await ben.post('/konto/name', { display_name: 'Benny', first_name: 'Ben' });
    await ben.post('/konto/name/zurueckziehen');
    assert.equal((await db.one<{ n: number }>(`select count(*)::int as n from name_requests where status = 'pending'`))!.n, 0);
    // Älteres Konto ohne Vornamen: der Vorname wird einmal direkt gespeichert
    await db.run(`update users set first_name = null where display_name = 'Ben'`);
    assert.match((await ben.post('/konto/name', { display_name: 'Ben', first_name: 'Ben' })).location ?? '', /hinweis=name-gespeichert/);
    assert.equal((await db.one<{ first_name: string }>(`select first_name from users where display_name = 'Ben'`))!.first_name, 'Ben');

    // Profil: nur über gemeinsame Tipprunde, mit Vorname und Zahlen
    const annaId = (await db.one<{ id: string }>(`select id from users where email = 'anna.neu@example.de' or display_name = 'Anna' order by created_at limit 1`))!.id;
    const rank = await ben.get(`/r/${slug}/rangliste`);
    assert.match(rank.text, new RegExp(`href="/r/${slug}/spieler/${annaId}"`));
    const prof = await ben.get(`/r/${slug}/spieler/${annaId}`);
    assert.match(prof.text, /<h2>Abzeichen <span class="progress">\d+ von 8<\/span><\/h2>/);
    assert.equal((prof.text.match(/class="badge-card badge-l\d"/g) ?? []).length, 8, "alle acht Abzeichen");
    assert.match(prof.text, /<svg class="badge-icon badge-l\d"/);
    assert.equal(prof.status, 200);
    assert.match(prof.text, /Anna-Lena/);
    assert.match(prof.text, /Platz in der Rangliste/);
    assert.match(prof.text, /Sonderfragen/);
    assert.equal((await stranger.get(`/r/${slug}/spieler/${annaId}`)).status, 404, 'Fremde ohne Mitgliedschaft');
    assert.equal((await new Client().get(`/r/${slug}/spieler/${annaId}`)).status, 303, 'ohne Anmeldung');
    assert.equal((await ben.get(`/r/${slug}/spieler/${randomUUID()}`)).status, 404);
  });

  test('Rückblick: Reiter und Seite erst, wenn alle Spiele gespielt sind', async () => {
    const before = await ben.get(`/r/${slug}/rangliste`);
    const open = (await db.one<{ n: number }>(`select count(*)::int as n from matches where status not in ('finished', 'cancelled')`))!.n;
    assert.ok(open > 0, 'Voraussetzung: es gibt noch offene Spiele');
    assert.doesNotMatch(before.text, /rueckblick/);
    assert.equal((await ben.get(`/r/${slug}/rueckblick`)).status, 404);

    // Alle Spiele als gespielt eintragen (danach den alten Stand wiederherstellen)
    const saved = await db.query<{ id: string; status: string; wins_a: number | null; wins_b: number | null }>(`select id, status, wins_a, wins_b from matches`);
    await db.run(`update matches set status = 'finished', wins_a = (best_of + 1) / 2, wins_b = 0 where status not in ('finished', 'cancelled')`);
    try {
      const page = await ben.get(`/r/${slug}/rueckblick`);
      assert.equal(page.status, 200);
      assert.match(page.text, /<h1>Rückblick<\/h1>/);
      assert.match(page.text, /class="rc-card/);
      assert.match(page.text, /rueckblick" aria-current="page">Rückblick</);
      assert.match((await ben.get(`/r/${slug}/rangliste`)).text, /rueckblick/, 'Reiter erscheint überall');
      assert.equal((await stranger.get(`/r/${slug}/rueckblick`)).status, 404, 'Fremde ohne Mitgliedschaft');
      assert.equal((await new Client().get(`/r/${slug}/rueckblick`)).status, 303, 'ohne Anmeldung');
    } finally {
      for (const m of saved) await db.run(`update matches set status = $2, wins_a = $3, wins_b = $4 where id = $1`, [m.id, m.status, m.wins_a, m.wins_b]);
    }
    assert.doesNotMatch((await ben.get(`/r/${slug}/rangliste`)).text, /rueckblick/);
  });

  test('Chat: nur für Mitglieder, Nachrichten senden und abholen, nach 7 Tagen gelöscht', async () => {
    const page = await anna.get(`/r/${slug}/rangliste`);
    assert.match(page.text, /data-chat data-slug=/);
    assert.match(page.text, /chat\.js/);
    assert.match(page.text, /Nachrichten werden nach 7 Tagen gelöscht/);

    // Lautsprecher: standardmäßig stumm, Umschalten gleicht sich mit dem Konto ab
    assert.match(page.text, /data-muted="1"/);
    assert.match(page.text, /data-chat-mute aria-pressed="true"/);
    assert.match(page.text, /<a class="rank-n" href="\/r\/[a-z0-9-]+\/spieler\/[0-9a-f-]{36}">/, 'Namen in der Rangliste rechts führen zum Profil');
    assert.equal((await anna.post('/konto/chat-stumm', { stumm: '0' })).status, 204);
    assert.match((await anna.get(`/r/${slug}/rangliste`)).text, /data-muted="0"/);
    assert.match((await anna.get('/konto?bereich=chat')).text, /name="chat" value="an" checked/);
    assert.equal((await anna.post('/konto/chat-stumm', { stumm: '1' })).status, 204);
    assert.match((await anna.get('/konto?bereich=chat')).text, /name="chat" value="aus" checked/);

    // Profil: Vorname = Anzeigename wird nur einmal gezeigt
    await db.run(`update users set first_name = 'Ben' where email = 'ben@example.de'`);
    const benId = (await db.one<{ id: string }>(`select id from users where email = 'ben@example.de'`))!.id;
    const benProfile = (await anna.get(`/r/${slug}/spieler/${benId}`)).text;
    assert.match(benProfile, /<h1>Ben<\/h1>\s*<p class="muted">Mitglied in /);

    const empty = JSON.parse((await anna.get(`/r/${slug}/chat/nachrichten`)).text);
    assert.deepEqual(empty.messages, []);
    assert.equal((await anna.post(`/r/${slug}/chat`, { text: '   ' })).status, 400);
    assert.equal((await anna.post(`/r/${slug}/chat`, { text: 'x'.repeat(501) })).status, 400);
    const sent = await anna.post(`/r/${slug}/chat`, { text: 'Hallo <b>zusammen</b>' });
    assert.equal(sent.status, 201);
    assert.equal(JSON.parse(sent.text).message.x, 'Hallo <b>zusammen</b>', 'Text bleibt Text (der Browser setzt ihn per textContent ein)');

    const got = JSON.parse((await ben.get(`/r/${slug}/chat/nachrichten`)).text);
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].n, 'Anna');
    const none = JSON.parse((await ben.get(`/r/${slug}/chat/nachrichten?nach=${got.messages[0].id}`)).text);
    assert.deepEqual(none.messages, []);
    await ben.post(`/r/${slug}/chat`, { text: 'Moin' });
    assert.equal(JSON.parse((await anna.get(`/r/${slug}/chat/nachrichten?nach=${got.messages[0].id}`)).text).messages.length, 1);

    // Schimpfwortfilter: Standard Sterne, pro Teilnehmer abschaltbar
    await ben.post(`/r/${slug}/chat`, { text: 'Du Arsch' });
    const starred = JSON.parse((await anna.get(`/r/${slug}/chat/nachrichten`)).text).messages.at(-1);
    assert.equal(starred.x, 'Du *****');
    assert.match((await anna.get('/konto?bereich=chat')).text, /name="filter" value="an" checked/);
    assert.match((await anna.post('/konto/chat', { chat: 'aus', filter: 'aus' })).location ?? '', /bereich=chat/);
    assert.equal(JSON.parse((await anna.get(`/r/${slug}/chat/nachrichten`)).text).messages.at(-1).x, 'Du Arsch');
    assert.equal(JSON.parse((await ben.get(`/r/${slug}/chat/nachrichten`)).text).messages.at(-1).x, 'Du *****', 'Ben behält seinen Filter');
    await anna.post('/konto/chat', { chat: 'aus', filter: 'an' });
    assert.doesNotMatch((await anna.get('/konto?bereich=benachrichtigungen')).text, /Chat-Nachrichten/, 'Chat-Einstellungen sind im Reiter Chat');

    // Eigene Nachricht löschen: nur die eigene
    const last = JSON.parse((await ben.get(`/r/${slug}/chat/nachrichten`)).text).messages.at(-1);
    assert.equal((await anna.post(`/r/${slug}/chat/${last.id}/loeschen`)).status, 404, 'fremde Nachricht bleibt');
    assert.equal((await ben.post(`/r/${slug}/chat/${last.id}/loeschen`)).status, 200);
    assert.ok(!JSON.parse((await anna.get(`/r/${slug}/chat/nachrichten`)).text).messages.some((m: { id: number }) => m.id === last.id));

    assert.equal((await stranger.get(`/r/${slug}/chat/nachrichten`)).status, 404, 'Fremde lesen nicht mit');
    assert.equal((await stranger.post(`/r/${slug}/chat`, { text: 'hi' })).status, 404);
    assert.equal((await new Client().get(`/r/${slug}/chat/nachrichten`)).status, 303);

    // Spielleiter leert den Chat der Runde (mit Rückfrage im Browser), Administrator alle Chats
    assert.match((await anna.get(`/r/${slug}/verwalten?bereich=einstellungen`)).text, /data-confirm="Wirklich den ganzen Chatverlauf dieser Tipprunde/);
    assert.equal((await stranger.post(`/r/${slug}/verwalten/chat-leeren`)).status, 404);
    assert.match((await anna.post(`/r/${slug}/verwalten/chat-leeren`)).location ?? '', /hinweis=chat-geleert/);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from chat_messages'))!.n, 0);
    await anna.post(`/r/${slug}/chat`, { text: 'Noch eine' });
    assert.match((await admin.get('/admin?bereich=system')).text, /Alle Chatverläufe leeren/);
    assert.match((await admin.post('/admin/chat-leeren')).location ?? '', /hinweis=chat-geleert/);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from chat_messages'))!.n, 0);
    await ben.post(`/r/${slug}/chat`, { text: 'Moin' });
    await db.run(`update chat_messages set created_at = now() - interval '8 days' where body = 'Moin'`);
    assert.equal(await purgeOldMessages(db), 1);
    assert.equal((await db.one<{ n: number }>('select count(*)::int as n from chat_messages'))!.n, 0);
  });

  test('Konto löschen: Spielleiter geht an Mit-Spielleiter über, Daten sind weg', async () => {
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
    const before = await admin.get('/admin?bereich=abgleich');
    assert.match(before.text, /Datenabgleich/);
    assert.match(before.text, /noch nie/);

    const r = await admin.post('/admin/abgleich');
    assert.equal(r.status, 303, r.text);
    assert.equal(r.location, '/admin?bereich=abgleich&hinweis=abgeglichen');
    const n = (await db.one<{ c: number; p: number; t: number }>(
      `select (select count(*)::int from champions) as c, (select count(*)::int from players where active) as p,
              (select count(*)::int from teams where external_id is not null) as t`,
    ))!;
    // Die vier Teams aus dem Admin-Test haben die Region "X" – sie werden trotzdem über Name und Kürzel gefunden
    assert.deepEqual([n.c, n.t], [120, 19]);
    assert.ok(n.p > 19 * 5, `${n.p} Spieler`);
    assert.match((await admin.get('/admin?bereich=abgleich')).text, /Spieler aus 19 von 19 Teams/);

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
    // Der Abgleich setzt die Anstoßzeiten zurück (15.10. 18:00) – für die Auswahl muss das Turnier wieder in der Zukunft liegen
    const restoreSync = await postponeTournament(tid);
    const after = await admin.get(`/r/${slug}/sonderfragen`);
    assert.doesNotMatch(after.text, /Faker \(Mid\)/);
    assert.match(after.text, /<option value="Faker" selected>Faker<\/option>/);
    await restoreSync();

    // Quelle nicht erreichbar: Fehler wird angezeigt, vorhandene Listen bleiben
    const failed = await runSync(db, async () => {
      throw new Error('offline');
    });
    assert.ok(failed.every((x) => !x.ok));
    assert.equal((await db.one<{ c: number }>('select count(*)::int as c from champions'))!.c, 120);
    assert.match((await admin.get('/admin?bereich=abgleich')).text, /Fehler: offline/);
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
    assert.match(tipPage.text, />C9</);
    assert.match(tipPage.text, /weitere Spiele dieser Phase erscheinen hier/);
    const swissPage = await admin.get(`/r/${slug}/tippen?phase=swiss`);
    assert.match(swissPage.text, /Die Paarungen für Swiss stehen noch nicht fest/);
    assert.match(swissPage.text, /Freitag, 23\. Oktober/);
    assert.doesNotMatch(swissPage.text, /class="match/);
  });

  test('Layout: Werbeflächen links und rechts', async () => {
    const pub = await new Client().get('/impressum');
    // Links nur ein unsichtbarer Platzhalter (Werbung ist ausgeblendet), rechts die Werbefläche bzw. – angemeldet – die Rangliste
    assert.equal((pub.text.match(/class="ad ad-right"/g) ?? []).length, 1);
    assert.match(pub.text, /class="ad ad-ghost" aria-hidden="true"/);
    assert.doesNotMatch(pub.text, /ad-left/);
  });

  test('Administrator: Update sofort anfordern (legt nur eine Anfrage-Datei ab)', async () => {
    rmSync(UPDATE_FILE, { force: true });
    const page = await admin.get('/admin?bereich=system');
    assert.match(page.text, /Jetzt aktualisieren/);
    assert.match(page.text, /Version &amp; Update/);
    // Reihenfolge: Version & Update, Server, Chat; kurze Angaben statt langer Erklärung
    const at = (h: string) => page.text.indexOf(`<h2>${h}</h2>`);
    assert.ok(at('Version &amp; Update') > 0 && at('Version &amp; Update') < at('Server') && at('Server') < at('Chat'), 'Reihenfolge der Abschnitte');
    assert.match(page.text, /Aktuelle Version: <strong>\d+\.\d+\.\d+<\/strong>\./);
    assert.match(page.text, /Letzte Updatesuche/);
    assert.match(page.text, /Letztes Update installiert/);
    assert.doesNotMatch(page.text, /ohne auf den nächsten 15-Minuten-Takt/);
    const r = await admin.post('/admin/update-erzwingen');
    assert.equal(r.status, 303, r.text);
    assert.match(r.location ?? '', /hinweis=update-angefordert/);
    assert.ok(existsSync(UPDATE_FILE));
    assert.match((await admin.get('/admin?bereich=system')).text, /Ein Update ist angefordert/);
    rmSync(UPDATE_FILE, { force: true });
  });

  test('Administrator: Reiter Backup mit Status, Liste und Knopf für eine Sicherung', async () => {
    rmSync(BACKUP_FILE, { force: true });
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    assert.equal((await new Client().get('/admin?bereich=backup')).status, 303, 'ohne Anmeldung');
    const empty = await admin.get('/admin?bereich=backup');
    assert.equal(empty.status, 200);
    assert.match(empty.text, /<a href="\/admin\?bereich=backup"[^>]*>Backup<\/a>/);
    assert.match(empty.text, /sys-fact-hot"><span class="muted">Letzte Sicherung<\/span>\s*<strong>noch keine/, 'ohne Sicherung rot');
    assert.match(empty.text, /Es gibt noch keine Sicherung\./);
    assert.match(empty.text, /nicht eingerichtet/, 'MyCloud noch nicht eingerichtet');

    // Zwei Sicherungen auf dem Pi (eine vom Update) und eine erfolgreiche MyCloud-Kopie
    mkdirSync(BACKUP_DIR, { recursive: true });
    const recent = new Date(Date.now() - 2 * 3_600_000);
    writeFileSync(join(BACKUP_DIR, 'tippspiel-2026-10-16_040000.dump'), 'x'.repeat(2048));
    writeFileSync(join(BACKUP_DIR, 'tippspiel-2026-10-15_120000-vor-update.dump'), 'y'.repeat(1024));
    utimesSync(join(BACKUP_DIR, 'tippspiel-2026-10-16_040000.dump'), recent, recent);
    utimesSync(join(BACKUP_DIR, 'tippspiel-2026-10-15_120000-vor-update.dump'), new Date(recent.getTime() - 3_600_000), new Date(recent.getTime() - 3_600_000));
    writeFileSync(join(BACKUP_DIR, '.nas-status'), `ok\t${new Date().toISOString()}\ttippspiel-2026-10-16_040000.dump\n`);
    const filled = await admin.get('/admin?bereich=backup');
    assert.match(filled.text, /sys-fact-ok"><span class="muted">Letzte Sicherung/);
    assert.match(filled.text, /vor 2 Std\./);
    assert.match(filled.text, /vor einem Update/);
    assert.match(filled.text, /<strong>2 \(3,0 KB\)<\/strong>|<strong>2 \(3 KB\)<\/strong>/);
    assert.match(filled.text, /Kopie auf der MyCloud<\/span><strong>in Ordnung/);

    // Knopf: legt nur die Anfrage-Datei ab (die Sicherung selbst macht der Pi), nur mit Formularschutz und nur für den Betreiber
    assert.ok(!existsSync(BACKUP_FILE));
    const r = await admin.post('/admin/backup-erstellen');
    assert.equal(r.status, 303, r.text);
    assert.match(r.location ?? '', /bereich=backup&hinweis=backup-angefordert/);
    assert.ok(existsSync(BACKUP_FILE));
    assert.match((await admin.get('/admin?bereich=backup')).text, /Eine Sicherung ist angefordert/);
    rmSync(BACKUP_FILE, { force: true });
    rmSync(BACKUP_DIR, { recursive: true, force: true });
  });

  test('Seitenende: Umschalter Spielleiter/Administrator nur für den Betreiber', async () => {
    const adminPage = await admin.get('/admin');
    assert.match(adminPage.text, /class="role-switch"/);
    assert.match(adminPage.text, /<summary>Administrator<\/summary>/);
    const normal = await admin.get(`/r/${slug}/rangliste`);
    assert.match(normal.text, /<summary>Spielleiter<\/summary>/);
    assert.match(normal.text, new RegExp(`href="/r/${slug}/verwalten"`));
    assert.match(normal.text, /<a href="\/admin">Administrator<\/a>/);
    assert.match(normal.text, /<a href="\/r\/[a-z0-9-]+\/verwalten" aria-current="true">Spielleiter<\/a>/, 'gewählte Rolle ist markiert');
    assert.match(normal.text, /<footer class="foot">\s*<div class="foot-role">\s*<details class="role-switch">/, 'Umschalter steht im Seitenende');
    assert.doesNotMatch(normal.text.slice(0, normal.text.indexOf('</header>')), /role-switch/, 'nicht mehr in der Kopfzeile');
    assert.doesNotMatch((await new Client().get('/impressum')).text, /role-switch/);
  });

  test('Testspiel: Betreiber sieht dort nur die Teilnehmer-Ansicht, Dropdown nur mit zwei Tipprunden', async () => {
    assert.doesNotMatch((await admin.get(`/r/${slug}/rangliste`)).text, /league-switch/);
    assert.equal((await stranger.post('/admin/test/einblenden')).status, 404);
    assert.match((await admin.post('/admin/test/einblenden')).location ?? '', /test-eingeblendet/);
    const main = await admin.get(`/r/${slug}/rangliste`);
    assert.match(main.text, /league-switch/);
    assert.match(main.text, /href="\/r\/testspiel\/tippen"/);
    assert.match(main.text, /<summary>Spielleiter<\/summary>/);
    const test = await admin.get('/r/testspiel/tippen');
    assert.equal(test.status, 200);
    assert.doesNotMatch(test.text, /role-switch"|role-single|>Verwalten</);
    assert.equal((await admin.get('/r/testspiel/verwalten')).status, 403);
    // Adminseiten verweisen weiter aufs Hauptspiel
    assert.match((await admin.get('/admin')).text, new RegExp(`/r/${slug}/verwalten`));
    assert.match((await admin.post('/admin/test/abgleichen')).location ?? '', /test-abgeglichen/);
    assert.match((await admin.post('/admin/test/ausblenden')).location ?? '', /test-ausgeblendet/);
    assert.doesNotMatch((await admin.get(`/r/${slug}/rangliste`)).text, /league-switch/);
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
    assert.match(play.text, /phase=knockout-stage"/);
    for (const round of ['Upper Bracket Semifinal', 'Lower Bracket Semifinal', 'Upper Bracket Final', 'Lower Bracket Final', 'Final']) {
      assert.match(play.text, new RegExp(`class="bk-rtitle" x="\\d+" y="\\d+">${round}</text>`));
    }
    assert.match(play.text, /Double Elimination/);
    assert.match(play.text, new RegExp(`href="/r/${slug}/spiel/${await matchId('pi-oh-1')}"`));
    // Noch ist niemand ausgeschieden (alle haben höchstens eine Niederlage)
    assert.doesNotMatch(play.text, /bk-out/);
    // Offene Paarungen ohne Link
    assert.match(play.text, /class="bk-match bk-open"/);

    // Unteres Halbfinale C9 – MVK endet 3:0: MVK hat zwei Niederlagen und ist ausgeschieden
    await db.run(`update matches set wins_a = 3, wins_b = 0, status = 'finished' where id = $1`, [await matchId('pi-uh')]);
    const after = await admin.get(`${path}?turnier=${tid}&phase=play-in`);
    assert.match(after.text, /bk-row bk-b bk-lost bk-out"[^]*?>MVK<\/text>/);
    assert.match(after.text, /<svg class="bk-svg"/);
    assert.match(after.text, /bk-edge-lose/, 'Verlierer-Linien im Lower Bracket');
    assert.match(after.text, /<li class="bk-chip bk-out" title="MVK Esports">MVK/);
    assert.doesNotMatch(after.text, /<li class="bk-chip bk-out" title="Cloud9[^"]*">/, 'C9 hat erst eine Niederlage');
    assert.match(after.text, /bk-legend/);
    // Der Baum steht außerhalb der Mittelspalte (eigene Zeile), Reiter und Texte bleiben in der Mittelspalte
    assert.match(after.text, /<\/main>[^]*<div class="below"><div class="bracket bracket-tree"[^]*<svg class="bk-svg"/);
    assert.doesNotMatch(after.text.slice(0, after.text.indexOf('</main>')), /<svg class="bk-svg"/);

    // Swiss: Runden stehen schon, die Paarungen sind noch offen
    const swiss = await admin.get(`${path}?turnier=${tid}&phase=swiss`);
    assert.match(swiss.text, /Schweizer System/);
    assert.match(swiss.text, /<span class="sw-title">Round 5<\/span>/);
    assert.doesNotMatch(swiss.text, /bk-table/);
    // K.-o.-Phase: Viertelfinale, Halbfinale, Finale als Spalten
    const ko = await admin.get(`${path}?turnier=${tid}&phase=knockout-stage`);
    for (const round of ['Quarterfinals', 'Semifinals', 'Final']) assert.match(ko.text, new RegExp(`class="bk-rtitle" x="\\d+" y="\\d+">${round}</text>`));
    // Reiter "Statistiken" neben dem Turnierbaum
    const stats = await admin.get(`/r/${slug}/statistiken?turnier=${tid}`);
    assert.equal(stats.status, 200);
    assert.match(stats.text, /<a href="\/r\/[a-z0-9-]+\/statistiken" aria-current="page">Statistiken<\/a>/);
    assert.doesNotMatch(stats.text, /Maps gespielt|Maps pro Serie/);
    assert.match(stats.text, /class="filter-bar" data-filter="st-teams"/);
    assert.match(stats.text, /<h1 class="bk-title">Statistiken – Worlds 2026<\/h1>/);
    assert.match(stats.text, /Das Turnier in Zahlen/);
    assert.match(stats.text, /<strong>MVK<\/strong>/, 'Teams mit Kürzel in der Tabelle');
    assert.match(stats.text, /Tipps der Runde/);
    // Unbekannte Phase → die aktuelle wird gezeigt
    assert.equal((await admin.get(`${path}?turnier=${tid}&phase=gibt-es-nicht`)).status, 200);
  });
});
