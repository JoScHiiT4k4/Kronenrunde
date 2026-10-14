// Admin-Bereich (nur für ADMIN_EMAILS): Teams, Turniere, Phasen, Spiele und Ergebnisse.
// Das ist die "Datenquelle von Hand". Später kann ein Daten-Dienst (API) dieselben Tabellen füllen.

import { resultOptions } from '../../domain/results.ts';
import type { BestOf } from '../../domain/types.ts';
import type { Ctx } from '../app.ts';
import { PgError } from '../db/index.ts';
import { dayKey, formatDateTime, formatDayLong, isLocalInput, toLocalInput } from '../format.ts';
import { attr, type Html, html, nothing } from '../html.ts';
import { HttpError, htmlResponse, redirect, type Res, type Router } from '../http.ts';
import { csrfField, layout, postButton } from '../views/layout.ts';
import { cleanName, isUuid, loginRedirect } from './common.ts';
import { type MatchRow, oneMatch, shortA, shortB, tournamentMatches } from './league-data.ts';

function requireAdmin(ctx: Ctx) {
  if (!ctx.isAdmin) throw new HttpError(404, 'Diese Seite gibt es nicht.');
}

function page(ctx: Ctx, title: string, body: Html, error?: string): Res {
  return htmlResponse(layout(ctx, { title, body, error }), error ? 400 : 200);
}

interface Team {
  id: string;
  name: string;
  short_name: string | null;
  region: string | null;
}

function teams(ctx: Ctx) {
  return ctx.deps.db.query<Team>(`select id, name, short_name, region from teams order by region nulls last, name`);
}

function dbError(e: unknown): string {
  if (e instanceof PgError) {
    if (e.code === '23505') return 'Das gibt es schon (der Name ist bereits vergeben).';
    if (e.code === '23514') return 'Die Angaben passen nicht zusammen (z. B. zweimal dasselbe Team oder ein Ergebnis, das nicht zum Format passt).';
    if (e.code === '23503') return 'Das wird noch verwendet und kann deshalb nicht gelöscht werden.';
    if (e.code === 'P0001') return e.message;
  }
  throw e;
}

/** Ergebnis-Auswahl → Siege von Team A und B. */
function parseResult(value: string, bestOf: BestOf): { winsA: number; winsB: number } | null | 'invalid' {
  if (!value) return null;
  const m = /^([AB])(?:-(\d)-(\d))?$/.exec(value);
  if (!m) return 'invalid';
  const w = m[2] === undefined ? 1 : Number(m[2]);
  const l = m[3] === undefined ? 0 : Number(m[3]);
  const option = resultOptions(bestOf).find(
    (o) => o.winner === m[1] && (o.winnerWins ?? 1) === w && (o.loserWins ?? 0) === l,
  );
  if (!option) return 'invalid';
  return m[1] === 'A' ? { winsA: w, winsB: l } : { winsA: l, winsB: w };
}

function resultValue(m: MatchRow): string {
  if (m.wins_a === null || m.wins_b === null) return '';
  const winner = m.wins_a > m.wins_b ? 'A' : 'B';
  if (m.best_of === 1) return winner;
  return `${winner}-${Math.max(m.wins_a, m.wins_b)}-${Math.min(m.wins_a, m.wins_b)}`;
}

function resultSelect(m: MatchRow, name = 'ergebnis'): Html {
  const current = resultValue(m);
  return html`<select name="${name}" aria-label="Ergebnis ${m.team_a ?? ''} gegen ${m.team_b ?? ''}">
    <option value="">Kein Ergebnis</option>
    ${resultOptions(m.best_of).map((o) => {
      const v = o.winnerWins === null ? o.winner : `${o.winner}-${o.winnerWins}-${o.loserWins}`;
      const team = o.winner === 'A' ? shortA(m) : shortB(m);
      return html`<option value="${v}"${attr(v === current, 'selected')}>${team}${o.winnerWins === null ? '' : ` ${o.winnerWins}:${o.loserWins}`}</option>`;
    })}
  </select>`;
}

// ---------------------------------------------------------------------
// Übersicht: Turniere und Teams
// ---------------------------------------------------------------------

