// Tests für die Server-Bausteine, die ohne Datenbank laufen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csrfToken, csrfValid, normalizeEmail, safeNext } from './auth.ts';
import { parseArray, parseDatabaseUrl, parseTimestamp, serializeParam } from './db/pg.ts';
import { formatDateTime, formatDayLong, toLocalInput } from './format.ts';
import { html, raw } from './html.ts';
import { isSameOrigin, parseCookies, Router, serializeCookie } from './http.ts';
import { cleanName, slugify } from './routes/common.ts';
import { parsePick, pickValue } from './routes/leagues.ts';

test('HTML: Eingaben werden maskiert, verschachteltes HTML nicht', () => {
  const name = '<img src=x onerror=alert(1)> & "Tom\'s"';
  assert.equal(
    html`<p title="${name}">${name}</p>`.value,
    '<p title="&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Tom&#39;s&quot;">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Tom&#39;s&quot;</p>',
  );
  assert.equal(html`<ul>${['a', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`.value, '<ul><li>a</li><li>b</li></ul>');
  assert.equal(html`${null}${undefined}${false}${0}${raw('<b>')}`.value, '0<b>');
});

test('Datenbank: Arrays, Zeitstempel, Parameter', () => {
  assert.deepEqual(parseArray('{}'), []);
  assert.deepEqual(parseArray('{a,"b c",NULL,"x\\"y","back\\\\slash"}'), ['a', 'b c', null, 'x"y', 'back\\slash']);
  assert.equal(parseTimestamp('2026-10-15 18:00:00+00', true).toISOString(), '2026-10-15T18:00:00.000Z');
  assert.equal(parseTimestamp('2026-10-15 20:00:00.5+02', true).toISOString(), '2026-10-15T18:00:00.500Z');
  assert.equal(parseTimestamp('2026-01-01 05:30:00.123456+05:30', true).toISOString(), '2026-01-01T00:00:00.123Z');
  assert.equal(parseTimestamp('2026-10-15 12:00:00-03', true).toISOString(), '2026-10-15T15:00:00.000Z');
  assert.equal(serializeParam(null), null);
  assert.equal(serializeParam(true)?.toString(), 't');
  assert.equal(serializeParam(['a', 'b"c', null])?.toString(), '{"a","b\\"c",NULL}');
  assert.equal(serializeParam(new Date('2026-10-15T18:00:00Z'))?.toString(), '2026-10-15T18:00:00.000Z');
  assert.throws(() => serializeParam('a\0b'));
});

test('Datenbank-Adresse lesen', () => {
  const c = parseDatabaseUrl('postgresql://user:p%40ss@db.example.com:6543/postgres?sslmode=require');
  assert.deepEqual(
    { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, ssl: c.ssl },
    { host: 'db.example.com', port: 6543, user: 'user', password: 'p@ss', database: 'postgres', ssl: 'require' },
  );
  assert.equal(parseDatabaseUrl('postgres://u:p@localhost/x').ssl, 'disable');
  assert.equal(parseDatabaseUrl('postgres://u:p@db.example.com/x').ssl, 'prefer');
  assert.throws(() => parseDatabaseUrl('mysql://x'));
});

test('Anzeige in deutscher Zeit, auch über die Zeitumstellung', () => {
  const tz = 'Europe/Berlin';
  assert.equal(formatDateTime(new Date('2026-10-15T18:00:00Z'), tz), 'Do., 15.10., 20:00');
  assert.equal(formatDateTime(new Date('2026-11-07T15:00:00Z'), tz), 'Sa., 07.11., 16:00'); // nach Umstellung auf Winterzeit
  assert.equal(formatDayLong(new Date('2026-10-15T18:00:00Z'), tz), 'Donnerstag, 15. Oktober');
  assert.equal(toLocalInput(new Date('2026-10-15T18:00:00Z'), tz), '2026-10-15T20:00');
  assert.equal(toLocalInput(null, tz), '');
});

test('Cookies und Formular-Herkunft', () => {
  assert.deepEqual(parseCookies('sid=abc; x=%C3%A4; sid=zweiter'), { sid: 'abc', x: 'ä' });
  assert.equal(serializeCookie('sid', 'abc', { secure: true, maxAgeSeconds: 60 }), 'sid=abc; Path=/; SameSite=Lax; HttpOnly; Secure; Max-Age=60');
  const app = 'https://tippspiel.example.de';
  assert.equal(isSameOrigin({ origin: app, host: 'tippspiel.example.de' }, app), true);
  assert.equal(isSameOrigin({ origin: 'https://boese.example', host: 'tippspiel.example.de' }, app), false);
  assert.equal(isSameOrigin({ 'sec-fetch-site': 'cross-site', host: 'tippspiel.example.de' }, app), false);
  assert.equal(isSameOrigin({ host: 'tippspiel.example.de' }, app), true);
});

test('Formular-Token und sichere Weiterleitung', () => {
  const t = csrfToken('geheim', 'sitzung-1');
  assert.equal(csrfValid('geheim', 'sitzung-1', t), true);
  assert.equal(csrfValid('geheim', 'sitzung-2', t), false);
  assert.equal(csrfValid('geheim', 'sitzung-1', null), false);
  assert.equal(safeNext('/r/runde/tippen'), '/r/runde/tippen');
  assert.equal(safeNext('//boese.example'), '/');
  assert.equal(safeNext('https://boese.example'), '/');
  assert.equal(safeNext('/\\boese.example'), '/');
});

test('E-Mail, Namen, Adressen', () => {
  assert.equal(normalizeEmail('  Anna@Example.DE '), 'anna@example.de');
  assert.equal(normalizeEmail('ohne-at.de'), null);
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(cleanName('  Faker   der\tGroße  '), 'Faker der Große');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName('x'.repeat(41)), null);
  assert.equal(slugify('Die Rift-Runde 2026'), 'die-rift-runde-2026');
  assert.equal(slugify('Größte Fans! Ørsted'), 'groesste-fans-orsted');
});

test('Tipp-Werte im Formular', () => {
  for (const v of ['A', 'B', 'A-3-1', 'B-2-0']) assert.equal(pickValue(parsePick(v)!), v);
  assert.equal(parsePick('C'), null);
  assert.equal(parsePick('A-3'), null);
  assert.equal(parsePick('A-10-1'), null);
});

test('Routen mit Platzhaltern', () => {
  const r = new Router<null>();
  const h = async () => ({ status: 200, headers: {}, body: '' });
  r.get('/r/:slug/tippen', h);
  r.post('/r/:slug/tippen', h);
  const m = r.match('GET', '/r/die-runde/tippen');
  assert.ok(m && m !== 'method');
  assert.deepEqual(m.params, { slug: 'die-runde' });
  assert.equal(r.match('PUT', '/r/x/tippen'), 'method');
  assert.equal(r.match('GET', '/r/x/y/tippen'), null);
  assert.ok(r.match('HEAD', '/r/x/tippen'));
});
