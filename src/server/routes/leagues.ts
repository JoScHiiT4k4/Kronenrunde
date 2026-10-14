// Startseite, Tipprunde anlegen/beitreten, Tippen, Spiel-Details, Rangliste, Sonderfragen.

import { isBonusCorrect } from '../../domain/bonus.ts';
import { arePredictionsPublic, isOpen, lockTime } from '../../domain/locking.ts';
import { isValidResult, matchResult, resultOptions, type ResultOption } from '../../domain/results.ts';
import { computeStandings, scorePrediction } from '../../domain/scoring.ts';
import type { Ctx } from '../app.ts';
import { PgError } from '../db/index.ts';
import { dayKey, formatDateTime, formatDayLong, formatRemaining, formatTime } from '../format.ts';
import { attr, type Html, html, nothing } from '../html.ts';
import { HttpError, htmlResponse, redirect, type Res, type Router } from '../http.ts';
import { csrfField, emptyState, layout, postButton } from '../views/layout.ts';
import { cleanName, intField, isUuid, loginRedirect, slugify } from './common.ts';
import {
  type League,
  leagueMatches,
  leagueTournaments,
  loadLeague,
  type MatchRow,
  oneMatch,
  type PredictionRow,
  rulesOf,
  shortA,
  shortB,
  toDomainMatch,
  toDomainPrediction,
} from './league-data.ts';

// ---------------------------------------------------------------------
// Tipp-Werte im Formular: "A" (Bo1) oder "A-3-1" (Sieger A gewinnt 3:1)
// ---------------------------------------------------------------------

export function pickValue(o: ResultOption): string {
  return o.winnerWins === null ? o.winner : `${o.winner}-${o.winnerWins}-${o.loserWins}`;
}

export function parsePick(value: string): ResultOption | null {
  const m = /^([AB])(?:-(\d)-(\d))?$/.exec(value);
  if (!m) return null;
  const winner = m[1] as 'A' | 'B';
  return m[2] === undefined
    ? { winner, winnerWins: null, loserWins: null }
    : { winner, winnerWins: Number(m[2]), loserWins: Number(m[3]) };
}

function pickLabel(m: MatchRow, winner: 'A' | 'B', winnerWins: number | null, loserWins: number | null): string {
  const team = winner === 'A' ? shortA(m) : shortB(m);
  return winnerWins === null ? team : `${team} ${winnerWins}:${loserWins}`;
}

function predictionLabel(m: MatchRow, p: { winner: 'A' | 'B'; winner_wins: number | null; loser_wins: number | null }): string {
  return pickLabel(m, p.winner, p.winner_wins, p.loser_wins);
}

function resultLabel(m: MatchRow): string | null {
  const r = matchResult(toDomainMatch(m));
  return r ? pickLabel(m, r.winner, r.winnerWins, r.loserWins) : null;
}

function pointsBadge(points: number | null, exact = false): Html {
  if (points === null) return nothing;
  return html`<span class="pts${points > 0 ? ' pts-hit' : ''}${exact ? ' pts-exact' : ''}">+${points}</span>`;
}

function leagueNav(access: { league: League; canManage: boolean }, active: 'tippen' | 'rangliste' | 'sonderfragen' | 'verwalten' | 'spiel') {
  return { slug: access.league.slug, name: access.league.name, canManage: access.canManage, active };
}

// ---------------------------------------------------------------------
// Startseite
// ---------------------------------------------------------------------

async function homePage(ctx: Ctx): Promise<Res> {
  const { config, db } = ctx.deps;
  if (!ctx.user) {
    const body = html`<section class="hero">
  <h1>Tippt die Worlds zusammen.</h1>
  <p>Sieger und Ergebnis jeder Serie tippen, Sonderfragen beantworten und in der Rangliste sehen, wer die Szene am besten kennt.</p>
  <div class="match preview" aria-hidden="true">
    <div class="match-meta"><span>Finale</span><span class="bo">Bo5</span></div>
    <div class="teams"><span class="team team-a">Gen.G</span><span class="vs">vs</span><span class="team team-b">T1</span></div>
    <div class="picks picks-bo5">
      <div class="side side-a">${['3:0', '3:1', '3:2'].map((s) => html`<span class="chip chip-a"><input type="radio" disabled tabindex="-1"><span>${s}</span></span>`)}</div>
      <div class="side side-b">${['3:2', '3:1', '3:0'].map((s) => html`<span class="chip chip-b"><input type="radio" disabled tabindex="-1"${attr(s === '3:2', 'checked')}><span>${s}</span></span>`)}</div>
    </div>
  </div>
  <p><a class="btn btn-primary" href="/anmelden">Anmelden</a></p>
  <p class="muted">Du hast einen Einladungslink? Öffne ihn einfach – die Anmeldung passiert dabei.</p>
</section>`;
    return htmlResponse(layout(ctx, { title: config.appName, body }));
  }

  const leagues = await db.query<{ slug: string; name: string; members: number; role: string }>(
    `select l.slug, l.name, m.role,
            (select count(*)::int from league_members x where x.league_id = l.id) as members
       from league_members m join leagues l on l.id = m.league_id
      where m.user_id = $1
      order by m.joined_at`,
    [ctx.user.id],
  );

  const body = html`<section class="panel">
  <h1>Deine Tipprunden</h1>
  ${
    leagues.length
      ? html`<ul class="league-list">
    ${leagues.map(
      (l) => html`<li><a href="/r/${l.slug}/tippen"><span class="league-list-name">${l.name}</span>
      <span class="muted">${l.members} ${l.members === 1 ? 'Mitglied' : 'Mitglieder'}${l.role === 'owner' ? ', von dir geleitet' : ''}</span></a></li>`,
    )}
  </ul>`
      : html`<p>Du bist noch in keiner Tipprunde. Tritt mit einem Einladungscode bei oder lege eine eigene an.</p>`
  }
</section>
<section class="panel two-col">
  <form method="post" action="/beitreten" class="stack">
    ${csrfField(ctx)}
    <h2>Tipprunde beitreten</h2>
    <label class="field">
      <span>Einladungscode oder -link</span>
      <input type="text" name="code" required maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false">
    </label>
    <button type="submit" class="btn">Beitreten</button>
  </form>
  <div class="stack">
    <h2>Eigene Tipprunde</h2>
    <p class="muted">Für deine Freunde, deine Community oder dein Team.</p>
    <a class="btn" href="/neu">Tipprunde erstellen</a>
  </div>
</section>`;
  return htmlResponse(layout(ctx, { title: 'Deine Tipprunden', body }));
}