async function adminHome(ctx: Ctx, error?: string): Promise<Res> {
  const { db } = ctx.deps;
  const [tournaments, teamList] = await Promise.all([
    db.query<{ id: string; name: string; starts_on: string | null; ends_on: string | null; matches: number; open_results: number }>(
      `select t.id, t.name, t.starts_on, t.ends_on,
              (select count(*)::int from matches m where m.tournament_id = t.id) as matches,
              (select count(*)::int from matches m where m.tournament_id = t.id and m.wins_a is null
                  and m.status <> 'cancelled' and m.scheduled_at < now() - interval '30 minutes') as open_results
         from tournaments t order by t.starts_on desc nulls last, t.name`,
    ),
    teams(ctx),
  ]);
  const body = html`<section class="panel">
  <h1>Admin</h1>
  <p class="muted">Turniere, Teams, Spiele und Ergebnisse gelten für alle Tipprunden.</p>
  <h2>Turniere</h2>
  <ul class="league-list">
    ${tournaments.map(
      (t) => html`<li><a href="/admin/turnier/${t.id}"><span class="league-list-name">${t.name}</span>
      <span class="muted">${t.matches} Spiele${t.open_results ? html`, <strong class="warn">${t.open_results} ohne Ergebnis</strong>` : ''}</span></a></li>`,
    )}
  </ul>
  <form method="post" action="/admin/turnier" class="stack bordered">
    ${csrfField(ctx)}
    <h3>Neues Turnier</h3>
    <label class="field"><span>Name</span><input type="text" name="name" required maxlength="80" placeholder="z. B. MSI 2027"></label>
    <div class="row">
      <label class="field small"><span>Beginn</span><input type="date" name="starts_on"></label>
      <label class="field small"><span>Ende</span><input type="date" name="ends_on"></label>
    </div>
    <label class="field"><span>Phasen <small class="muted">(eine pro Zeile, in Reihenfolge)</small></span>
      <textarea name="stages" rows="4">Play-In
Swiss
Viertelfinale
Halbfinale
Finale</textarea></label>
    <button type="submit" class="btn btn-primary">Turnier anlegen</button>
  </form>
</section>

<section class="panel">
  <h2>Teams (${teamList.length})</h2>
  <table class="table compact">
    <thead><tr><th>Name</th><th>Kürzel</th><th>Region</th><th></th></tr></thead>
    <tbody>
    ${teamList.map(
      (t) => html`<tr><td colspan="4">
      <form method="post" action="/admin/team/${t.id}" class="team-row">
        ${csrfField(ctx)}
        <input type="text" name="name" value="${t.name}" required maxlength="80" aria-label="Name">
        <input type="text" name="short_name" value="${t.short_name ?? ''}" maxlength="8" aria-label="Kürzel">
        <input type="text" name="region" value="${t.region ?? ''}" maxlength="20" aria-label="Region">
        <button type="submit" class="btn">Speichern</button>
      </form></td></tr>`,
    )}
    </tbody>
  </table>
  <form method="post" action="/admin/team" class="team-row bordered">
    ${csrfField(ctx)}
    <input type="text" name="name" required maxlength="80" placeholder="Neues Team" aria-label="Name">
    <input type="text" name="short_name" maxlength="8" placeholder="Kürzel" aria-label="Kürzel">
    <input type="text" name="region" maxlength="20" placeholder="Region" aria-label="Region">
    <button type="submit" class="btn btn-primary">Anlegen</button>
  </form>
  <p class="muted">Teamnamen nachträglich ändern ist unproblematisch: Tipps hängen am Team, nicht am Namen.</p>
</section>`;
  return page(ctx, 'Admin', body, error);
}

// ---------------------------------------------------------------------
// Ein Turnier: Phasen und Spiele
// ---------------------------------------------------------------------

