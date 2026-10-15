// Kleines Profil eines Mitspielers: nur über die Rangliste einer gemeinsamen Tipprunde erreichbar.

import type { Ctx } from '../app.ts';
import { html, nothing } from '../html.ts';
import { HttpError, htmlResponse, type Res, type Router } from '../http.ts';
import { avatar, layout, scaleBar } from '../views/layout.ts';
import { isUuid, loginRedirect } from './common.ts';
import { leagueTournaments, loadLeague } from './league-data.ts';
import { loadStandings } from './standings-data.ts';

const tile = (value: string | number, label: string) => html`<div class="st-tile"><strong>${value}</strong><span>${label}</span></div>`;

async function profilePage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db } = ctx.deps;
  const id = ctx.params.userId;
  if (!isUuid(id)) throw new HttpError(404, 'Nicht gefunden.');
  // Nur Mitglieder dieser Tipprunde haben hier ein Profil
  const person = await db.one<{ display_name: string; first_name: string | null; avatar_updated_at: Date | null }>(
    `select u.display_name, u.first_name, u.avatar_updated_at from league_members lm join users u on u.id = lm.user_id where lm.league_id = $1 and lm.user_id = $2`,
    [league.id, id],
  );
  if (!person) throw new HttpError(404, 'Nicht gefunden.');

  const [standings, tournaments] = await Promise.all([loadStandings(db, league), leagueTournaments(db, league.id)]);
  const row = standings.rows.find((r) => r.userId === id)!;
  const own = id === ctx.user.id;

  // Antworten auf die Sonderfragen: wie bei den anderen erst ab Start des Turniers (die eigenen immer)
  const sections = [];
  for (const t of tournaments) {
    const visible = own || (!!t.bonus_deadline_at && ctx.now >= t.bonus_deadline_at);
    const answers = visible
      ? await db.query<{ question: string; answer: string; points: number; correct_answers: string[] }>(
          `select q.question, a.answer, q.points, q.correct_answers
             from bonus_questions q join bonus_answers a on a.question_id = q.id and a.user_id = $3
            where q.league_id = $1 and q.tournament_id = $2 order by q.position, q.created_at`,
          [league.id, t.id, id],
        )
      : null;
    sections.push({ t, answers });
  }

  // Sind Vorname und Anzeigename gleich, steht der Name nur einmal da
  const sameName = !!person.first_name && person.first_name.trim().toLowerCase() === person.display_name.trim().toLowerCase();
  const norm = (v: string) => v.trim().toLowerCase();
  const body = html`<p class="muted page-note"><a href="/r/${league.slug}/rangliste">← Zur Rangliste</a></p>
<section class="panel profile-head">
  ${avatar(id, person.display_name, person.avatar_updated_at, 'lg')}
  <div>
    <h1>${person.first_name && sameName ? person.first_name : person.display_name}</h1>
    <p class="muted">${person.first_name && !sameName ? html`${person.first_name} · ` : nothing}Mitglied in ${league.name}</p>
  </div>
</section>
<section class="panel">
  <h2>Bisheriger Stand</h2>
  <div class="st-tiles">
    ${tile(`${row.rank}.`, 'Platz in der Rangliste')}
    ${tile(row.points, row.points === 1 ? 'Punkt' : 'Punkte')}
    ${tile(row.correctWinners, 'richtige Sieger')}
    ${tile(row.exactResults, 'exakte Ergebnisse')}
    ${standings.hasBonus ? tile(row.bonusPoints, 'Punkte aus Sonderfragen') : nothing}
    ${tile(row.predictionsMade, row.predictionsMade === 1 ? 'Tipp abgegeben' : 'Tipps abgegeben')}
  </div>
  <p class="profile-scale">${scaleBar(row.points, standings.possible)}<small class="muted">Ausbeute von bisher ${standings.possible} möglichen Punkten</small></p>
</section>
<section class="panel">
  <h2>Sonderfragen</h2>
  ${
    sections.length
      ? sections.map(({ t, answers }) => html`${sections.length > 1 ? html`<h3 class="small-title">${t.name}</h3>` : nothing}
  ${
    answers === null
      ? html`<p class="muted">Die Antworten sind ab dem Start des Turniers sichtbar.</p>`
      : answers.length
        ? html`<table class="table compact"><tbody>${answers.map((a) => {
            const done = a.correct_answers.length > 0;
            const right = done && a.correct_answers.some((c) => norm(c) === norm(a.answer));
            return html`<tr><td>${a.question}</td><td><strong>${a.answer}</strong></td><td class="num">${done ? (right ? html`<span class="hit">+${a.points}</span>` : html`<span class="muted">0</span>`) : html`<span class="muted">offen</span>`}</td></tr>`;
          })}</tbody></table>`
        : html`<p class="muted">Keine Sonderfragen beantwortet.</p>`
  }`)
      : html`<p class="muted">Diese Tipprunde hat noch kein Turnier.</p>`
  }
</section>`;
  return htmlResponse(layout(ctx, { title: `Profil – ${person.display_name}`, body, league: { slug: league.slug, name: league.name, canManage: access.canManage, active: 'rangliste' } }));
}

export function registerProfileRoutes(router: Router<Ctx>) {
  router.get('/r/:slug/spieler/:userId', profilePage);
}
