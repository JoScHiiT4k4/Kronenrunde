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
});