async function tournamentPage(ctx: Ctx, error?: string): Promise<Res> {
  const { db, config } = ctx.deps;
  const tz = config.timeZone;
  const id = ctx.params.id;
  const t = isUuid(id)
    ? await db.one<{ id: string; name: string; starts_on: string | null; ends_on: string | null }>(
        'select id, name, starts_on, ends_on from tournaments where id = $1',
        [id],
      )
    : null;
  if (!t) throw new HttpError(404, 'Dieses Turnier gibt es nicht.');
  const [stages, matches, teamList] = await Promise.all([
    db.query<{ id: string; name: string; position: number }>('select id, name, position from stages where tournament_id = $1 order by position, name', [id]),
    tournamentMatches(db, id),
    teams(ctx),
  ]);

  const days = new Map<string, MatchRow[]>();
  for (const m of matches) {
    const k = m.scheduled_at ? dayKey(m.scheduled_at, tz) : 'ohne';
    days.set(k, [...(days.get(k) ?? []), m]);
  }

  const base = `/admin/turnier/${t.id}`;
  const body = html`<section class="panel">
  <p><a href="/admin">Zurück zum Admin-Bereich</a></p>
  <h1>${t.name}</h1>
  <form method="post" action="${base}" class="stack">
    ${csrfField(ctx)}
    <label class="field"><span>Name</span><input type="text" name="name" value="${t.name}" required maxlength="80"></label>
    <div class="row">
      <label class="field small"><span>Beginn</span><input type="date" name="starts_on" value="${t.starts_on ?? ''}"></label>
      <label class="field small"><span>Ende</span><input type="date" name="ends_on" value="${t.ends_on ?? ''}"></label>
    </div>
    <button type="submit" class="btn">Speichern</button>
  </form>
  <h2>Phasen</h2>
  <p>${stages.map((s, i) => html`${i ? ', ' : ''}${s.name}`)}${stages.length ? '' : html`<span class="muted">Keine</span>`}</p>
  <form method="post" action="${base}/phase" class="team-row">
    ${csrfField(ctx)}
    <input type="text" name="name" required maxlength="60" placeholder="Neue Phase" aria-label="Neue Phase">
    <button type="submit" class="btn">Hinzufügen</button>
  </form>
</section>

<section class="panel">
  <h2>Spiele (${matches.length})</h2>
  <p class="muted">Ergebnis auswählen und speichern. Spiele mit weniger als 6 Stunden Abstand bilden automatisch einen Spieltag.</p>
  ${[...days.entries()].map(
    ([k, ms]) => html`<h3>${k === 'ohne' ? 'Ohne Termin' : formatDayLong(ms[0].scheduled_at!, tz)}</h3>
    <div class="admin-matches">
    ${ms.map(
      (m) => html`<div class="admin-match${m.wins_a === null && m.scheduled_at && m.scheduled_at < ctx.now ? ' needs-result' : ''}">
      <div><strong>${m.team_a ?? 'offen'} – ${m.team_b ?? 'offen'}</strong>
        <small class="muted">${m.scheduled_at ? formatDateTime(m.scheduled_at, tz) : 'ohne Termin'}, Bo${m.best_of}${m.stage ? `, ${m.stage}` : ''}${m.status === 'cancelled' ? ', abgesagt' : ''}</small></div>
      ${
        m.team_a_id && m.team_b_id
          ? html`<form method="post" action="/admin/spiel/${m.id}/ergebnis" class="inline-form">
        ${csrfField(ctx)}
        ${resultSelect(m)}
        <button type="submit" class="btn">Speichern</button>
      </form>`
          : nothing
      }
      <a href="/admin/spiel/${m.id}">Bearbeiten</a>
    </div>`,
    )}
    </div>`,
  )}
</section>

<section class="panel">
  <h2>Spiel hinzufügen</h2>
  <form method="post" action="${base}/spiel" class="stack">
    ${csrfField(ctx)}
    ${matchFields(ctx, null, stages, teamList)}
    <button type="submit" class="btn btn-primary">Spiel anlegen</button>
  </form>
</section>`;
  return page(ctx, `${t.name} – Admin`, body, error);
}