// ---------------------------------------------------------------------
// Tipprunde erstellen
// ---------------------------------------------------------------------

async function createPage(ctx: Ctx, values: URLSearchParams, error?: string): Promise<Res> {
  const tournaments = await ctx.deps.db.query<{ id: string; name: string }>(
    `select id, name from tournaments order by starts_on desc nulls last, name`,
  );
  const v = (k: string, d = '') => values.get(k) ?? d;
  const body = html`<section class="panel narrow">
  <h1>Tipprunde erstellen</h1>
  <form method="post" action="/neu" class="stack">
    ${csrfField(ctx)}
    <label class="field">
      <span>Name der Tipprunde</span>
      <input type="text" name="name" value="${v('name')}" required maxlength="60" autofocus>
    </label>
    <label class="field">
      <span>Turnier</span>
      <select name="tournament_id">
        ${tournaments.map((t) => html`<option value="${t.id}"${attr(v('tournament_id') === t.id, 'selected')}>${t.name}</option>`)}
        <option value=""${attr(values.has('tournament_id') && v('tournament_id') === '', 'selected')}>Später auswählen</option>
      </select>
    </label>
    <fieldset class="field">
      <legend>Punkte</legend>
      <div class="row">
        <label class="field small"><span>Richtiger Sieger</span>
          <input type="number" name="points_winner" value="${v('points_winner', '1')}" min="0" max="20" required inputmode="numeric"></label>
        <label class="field small"><span>Extra für exaktes Ergebnis</span>
          <input type="number" name="points_exact" value="${v('points_exact', '1')}" min="0" max="20" required inputmode="numeric"></label>
      </div>
    </fieldset>
    <fieldset class="field">
      <legend>Tippschluss</legend>
      <label class="check"><input type="radio" name="lock_mode" value="matchday"${attr(v('lock_mode', 'matchday') === 'matchday', 'checked')}>
        Beim ersten Spiel des Tages für alle Spiele dieses Tages <span class="muted">(empfohlen, weil spätere Anstoßzeiten nur geschätzt sind)</span></label>
      <label class="check"><input type="radio" name="lock_mode" value="match"${attr(v('lock_mode') === 'match', 'checked')}>
        Für jedes Spiel einzeln bei dessen Anstoß</label>
    </fieldset>
    <button type="submit" class="btn btn-primary">Tipprunde erstellen</button>
  </form>
</section>`;
  return htmlResponse(layout(ctx, { title: 'Tipprunde erstellen', body, error }), error ? 400 : 200);
}

