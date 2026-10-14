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
import { importTournament, type TournamentData } from './daten.ts';
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

  /** Anmelden über den E-Mail-Link; gibt die Weiterleitung nach dem Bestätigen zurück. */
  async login(email: string, name?: string, next = '/') {
    const before = mailer.sent!.length;
    const r = await this.post('/anmelden', { email, weiter: next });
    assert.equal(r.status, 200, r.text);
    const mail = mailer.sent![before];
    assert.ok(mail, 'Es wurde keine E-Mail verschickt');
    assert.equal(mail.to, email.toLowerCase());
    const link = /https?:\/\/[^\s]+\/anmelden\/bestaetigen\?[^\s]+/.exec(mail.text)![0];
    const url = new URL(link);
    const confirm = await this.get(url.pathname + url.search);
    assert.equal(confirm.status, 200);
    const done = await this.post('/anmelden/bestaetigen', {
      token: url.searchParams.get('token')!,
      weiter: url.searchParams.get('weiter') ?? '/',
    });
    assert.equal(done.status, 303);
    if (name && done.location?.startsWith('/willkommen')) {
      const w = await this.get(done.location);
      assert.equal(w.status, 200);
      const target = new URL(done.location, base).searchParams.get('weiter') ?? '/';
      const saved = await this.post('/willkommen', { display_name: name, weiter: target });
      assert.equal(saved.status, 303);
      return { ...done, location: saved.location, link: url };
    }
    return { ...done, link: url };
  }
}

function localInput(d: Date): string {
  // Zeit in Europe/Berlin für <input type="datetime-local">
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  return p.replace(' ', 'T');
}