function matchFields(ctx: Ctx, m: MatchRow | null, stages: { id: string; name: string }[], teamList: Team[]): Html {
  const tz = ctx.deps.config.timeZone;
  const teamSelect = (name: string, current: string | null, label: string) => html`<label class="field"><span>${label}</span>
    <select name="${name}">
      <option value="">Steht noch nicht fest</option>
      ${teamList.map((t) => html`<option value="${t.id}"${attr(t.id === current, 'selected')}>${t.name}${t.region ? ` (${t.region})` : ''}</option>`)}
    </select></label>`;
  return html`
    <div class="row">
      ${teamSelect('team_a_id', m?.team_a_id ?? null, 'Team A (links, blaue Seite)')}
      ${teamSelect('team_b_id', m?.team_b_id ?? null, 'Team B (rechts, rote Seite)')}
    </div>
    <div class="row">
      <label class="field small"><span>Format</span>
        <select name="best_of">${[1, 3, 5].map((b) => html`<option value="${b}"${attr((m?.best_of ?? 5) === b, 'selected')}>Bo${b}</option>`)}</select></label>
      <label class="field"><span>Anstoß (deutsche Zeit)</span>
        <input type="datetime-local" name="scheduled_at" value="${toLocalInput(m?.scheduled_at ?? null, tz)}"></label>
    </div>
    <label class="field"><span>Phase</span>
      <select name="stage_id">
        <option value="">Keine</option>
        ${stages.map((s) => html`<option value="${s.id}"${attr(m?.stage === s.name, 'selected')}>${s.name}</option>`)}
      </select></label>`;
}

interface MatchInput {
  team_a_id: string | null;
  team_b_id: string | null;
  best_of: BestOf;
  scheduled_at: string;
  stage_id: string | null;
}

function readMatch(f: URLSearchParams): MatchInput | string {
  const opt = (k: string) => {
    const v = f.get(k) || null;
    if (v !== null && !isUuid(v)) throw new HttpError(400, 'Ungültige Auswahl.');
    return v;
  };
  const best_of = Number(f.get('best_of')) as BestOf;
  if (![1, 3, 5].includes(best_of)) return 'Bitte wähle das Format (Bo1, Bo3 oder Bo5).';
  const scheduled_at = f.get('scheduled_at') ?? '';
  if (scheduled_at && !isLocalInput(scheduled_at)) return 'Bitte gib Datum und Uhrzeit vollständig an.';
  const input = { team_a_id: opt('team_a_id'), team_b_id: opt('team_b_id'), best_of, scheduled_at, stage_id: opt('stage_id') };
  if (input.team_a_id && input.team_a_id === input.team_b_id) return 'Ein Team kann nicht gegen sich selbst spielen.';
  return input;
}

async function matchPage(ctx: Ctx, error?: string): Promise<Res> {
  const { db, config } = ctx.deps;
  const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
  if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
  const [stages, teamList, tips] = await Promise.all([
    db.query<{ id: string; name: string }>('select id, name from stages where tournament_id = $1 order by position, name', [m.tournament_id]),
    teams(ctx),
    db.one<{ n: number }>('select count(*)::int as n from predictions where match_id = $1', [m.id]),
  ]);
  const body = html`<section class="panel">
  <p><a href="/admin/turnier/${m.tournament_id}">Zurück zu ${m.tournament}</a></p>
  <h1>${m.team_a ?? 'offen'} – ${m.team_b ?? 'offen'}</h1>
  ${tips?.n ? html`<p class="notice notice-warn">Für dieses Spiel gibt es schon ${tips.n} ${tips.n === 1 ? 'Tipp' : 'Tipps'}. Tausche die Teams nur, wenn sie falsch eingetragen waren – Tipps beziehen sich auf Team A bzw. B.</p>` : nothing}
  <form method="post" action="/admin/spiel/${m.id}" class="stack">
    ${csrfField(ctx)}
    ${matchFields(ctx, m, stages, teamList)}
    <div class="row">
      <label class="field"><span>Ergebnis</span>${resultSelect(m)}</label>
      <label class="field"><span>Status</span>
        <select name="status">
          ${(['scheduled', 'live', 'finished', 'cancelled'] as const).map(
            (s) => html`<option value="${s}"${attr(m.status === s, 'selected')}>${{ scheduled: 'Geplant', live: 'Läuft', finished: 'Beendet', cancelled: 'Abgesagt' }[s]}</option>`,
          )}
        </select></label>
    </div>
    <button type="submit" class="btn btn-primary">Speichern</button>
  </form>
  ${postButton(ctx, `/admin/spiel/${m.id}/loeschen`, 'Spiel löschen', {
    cls: 'btn btn-quiet',
    confirm: 'Spiel mit allen Tipps dazu löschen?',
  })}
  <p class="muted">Anstoß: ${m.scheduled_at ? `${formatDateTime(m.scheduled_at, config.timeZone)} Uhr` : 'offen'}</p>
</section>`;
  return page(ctx, 'Spiel bearbeiten – Admin', body, error);
}