async function createLeague(ctx: Ctx): Promise<Res> {
  const user = ctx.user!;
  const f = ctx.form;
  const name = cleanName(f.get('name'), 60);
  const pw = intField(f.get('points_winner'), 0, 20);
  const pe = intField(f.get('points_exact'), 0, 20);
  const lockMode = f.get('lock_mode') === 'match' ? 'match' : 'matchday';
  const tournamentId = f.get('tournament_id') || null;
  if (!name) return createPage(ctx, f, 'Bitte gib einen Namen mit 1 bis 60 Zeichen ein.');
  if (pw === null || pe === null) return createPage(ctx, f, 'Bitte gib bei den Punkten Zahlen von 0 bis 20 ein.');
  if (tournamentId && !isUuid(tournamentId)) return createPage(ctx, f, 'Dieses Turnier gibt es nicht.');

  let base = slugify(name);
  if (base.length < 3) base = `runde-${base}`.replace(/-+$/, '');
  const slug = await ctx.deps.db.tx(async (q) => {
    let candidate = base;
    for (let i = 2; await q.one('select 1 from leagues where slug = $1', [candidate]); i++) {
      candidate = `${base}-${i}`;
    }
    const league = await q.one<{ id: string }>(
      `insert into leagues (name, slug, owner_id, points_winner, points_exact, lock_mode)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [name, candidate, user.id, pw, pe, lockMode],
    );
    await q.run(`insert into league_members (league_id, user_id, role) values ($1, $2, 'owner')`, [league!.id, user.id]);
    if (tournamentId) {
      const added = await q.run(
        `insert into league_tournaments (league_id, tournament_id, bonus_deadline_at)
         select $1, t.id, (select min(scheduled_at) from matches where tournament_id = t.id and scheduled_at > now())
           from tournaments t where t.id = $2`,
        [league!.id, tournamentId],
      );
      if (!added) throw new HttpError(400, 'Dieses Turnier gibt es nicht.');
    }
    return candidate;
  });
  return redirect(`/r/${slug}/verwalten?hinweis=erstellt`);
}

// ---------------------------------------------------------------------
// Beitreten
// ---------------------------------------------------------------------

function extractCode(value: string): string {
  const v = value.trim();
  const m = /\/beitreten\/([A-Za-z0-9]+)/.exec(v);
  return (m ? m[1] : v).toLowerCase();
}

async function joinPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const code = ctx.params.code.toLowerCase();
  const league = await ctx.deps.db.one<{ id: string; name: string; slug: string; members: number; is_member: boolean }>(
    `select l.id, l.name, l.slug,
            (select count(*)::int from league_members where league_id = l.id) as members,
            exists (select 1 from league_members where league_id = l.id and user_id = $2) as is_member
       from leagues l where l.invite_code = $1`,
    [code, ctx.user.id],
  );
  if (!league) {
    throw new HttpError(404, 'Dieser Einladungslink ist ungültig. Vielleicht wurde er erneuert – frag nach dem aktuellen Link.');
  }
  if (league.is_member) return redirect(`/r/${league.slug}/tippen`);
  const body = html`<section class="panel narrow">
  <h1>${league.name}</h1>
  <p>Du wurdest in diese Tipprunde eingeladen. Sie hat ${league.members} ${league.members === 1 ? 'Mitglied' : 'Mitglieder'}.</p>
  <p class="muted">Du trittst als <strong>${ctx.user.display_name}</strong> bei. Deinen Namen kannst du jederzeit unter <a href="/konto">Konto</a> ändern.</p>
  <form method="post" action="/beitreten/${code}" class="stack">
    ${csrfField(ctx)}
    <button type="submit" class="btn btn-primary">Tipprunde beitreten</button>
  </form>
</section>`;
  return htmlResponse(layout(ctx, { title: league.name, body }));
}

async function join(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const code = ctx.params.code.toLowerCase();
  const league = await ctx.deps.db.one<{ id: string; slug: string }>('select id, slug from leagues where invite_code = $1', [code]);
  if (!league) throw new HttpError(404, 'Dieser Einladungslink ist ungültig. Vielleicht wurde er erneuert – frag nach dem aktuellen Link.');
  const added = await ctx.deps.db.run(
    `insert into league_members (league_id, user_id) values ($1, $2) on conflict do nothing`,
    [league.id, ctx.user.id],
  );
  return redirect(`/r/${league.slug}/tippen${added ? '?hinweis=beigetreten' : ''}`);
}

// ---------------------------------------------------------------------
// Tippen
// ---------------------------------------------------------------------

interface Matchday {
  key: string;
  start: Date | null;
  lock: Date | null;
  matches: MatchRow[];
}

function groupMatchdays(matches: MatchRow[], tz: string): Matchday[] {
  const days = new Map<string, Matchday>();
  for (const m of matches) {
    const start = m.matchday_starts_at ?? m.scheduled_at;
    const key = start ? dayKey(start, tz) + '|' + start.toISOString() : 'ohne-termin';
    let d = days.get(key);
    if (!d) {
      d = { key, start, lock: start, matches: [] };
      days.set(key, d);
    }
    d.matches.push(m);
  }
  return [...days.values()];
}

function matchCard(ctx: Ctx, league: League, m: MatchRow, own: PredictionRow | undefined, open: boolean): Html {
  const tz = ctx.deps.config.timeZone;
  const match = toDomainMatch(m);
  const teamsKnown = !!(m.team_a_id && m.team_b_id);
  const meta = html`<div class="match-meta">
    <span>${m.scheduled_at ? formatTime(m.scheduled_at, tz) : 'Termin offen'}</span>
    <span class="bo">Bo${m.best_of}</span>
    ${m.stage ? html`<span>${m.stage}</span>` : nothing}
    ${m.status === 'live' ? html`<span class="live">läuft</span>` : nothing}
  </div>`;
  const teams = html`<div class="teams">
    <span class="team team-a">${m.team_a ?? 'Steht noch nicht fest'}</span>
    <span class="vs">vs</span>
    <span class="team team-b">${m.team_b ?? 'Steht noch nicht fest'}</span>
  </div>`;

  if (open && teamsKnown) {
    const options = resultOptions(m.best_of);
    const current = own ? pickValue({ winner: own.winner, winnerWins: own.winner_wins, loserWins: own.loser_wins }) : '';
    const chip = (o: ResultOption) => {
      const value = pickValue(o);
      const team = o.winner === 'A' ? m.team_a : m.team_b;
      const label = o.winnerWins === null ? (o.winner === 'A' ? shortA(m) : shortB(m)) : `${o.winnerWins}:${o.loserWins}`;
      const aria = o.winnerWins === null ? `${team} gewinnt` : `${team} gewinnt ${o.winnerWins}:${o.loserWins}`;
      return html`<label class="chip chip-${o.winner.toLowerCase()}"><input type="radio" name="tipp_${m.id}" value="${value}"${attr(value === current, 'checked')} aria-label="${aria}"><span>${label}</span></label>`;
    };
    const sideA = options.filter((o) => o.winner === 'A');
    const sideB = options.filter((o) => o.winner === 'B');
    return html`<article class="match" id="spiel-${m.id}">
  ${meta}${teams}
  <fieldset class="picks picks-bo${m.best_of}">
    <legend class="sr-only">Dein Tipp für ${m.team_a} gegen ${m.team_b}</legend>
    <div class="side side-a">${sideA.map(chip)}</div>
    <div class="side side-b">${sideB.map(chip)}</div>
  </fieldset>
</article>`;
  }

  const score = own ? scorePrediction(toDomainPrediction(own), match, rulesOf(league)) : null;
  const result = resultLabel(m);
  const isPublic = arePredictionsPublic(match, league.lock_mode, ctx.now);
  return html`<article class="match match-closed" id="spiel-${m.id}">
  ${meta}${teams}
  <div class="match-foot">
    ${!teamsKnown && open ? html`<span class="muted">Tippen geht, sobald beide Teams feststehen.</span>` : nothing}
    ${teamsKnown || !open ? html`<span>Dein Tipp: <strong>${own ? predictionLabel(m, own) : '–'}</strong></span>` : nothing}
    ${result ? html`<span>Ergebnis: <strong>${result}</strong></span>` : nothing}
    ${score ? pointsBadge(score.points, score.exact) : nothing}
    ${isPublic && teamsKnown ? html`<a href="/r/${league.slug}/spiel/${m.id}">Alle Tipps</a>` : nothing}
  </div>
</article>`;
}

async function tipsPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db, config } = ctx.deps;
  const tz = config.timeZone;
  const [matches, preds, tournaments] = await Promise.all([
    leagueMatches(db, league.id),
    db.query<PredictionRow>(
      `select match_id, user_id, winner, winner_wins, loser_wins from predictions where league_id = $1 and user_id = $2`,
      [league.id, ctx.user.id],
    ),
    leagueTournaments(db, league.id),
  ]);
  const own = new Map(preds.map((p) => [p.match_id, p]));
  const days = groupMatchdays(matches, tz);

  const openDays: Matchday[] = [];
  const closedDays: Matchday[] = [];
  const unscheduled: Matchday[] = [];
  const beforeLock = (m: MatchRow) => (lockTime(toDomainMatch(m), league.lock_mode)?.getTime() ?? 0) > ctx.now.getTime();
  for (const d of days) {
    if (!d.start) unscheduled.push(d);
    else if (d.matches.some(beforeLock)) openDays.push(d);
    else closedDays.push(d);
  }
  closedDays.reverse();

  const anyTippable = matches.some((m) => isOpen(toDomainMatch(m), league.lock_mode, ctx.now));

  const dayHeader = (d: Matchday, closed: boolean) => {
    const first = d.matches[0];
    const lock = lockTime(toDomainMatch(first), league.lock_mode);
    return html`<header class="day-head">
      <h2>${d.start ? formatDayLong(d.start, tz) : 'Noch ohne Termin'}</h2>
      ${
        !closed && lock && league.lock_mode === 'matchday'
          ? html`<p class="lock">Tippschluss ${formatTime(lock, tz)} Uhr <span class="muted">(${formatRemaining(lock, ctx.now)})</span></p>`
          : !closed && league.lock_mode === 'match'
            ? html`<p class="lock">Tippschluss jeweils beim Anstoß</p>`
            : nothing
      }
    </header>`;
  };

  const dayPoints = (d: Matchday) => {
    let total = 0;
    let scored = false;
    for (const m of d.matches) {
      const p = own.get(m.id);
      if (!p) continue;
      const s = scorePrediction(toDomainPrediction(p), toDomainMatch(m), rulesOf(league));
      if (s.points !== null) {
        scored = true;
        total += s.points;
      }
    }
    return scored ? html`<span class="pts${total > 0 ? ' pts-hit' : ''}">+${total}</span>` : nothing;
  };

  const tournamentNames = tournaments.length > 1 ? new Map(tournaments.map((t) => [t.id, t.name])) : null;

  const body = html`
${
  !tournaments.length
    ? emptyState(
        'Diese Tipprunde hat noch kein Turnier.',
        access.canManage ? html`<a class="btn" href="/r/${league.slug}/verwalten#turniere">Turnier auswählen</a>` : undefined,
      )
    : !matches.length
      ? emptyState('Für dieses Turnier sind noch keine Spiele eingetragen.')
      : nothing
}
${
  openDays.length || unscheduled.length
    ? html`<form method="post" action="/r/${league.slug}/tippen" class="tip-form">
  ${csrfField(ctx)}
  ${openDays.map(
    (d) => html`<section class="day">
    ${dayHeader(d, false)}
    ${tournamentNames ? html`<p class="muted">${tournamentNames.get(d.matches[0].tournament_id)}</p>` : nothing}
    ${d.matches.map((m) => matchCard(ctx, league, m, own.get(m.id), beforeLock(m)))}
  </section>`,
  )}
  ${unscheduled.map(
    (d) => html`<section class="day">
    ${dayHeader(d, false)}
    ${d.matches.map((m) => matchCard(ctx, league, m, own.get(m.id), false))}
  </section>`,
  )}
  ${anyTippable ? html`<div class="save-bar"><button type="submit" class="btn btn-primary">Tipps speichern</button></div>` : nothing}
</form>`
    : matches.length
      ? emptyState('Gerade gibt es nichts zu tippen. Neue Spiele erscheinen hier, sobald sie feststehen.')
      : nothing
}
${
  closedDays.length
    ? html`<h2 class="section-title">Vorbei</h2>
  ${closedDays.map(
    (d, i) => html`<details class="day day-closed"${attr(i === 0, 'open')}>
    <summary><span>${d.start ? formatDayLong(d.start, tz) : ''}</span>${dayPoints(d)}</summary>
    ${d.matches.map((m) => matchCard(ctx, league, m, own.get(m.id), false))}
  </details>`,
  )}`
    : nothing
}`;
  return htmlResponse(layout(ctx, { title: `Tippen – ${league.name}`, body, league: leagueNav(access, 'tippen') }));
}

async function saveTips(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const { league } = await loadLeague(ctx, ctx.params.slug);
  const { db } = ctx.deps;
  const user = ctx.user;
  const [matches, preds] = await Promise.all([
    leagueMatches(db, league.id),
    db.query<PredictionRow>(
      `select match_id, user_id, winner, winner_wins, loser_wins from predictions where league_id = $1 and user_id = $2`,
      [league.id, user.id],
    ),
  ]);
  const byId = new Map(matches.map((m) => [m.id, m]));
  const own = new Map(preds.map((p) => [p.match_id, p]));
  let saved = 0;
  let rejected = 0;
  for (const [key, value] of ctx.form) {
    if (!key.startsWith('tipp_')) continue;
    const m = byId.get(key.slice(5));
    const pick = parsePick(value);
    if (!m || !pick || !isValidResult(m.best_of, pick)) continue;
    const old = own.get(m.id);
    if (old && old.winner === pick.winner && old.winner_wins === pick.winnerWins && old.loser_wins === pick.loserWins) continue;
    try {
      await db.run(
        `insert into predictions (league_id, match_id, user_id, winner, winner_wins, loser_wins)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (league_id, match_id, user_id)
         do update set winner = excluded.winner, winner_wins = excluded.winner_wins, loser_wins = excluded.loser_wins`,
        [league.id, m.id, user.id, pick.winner, pick.winnerWins, pick.loserWins],
      );
      saved++;
    } catch (e) {
      if (e instanceof PgError && e.code === 'P0001') rejected++;
      else throw e;
    }
  }
  const notice = rejected ? 'tipps-teilweise' : saved ? 'tipps-gespeichert' : 'keine-aenderung';
  return redirect(`/r/${league.slug}/tippen?hinweis=${notice}`);
}

// ---------------------------------------------------------------------
// Ein Spiel: alle Tipps (erst ab Tippschluss)
// ---------------------------------------------------------------------

async function matchPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db, config } = ctx.deps;
  const matchId = ctx.params.id;
  const m = isUuid(matchId) ? await oneMatch(db, matchId) : null;
  const inLeague = m && (await db.one('select 1 from league_tournaments where league_id = $1 and tournament_id = $2', [league.id, m.tournament_id]));
  if (!m || !inLeague) throw new HttpError(404, 'Dieses Spiel gibt es in dieser Tipprunde nicht.');

  const match = toDomainMatch(m);
  const isPublic = arePredictionsPublic(match, league.lock_mode, ctx.now);
  const lock = lockTime(match, league.lock_mode);
  const result = resultLabel(m);

  let content: Html;
  if (!isPublic) {
    content = html`<p>Die Tipps der anderen siehst du ab Tippschluss${lock ? html` (${formatDateTime(lock, config.timeZone)} Uhr)` : nothing}. So kann niemand abschreiben.</p>`;
  } else {
    const rows = await db.query<{ display_name: string; user_id: string; winner: 'A' | 'B' | null; winner_wins: number | null; loser_wins: number | null }>(
      `select u.display_name, u.id as user_id, p.winner, p.winner_wins, p.loser_wins
         from league_members lm
         join users u on u.id = lm.user_id
         left join predictions p on p.league_id = lm.league_id and p.user_id = lm.user_id and p.match_id = $2
        where lm.league_id = $1
        order by u.display_name`,
      [league.id, m.id],
    );
    const tally = new Map<string, number>();
    for (const r of rows) {
      if (!r.winner) continue;
      const label = pickLabel(m, r.winner, r.winner_wins, r.loser_wins);
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    const tipped = rows.filter((r) => r.winner).length;
    content = html`
${
  tipped
    ? html`<ul class="tally">
  ${[...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => html`<li${attr(label === result, 'class="hit"')}><span>${label}</span><progress max="${tipped}" value="${n}">${n}</progress><span class="num">${n}</span></li>`)}
</ul>`
    : nothing
}
<table class="table">
  <thead><tr><th>Name</th><th>Tipp</th><th class="num">Punkte</th></tr></thead>
  <tbody>
  ${rows.map((r) => {
    const score = r.winner
      ? scorePrediction(
          { matchId: m.id, userId: r.user_id, winner: r.winner, winnerWins: r.winner_wins, loserWins: r.loser_wins },
          match,
          rulesOf(league),
        )
      : null;
    return html`<tr${attr(r.user_id === ctx.user!.id, 'class="me"')}>
      <td>${r.display_name}</td>
      <td>${r.winner ? pickLabel(m, r.winner, r.winner_wins, r.loser_wins) : html`<span class="muted">kein Tipp</span>`}</td>
      <td class="num">${score?.points ?? ''}</td>
    </tr>`;
  })}
  </tbody>
</table>`;
  }

  const body = html`<section class="panel">
  <p><a href="/r/${league.slug}/tippen#spiel-${m.id}">Zurück zu den Spielen</a></p>
  <h1 class="versus"><span class="team-a">${m.team_a ?? 'offen'}</span> <span class="vs">vs</span> <span class="team-b">${m.team_b ?? 'offen'}</span></h1>
  <p class="muted">${m.tournament}${m.stage ? `, ${m.stage}` : ''}, Bo${m.best_of}${m.scheduled_at ? `, ${formatDateTime(m.scheduled_at, config.timeZone)} Uhr` : ''}</p>
  ${result ? html`<p class="result">Ergebnis: <strong>${result}</strong></p>` : nothing}
  ${content}
</section>`;
  return htmlResponse(layout(ctx, { title: `${m.team_a ?? '?'} vs ${m.team_b ?? '?'}`, body, league: leagueNav(access, 'spiel') }));
}

// ---------------------------------------------------------------------
// Rangliste
// ---------------------------------------------------------------------

async function standingsPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db } = ctx.deps;
  const [members, matches, preds, questions, answers] = await Promise.all([
    db.query<{ user_id: string; display_name: string }>(
      `select u.id as user_id, u.display_name from league_members lm join users u on u.id = lm.user_id where lm.league_id = $1`,
      [league.id],
    ),
    leagueMatches(db, league.id),
    db.query<PredictionRow>(`select match_id, user_id, winner, winner_wins, loser_wins from predictions where league_id = $1`, [league.id]),
    db.query<{ id: string; points: number; correct_answers: string[] }>(
      `select q.id, q.points, q.correct_answers from bonus_questions q
         join league_tournaments lt on lt.league_id = q.league_id and lt.tournament_id = q.tournament_id
        where q.league_id = $1`,
      [league.id],
    ),
    db.query<{ question_id: string; user_id: string; answer: string }>(
      `select question_id, user_id, answer from bonus_answers where league_id = $1`,
      [league.id],
    ),
  ]);
  const finished = matches.filter((m) => matchResult(toDomainMatch(m)));
  const rows = computeStandings({
    members: members.map((m) => ({ userId: m.user_id, displayName: m.display_name })),
    matches: matches.map(toDomainMatch),
    predictions: preds.map(toDomainPrediction),
    rules: rulesOf(league),
    bonusQuestions: questions.map((q) => ({ id: q.id, points: q.points, correctAnswers: q.correct_answers })),
    bonusAnswers: answers.map((a) => ({ questionId: a.question_id, userId: a.user_id, answer: a.answer })),
  });
  const hasBonus = questions.some((q) => q.correct_answers.length);

  const body = html`<section class="panel">
  <h1>Rangliste</h1>
  <p class="muted">${finished.length} ${finished.length === 1 ? 'Spiel' : 'Spiele'} gewertet. Richtiger Sieger ${league.points_winner} ${league.points_winner === 1 ? 'Punkt' : 'Punkte'}, exaktes Ergebnis ${league.points_exact} extra. Bei Gleichstand zählen die exakten Ergebnisse.</p>
  <table class="table standings">
    <thead><tr>
      <th class="num">Platz</th><th>Name</th>
      <th class="num" title="Richtige Sieger">Sieger</th>
      <th class="num" title="Exakte Ergebnisse">Exakt</th>
      ${hasBonus ? html`<th class="num" title="Punkte aus Sonderfragen">Sonder</th>` : nothing}
      <th class="num">Punkte</th>
    </tr></thead>
    <tbody>
    ${rows.map(
      (r) => html`<tr class="${r.userId === ctx.user!.id ? 'me' : ''}${r.rank <= 3 && r.points > 0 ? ` podium podium-${r.rank}` : ''}">
        <td class="num rank">${r.rank}</td>
        <td>${r.displayName}</td>
        <td class="num">${r.correctWinners}</td>
        <td class="num">${r.exactResults}</td>
        ${hasBonus ? html`<td class="num">${r.bonusPoints}</td>` : nothing}
        <td class="num total">${r.points}</td>
      </tr>`,
    )}
    </tbody>
  </table>
</section>
${
  league.role && league.role !== 'owner'
    ? html`<section class="panel quiet">${postButton(ctx, `/r/${league.slug}/verlassen`, 'Tipprunde verlassen', {
        cls: 'btn btn-quiet',
        confirm: 'Willst du die Tipprunde wirklich verlassen? Deine Tipps in dieser Runde werden gelöscht.',
      })}</section>`
    : nothing
}`;
  return htmlResponse(layout(ctx, { title: `Rangliste – ${league.name}`, body, league: leagueNav(access, 'rangliste') }));
}

// ---------------------------------------------------------------------
// Sonderfragen
// ---------------------------------------------------------------------

interface QuestionRow {
  id: string;
  tournament_id: string;
  question: string;
  points: number;
  answer_type: 'text' | 'team' | 'choice';
  choices: string[];
  hint: string | null;
  correct_answers: string[];
}

async function bonusPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db, config } = ctx.deps;
  const tz = config.timeZone;
  const tournaments = await leagueTournaments(db, league.id);
  const [questions, answers, members, teams] = await Promise.all([
    db.query<QuestionRow>(
      `select id, tournament_id, question, points, answer_type, choices, hint, correct_answers
         from bonus_questions where league_id = $1 order by position, created_at`,
      [league.id],
    ),
    db.query<{ question_id: string; user_id: string; answer: string }>(
      `select question_id, user_id, answer from bonus_answers where league_id = $1`,
      [league.id],
    ),
    db.query<{ user_id: string; display_name: string }>(
      `select u.id as user_id, u.display_name from league_members lm join users u on u.id = lm.user_id
        where lm.league_id = $1 order by u.display_name`,
      [league.id],
    ),
    db.query<{ tournament_id: string; name: string }>(
      `select distinct x.tournament_id, t.name
         from (select tournament_id, team_id from tournament_teams
               union select tournament_id, team_a_id from matches
               union select tournament_id, team_b_id from matches) x
         join teams t on t.id = x.team_id
         join league_tournaments lt on lt.tournament_id = x.tournament_id and lt.league_id = $1
        order by t.name`,
      [league.id],
    ),
  ]);
  const myAnswers = new Map(answers.filter((a) => a.user_id === ctx.user!.id).map((a) => [a.question_id, a.answer]));

  const sections = tournaments.map((t) => {
    const qs = questions.filter((q) => q.tournament_id === t.id);
    const closed = !t.bonus_deadline_at || ctx.now >= t.bonus_deadline_at;
    const teamNames = teams.filter((x) => x.tournament_id === t.id).map((x) => x.name);
    if (!qs.length) {
      return html`<section class="panel"><h2>${t.name}</h2><p class="muted">Für dieses Turnier gibt es keine Sonderfragen.</p>
      ${access.canManage ? html`<p><a href="/r/${league.slug}/verwalten#fragen">Sonderfragen anlegen</a></p>` : nothing}</section>`;
    }

    if (!closed) {
      return html`<section class="panel">
  <h2>${t.name}</h2>
  <p><span class="lock">Antworten bis ${formatDateTime(t.bonus_deadline_at!, tz)} Uhr</span> <span class="muted">(${formatRemaining(t.bonus_deadline_at!, ctx.now)})</span>. Danach sind sie fest und alle sehen die Antworten der anderen.</p>
  <form method="post" action="/r/${league.slug}/sonderfragen" class="stack">
    ${csrfField(ctx)}
    ${qs.map((q) => {
      const current = myAnswers.get(q.id) ?? '';
      const name = `antwort_${q.id}`;
      let input: Html;
      if (q.answer_type === 'text') {
        input = html`<input type="text" name="${name}" value="${current}" maxlength="200" autocomplete="off">`;
      } else {
        const opts = q.answer_type === 'team' ? [...teamNames, ...q.choices] : q.choices;
        const known = opts.includes(current);
        input = html`<select name="${name}">
          <option value="">Noch keine Antwort</option>
          ${!known && current ? html`<option value="${current}" selected>${current}</option>` : nothing}
          ${opts.map((o) => html`<option value="${o}"${attr(o === current, 'selected')}>${o}</option>`)}
        </select>`;
      }
      return html`<label class="field question">
        <span>${q.question} <span class="pts-label">${q.points} ${q.points === 1 ? 'Punkt' : 'Punkte'}</span></span>
        ${q.hint ? html`<small class="muted">${q.hint}</small>` : nothing}
        ${input}
      </label>`;
    })}
    <button type="submit" class="btn btn-primary">Antworten speichern</button>
  </form>
</section>`;
    }

    return html`<section class="panel">
  <h2>${t.name}</h2>
  <p class="muted">${t.bonus_deadline_at ? html`Geschlossen seit ${formatDateTime(t.bonus_deadline_at, tz)} Uhr.` : 'Noch keine Frist festgelegt – Antworten sind noch nicht möglich.'}</p>
  ${qs.map((q) => {
    const resolved = q.correct_answers.length > 0;
    return html`<div class="question-result">
    <h3>${q.question} <span class="pts-label">${q.points} ${q.points === 1 ? 'Punkt' : 'Punkte'}</span></h3>
    ${resolved ? html`<p>Richtig: <strong>${q.correct_answers.join(' / ')}</strong></p>` : html`<p class="muted">Noch nicht aufgelöst.</p>`}
    ${(() => {
      if (!t.bonus_deadline_at) return nothing;
      const given = members
        .map((mem) => ({ mem, a: answers.find((x) => x.question_id === q.id && x.user_id === mem.user_id) }))
        .filter((x) => x.a);
      const missing = members.filter((mem) => !given.some((g) => g.mem.user_id === mem.user_id));
      return html`${
        given.length
          ? html`<table class="table compact"><tbody>
        ${given.map(({ mem, a }) => {
          const ok = resolved ? isBonusCorrect(a!.answer, { correctAnswers: q.correct_answers }) : null;
          return html`<tr${attr(mem.user_id === ctx.user!.id, 'class="me"')}><td>${mem.display_name}</td>
            <td>${a!.answer}</td>
            <td class="num">${ok === null ? '' : pointsBadge(ok ? q.points : 0)}</td></tr>`;
        })}
      </tbody></table>`
          : html`<p class="muted">Niemand hat geantwortet.</p>`
      }
      ${given.length && missing.length ? html`<p class="muted">Ohne Antwort: ${missing.map((m) => m.display_name).join(', ')}</p>` : nothing}`;
    })()}
  </div>`;
  })}
</section>`;
  });

  const body = html`${tournaments.length ? sections : emptyState('Diese Tipprunde hat noch kein Turnier.')}`;
  return htmlResponse(layout(ctx, { title: `Sonderfragen – ${league.name}`, body, league: leagueNav(access, 'sonderfragen') }));
}

async function saveBonus(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const { league } = await loadLeague(ctx, ctx.params.slug);
  const { db } = ctx.deps;
  const user = ctx.user;
  const questions = await db.query<{ id: string; open: boolean }>(
    `select q.id, coalesce(lt.bonus_deadline_at > now(), false) as open
       from bonus_questions q
       join league_tournaments lt on lt.league_id = q.league_id and lt.tournament_id = q.tournament_id
      where q.league_id = $1`,
    [league.id],
  );
  const byId = new Map(questions.map((q) => [q.id, q]));
  let late = false;
  for (const [key, raw] of ctx.form) {
    if (!key.startsWith('antwort_')) continue;
    const q = byId.get(key.slice(8));
    if (!q) continue;
    if (!q.open) {
      late = true;
      continue;
    }
    const answer = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    try {
      if (!answer) {
        await db.run('delete from bonus_answers where question_id = $1 and user_id = $2', [q.id, user.id]);
      } else {
        await db.run(
          `insert into bonus_answers (question_id, league_id, user_id, answer) values ($1, $2, $3, $4)
           on conflict (question_id, user_id) do update set answer = excluded.answer
           where bonus_answers.answer is distinct from excluded.answer`,
          [q.id, league.id, user.id, answer],
        );
      }
    } catch (e) {
      if (e instanceof PgError && e.code === 'P0001') late = true;
      else throw e;
    }
  }
  return redirect(`/r/${league.slug}/sonderfragen?hinweis=${late ? 'antworten-zu-spaet' : 'antworten-gespeichert'}`);
}

// ---------------------------------------------------------------------
// Tipprunde verlassen
// ---------------------------------------------------------------------

async function leave(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const { league } = await loadLeague(ctx, ctx.params.slug);
  if (league.role === 'owner') {
    throw new HttpError(400, 'Du leitest diese Tipprunde. Übergib sie zuerst unter „Verwalten“ an ein anderes Mitglied oder lösche sie.');
  }
  await ctx.deps.db.run('delete from league_members where league_id = $1 and user_id = $2', [league.id, ctx.user.id]);
  return redirect('/?hinweis=verlassen');
}

export function registerLeagueRoutes(router: Router<Ctx>) {
  router.get('/', homePage);
  router.get('/neu', async (ctx) => (ctx.user ? createPage(ctx, new URLSearchParams()) : loginRedirect(ctx)));
  router.post('/neu', async (ctx) => (ctx.user ? createLeague(ctx) : loginRedirect(ctx)));
  router.post('/beitreten', async (ctx) => {
    const code = extractCode(ctx.form.get('code') ?? '');
    if (!/^[a-z0-9]{4,40}$/.test(code)) throw new HttpError(400, 'Dieser Einladungscode ist ungültig.');
    return redirect(`/beitreten/${code}`);
  });
  router.get('/beitreten/:code', joinPage);
  router.post('/beitreten/:code', join);
  router.get('/r/:slug', async (ctx) => redirect(`/r/${encodeURIComponent(ctx.params.slug)}/tippen`));
  router.get('/r/:slug/tippen', tipsPage);
  router.post('/r/:slug/tippen', saveTips);
  router.get('/r/:slug/spiel/:id', matchPage);
  router.get('/r/:slug/rangliste', standingsPage);
  router.get('/r/:slug/sonderfragen', bonusPage);
  router.post('/r/:slug/sonderfragen', saveBonus);
  router.post('/r/:slug/verlassen', leave);
}

