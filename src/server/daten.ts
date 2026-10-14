// Turnierdaten aus einer Datei einspielen (db/daten/<name>.json):
//   tippspiel daten worlds-2026        (auf dem Server)
//   npm run daten -- worlds-2026       (beim Entwickeln)
//
// Mehrfach ausführbar: Was es schon gibt, wird aktualisiert statt doppelt angelegt.
// Was im Admin-Bereich von Hand eingetragen wurde (Teams eines offenen Spiels, Ergebnisse),
// bleibt erhalten, solange die Datei an dieser Stelle nichts angibt.
// Dieselbe Funktion kann später eine automatische Datenquelle (API) benutzen.

import type { BestOf } from '../domain/types.ts';
import type { Db, Queryable } from './db/index.ts';

export interface TournamentData {
  tournament: { key: string; name: string; game?: string; starts_on?: string | null; ends_on?: string | null };
  /** Phasen in ihrer Reihenfolge; der Name erscheint bei jedem Spiel. */
  stages?: string[];
  teams: { key: string; name: string; short_name?: string | null; region?: string | null }[];
  matches: {
    key: string;
    stage?: string | null;
    /** Kennung aus "teams" oder null, solange das Team noch nicht feststeht. */
    team_a?: string | null;
    team_b?: string | null;
    best_of: BestOf;
    /** ISO-Zeit mit Zeitzone, z. B. 2026-10-15T11:00:00-07:00 */
    scheduled_at?: string | null;
    /** Siege [Team A, Team B], z. B. [3, 1] */
    result?: [number, number] | null;
  }[];
}

