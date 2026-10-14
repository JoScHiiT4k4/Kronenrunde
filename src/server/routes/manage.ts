// Verwaltung einer Tipprunde: Einladen, Einstellungen, Turniere, Sonderfragen, Mitglieder.

import type { Ctx } from '../app.ts';
import { PgError } from '../db/index.ts';
import { formatDateTime, isLocalInput, toLocalInput } from '../format.ts';
import { attr, type Html, html, nothing } from '../html.ts';
import { HttpError, htmlResponse, redirect, type Res, type Router } from '../http.ts';
import { csrfField, layout, postButton } from '../views/layout.ts';
import { cleanName, intField, isUuid, loginRedirect } from './common.ts';
import { type LeagueAccess, leagueTournaments, loadLeague } from './league-data.ts';
import { lockModeOptions, parseLockMode } from './leagues.ts';

async function manageAccess(ctx: Ctx): Promise<LeagueAccess> {
  const access = await loadLeague(ctx, ctx.params.slug, { allowAdmin: true });
  if (!access.canManage) throw new HttpError(403, 'Nur die Leitung der Tipprunde kann das ändern.');
  return access;
}

interface QuestionRow {
  id: string;
  tournament_id: string;
  position: number;
  question: string;
  points: number;
  answer_type: 'text' | 'team' | 'choice' | 'champion' | 'player';
  choices: string[];
  hint: string | null;
  correct_answers: string[];
  answers: number;
}

const ANSWER_TYPES: Record<QuestionRow['answer_type'], string> = {
  team: 'Team aus dem Turnier auswählen',
  player: 'Spieler aus den Turnier-Teams auswählen',
  champion: 'Champion auswählen',
  choice: 'Aus eigener Liste auswählen',
  text: 'Freitext',
};

/** Die Fragen, die in der bisherigen Tipprunde jedes Jahr dabei waren. Punkte sind änderbar. */
const TYPICAL_QUESTIONS: { question: string; points: number; type: QuestionRow['answer_type']; choices?: string[]; hint?: string }[] = [
  { question: 'Wer wird Weltmeister?', points: 5, type: 'team' },
  { question: 'Wer wird Finals-MVP?', points: 3, type: 'player' },
  { question: 'Welcher Champion wird am häufigsten gebannt?', points: 3, type: 'champion' },
  { question: 'Welches Team verliert das kürzeste Spiel?', points: 3, type: 'team' },
  { question: 'Welches Team holt den ersten Pentakill?', points: 3, type: 'team', choices: ['Kein Pentakill'] },
  { question: 'Welcher Spieler holt den ersten Pentakill?', points: 3, type: 'player', choices: ['Kein Pentakill'] },
];

function lines(value: string | null, maxItems = 50, maxLen = 200): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen))
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

function questionFields(q: Partial<QuestionRow>, tournaments: { id: string; name: string }[] | null): Html {
  return html`
    ${
      tournaments && tournaments.length > 1
        ? html`<label class="field"><span>Turnier</span><select name="tournament_id">
          ${tournaments.map((t) => html`<option value="${t.id}"${attr(t.id === q.tournament_id, 'selected')}>${t.name}</option>`)}
        </select></label>`
        : tournaments
          ? html`<input type="hidden" name="tournament_id" value="${tournaments[0]?.id ?? ''}">`
          : nothing
    }
    <label class="field"><span>Frage</span>
      <input type="text" name="question" value="${q.question ?? ''}" required maxlength="300"></label>
    <div class="row">
      <label class="field small"><span>Punkte</span>
        <input type="number" name="points" value="${q.points ?? 3}" min="0" max="50" required inputmode="numeric"></label>
      <label class="field small"><span>Reihenfolge</span>
        <input type="number" name="position" value="${q.position ?? 0}" min="0" max="999" inputmode="numeric"></label>
    </div>
    <label class="field"><span>Antwort</span>
      <select name="answer_type">
        ${(Object.keys(ANSWER_TYPES) as QuestionRow['answer_type'][]).map(
          (k) => html`<option value="${k}"${attr((q.answer_type ?? 'team') === k, 'selected')}>${ANSWER_TYPES[k]}</option>`,
        )}
      </select></label>
    <label class="field"><span>Auswahl-Möglichkeiten <small class="muted">(eine pro Zeile; bei Team, Spieler oder Champion zusätzlich zur Liste, z. B. „Kein Pentakill“)</small></span>
      <textarea name="choices" rows="2">${(q.choices ?? []).join('\n')}</textarea></label>
    <label class="field"><span>Hinweis für die Tipper <small class="muted">(optional)</small></span>
      <input type="text" name="hint" value="${q.hint ?? ''}" maxlength="200"></label>
    <label class="field"><span>Richtige Antwort(en) <small class="muted">(eine pro Zeile, z. B. bei Gleichstand; Groß-/Kleinschreibung und Satzzeichen sind egal)</small></span>
      <textarea name="correct_answers" rows="2">${(q.correct_answers ?? []).join('\n')}</textarea></label>`;
}

