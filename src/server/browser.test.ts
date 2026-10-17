// Browser-Prüfung: öffnet die App in einem echten (unsichtbaren) Chrome, bei Handy-, Tablet- und PC-Breiten,
// misst das Layout und legt Screenshots ab.
//
//   BROWSER_TEST=1 TEST_DATABASE_URL=postgres://… node --experimental-strip-types --test src/server/browser.test.ts
//
// Läuft nur, wenn BROWSER_TEST und TEST_DATABASE_URL gesetzt sind und das Paket "playwright" installiert ist
// (in GitHub Actions: Auftrag "Browser-Prüfung"). Die Screenshots landen in browser-screenshots/ und werden
// bei GitHub nach 7 Tagen automatisch gelöscht; auf dem Raspberry Pi läuft nichts davon.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, type Db, migrate } from './db/index.ts';
import { importTournament, type TournamentData } from './daten.ts';
import { hashPassword } from './auth.ts';
import { createMailer } from './mail.ts';
import { fakeRiot } from './testdaten/fake-riot.ts';

const DB_URL = process.env.TEST_DATABASE_URL;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.BROWSER_SHOTS ?? join(root, 'browser-screenshots');
const WIDTHS = [390, 700, 944, 1100, 1300, 1700];
const PAGES = ['tippen', 'sonderfragen', 'rangliste', 'alle-tipps', 'turnierbaum', 'statistiken', 'verwalten'];
const PASSWORT = 'richtig-geheim-123';