export interface ImportSummary {
  tournament: string;
  tournamentNew: boolean;
  teamsNew: number;
  teamsKnown: number;
  matchesNew: number;
  matchesChanged: number;
  matchesUnchanged: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Prüft die Datei, bevor irgendetwas in die Datenbank geht. Gibt die gefundenen Fehler zurück. */
export function validateTournamentData(data: unknown): string[] {
  const errors: string[] = [];
  const d = data as Partial<TournamentData> | null;
  if (!d || typeof d !== 'object') return ['Die Datei enthält keine Turnierdaten.'];

  const t = d.tournament;
  if (!t || typeof t.key !== 'string' || !/^[a-z0-9-]{3,60}$/.test(t.key)) errors.push('tournament.key fehlt oder ist ungültig (nur a-z, 0-9, -).');
  if (!t || typeof t.name !== 'string' || !t.name.trim()) errors.push('tournament.name fehlt.');
  for (const f of ['starts_on', 'ends_on'] as const) {
    const v = t?.[f];
    if (v != null && (typeof v !== 'string' || !DATE.test(v))) errors.push(`tournament.${f} muss JJJJ-MM-TT sein.`);
  }

  const stages = d.stages ?? [];
  if (!Array.isArray(stages) || stages.some((s) => typeof s !== 'string' || !s.trim())) errors.push('stages muss eine Liste von Namen sein.');
  else if (new Set(stages).size !== stages.length) errors.push('stages enthält einen Namen doppelt.');

  const teamKeys = new Set<string>();
  const teamNames = new Set<string>();
  if (!Array.isArray(d.teams)) errors.push('teams fehlt.');
  for (const [i, team] of (Array.isArray(d.teams) ? d.teams : []).entries()) {
    const where = `teams[${i}]`;
    if (typeof team?.key !== 'string' || !team.key.trim()) { errors.push(`${where}: key fehlt.`); continue; }
    if (teamKeys.has(team.key)) errors.push(`${where}: key "${team.key}" doppelt.`);
    teamKeys.add(team.key);
    if (typeof team.name !== 'string' || !team.name.trim()) errors.push(`${where} (${team.key}): name fehlt.`);
    else if (teamNames.has(team.name.toLowerCase())) errors.push(`${where}: Name "${team.name}" doppelt.`);
    else teamNames.add(team.name.toLowerCase());
  }

  const matchKeys = new Set<string>();
  if (!Array.isArray(d.matches)) errors.push('matches fehlt.');
  for (const [i, m] of (Array.isArray(d.matches) ? d.matches : []).entries()) {
    const where = `matches[${i}]${typeof m?.key === 'string' ? ` (${m.key})` : ''}`;
    if (typeof m?.key !== 'string' || !m.key.trim()) { errors.push(`${where}: key fehlt.`); continue; }
    if (matchKeys.has(m.key)) errors.push(`${where}: key doppelt.`);
    matchKeys.add(m.key);
    if (m.stage != null && !stages.includes(m.stage)) errors.push(`${where}: Phase "${m.stage}" steht nicht in stages.`);
    for (const side of ['team_a', 'team_b'] as const) {
      const ref = m[side];
      if (ref != null && !teamKeys.has(ref)) errors.push(`${where}: ${side} "${ref}" steht nicht in teams.`);
    }
    if (m.team_a != null && m.team_a === m.team_b) errors.push(`${where}: Ein Team kann nicht gegen sich selbst spielen.`);
    if (![1, 3, 5].includes(m.best_of)) errors.push(`${where}: best_of muss 1, 3 oder 5 sein.`);
    if (m.scheduled_at != null && (typeof m.scheduled_at !== 'string' || !ISO_WITH_ZONE.test(m.scheduled_at) || Number.isNaN(Date.parse(m.scheduled_at)))) {
      errors.push(`${where}: scheduled_at braucht Datum, Uhrzeit und Zeitzone, z. B. 2026-10-15T11:00:00-07:00.`);
    }
    if (m.result != null) {
      const need = ([1, 3, 5].includes(m.best_of) ? m.best_of + 1 : 2) / 2;
      const [a, b]: unknown[] = Array.isArray(m.result) ? m.result : [];
      const ok = typeof a === 'number' && typeof b === 'number' && Number.isInteger(a) && Number.isInteger(b)
        && a >= 0 && b >= 0 && Math.max(a, b) === need && a !== b;
      if (!ok) errors.push(`${where}: result passt nicht zu Bo${m.best_of} (z. B. [${need}, ${need - 1}]).`);
      if (m.team_a == null || m.team_b == null) errors.push(`${where}: Ein Ergebnis geht nur, wenn beide Teams feststehen.`);
    }
  }
  return errors;
}

/** Spielt die Daten in einer Transaktion ein: entweder alles oder nichts. */
export async function importTournament(db: Db, data: TournamentData): Promise<ImportSummary> {
  const errors = validateTournamentData(data);
  if (errors.length) throw new Error(`Die Datei ist fehlerhaft:\n  - ${errors.join('\n  - ')}`);
  return db.tx((q) => importInto(q, data));
}

async function importInto(q: Queryable, data: TournamentData): Promise<ImportSummary> {
  const game = data.tournament.game ?? 'lol';

  // Teams: vorhandene (auch von Hand angelegte) über den Namen oder das Kürzel wiederfinden
  const existing = await q.query<{ id: string; name: string; short_name: string | null }>(
    'select id, name, short_name from teams where game = $1',
    [game],
  );
  const teamId = new Map<string, string>();
  let teamsNew = 0;
  for (const t of data.teams) {
    const byName = existing.find((e) => e.name.toLowerCase() === t.name.toLowerCase());
    const byShort = t.short_name ? existing.filter((e) => e.short_name?.toLowerCase() === t.short_name!.toLowerCase()) : [];
    const found = byName ?? (byShort.length === 1 ? byShort[0] : undefined);
    if (found) {
      await q.run(
        'update teams set short_name = coalesce(short_name, $2), region = coalesce(region, $3) where id = $1',
        [found.id, t.short_name ?? null, t.region ?? null],
      );
      teamId.set(t.key, found.id);
    } else {
      const row = await q.one<{ id: string }>(
        'insert into teams (game, name, short_name, region) values ($1, $2, $3, $4) returning id',
        [game, t.name.trim(), t.short_name ?? null, t.region ?? null],
      );
      teamId.set(t.key, row!.id);
      teamsNew++;
    }
  }

  // Turnier: über die Kennung, sonst ein von Hand angelegtes mit gleichem Namen übernehmen
  let tournament = await q.one<{ id: string }>('select id from tournaments where game = $1 and external_id = $2', [game, data.tournament.key]);
  let tournamentNew = false;
  if (!tournament) {
    tournament = await q.one<{ id: string }>(
      `update tournaments set external_id = $2
        where id = (select id from tournaments where game = $1 and external_id is null and lower(name) = lower($3)
                     order by created_at limit 1)
        returning id`,
      [game, data.tournament.key, data.tournament.name],
    );
  }
  if (!tournament) {
    tournament = await q.one<{ id: string }>(
      'insert into tournaments (game, name, external_id) values ($1, $2, $3) returning id',
      [game, data.tournament.name.trim(), data.tournament.key],
    );
    tournamentNew = true;
  }
  const tid = tournament!.id;
  await q.run(
    'update tournaments set starts_on = coalesce($2::date, starts_on), ends_on = coalesce($3::date, ends_on) where id = $1',
    [tid, data.tournament.starts_on ?? null, data.tournament.ends_on ?? null],
  );

  // Teilnehmende Teams (für Sonderfragen wie "Wer wird Weltmeister?", auch bevor ihre Spiele feststehen)
  for (const id of teamId.values()) {
    await q.run('insert into tournament_teams (tournament_id, team_id) values ($1, $2) on conflict do nothing', [tid, id]);
  }

  // Phasen
  const stageId = new Map<string, string>();
  for (const [i, name] of (data.stages ?? []).entries()) {
    const row = await q.one<{ id: string }>(
      `insert into stages (tournament_id, name, position) values ($1, $2, $3)
       on conflict (tournament_id, name) do update set position = excluded.position
       returning id`,
      [tid, name, i + 1],
    );
    stageId.set(name, row!.id);
  }

  // Spiele: Angaben aus der Datei gelten; fehlt eine Angabe (Team offen, kein Ergebnis), bleibt der Eintrag aus dem Admin-Bereich.
  // Das Format (Bo) bleibt, sobald jemand getippt hat oder ein Ergebnis steht – sonst würden Tipps oder Ergebnis ungültig.
  let matchesNew = 0;
  let matchesChanged = 0;
  for (const m of data.matches) {
    const [winsA, winsB] = m.result ?? [null, null];
    const row = await q.one<{ inserted: boolean }>(
      `insert into matches as m (tournament_id, external_id, stage_id, team_a_id, team_b_id, best_of, scheduled_at, wins_a, wins_b, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $8::smallint is null then 'scheduled' else 'finished' end)
       on conflict (tournament_id, external_id) where external_id is not null do update set
         stage_id     = coalesce(excluded.stage_id, m.stage_id),
         team_a_id    = coalesce(excluded.team_a_id, m.team_a_id),
         team_b_id    = coalesce(excluded.team_b_id, m.team_b_id),
         best_of      = case when m.wins_a is not null or exists (select 1 from predictions p where p.match_id = m.id)
                             then m.best_of else excluded.best_of end,
         scheduled_at = coalesce(excluded.scheduled_at, m.scheduled_at),
         wins_a       = coalesce(excluded.wins_a, m.wins_a),
         wins_b       = coalesce(excluded.wins_b, m.wins_b),
         status       = case when excluded.wins_a is not null and m.status <> 'cancelled' then 'finished' else m.status end
       where (m.stage_id, m.team_a_id, m.team_b_id, m.scheduled_at, m.wins_a, m.wins_b)
             is distinct from
             (coalesce(excluded.stage_id, m.stage_id), coalesce(excluded.team_a_id, m.team_a_id),
              coalesce(excluded.team_b_id, m.team_b_id), coalesce(excluded.scheduled_at, m.scheduled_at),
              coalesce(excluded.wins_a, m.wins_a), coalesce(excluded.wins_b, m.wins_b))
          or (m.best_of <> excluded.best_of and m.wins_a is null
              and not exists (select 1 from predictions p where p.match_id = m.id))
       returning (xmax = 0) as inserted`,
      [
        tid,
        m.key,
        m.stage ? stageId.get(m.stage)! : null,
        m.team_a ? teamId.get(m.team_a)! : null,
        m.team_b ? teamId.get(m.team_b)! : null,
        m.best_of,
        m.scheduled_at ?? null,
        winsA,
        winsB,
      ],
    );
    if (row?.inserted) matchesNew++;
    else if (row) matchesChanged++;
  }

  return {
    tournament: data.tournament.name,
    tournamentNew,
    teamsNew,
    teamsKnown: data.teams.length - teamsNew,
    matchesNew,
    matchesChanged,
    matchesUnchanged: data.matches.length - matchesNew - matchesChanged,
  };
}

export function describeSummary(s: ImportSummary): string {
  return [
    `${s.tournament}: ${s.tournamentNew ? 'neu angelegt' : 'aktualisiert'}`,
    `  Teams:  ${s.teamsNew} neu, ${s.teamsKnown} schon vorhanden`,
    `  Spiele: ${s.matchesNew} neu, ${s.matchesChanged} geändert, ${s.matchesUnchanged} unverändert`,
  ].join('\n');
}
