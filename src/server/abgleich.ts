// Datenabgleich mit Riot: Champion-Liste und Spielerkader der Turnier-Teams.
//
// - Champions: Data Dragon, Riots offizielle, frei nutzbare Datenquelle (deutsche Namen).
// - Spieler:   lolesports.com (inoffizielle Schnittstelle der Seite – kann sich ändern; siehe docs/ARCHITEKTUR.md).
//
// Läuft in der App alle 6 Stunden (DATENABGLEICH, in Produktion an), auf Knopfdruck im Admin-Bereich
// und mit  tippspiel abgleich. Fehler werden gemeldet, die vorhandenen Daten bleiben dann einfach stehen.

import type { Db } from './db/index.ts';

export type FetchJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

export const fetchJson: FetchJson = async (url, headers = {}) => {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'LoL-Tippspiel (Fan-Projekt)', ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
};

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const LOLESPORTS = 'https://esports-api.lolesports.com/persisted/gw';
/** Öffentlicher Schlüssel, den lolesports.com selbst im Browser benutzt. */
const LOLESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// ---------------------------------------------------------------------
// Champions
// ---------------------------------------------------------------------

export async function fetchChampions(get: FetchJson): Promise<{ id: string; name: string }[]> {
  const versions = await get(`${DDRAGON}/api/versions.json`);
  if (!Array.isArray(versions) || typeof versions[0] !== 'string') throw new Error('Data Dragon: keine Versionsliste erhalten');
  const file = (await get(`${DDRAGON}/cdn/${encodeURIComponent(versions[0])}/data/de_DE/champion.json`)) as {
    data?: Record<string, { id?: unknown; name?: unknown }>;
  };
  const list = Object.values(file?.data ?? {})
    .filter((c): c is { id: string; name: string } => typeof c?.id === 'string' && typeof c?.name === 'string' && !!c.name.trim())
    .map((c) => ({ id: c.id, name: c.name.trim() }));
  // Plausibilität: Es gibt weit über 100 Champions. Weniger heißt: Antwort kaputt – lieber nichts ändern.
  if (list.length < 100) throw new Error(`Data Dragon: nur ${list.length} Champions erhalten`);
  return list;
}

export async function syncChampions(db: Db, get: FetchJson = fetchJson): Promise<string> {
  const list = await fetchChampions(get);
  await db.run(
    `insert into champions (id, name)
     select * from unnest($1::text[], $2::text[])
     on conflict (id) do update set name = excluded.name, updated_at = now()
     where champions.name is distinct from excluded.name`,
    [list.map((c) => c.id), list.map((c) => c.name)],
  );
  return `${list.length} Champions`;
}

// ---------------------------------------------------------------------
// Spieler
// ---------------------------------------------------------------------

export interface LolTeam {
  id: string;
  slug?: string;
  code?: string;
  name: string;
  status?: string;
  homeLeague?: { name?: string; region?: string } | null;
  players?: { id: string; summonerName: string; role?: string }[];
}