// Das Paket gehört nicht zu den Abhängigkeiten der App (nur in CI installiert) – deshalb ohne Typen laden
interface Playwright {
  chromium: { launch(options?: object): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const PACKAGE = 'playwright';
let playwright: Playwright | null = null;
if (process.env.BROWSER_TEST && DB_URL) {
  try {
    playwright = (await import(PACKAGE)) as Playwright;
  } catch {
    playwright = null;
  }
}
const skip = !process.env.BROWSER_TEST ? 'BROWSER_TEST nicht gesetzt' : !DB_URL ? 'TEST_DATABASE_URL nicht gesetzt' : !playwright ? 'Paket playwright fehlt' : false;

let db: Db;
let server: Server;
let base = '';

/** Kleiner Ersatz-Browser nur für die Einrichtung (Konto, Tipprunde): Cookies und Formular-Token merken. */
class Client {
  cookies = new Map<string, string>();
  csrf = '';

  async request(method: string, path: string, form?: Record<string, string>) {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (form) {
      body = new URLSearchParams({ ...form, ...(this.csrf ? { _csrf: this.csrf } : {}) }).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = base;
    }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      this.cookies.set(k, v);
    }
    const text = await res.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(text);
    if (token) this.csrf = token[1];
    return { status: res.status, location: res.headers.get('location'), text };
  }
}

describe('Browser-Prüfung (Layout bei verschiedenen Fensterbreiten)', { skip }, () => {
  before(async () => {
    db = createDb(DB_URL!, { max: 4 });
    const tables = await db.one<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_schema = 'public'`);
    if (tables!.n !== 0) throw new Error('Abbruch: Die Test-Datenbank ist nicht leer.');
    await migrate(db, join(root, 'db', 'migrations'));
    const config = loadConfig({ DATABASE_URL: DB_URL, PORT: '0', APP_URL: 'http://127.0.0.1', ADMIN_EMAILS: 'admin@example.de', MAIL_MODE: 'memory', APP_SECRET: 'test-geheimnis' });
    const app = createApp({ db, config, mailer: createMailer(config), publicDir: join(root, 'public'), fetchJson: fakeRiot(), log: () => {} });
    server = createServer(app.listener);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config.appUrl = base;
    rmSync(SHOTS, { recursive: true, force: true });
    mkdirSync(SHOTS, { recursive: true });
  });

  after(async () => {
    server?.close();
    if (db) {
      await db.exec('drop schema public cascade; create schema public;');
      await db.end();
    }
  });

  test('Seiten bei Handy-, Tablet- und PC-Breiten: nichts ragt heraus, Reiter bündig, Rangliste da', async () => {
    const data = JSON.parse(readFileSync(join(root, 'db', 'daten', 'worlds-2026.json'), 'utf8')) as TournamentData;
    await importTournament(db, data);
    const tid = (await db.one<{ id: string }>(`select id from tournaments where external_id = 'worlds-2026'`))!.id;

    // Konto (Admin), Tipprunde, ein Mitspieler für die Rangliste
    const me = new Client();
    await me.request('GET', '/registrieren');
    assert.equal((await me.request('POST', '/registrieren', { display_name: 'Admin', first_name: 'Ad', email: 'admin@example.de', password: PASSWORT })).status, 303);
    await me.request('GET', '/konto');
    const created = await me.request('POST', '/neu', { name: 'Browser-Runde', tournament_id: tid, points_winner: '1', points_exact: '1', lock_mode: 'matchday' });
    assert.equal(created.status, 303, created.text);
    const slug = /\/r\/([^/]+)\//.exec(created.location!)![1];

    const { chromium } = playwright!;
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const problems: string[] = [];
    try {
      const context = await browser.newContext({ locale: 'de-DE' });
      await context.addCookies([...me.cookies].map(([name, value]) => ({ name, value, url: base })));
      for (const width of WIDTHS) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        for (const name of PAGES) {
          const where = `${name} bei ${width}px`;
          const res = await page.goto(`${base}/r/${slug}/${name}`, { waitUntil: 'load' });
          if (res?.status() !== 200) {
            problems.push(`${where}: Antwort ${res?.status()}`);
            continue;
          }
          const m = await page.evaluate(() => {
            const box = (sel: string) => {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (!el || getComputedStyle(el).display === 'none') return null;
              const r = el.getBoundingClientRect();
              return r.width > 0 ? { left: r.left, right: r.right, width: r.width } : null;
            };
            const tabTops = [...document.querySelectorAll('.league-nav .tabs a')].map((a) => Math.round(a.getBoundingClientRect().top));
            return {
              scroll: document.documentElement.scrollWidth,
              inner: window.innerWidth,
              nav: box('.league-nav'),
              main: box('main.main'),
              rank: box('.rank-side'),
              tabs: box('.league-nav .tabs'),
              menu: box('.league-nav .m-menu'),
              tabTops,
            };
          });
          if (m.scroll > m.inner + 1) problems.push(`${where}: Seite ragt seitlich heraus (${m.scroll}px bei ${m.inner}px)`);
          if (width > 640) {
            if (!m.tabs || new Set(m.tabTops).size !== 1) problems.push(`${where}: Reiter stehen nicht in einer Zeile (${m.tabTops.join(', ')})`);
            if (m.nav && m.main && Math.abs(m.nav.left - m.main.left) > 1) problems.push(`${where}: Reiter-Leiste (${m.nav.left}) und Inhalt (${m.main.left}) nicht bündig`);
            if (m.main && m.main.width < 640) problems.push(`${where}: Inhalt nur ${Math.round(m.main.width)}px breit`);
          } else if (m.tabs || !m.menu) {
            problems.push(`${where}: auf dem Handy fehlt das Menü oder die Reiter-Leiste ist noch da`);
          }
          // Rangliste rechts: überall bei PC-Breite – außer auf Rangliste, Turnierbaum und Verwalten (dort ausgeblendet)
          const rankHidden = ['rangliste', 'turnierbaum', 'verwalten'].includes(name);
          if (width >= 920 && !rankHidden && !m.rank) problems.push(`${where}: Rangliste rechts fehlt`);
          if (rankHidden && m.rank) problems.push(`${where}: Rangliste rechts sollte hier ausgeblendet sein`);
          if (m.rank && width >= 1140 && m.rank.right < m.inner - 24) problems.push(`${where}: Rangliste steht nicht am rechten Rand (${Math.round(m.rank.right)} von ${m.inner}px)`);
          if (m.rank && m.main && m.rank.left < m.main.right - 1) problems.push(`${where}: Rangliste überlappt den Inhalt`);
          await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`) });
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test('Team ohne Kürzel (langer Name): VS/% in der Mitte bleibt bündig, Zeile ragt nicht heraus', async () => {
    const { id: tid } = (await db.one<{ id: string }>(
      `insert into tournaments (name, starts_on, ends_on) values ('Kürzel-Testturnier', current_date - 1, current_date + 30) returning id`,
    ))!;
    const mkTeam = async (name: string, short: string | null) =>
      (await db.one<{ id: string }>(`insert into teams (name, short_name, region) values ($1, $2, 'X') returning id`, [name, short]))!.id;
    const kurzA = await mkTeam('KC', 'KC');
    const kurzB = await mkTeam('C9', 'C9');
    // Ohne gepflegtes Kürzel fällt die Anzeige auf den vollen Namen zurück (siehe shortA/shortB) – der
    // darf die mittlere Spalte (VS/%) nicht verschieben und die Zeile nicht breiter als den Bildschirm machen.
    const langA = await mkTeam('Ein ziemlich langer Teamname ohne Kürzel', null);
    const langB = await mkTeam('Noch ein langer Teamname ohne Kürzel', null);
    const addMatch = (a: string, b: string, at: Date) =>
      db.one<{ id: string }>(
        `insert into matches (tournament_id, team_a_id, team_b_id, best_of, scheduled_at, status) values ($1, $2, $3, 1, $4, 'scheduled') returning id`,
        [tid, a, b, at],
      );
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
    const kurzMatch = (await addMatch(kurzA, kurzB, hours(1)))!.id;
    const langMatch = (await addMatch(langA, langB, hours(2)))!.id;

    const me = new Client();
    // Nur der Administrator (ADMIN_EMAILS = admin@example.de, aus dem vorigen Test schon registriert) darf
    // Tipprunden anlegen – hier anmelden statt neu zu registrieren.
    await me.request('GET', '/anmelden');
    assert.equal((await me.request('POST', '/anmelden', { email: 'admin@example.de', password: PASSWORT })).status, 303);
    await me.request('GET', '/konto');
    const created = await me.request('POST', '/neu', { name: 'Kürzel-Runde', tournament_id: tid, points_winner: '1', points_exact: '1', lock_mode: 'match' });
    assert.equal(created.status, 303, created.text);
    const slug = /\/r\/([^/]+)\//.exec(created.location!)![1];

    const { chromium } = playwright!;
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const problems: string[] = [];
    try {
      const context = await browser.newContext({ locale: 'de-DE' });
      await context.addCookies([...me.cookies].map(([name, value]) => ({ name, value, url: base })));
      for (const width of [390, 1300]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px`;
        await page.goto(`${base}/r/${slug}/tippen`, { waitUntil: 'load' });
        const m = await page.evaluate(
          ({ kurzId, langId }: { kurzId: string; langId: string }) => {
            const midLeft = (id: string) => {
              const el = document.querySelector(`#spiel-${id} .mid`);
              return el ? el.getBoundingClientRect().left : null;
            };
            return {
              scroll: document.documentElement.scrollWidth,
              inner: window.innerWidth,
              kurzX: midLeft(kurzId),
              langX: midLeft(langId),
              teamAText: document.querySelector(`#spiel-${langId} .team-a`)?.textContent ?? null,
              teamBText: document.querySelector(`#spiel-${langId} .team-b`)?.textContent ?? null,
            };
          },
          { kurzId: kurzMatch, langId: langMatch },
        );
        if (m.scroll > m.inner + 1) problems.push(`${where}: Seite ragt seitlich heraus (${m.scroll}px bei ${m.inner}px)`);
        if (m.kurzX === null || m.langX === null) problems.push(`${where}: Zeile(n) nicht gefunden`);
        else if (Math.abs(m.kurzX - m.langX) > 1) problems.push(`${where}: Mitte (VS/%) verschoben – kurz bei ${m.kurzX}, lang bei ${m.langX}`);
        // Ohne Kürzel: der volle Teamname muss stehen bleiben (umbrechen statt mit "…" abschneiden).
        if (m.teamAText !== 'Ein ziemlich langer Teamname ohne Kürzel') problems.push(`${where}: Teamname A abgeschnitten (${m.teamAText})`);
        if (m.teamBText !== 'Noch ein langer Teamname ohne Kürzel') problems.push(`${where}: Teamname B abgeschnitten (${m.teamBText})`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test('%-Zeichen bei der Gewinnchance steht unabhängig von der Ziffernzahl (1/2/3-stellig) an derselben Stelle', async () => {
    const { id: tid } = (await db.one<{ id: string }>(
      `insert into tournaments (name, starts_on, ends_on) values ('Prozent-Testturnier', current_date - 1, current_date + 30) returning id`,
    ))!;
    const mkTeam = async (name: string) => (await db.one<{ id: string }>(`insert into teams (name, short_name, region) values ($1, $1, 'X') returning id`, [name]))!.id;
    const [a1, a2, b1, b2] = await Promise.all([mkTeam('AA'), mkTeam('AB'), mkTeam('BA'), mkTeam('BB')]);
    const addMatch = (a: string, b: string, at: Date) =>
      db.one<{ id: string }>(
        `insert into matches (tournament_id, team_a_id, team_b_id, best_of, scheduled_at, status) values ($1, $2, $3, 1, $4, 'finished') returning id`,
        [tid, a, b, at],
      );
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
    // Ein Spiel mit drei-/einstelligem Ergebnis (100 %/0 %), eins mit zweistelligem auf beiden Seiten (70 %/30 %) –
    // nur reine Textausrichtung (ohne feste Breite für die Zahl) lässt das %-Zeichen hier an unterschiedlichen
    // Stellen stehen, je nachdem wie viele Ziffern davor stehen.
    const match100 = (await addMatch(a1, a2, hours(-2)))!.id;
    const match70 = (await addMatch(b1, b2, hours(-3)))!.id;

    const me = new Client();
    await me.request('GET', '/anmelden');
    assert.equal((await me.request('POST', '/anmelden', { email: 'admin@example.de', password: PASSWORT })).status, 303);
    await me.request('GET', '/konto');
    const created = await me.request('POST', '/neu', { name: 'Prozent-Runde', tournament_id: tid, points_winner: '1', points_exact: '1', lock_mode: 'match' });
    assert.equal(created.status, 303, created.text);
    const slug = /\/r\/([^/]+)\//.exec(created.location!)![1];
    const { id: leagueId } = (await db.one<{ id: string }>(`select id from leagues where slug = $1`, [slug]))!;

    // 20 Mitspieler: beim ersten Spiel alle auf A (100 %/0 %), beim zweiten 14 auf A / 6 auf B (70 %/30 %)
    const pwHash = await hashPassword(PASSWORT);
    const voters: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { id } = (await db.one<{ id: string }>(
        `insert into users (email, display_name, first_name, password_hash, password_changed_at) values ($1, $2, $3, $4, now()) returning id`,
        [`prozent-v${i}@example.de`, `V${i}`, `V${i}`, pwHash],
      ))!;
      await db.run(`insert into league_members (league_id, user_id) values ($1, $2)`, [leagueId, id]);
      voters.push(id);
    }
    await db.tx(async (q) => {
      await q.exec(`set local app.bypass_lock = 'on'`);
      for (let i = 0; i < 20; i++) {
        await q.run(`insert into predictions (league_id, match_id, user_id, winner, winner_wins, loser_wins) values ($1, $2, $3, 'A', null, null)`, [leagueId, match100, voters[i]]);
      }
      for (let i = 0; i < 20; i++) {
        await q.run(`insert into predictions (league_id, match_id, user_id, winner, winner_wins, loser_wins) values ($1, $2, $3, $4, null, null)`, [
          leagueId,
          match70,
          voters[i],
          i < 14 ? 'A' : 'B',
        ]);
      }
    });

    const { chromium } = playwright!;
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const problems: string[] = [];
    try {
      const context = await browser.newContext({ locale: 'de-DE' });
      await context.addCookies([...me.cookies].map(([name, value]) => ({ name, value, url: base })));
      for (const width of [390, 1300]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px`;
        await page.goto(`${base}/r/${slug}/tippen`, { waitUntil: 'load' });
        const r = await page.evaluate(
          ({ id100, id70 }: { id100: string; id70: string }) => {
            const percentX = (matchId: string, cls: string) => {
              const span = document.querySelector(`#spiel-${matchId} .${cls}`);
              const last = span?.lastChild;
              if (!last || last.nodeType !== Node.TEXT_NODE || !last.textContent) return null;
              const i = last.textContent.lastIndexOf('%');
              if (i < 0) return null;
              const range = document.createRange();
              range.setStart(last, i);
              range.setEnd(last, last.textContent.length);
              return range.getBoundingClientRect().left;
            };
            return {
              aFor100: percentX(id100, 'pct-a'),
              bFor100: percentX(id100, 'pct-b'),
              aFor70: percentX(id70, 'pct-a'),
              bFor70: percentX(id70, 'pct-b'),
            };
          },
          { id100: match100, id70: match70 },
        );
        if (r.aFor100 === null || r.bFor100 === null || r.aFor70 === null || r.bFor70 === null) problems.push(`${where}: %-Zeichen nicht gefunden`);
        else {
          if (Math.abs(r.aFor100 - r.aFor70) > 1) problems.push(`${where}: % links verschoben – 100 % bei ${r.aFor100}, 70 % bei ${r.aFor70}`);
          if (Math.abs(r.bFor100 - r.bFor70) > 1) problems.push(`${where}: % rechts verschoben – 0 % bei ${r.bFor100}, 30 % bei ${r.bFor70}`);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test('%-Zahl steht mittig zwischen Team-Name und VS/Ergebnis – bei laufendem Spiel (VS) wie bei Spoilerschutz gleich', async () => {
    const { id: tid } = (await db.one<{ id: string }>(
      `insert into tournaments (name, starts_on, ends_on) values ('Mittig-Testturnier', current_date - 1, current_date + 30) returning id`,
    ))!;
    const mkTeam = async (name: string) => (await db.one<{ id: string }>(`insert into teams (name, short_name, region) values ($1, $1, 'X') returning id`, [name]))!.id;
    const [a1, a2, b1, b2] = await Promise.all([mkTeam('MA'), mkTeam('MB'), mkTeam('MC'), mkTeam('MD')]);
    // Ein laufendes Spiel (grünes VS) und ein beendetes mit Spoilerschutz (Auge-Symbol) – beide mit Tipps,
    // damit auf beiden Seiten eine echte %-Zahl steht.
    const liveMatch = (await db.one<{ id: string }>(
      `insert into matches (tournament_id, team_a_id, team_b_id, best_of, scheduled_at, status) values ($1, $2, $3, 1, now() - interval '5 minutes', 'live') returning id`,
      [tid, a1, a2],
    ))!.id;
    const scoreMatch = (await db.one<{ id: string }>(
      `insert into matches (tournament_id, team_a_id, team_b_id, best_of, scheduled_at, status, wins_a, wins_b) values ($1, $2, $3, 1, now() - interval '2 hours', 'finished', 1, 0) returning id`,
      [tid, b1, b2],
    ))!.id;

    const me = new Client();
    await me.request('GET', '/anmelden');
    assert.equal((await me.request('POST', '/anmelden', { email: 'admin@example.de', password: PASSWORT })).status, 303);
    await me.request('GET', '/konto');
    const created = await me.request('POST', '/neu', { name: 'Mittig-Runde', tournament_id: tid, points_winner: '1', points_exact: '1', lock_mode: 'match' });
    assert.equal(created.status, 303, created.text);
    const slug = /\/r\/([^/]+)\//.exec(created.location!)![1];
    const { id: leagueId } = (await db.one<{ id: string }>(`select id from leagues where slug = $1`, [slug]))!;

    const pwHash = await hashPassword(PASSWORT);
    const voters: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { id } = (await db.one<{ id: string }>(
        `insert into users (email, display_name, first_name, password_hash, password_changed_at) values ($1, $2, $3, $4, now()) returning id`,
        [`mittig-v${i}@example.de`, `V${i}`, `V${i}`, pwHash],
      ))!;
      await db.run(`insert into league_members (league_id, user_id) values ($1, $2)`, [leagueId, id]);
      voters.push(id);
    }
    await db.tx(async (q) => {
      await q.exec(`set local app.bypass_lock = 'on'`);
      for (let i = 0; i < 20; i++) {
        await q.run(`insert into predictions (league_id, match_id, user_id, winner, winner_wins, loser_wins) values ($1, $2, $3, 'A', null, null)`, [leagueId, liveMatch, voters[i]]);
      }
      for (let i = 0; i < 20; i++) {
        // Dieselbe Gewinnchance wie beim VS-Spiel (100 %/0 %) – so lässt sich die Position der %-Zahl 1:1
        // vergleichen, ohne dass unterschiedliche Ziffernzahlen das Ergebnis verfälschen.
        await q.run(`insert into predictions (league_id, match_id, user_id, winner, winner_wins, loser_wins) values ($1, $2, $3, 'A', null, null)`, [leagueId, scoreMatch, voters[i]]);
      }
    });

    const { chromium } = playwright!;
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const problems: string[] = [];
    try {
      const context = await browser.newContext({ locale: 'de-DE' });
      await context.addCookies([...me.cookies].map(([name, value]) => ({ name, value, url: base })));
      for (const width of [390, 1300]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px`;
        await page.goto(`${base}/r/${slug}/tippen`, { waitUntil: 'load' });
        const r = await page.evaluate(
          ({ idLive, idScore }: { idLive: string; idScore: string }) => {
            // Position des %-Zeichens selbst (wie beim Test für 1-/2-/3-stellige Zahlen oben) – so lässt sich
            // vergleichen, ob die Zahl bei "VS" exakt an derselben Stelle steht wie beim Spoilerschutz.
            const percentX = (matchId: string, cls: string) => {
              const span = document.querySelector(`#spiel-${matchId} .${cls}`);
              const last = span?.lastChild;
              if (!last || last.nodeType !== Node.TEXT_NODE || !last.textContent) return null;
              const i = last.textContent.lastIndexOf('%');
              if (i < 0) return null;
              const range = document.createRange();
              range.setStart(last, i);
              range.setEnd(last, last.textContent.length);
              return range.getBoundingClientRect().left;
            };
            return {
              aLive: percentX(idLive, 'pct-a'),
              bLive: percentX(idLive, 'pct-b'),
              aScore: percentX(idScore, 'pct-a'),
              bScore: percentX(idScore, 'pct-b'),
            };
          },
          { idLive: liveMatch, idScore: scoreMatch },
        );
        if (r.aLive === null || r.bLive === null || r.aScore === null || r.bScore === null) {
          problems.push(`${where}: %-Zeichen nicht gefunden`);
        } else {
          // Beide Spiele haben dieselbe Gewinnchance (100 % / 0 %) und gleich lange Teamnamen – die Position
          // der %-Zahl darf sich also nicht unterscheiden, egal ob in der Mitte "VS" oder das Ergebnis steht.
          if (Math.abs(r.aLive - r.aScore) > 1) problems.push(`${where}: % links bei VS (${r.aLive}) und Spoilerschutz (${r.aScore}) unterschiedlich`);
          if (Math.abs(r.bLive - r.bScore) > 1) problems.push(`${where}: % rechts bei VS (${r.bLive}) und Spoilerschutz (${r.bScore}) unterschiedlich`);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test('Kopf-Suche: nur die Lupe, bis man draufklickt – dann öffnet sich darunter das Eingabefeld, ohne die Seite zu verschieben', async () => {
    const { id: tid } = (await db.one<{ id: string }>(
      `insert into tournaments (name, starts_on, ends_on) values ('Suche-Testturnier', current_date - 1, current_date + 30) returning id`,
    ))!;

    const me = new Client();
    await me.request('GET', '/anmelden');
    assert.equal((await me.request('POST', '/anmelden', { email: 'admin@example.de', password: PASSWORT })).status, 303);
    await me.request('GET', '/konto');
    const created = await me.request('POST', '/neu', { name: 'Such-Runde', tournament_id: tid, points_winner: '1', points_exact: '1', lock_mode: 'match' });
    assert.equal(created.status, 303, created.text);
    const slug = /\/r\/([^/]+)\//.exec(created.location!)![1];

    const { chromium } = playwright!;
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const problems: string[] = [];
    try {
      const context = await browser.newContext({ locale: 'de-DE' });
      await context.addCookies([...me.cookies].map(([name, value]) => ({ name, value, url: base })));
      for (const width of [390, 700, 1300]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px`;
        await page.goto(`${base}/r/${slug}/tippen`, { waitUntil: 'load' });
        const box = (sel: string) =>
          page.evaluate((s: string) => {
            const el = document.querySelector(s) as HTMLElement | null;
            // checkVisibility() beachtet auch ein geschlossenes <details> – anders als getComputedStyle()
            // allein, denn Chromium hält den Inhalt eines geschlossenen <details> zwar fürs Layout vor
            // (getBoundingClientRect() liefert trotzdem eine Box), zeichnet ihn aber nicht.
            if (!el || (el.checkVisibility ? !el.checkVisibility() : getComputedStyle(el).display === 'none')) return null;
            const r = el.getBoundingClientRect();
            return r.width > 0 ? { top: r.top, left: r.left, right: r.right } : null;
          }, sel);

        // Vorher: nur die Lupe, kein Eingabefeld – am Handy direkt neben "Kronenrunde".
        const before = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
        if (before.scroll > before.inner + 1) problems.push(`${where} (zu): Seite ragt seitlich heraus (${before.scroll}px bei ${before.inner}px)`);
        const brand = await box('.brand');
        const btnClosed = await box('.top-search-btn');
        if (await box('.top-search-q')) problems.push(`${where} (zu): Eingabefeld sollte erst nach einem Klick erscheinen`);
        if (!btnClosed) problems.push(`${where} (zu): Lupen-Knopf fehlt`);
        if (width <= 640 && brand && btnClosed && Math.abs(brand.top - btnClosed.top) > 10) {
          problems.push(`${where} (zu): Lupe steht nicht in derselben Zeile wie "Kronenrunde" (${brand.top} vs. ${btnClosed.top})`);
        }

        // Klick auf die Lupe: Eingabefeld klappt auf, ohne die übrige Kopfzeile zu verschieben oder die Seite zu verbreitern.
        await page.click('.top-search-btn');
        const after = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
        if (after.scroll > after.inner + 1) problems.push(`${where} (auf): Seite ragt seitlich heraus (${after.scroll}px bei ${after.inner}px)`);
        if (!(await box('.top-search-q'))) problems.push(`${where} (auf): Eingabefeld erscheint nach dem Klick nicht`);
        const brandAfter = await box('.brand');
        if (brand && brandAfter && Math.abs(brand.top - brandAfter.top) > 1) problems.push(`${where} (auf): Logo verschiebt sich durch das Aufklappen`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });
});