const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

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
      MAIL_MODE: 'memory',
      APP_SECRET: 'test-geheimnis',
    });
    mailer = createMailer(config);
    const app = createApp({ db, config, mailer, publicDir: join(root, 'public'), log: process.env.TEST_LOG ? (m) => console.error(m) : () => {} });
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
  });

  test('Anmeldung: ungültige E-Mail, Link, Name, Link nur einmal gültig', async () => {
    const bad = await anna.post('/anmelden', { email: 'kein-at-zeichen' });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /gültige E-Mail-Adresse/);

    const r = await anna.login('Anna@Example.de', 'Anna');
    assert.equal(r.location, '/');
    const home = await anna.get('/');
    assert.match(home.text, /Deine Tipprunden/);
    assert.match(home.text, />Anna</);

    // derselbe Link funktioniert kein zweites Mal
    const again = await new Client().post('/anmelden/bestaetigen', { token: r.link.searchParams.get('token')! });
    assert.equal(again.status, 400);
    assert.match(again.text, /nicht mehr gültig/);

    // In der Datenbank steht nur der Hash
    const stored = await db.one<{ n: number }>('select count(*)::int as n from login_tokens where token_hash = $1', [r.link.searchParams.get('token')]);
    assert.equal(stored!.n, 0);

    // zweites Anmelden: kein Willkommen mehr
    const second = await new Client().login('anna@example.de');
    assert.equal(second.location, '/');
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
    assert.match(page.text, /Tippen geht, sobald beide Teams feststehen/);

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
    const rows = [...table.text.matchAll(/<td class="num rank">(\d+)<\/td>\s*<td>([^<]+)<\/td>[\s\S]*?<td class="num total">(\d+)<\/td>/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(rows, [['1', 'Anna', '3'], ['2', 'Ben', '2']]);

    const tips = await anna.get(`/r/${slug}/tippen`);
    assert.match(tips.text, /Vorbei/);
    assert.match(tips.text, /pts pts-hit pts-exact">\+2</);
  });

  test('Sonderfragen: anlegen, beantworten, Frist, Auflösung', async () => {
    const add = await anna.post(`/r/${slug}/verwalten/typische-fragen`, { tournament_id: tournamentId });
    assert.equal(add.status, 303);
    const qs = await db.query<{ id: string; question: string; answer_type: string }>('select id, question, answer_type from bonus_questions order by position');
    assert.equal(qs.length, 6);
    const champ = qs.find((q) => q.question.includes('Weltmeister'))!;
    const mvp = qs.find((q) => q.question.includes('MVP'))!;

    // Frist auf morgen setzen
    await anna.post(`/r/${slug}/verwalten/turnier/${tournamentId}`, { aktion: 'speichern', bonus_deadline_at: localInput(hours(20)) });
    const form = await ben.get(`/r/${slug}/sonderfragen`);
    assert.match(form.text, /Antworten speichern/);
    assert.match(form.text, /<option value="Gen.G">Gen.G<\/option>/);
    const saved = await ben.post(`/r/${slug}/sonderfragen`, { [`antwort_${champ.id}`]: 'Gen.G', [`antwort_${mvp.id}`]: '  chovy ' });
    assert.equal(saved.location, `/r/${slug}/sonderfragen?hinweis=antworten-gespeichert`);
    await anna.post(`/r/${slug}/sonderfragen`, { [`antwort_${champ.id}`]: 'T1', [`antwort_${mvp.id}`]: '<script>alert(1)</script>' });

    // Vor der Frist sieht man die Antworten der anderen nicht
    assert.doesNotMatch((await anna.get(`/r/${slug}/sonderfragen`)).text, /chovy/);

    // Frist vorbei → keine Änderungen mehr, Antworten aller sichtbar (und maskiert)
    await anna.post(`/r/${slug}/verwalten/turnier/${tournamentId}`, { aktion: 'speichern', bonus_deadline_at: localInput(hours(-1)) });
    const late = await ben.post(`/r/${slug}/sonderfragen`, { [`antwort_${champ.id}`]: 'T1' });
    assert.equal(late.location, `/r/${slug}/sonderfragen?hinweis=antworten-zu-spaet`);
    const closed = await ben.get(`/r/${slug}/sonderfragen`);
    assert.match(closed.text, /chovy/);
    assert.match(closed.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(closed.text, /<script>alert/);

    // Auflösen: Weltmeister Gen.G (5 Punkte), MVP "Chovy" – Schreibweise egal (3 Punkte)
    const q = (id: string) => db.one<Record<string, unknown>>('select * from bonus_questions where id = $1', [id]);
    const c = (await q(champ.id))!;
    await anna.post(`/r/${slug}/verwalten/frage/${champ.id}`, {
      aktion: 'speichern', question: String(c.question), points: '5', position: '1', answer_type: 'team', choices: '', hint: '', correct_answers: 'Gen.G',
    });
    await anna.post(`/r/${slug}/verwalten/frage/${mvp.id}`, {
      aktion: 'speichern', question: 'Wer wird Finals-MVP?', points: '3', position: '2', answer_type: 'text', choices: '', hint: '', correct_answers: 'Chovy',
    });
    const table = await ben.get(`/r/${slug}/rangliste`);
    const rows = [...table.text.matchAll(/<td class="num rank">(\d+)<\/td>\s*<td>([^<]+)<\/td>[\s\S]*?<td class="num total">(\d+)<\/td>/g)].map((m) => [m[1], m[2], m[3]]);
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
    assert.deepEqual([first.tournamentNew, first.teamsNew, first.teamsKnown, first.matchesNew], [true, 15, 4, 13]);
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
    await db.run(`insert into league_tournaments (league_id, tournament_id, bonus_deadline_at) values ($1, $2, now() + interval '1 day')`, [league, tid]);
    await db.run(`insert into bonus_questions (league_id, tournament_id, question, points, answer_type) values ($1, $2, 'Wer wird Weltmeister?', 5, 'team')`, [league, tid]);
    const bonus = await admin.get(`/r/${slug}/sonderfragen`);
    assert.equal(bonus.status, 200);
    for (const name of ['Bilibili Gaming', 'Gen.G', 'LOS', 'Team Secret Whales']) assert.match(bonus.text, new RegExp(`<option[^>]*>${name}</option>`), name);

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
    assert.deepEqual([again.tournamentNew, again.teamsNew, again.matchesNew, again.matchesChanged, again.matchesUnchanged], [false, 0, 0, 0, 13]);

    // Im Admin-Bereich eingetragen: Teams fürs obere Finale, Ergebnis des ersten Spiels
    await db.run(`update matches set team_a_id = $2, team_b_id = $3 where tournament_id = $1 and external_id = 'pi-of'`, [tid, team.KC, team.T1]);
    await db.run(`update matches set wins_a = 3, wins_b = 1, status = 'finished' where tournament_id = $1 and external_id = 'pi-oh-1'`, [tid]);
    // Neue Datei-Version: Finale eine Stunde später
    const newer = structuredClone(data);
    newer.matches.find((m) => m.key === 'finale')!.scheduled_at = '2026-11-14T15:00:00-05:00';
    const third = await importTournament(db, newer);
    assert.deepEqual([third.matchesNew, third.matchesChanged, third.matchesUnchanged], [0, 1, 12]);
    assert.deepEqual([(await get('pi-of')).a, (await get('pi-of')).b], ['KC', 'T1']);
    assert.deepEqual([(await get('pi-oh-1')).wins_a, (await get('pi-oh-1')).status], [3, 'finished']);
    assert.equal((await get('finale')).scheduled_at.toISOString(), '2026-11-14T20:00:00.000Z');

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
});