export function registerAdminRoutes(router: Router<Ctx>) {
  const guard = (fn: (ctx: Ctx) => Promise<Res>) => async (ctx: Ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    requireAdmin(ctx);
    if (ctx.params.id !== undefined && !isUuid(ctx.params.id)) throw new HttpError(404, 'Diese Seite gibt es nicht.');
    return fn(ctx);
  };
  const get = (path: string, fn: (ctx: Ctx) => Promise<Res>) => router.get(path, guard(fn));
  const post = (path: string, fn: (ctx: Ctx) => Promise<Res>) => router.post(path, guard(fn));

  get('/admin', (ctx) => adminHome(ctx));
  get('/admin/turnier/:id', (ctx) => tournamentPage(ctx));
  get('/admin/spiel/:id', (ctx) => matchPage(ctx));

  post('/admin/turnier', async (ctx) => {
    const f = ctx.form;
    const name = cleanName(f.get('name'), 80);
    if (!name) return adminHome(ctx, 'Bitte gib einen Namen ein.');
    const date = (k: string) => (/^\d{4}-\d\d-\d\d$/.test(f.get(k) ?? '') ? f.get(k) : null);
    const stages = (f.get('stages') ?? '').split(/\r?\n/).map((s) => cleanName(s, 60)).filter((s): s is string => !!s);
    const id = await ctx.deps.db.tx(async (q) => {
      const t = await q.one<{ id: string }>(
        'insert into tournaments (name, starts_on, ends_on) values ($1, $2, $3) returning id',
        [name, date('starts_on'), date('ends_on')],
      );
      for (const [i, s] of [...new Set(stages)].entries()) {
        await q.run('insert into stages (tournament_id, name, position) values ($1, $2, $3)', [t!.id, s, i + 1]);
      }
      return t!.id;
    });
    return redirect(`/admin/turnier/${id}?hinweis=gespeichert`);
  });

  post('/admin/turnier/:id', async (ctx) => {
    const f = ctx.form;
    const name = cleanName(f.get('name'), 80);
    if (!name) return tournamentPage(ctx, 'Bitte gib einen Namen ein.');
    const date = (k: string) => (/^\d{4}-\d\d-\d\d$/.test(f.get(k) ?? '') ? f.get(k) : null);
    await ctx.deps.db.run('update tournaments set name = $2, starts_on = $3, ends_on = $4 where id = $1', [
      ctx.params.id,
      name,
      date('starts_on'),
      date('ends_on'),
    ]);
    return redirect(`/admin/turnier/${ctx.params.id}?hinweis=gespeichert`);
  });

  post('/admin/turnier/:id/phase', async (ctx) => {
    const name = cleanName(ctx.form.get('name'), 60);
    if (!name) return tournamentPage(ctx, 'Bitte gib einen Namen für die Phase ein.');
    try {
      await ctx.deps.db.run(
        `insert into stages (tournament_id, name, position)
         values ($1, $2, (select coalesce(max(position), 0) + 1 from stages where tournament_id = $1))`,
        [ctx.params.id, name],
      );
    } catch (e) {
      return tournamentPage(ctx, dbError(e));
    }
    return redirect(`/admin/turnier/${ctx.params.id}?hinweis=gespeichert`);
  });

  post('/admin/turnier/:id/spiel', async (ctx) => {
    const input = readMatch(ctx.form);
    if (typeof input === 'string') return tournamentPage(ctx, input);
    try {
      await ctx.deps.db.run(
        `insert into matches (tournament_id, stage_id, team_a_id, team_b_id, best_of, scheduled_at)
         values ($1, $2, $3, $4, $5, case when $6 = '' then null else ($6::timestamp at time zone $7) end)`,
        [ctx.params.id, input.stage_id, input.team_a_id, input.team_b_id, input.best_of, input.scheduled_at, ctx.deps.config.timeZone],
      );
    } catch (e) {
      return tournamentPage(ctx, dbError(e));
    }
    return redirect(`/admin/turnier/${ctx.params.id}?hinweis=gespeichert`);
  });

  post('/admin/spiel/:id', async (ctx) => {
    const { db, config } = ctx.deps;
    const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
    if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
    const input = readMatch(ctx.form);
    if (typeof input === 'string') return matchPage(ctx, input);
    const result = parseResult(ctx.form.get('ergebnis') ?? '', input.best_of);
    if (result === 'invalid') return matchPage(ctx, 'Das Ergebnis passt nicht zum Format.');
    let status = ctx.form.get('status') ?? 'scheduled';
    if (!['scheduled', 'live', 'finished', 'cancelled'].includes(status)) status = 'scheduled';
    if (result && status !== 'cancelled') status = 'finished';
    if (!result && status === 'finished') status = 'scheduled';
    try {
      await db.run(
        `update matches set stage_id = $2, team_a_id = $3, team_b_id = $4, best_of = $5,
                scheduled_at = case when $6 = '' then null else ($6::timestamp at time zone $7) end,
                wins_a = $8, wins_b = $9, status = $10
          where id = $1`,
        [m.id, input.stage_id, input.team_a_id, input.team_b_id, input.best_of, input.scheduled_at, config.timeZone,
          result?.winsA ?? null, result?.winsB ?? null, status],
      );
    } catch (e) {
      return matchPage(ctx, dbError(e));
    }
    return redirect(`/admin/turnier/${m.tournament_id}?hinweis=gespeichert`);
  });

  post('/admin/spiel/:id/ergebnis', async (ctx) => {
    const { db } = ctx.deps;
    const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
    if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
    const result = parseResult(ctx.form.get('ergebnis') ?? '', m.best_of);
    if (result === 'invalid') throw new HttpError(400, 'Das Ergebnis passt nicht zum Format.');
    await db.run(
      `update matches set wins_a = $2::smallint, wins_b = $3::smallint,
              status = case when $4 then 'finished' when status = 'finished' then 'scheduled' else status end
        where id = $1`,
      [m.id, result?.winsA ?? null, result?.winsB ?? null, !!result],
    );
    return redirect(`/admin/turnier/${m.tournament_id}?hinweis=ergebnis-gespeichert`);
  });

  post('/admin/spiel/:id/loeschen', async (ctx) => {
    const { db } = ctx.deps;
    const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
    if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
    await db.run('delete from matches where id = $1', [m.id]);
    return redirect(`/admin/turnier/${m.tournament_id}?hinweis=spiel-geloescht`);
  });

  post('/admin/team', async (ctx) => {
    const name = cleanName(ctx.form.get('name'), 80);
    if (!name) return adminHome(ctx, 'Bitte gib einen Teamnamen ein.');
    try {
      await ctx.deps.db.run('insert into teams (name, short_name, region) values ($1, $2, $3)', [
        name,
        cleanName(ctx.form.get('short_name'), 8),
        cleanName(ctx.form.get('region'), 20),
      ]);
    } catch (e) {
      return adminHome(ctx, dbError(e));
    }
    return redirect('/admin?hinweis=gespeichert');
  });

  post('/admin/team/:id', async (ctx) => {
    const name = cleanName(ctx.form.get('name'), 80);
    if (!name || !isUuid(ctx.params.id)) return adminHome(ctx, 'Bitte gib einen Teamnamen ein.');
    try {
      await ctx.deps.db.run('update teams set name = $2, short_name = $3, region = $4 where id = $1', [
        ctx.params.id,
        name,
        cleanName(ctx.form.get('short_name'), 8),
        cleanName(ctx.form.get('region'), 20),
      ]);
    } catch (e) {
      return adminHome(ctx, dbError(e));
    }
    return redirect('/admin?hinweis=gespeichert');
  });
}