async function managePage(ctx: Ctx, error?: string): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await manageAccess(ctx);
  const { league } = access;
  const { db, config } = ctx.deps;
  const tz = config.timeZone;
  const [tournaments, allTournaments, questions, members] = await Promise.all([
    leagueTournaments(db, league.id),
    db.query<{ id: string; name: string }>('select id, name from tournaments order by starts_on desc nulls last, name'),
    db.query<QuestionRow>(
      `select q.id, q.tournament_id, q.position, q.question, q.points, q.answer_type, q.choices, q.hint, q.correct_answers,
              (select count(*)::int from bonus_answers a where a.question_id = q.id) as answers
         from bonus_questions q where q.league_id = $1 order by q.position, q.created_at`,
      [league.id],
    ),
    db.query<{ user_id: string; display_name: string; role: string; joined_at: Date }>(
      `select u.id as user_id, u.display_name, lm.role, lm.joined_at
         from league_members lm join users u on u.id = lm.user_id
        where lm.league_id = $1 order by (lm.role = 'owner') desc, (lm.role = 'admin') desc, u.display_name`,
      [league.id],
    ),
  ]);
  const inviteLink = `${config.appUrl}/beitreten/${league.invite_code}`;
  const base = `/r/${league.slug}/verwalten`;
  const available = allTournaments.filter((t) => !tournaments.some((x) => x.id === t.id));
  const roleLabel: Record<string, string> = { owner: 'Leitung', admin: 'Mitleitung', member: 'Mitglied' };

  const body = html`
<section class="panel">
  <h1>Verwalten</h1>
  <h2>Leute einladen</h2>
  <p>Schick diesen Link an alle, die mittippen sollen. Wer ihn öffnet, meldet sich an und ist dabei.</p>
  <div class="copy-row">
    <input type="text" readonly value="${inviteLink}" id="invite-link" aria-label="Einladungslink">
    <button type="button" class="btn" data-copy="invite-link">Kopieren</button>
  </div>
  ${postButton(ctx, `${base}/einladung-neu`, 'Neuen Link erstellen', {
    cls: 'btn btn-quiet',
    confirm: 'Der bisherige Link funktioniert danach nicht mehr. Fortfahren?',
  })}
</section>

<section class="panel">
  <h2>Einstellungen</h2>
  <form method="post" action="${base}/einstellungen" class="stack">
    ${csrfField(ctx)}
    <label class="field"><span>Name der Tipprunde</span>
      <input type="text" name="name" value="${league.name}" required maxlength="60"></label>
    <div class="row">
      <label class="field small"><span>Richtiger Sieger</span>
        <input type="number" name="points_winner" value="${league.points_winner}" min="0" max="20" required inputmode="numeric"></label>
      <label class="field small"><span>Extra für exaktes Ergebnis</span>
        <input type="number" name="points_exact" value="${league.points_exact}" min="0" max="20" required inputmode="numeric"></label>
    </div>
    <fieldset class="field">
      <legend>Tippschluss</legend>
      ${lockModeOptions(league.lock_mode)}
    </fieldset>
    <button type="submit" class="btn btn-primary">Einstellungen speichern</button>
  </form>
</section>

<section class="panel" id="turniere">
  <h2>Turniere</h2>
  ${tournaments.map(
    (t) => html`<form method="post" action="${base}/turnier/${t.id}" class="stack bordered">
    ${csrfField(ctx)}
    <h3>${t.name}</h3>
    <label class="field"><span>Frist für die Sonderfragen</span>
      <input type="datetime-local" name="bonus_deadline_at" value="${toLocalInput(t.bonus_deadline_at, tz)}"></label>
    <div class="row">
      <button type="submit" name="aktion" value="speichern" class="btn">Frist speichern</button>
      <button type="submit" name="aktion" value="entfernen" class="btn btn-quiet" data-confirm="Turnier aus der Tipprunde entfernen? Die Sonderfragen dazu werden gelöscht.">Entfernen</button>
    </div>
  </form>`,
  )}
  ${
    available.length
      ? html`<form method="post" action="${base}/turnier" class="stack">
    ${csrfField(ctx)}
    <label class="field"><span>Turnier hinzufügen</span>
      <select name="tournament_id">${available.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></label>
    <button type="submit" class="btn">Hinzufügen</button>
  </form>`
      : tournaments.length
        ? nothing
        : html`<p class="muted">Es sind noch keine Turniere angelegt.${ctx.isAdmin ? html` <a href="/admin">Turnier anlegen</a>` : ''}</p>`
  }
</section>

<section class="panel" id="fragen">
  <h2>Sonderfragen</h2>
  ${
    !tournaments.length
      ? html`<p class="muted">Füge zuerst ein Turnier hinzu.</p>`
      : html`
  ${tournaments.map((t) => {
    const qs = questions.filter((q) => q.tournament_id === t.id);
    return html`<h3>${t.name}</h3>
    ${!qs.length ? html`<p class="muted">Noch keine Sonderfragen.</p>
      ${postButton(ctx, `${base}/typische-fragen`, 'Typische Fragen einfügen', { cls: 'btn', fields: { tournament_id: t.id } })}
      <p class="muted">Weltmeister, Finals-MVP, meistgebannter Champion, Verlierer des kürzesten Spiels und erster Pentakill (Team und Spieler). Danach kannst du alles anpassen.</p>` : nothing}
    ${qs.map(
      (q) => html`<details class="question-edit">
      <summary><span>${q.question}</span> <span class="muted">${q.points} P.${q.correct_answers.length ? ', aufgelöst' : ''}${q.answers ? `, ${q.answers} ${q.answers === 1 ? 'Antwort' : 'Antworten'}` : ''}</span></summary>
      <form method="post" action="${base}/frage/${q.id}" class="stack">
        ${csrfField(ctx)}
        ${questionFields(q, null)}
        <div class="row">
          <button type="submit" name="aktion" value="speichern" class="btn btn-primary">Speichern</button>
          <button type="submit" name="aktion" value="loeschen" class="btn btn-quiet" data-confirm="Frage mit allen Antworten löschen?">Löschen</button>
        </div>
      </form>
    </details>`,
    )}`;
  })}
  <details class="question-edit new">
    <summary>Neue Sonderfrage</summary>
    <form method="post" action="${base}/frage" class="stack">
      ${csrfField(ctx)}
      ${questionFields({ tournament_id: tournaments[0].id, position: questions.length + 1 }, tournaments)}
      <button type="submit" class="btn btn-primary">Frage anlegen</button>
    </form>
  </details>`
  }
</section>

<section class="panel">
  <h2>Mitglieder (${members.length})</h2>
  <table class="table">
    <tbody>
    ${members.map(
      (m) => html`<tr>
      <td>${m.display_name}<br><small class="muted">${roleLabel[m.role]}, seit ${formatDateTime(m.joined_at, tz)}</small></td>
      <td class="actions">${
        access.isOwner && m.role !== 'owner'
          ? html`<form method="post" action="${base}/mitglied/${m.user_id}" class="inline-form">
          ${csrfField(ctx)}
          <select name="aktion" aria-label="Aktion für ${m.display_name}">
            ${m.role === 'member' ? html`<option value="admin">Zur Mitleitung machen</option>` : html`<option value="member">Zum Mitglied machen</option>`}
            <option value="owner">Leitung übergeben</option>
            <option value="entfernen">Aus der Runde entfernen</option>
          </select>
          <button type="submit" class="btn" data-confirm="Wirklich ausführen?">OK</button>
        </form>`
          : nothing
      }</td>
    </tr>`,
    )}
    </tbody>
  </table>
</section>

${
  access.isOwner
    ? html`<section class="panel danger-zone">
  <h2>Tipprunde löschen</h2>
  <p>Löscht die Tipprunde mit allen Tipps, Sonderfragen und Antworten. Das lässt sich nicht rückgängig machen.</p>
  <form method="post" action="${base}/loeschen" class="stack">
    ${csrfField(ctx)}
    <label class="field"><span>Zum Bestätigen den Namen eintippen: <strong>${league.name}</strong></span>
      <input type="text" name="name" required autocomplete="off"></label>
    <button type="submit" class="btn btn-danger">Tipprunde löschen</button>
  </form>
</section>`
    : nothing
}`;
  return htmlResponse(
    layout(ctx, {
      title: `Verwalten – ${league.name}`,
      body,
      error,
      league: { slug: league.slug, name: league.name, canManage: true, active: 'verwalten' },
    }),
    error ? 400 : 200,
  );
}

