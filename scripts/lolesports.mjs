#!/usr/bin/env node
// Liest den Spielplan eines Turniers von lolesports.com (inoffizielle Schnittstelle der Seite) und
// gibt ihn kompakt als JSON aus. Nur zum Abgleichen; die App selbst braucht das nicht.
//
//   node scripts/lolesports.mjs worlds > spielplan.json
//
// Die Schnittstelle ist nicht offiziell dokumentiert und kann sich ohne Vorwarnung ändern.
// Der Schlüssel ist der öffentliche, den lolesports.com selbst im Browser benutzt.

const BASE = 'https://esports-api.lolesports.com/persisted/gw';
const KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const slug = process.argv[2] ?? 'worlds';

async function get(path, params) {
  const url = `${BASE}/${path}?${new URLSearchParams({ hl: 'de-DE', ...params })}`;
  const res = await fetch(url, { headers: { 'x-api-key': KEY } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()).data;
}

// Modus "teams": Teams mit Kader zu den angegebenen Kürzeln (z. B. "teams T1,GEN,KC")
if (slug === 'teams') {
  const codes = new Set((process.argv[3] ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
  const { teams } = await get('getTeams', {});
  const found = teams
    .filter((t) => codes.has(String(t.code).toUpperCase()))
    .map((t) => ({
      id: t.id, slug: t.slug, code: t.code, name: t.name, status: t.status,
      homeLeague: t.homeLeague ?? null,
      players: (t.players ?? []).map((p) => ({ id: p.id, summonerName: p.summonerName, firstName: p.firstName, lastName: p.lastName, role: p.role })),
    }));
  console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), total: teams.length, keys: Object.keys(teams[0] ?? {}), teams: found }, null, 2));
  process.exit(0);
}

const { leagues } = await get('getLeagues', {});
const league = leagues.find((l) => l.slug === slug);
if (!league) throw new Error(`Liga "${slug}" nicht gefunden. Vorhanden: ${leagues.map((l) => l.slug).join(', ')}`);

// Alle Seiten des Spielplans einsammeln (ältere und neuere)
const events = new Map();
const seen = new Set();
const queue = [undefined];
while (queue.length && seen.size < 30) {
  const token = queue.shift();
  if (seen.has(token ?? '')) continue;
  seen.add(token ?? '');
  const { schedule } = await get('getSchedule', { leagueId: league.id, ...(token ? { pageToken: token } : {}) });
  for (const e of schedule.events) if (e.type === 'match') events.set(e.match?.id ?? `${e.startTime}-${e.blockName}`, e);
  for (const t of [schedule.pages?.older, schedule.pages?.newer]) if (t && !seen.has(t)) queue.push(t);
}

const year = process.env.JAHR ?? String(new Date().getUTCFullYear());
const out = [...events.values()]
  .filter((e) => e.startTime.startsWith(year))
  .sort((a, b) => a.startTime.localeCompare(b.startTime))
  .map((e) => ({
    id: e.match?.id ?? null,
    start: e.startTime,
    state: e.state,
    block: e.blockName,
    bestOf: e.match?.strategy?.count ?? null,
    teams: (e.match?.teams ?? []).map((t) => ({
      code: t.code,
      name: t.name,
      wins: t.result?.gameWins ?? null,
      outcome: t.result?.outcome ?? null,
    })),
  }));

console.log(JSON.stringify({ league: { id: league.id, slug: league.slug, name: league.name }, fetchedAt: new Date().toISOString(), matches: out }, null, 2));