export async function fetchLolesportsTeams(get: FetchJson): Promise<LolTeam[]> {
  const res = (await get(`${LOLESPORTS}/getTeams?hl=de-DE`, { 'x-api-key': LOLESPORTS_KEY })) as { data?: { teams?: LolTeam[] } };
  const teams = res?.data?.teams;
  if (!Array.isArray(teams) || teams.length < 20) throw new Error('lolesports.com: keine Teamliste erhalten');
  return teams.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string');
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/**
 * Findet zu einem eigenen Team das passende bei lolesports.com: aktives Team derselben Liga (Region),
 * gleiches Kürzel und/oder ähnlicher Name. Akademie-Teams spielen in anderen Ligen und fallen so heraus.
 * Ist das Ergebnis nicht eindeutig, lieber keins (null).
 */
export function matchTeam(
  ours: { name: string; short_name: string | null; region: string | null; external_id: string | null },
  all: LolTeam[],
): LolTeam | null {
  if (ours.external_id) {
    const known = all.find((t) => t.id === ours.external_id);
    if (known) return known;
  }
  // Region nur beachten, wenn es eine echte Liga ist (z. B. LCK) – sonst (leer, Tippfehler) über alle suchen
  let region = norm(ours.region);
  if (region && !all.some((t) => norm(t.homeLeague?.name) === region)) region = '';
  const candidates = all.filter((t) => (t.status ?? 'active') === 'active' && (!region || norm(t.homeLeague?.name) === region));
  const n = norm(ours.name);
  const c = norm(ours.short_name);
  const ranked = candidates
    .map((t) => {
      const tn = norm(t.name);
      let score = 0;
      if (c && norm(t.code) === c) score += 2;
      if (n && tn === n) score += 3;
      else if (n && tn && (tn.includes(n) || n.includes(tn))) score += 2;
      return { t, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score)) return null;
  return ranked[0].t;
}

export async function syncPlayers(db: Db, get: FetchJson = fetchJson): Promise<string> {
  // Teams aus laufenden, kommenden oder gerade beendeten Turnieren
  const ours = await db.query<{ id: string; name: string; short_name: string | null; region: string | null; external_id: string | null }>(
    `select distinct t.id, t.name, t.short_name, t.region, t.external_id
       from teams t
       join tournament_teams tt on tt.team_id = t.id
       join tournaments tr on tr.id = tt.tournament_id
      where t.game = 'lol' and coalesce(tr.ends_on, current_date) >= current_date - 14
      order by t.name`,
  );
  if (!ours.length) return 'Keine Teams in aktuellen Turnieren';
  const all = await fetchLolesportsTeams(get);

  const missing: string[] = [];
  let players = 0;
  await db.tx(async (q) => {
    for (const team of ours) {
      const found = matchTeam(team, all);
      if (!found) {
        missing.push(team.name);
        continue;
      }
      if (!team.external_id) {
        await q.run(
          `update teams set external_id = $2 where id = $1
             and not exists (select 1 from teams x where x.game = 'lol' and x.external_id = $2)`,
          [team.id, found.id],
        );
      }
      const roster = (found.players ?? [])
        .filter((p) => p && typeof p.id === 'string' && typeof p.summonerName === 'string' && p.summonerName.trim())
        .map((p) => ({ id: p.id, name: p.summonerName.trim().slice(0, 40), role: p.role && p.role !== 'none' ? p.role : null }));
      for (const p of roster) {
        await q.run(
          `insert into players (team_id, name, role, external_id) values ($1, $2, $3, $4)
           on conflict (external_id) where external_id is not null do update
             set team_id = excluded.team_id, name = excluded.name, role = excluded.role, active = true, updated_at = now()`,
          [team.id, p.name, p.role, p.id],
        );
      }
      // Wer nicht mehr im Kader steht, verschwindet aus der Auswahl (abgegebene Antworten bleiben)
      await q.run(
        `update players set active = false, updated_at = now()
          where team_id = $1 and active and (external_id is null or not (external_id = any($2::text[])))`,
        [team.id, roster.map((p) => p.id)],
      );
      players += roster.length;
    }
  });
  const matched = ours.length - missing.length;
  return `${players} Spieler aus ${matched} von ${ours.length} Teams${missing.length ? ` – nicht gefunden: ${missing.join(', ')}` : ''}`;
}

// ---------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------

export interface SyncResult {
  name: string;
  ok: boolean;
  details: string;
}

const JOBS: { name: string; label: string; run: (db: Db, get: FetchJson) => Promise<string> }[] = [
  { name: 'champions', label: 'Champions (Riot Data Dragon)', run: syncChampions },
  { name: 'spieler', label: 'Spielerkader (lolesports.com)', run: syncPlayers },
];
export const SYNC_LABELS: Record<string, string> = Object.fromEntries(JOBS.map((j) => [j.name, j.label]));

/** Führt alle Abgleiche aus und merkt sich das Ergebnis in sync_status. Wirft nie. */
export async function runSync(db: Db, get: FetchJson = fetchJson): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const job of JOBS) {
    try {
      const details = await job.run(db, get);
      await db.run(
        `insert into sync_status (name, ok_at, details, error, updated_at) values ($1, now(), $2, null, now())
         on conflict (name) do update set ok_at = now(), details = excluded.details, error = null, updated_at = now()`,
        [job.name, details],
      );
      results.push({ name: job.name, ok: true, details });
    } catch (e) {
      const message = (e as Error).message.slice(0, 300);
      await db
        .run(
          `insert into sync_status (name, error, updated_at) values ($1, $2, now())
           on conflict (name) do update set error = excluded.error, updated_at = now()`,
          [job.name, message],
        )
        .catch(() => {});
      results.push({ name: job.name, ok: false, details: message });
    }
  }
  return results;
}

/** Abgleich kurz nach dem Start und dann alle 6 Stunden. */
export function startSyncSchedule(db: Db, log: (msg: string) => void, get: FetchJson = fetchJson): () => void {
  const tick = async () => {
    for (const r of await runSync(db, get)) log(`Datenabgleich ${SYNC_LABELS[r.name]}: ${r.ok ? r.details : `Fehler – ${r.details}`}`);
  };
  const first = setTimeout(tick, 20_000);
  const every = setInterval(tick, 6 * 3_600_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