type Q = { question: string; points: number; position: number; answer_type: string; choices: string[]; hint: string | null; correct_answers: string[] };

function readQuestion(f: URLSearchParams): Q | string {
  const question = cleanName(f.get('question'), 300);
  const points = intField(f.get('points'), 0, 50);
  const position = intField(f.get('position') || '0', 0, 999);
  const answer_type = f.get('answer_type') ?? '';
  if (!question) return 'Bitte gib eine Frage ein.';
  if (points === null) return 'Bitte gib Punkte von 0 bis 50 ein.';
  if (position === null) return 'Die Reihenfolge muss eine Zahl von 0 bis 999 sein.';
  if (!(answer_type in ANSWER_TYPES)) return 'Bitte wähle aus, wie geantwortet wird.';
  const choices = lines(f.get('choices'));
  if (answer_type === 'choice' && !choices.length) return 'Bitte gib bei „Aus eigener Liste“ mindestens eine Möglichkeit an.';
  return { question, points, position, answer_type, choices, hint: cleanName(f.get('hint'), 200), correct_answers: lines(f.get('correct_answers')) };
}

export function registerManageRoutes(router: Router<Ctx>) {
  router.get('/r/:slug/verwalten', (ctx) => managePage(ctx));

  const post = (path: string, fn: (ctx: Ctx, access: LeagueAccess) => Promise<Res | string | void>) =>
    router.post(`/r/:slug/verwalten${path}`, async (ctx) => {
      if (!ctx.user) return loginRedirect(ctx);
      const access = await manageAccess(ctx);
      const result = await fn(ctx, access);
      if (typeof result === 'string') return managePage(ctx, result);
      return result ?? redirect(`/r/${access.league.slug}/verwalten?hinweis=gespeichert`);
    });

  post('/einstellungen', async (ctx, { league }) => {
    const f = ctx.form;
    const name = cleanName(f.get('name'), 60);
    const pw = intField(f.get('points_winner'), 0, 20);
    const pe = intField(f.get('points_exact'), 0, 20);
    if (!name) return 'Bitte gib einen Namen mit 1 bis 60 Zeichen ein.';
    if (pw === null || pe === null) return 'Bitte gib bei den Punkten Zahlen von 0 bis 20 ein.';
    await ctx.deps.db.run(
      'update leagues set name = $2, points_winner = $3, points_exact = $4, lock_mode = $5 where id = $1',
      [league.id, name, pw, pe, parseLockMode(f.get('lock_mode'))],
    );
  });

  post('/einladung-neu', async (ctx, { league }) => {
    await ctx.deps.db.run(`update leagues set invite_code = encode(gen_random_bytes(6), 'hex') where id = $1`, [league.id]);
    return redirect(`/r/${league.slug}/verwalten?hinweis=link-erneuert`);
  });

  post('/turnier', async (ctx, { league }) => {
    const id = ctx.form.get('tournament_id');
    if (!isUuid(id)) return 'Bitte wähle ein Turnier aus.';
    await ctx.deps.db.run(
      `insert into league_tournaments (league_id, tournament_id, bonus_deadline_at)
       select $1, t.id, (select min(scheduled_at) from matches where tournament_id = t.id and scheduled_at > now())
         from tournaments t where t.id = $2
       on conflict do nothing`,
      [league.id, id],
    );
  });

  post('/turnier/:tid', async (ctx, { league }) => {
    const tid = ctx.params.tid;
    if (!isUuid(tid)) throw new HttpError(404, 'Dieses Turnier gibt es nicht.');
    if (ctx.form.get('aktion') === 'entfernen') {
      await ctx.deps.db.run('delete from league_tournaments where league_id = $1 and tournament_id = $2', [league.id, tid]);
      return;
    }
    const value = ctx.form.get('bonus_deadline_at') ?? '';
    if (value && !isLocalInput(value)) return 'Bitte gib Datum und Uhrzeit vollständig an.';
    await ctx.deps.db.run(
      `update league_tournaments set bonus_deadline_at = case when $3 = '' then null else ($3::timestamp at time zone $4) end
        where league_id = $1 and tournament_id = $2`,
      [league.id, tid, value, ctx.deps.config.timeZone],
    );
  });

  post('/typische-fragen', async (ctx, { league }) => {
    const tid = ctx.form.get('tournament_id');
    if (!isUuid(tid)) return 'Bitte wähle ein Turnier aus.';
    await ctx.deps.db.tx(async (q) => {
      const ok = await q.one('select 1 from league_tournaments where league_id = $1 and tournament_id = $2', [league.id, tid]);
      if (!ok) throw new HttpError(400, 'Dieses Turnier gehört nicht zur Tipprunde.');
      for (const [i, t] of TYPICAL_QUESTIONS.entries()) {
        await q.run(
          `insert into bonus_questions (league_id, tournament_id, position, question, points, answer_type, choices, hint)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [league.id, tid, i + 1, t.question, t.points, t.type, t.choices ?? [], t.hint ?? null],
        );
      }
    });
    return redirect(`/r/${league.slug}/verwalten?hinweis=gespeichert#fragen`);
  });

  post('/frage', async (ctx, { league }) => {
    const q = readQuestion(ctx.form);
    if (typeof q === 'string') return q;
    const tid = ctx.form.get('tournament_id');
    if (!isUuid(tid)) return 'Bitte wähle ein Turnier aus.';
    try {
      await ctx.deps.db.run(
        `insert into bonus_questions (league_id, tournament_id, position, question, points, answer_type, choices, hint, correct_answers)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [league.id, tid, q.position, q.question, q.points, q.answer_type, q.choices, q.hint, q.correct_answers],
      );
    } catch (e) {
      if (e instanceof PgError && e.code === '23503') return 'Dieses Turnier gehört nicht zur Tipprunde.';
      throw e;
    }
    return redirect(`/r/${league.slug}/verwalten?hinweis=gespeichert#fragen`);
  });

  post('/frage/:qid', async (ctx, { league }) => {
    const qid = ctx.params.qid;
    if (!isUuid(qid)) throw new HttpError(404, 'Diese Frage gibt es nicht.');
    if (ctx.form.get('aktion') === 'loeschen') {
      await ctx.deps.db.run('delete from bonus_questions where id = $1 and league_id = $2', [qid, league.id]);
    } else {
      const q = readQuestion(ctx.form);
      if (typeof q === 'string') return q;
      await ctx.deps.db.run(
        `update bonus_questions set question = $3, points = $4, position = $5, answer_type = $6, choices = $7, hint = $8, correct_answers = $9
          where id = $1 and league_id = $2`,
        [qid, league.id, q.question, q.points, q.position, q.answer_type, q.choices, q.hint, q.correct_answers],
      );
    }
    return redirect(`/r/${league.slug}/verwalten?hinweis=gespeichert#fragen`);
  });

  post('/mitglied/:uid', async (ctx, access) => {
    const { league } = access;
    const uid = ctx.params.uid;
    if (!access.isOwner) throw new HttpError(403, 'Nur die Leitung der Tipprunde kann Mitglieder verwalten.');
    if (!isUuid(uid)) throw new HttpError(404, 'Dieses Mitglied gibt es nicht.');
    const action = ctx.form.get('aktion');
    const { db } = ctx.deps;
    await db.tx(async (q) => {
      const member = await q.one<{ role: string }>('select role from league_members where league_id = $1 and user_id = $2', [league.id, uid]);
      if (!member || member.role === 'owner') throw new HttpError(400, 'Das geht bei diesem Mitglied nicht.');
      if (action === 'admin' || action === 'member') {
        await q.run('update league_members set role = $3 where league_id = $1 and user_id = $2', [league.id, uid, action]);
      } else if (action === 'entfernen') {
        await q.run('delete from league_members where league_id = $1 and user_id = $2', [league.id, uid]);
      } else if (action === 'owner') {
        await q.run(`update league_members set role = 'admin' where league_id = $1 and role = 'owner'`, [league.id]);
        await q.run(`update league_members set role = 'owner' where league_id = $1 and user_id = $2`, [league.id, uid]);
        await q.run('update leagues set owner_id = $2 where id = $1', [league.id, uid]);
      } else {
        throw new HttpError(400, 'Unbekannte Aktion.');
      }
    });
  });

  post('/loeschen', async (ctx, access) => {
    if (!access.isOwner) throw new HttpError(403, 'Nur die Leitung kann die Tipprunde löschen.');
    if ((ctx.form.get('name') ?? '').trim() !== access.league.name) return 'Der eingegebene Name stimmt nicht. Die Tipprunde wurde nicht gelöscht.';
    await ctx.deps.db.run('delete from leagues where id = $1', [access.league.id]);
    return redirect('/?hinweis=runde-geloescht');
  });
}
