// Verwaltung einer Tipprunde: Einladen, Einstellungen, Turniere, Sonderfragen, Mitglieder.

import type { Ctx } from '../app.ts';
import { ANSWER_TYPE_LABELS, type AnswerType, QUESTION_CATALOG } from '../../domain/questions.ts';
import { missingTips } from '../../domain/missing.ts';
import { formatDateTime, formatRemaining } from '../format.ts';
import { attr, type Html, html, nothing } from '../html.ts';
import { HttpError, htmlResponse, redirect, type Res, type Router } from '../http.ts';
import { csrfField, layout, postButton } from '../views/layout.ts';
import { cleanName, intField, isUuid, loginRedirect } from './common.ts';
import { type LeagueAccess, leagueMatches, leagueTournaments, loadLeague, toDomainMatch } from './league-data.ts';
import { lockModeOptions, parseLockMode } from './leagues.ts';

async function manageAccess(ctx: Ctx): Promise<LeagueAccess> {
  const access = await loadLeague(ctx, ctx.params.slug, { allowAdmin: true });
  if (!access.canManage) throw new HttpError(403, 'Nur der Spielleiter der Tipprunde kann das ändern.');
  return access;
}

interface QuestionRow {
  id: string;
  tournament_id: string;
  position: number;
  question: string;
  points: number;
  answer_type: AnswerType;
  catalog_key: string | null;
  correct_answers: string[];
  answers: number;
}

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

/** Einstellungen einer Frage: nur Punkte und richtige Antwort(en) – Frage und Antwortart sind fest. */
function questionFields(q: QuestionRow): Html {
  return html`
    <p class="muted">Antwort der Tipper: ${ANSWER_TYPE_LABELS[q.answer_type]}</p>
    <label class="field small"><span>Punkte</span>
      <input type="number" name="points" value="${q.points}" min="0" max="50" required inputmode="numeric"></label>
    <label class="field"><span>Richtige Antwort(en) <small class="muted">(eine pro Zeile, z. B. bei Gleichstand; Groß-/Kleinschreibung und Satzzeichen sind egal)</small></span>
      <textarea name="correct_answers" rows="2">${q.correct_answers.join('\n')}</textarea></label>`;
}

const AREAS = [
  ['uebersicht', 'Übersicht'],
  ['einstellungen', 'Einstellungen'],
  ['turniere', 'Turniere'],
  ['fragen', 'Sonderfragen'],
  ['mitglieder', 'Mitglieder'],
] as const;
type Area = (typeof AREAS)[number][0];
const isArea = (v: string | null | undefined): v is Area => AREAS.some(([k]) => k === v);

/** Zu welchem Bereich eine Aktion gehört (dorthin geht es nach dem Speichern zurück). */
function areaOfPath(path: string): Area {
  const rest = path.replace(/^\/r\/[^/]+\/verwalten/, '');
  if (rest.startsWith('/einstellungen') || rest.startsWith('/loeschen')) return 'einstellungen';
  if (rest.startsWith('/turnier')) return 'turniere';
  if (rest.startsWith('/frage')) return 'fragen';
  if (rest.startsWith('/mitglied')) return 'mitglieder';
  return 'uebersicht';
}

const areaHref = (slug: string, area: Area) => `/r/${slug}/verwalten?bereich=${area}`;

async function managePage(ctx: Ctx, error?: string, forcedArea?: Area): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await manageAccess(ctx);
  const { league } = access;
  const { db, config } = ctx.deps;
  const tz = config.timeZone;
  const queryArea = ctx.query.get('bereich');
  const area: Area = forcedArea ?? (isArea(queryArea) ? queryArea : 'uebersicht');
  const [tournaments, allTournaments, questions, members] = await Promise.all([
    leagueTournaments(db, league.id),
    db.query<{ id: string; name: string }>('select id, name from tournaments order by starts_on desc nulls last, name'),
    db.query<QuestionRow>(
      `select q.id, q.tournament_id, q.position, q.question, q.points, q.answer_type, q.catalog_key, q.correct_answers,
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
  const roleLabel: Record<string, string> = { owner: 'Spielleiter', admin: 'Mit-Spielleiter', member: 'Mitglied' };

  // Wer hat die anstehenden Spiele noch nicht getippt? Nur Anzahl und Frist, nie der Inhalt der Tipps.
  let missing: ReturnType<typeof missingTips> = [];
  if (area === 'uebersicht') {
    const [matches, tipped] = await Promise.all([
      leagueMatches(db, league.id),
      db.query<{ user_id: string; match_id: string }>('select user_id, match_id from predictions where league_id = $1', [league.id]),
    ]);
    missing = missingTips(
      members.map((m) => m.user_id),
      matches.map(toDomainMatch),
      new Set(tipped.map((t) => `${t.user_id}:${t.match_id}`)),
      league.lock_mode,
      ctx.now,
    );
  }
  const nameOf = new Map(members.map((m) => [m.user_id, m.display_name]));

  const body = html`
<h1 class="small-title">Verwalten</h1>
<nav class="sub-tabs" aria-label="Bereiche">
  ${AREAS.map(([key, label]) => html`<a href="${areaHref(league.slug, key)}"${area === key ? html` aria-current="page"` : nothing}>${label}</a>`)}
</nav>

${area === 'uebersicht' ? html`
<section class="panel">
  <h2>Noch nicht getippt</h2>
  ${
    missing.length
      ? html`<p class="muted">Diese Mitspieler haben für anstehende Spiele noch keinen Tipp abgegeben. Die Tipps selbst siehst du – wie alle anderen – erst nach Tippschluss.</p>
  <table class="table">
    <thead><tr><th>Name</th><th class="num">Offen</th><th>Nächster Tippschluss</th></tr></thead>
    <tbody>
    ${missing.map(
      (r) => html`<tr><td>${nameOf.get(r.userId) ?? ''}</td><td class="num">${r.missing}</td>
      <td>${formatDateTime(r.nextLock, tz)} Uhr <span class="muted">(${formatRemaining(r.nextLock, ctx.now)})</span></td></tr>`,
    )}
    </tbody>
  </table>`
      : html`<p class="muted">Alle haben die anstehenden Spiele getippt – oder es steht gerade kein Spiel zum Tippen an.</p>`
  }
</section>

<section class="panel">
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
</section>` : nothing}

${area === 'einstellungen' ? html`
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
` : nothing}

${area === 'turniere' ? html`
<section class="panel" id="turniere">
  <h2>Turniere</h2>
  ${tournaments.map(
    (t) => html`<form method="post" action="${base}/turnier/${t.id}" class="stack bordered">
    ${csrfField(ctx)}
    <h3>${t.name}</h3>
    <p class="muted">Die Sonderfragen schließen automatisch, sobald das erste Spiel beginnt${t.bonus_deadline_at ? ` (${formatDateTime(t.bonus_deadline_at, tz)} Uhr)` : ''}.</p>
    <div class="row">
      <button type="submit" name="aktion" value="entfernen" class="btn btn-quiet" data-confirm="Turnier aus der Tipprunde entfernen? Die Sonderfragen dazu werden gelöscht.">Turnier entfernen</button>
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
</section>` : nothing}

${area === 'fragen' ? html`
<section class="panel" id="fragen">
  <h2>Sonderfragen</h2>
  ${
    !tournaments.length
      ? html`<p class="muted">Füge zuerst ein Turnier hinzu.</p>`
      : html`
  ${tournaments.map((t) => {
    const qs = questions.filter((q) => q.tournament_id === t.id);
    const started = !!t.bonus_deadline_at && ctx.now >= t.bonus_deadline_at;
    return html`<h3>${t.name}</h3>
    <p class="muted">${
      started
        ? 'Das Turnier hat begonnen: Die Auswahl ist gesperrt. Punkte und richtige Antworten kannst du weiter ändern; eine Frage lässt sich nur noch über ihre Einstellungen löschen.'
        : 'Hake an, welche Fragen in deiner Tipprunde gestellt werden (Abwählen löscht die Frage samt Antworten). Das geht bis zum Start des ersten Spiels, danach ist die Auswahl gesperrt.'
    }</p>
    <form method="post" action="${base}/fragen-auswahl" class="stack" data-confirm-uncheck="Abgewählte Fragen werden mit allen Antworten gelöscht. Wirklich speichern?">
      ${csrfField(ctx)}
      <input type="hidden" name="tournament_id" value="${t.id}">
      <div class="q-list">
      ${QUESTION_CATALOG.map((c) => {
        const q = qs.find((x) => x.catalog_key === c.key);
        return html`<div class="q-row">
        <label class="check"><input type="checkbox" name="frage" value="${c.key}"${attr(!!q, 'checked data-was-checked="1"')}${attr(started, 'disabled')}>
          <span>${c.question}</span></label>
        ${
          q
            ? html`<details class="question-edit">
          <summary><span class="muted">${q.points} P.${q.correct_answers.length ? ', aufgelöst' : ''}${q.answers ? `, ${q.answers} ${q.answers === 1 ? 'Antwort' : 'Antworten'}` : ''} – Einstellungen</span></summary>
          <div class="stack">
            <p class="muted">Antwort der Tipper: ${ANSWER_TYPE_LABELS[q.answer_type]}</p>
            <label class="field small"><span>Punkte</span>
              <input type="number" name="punkte_${c.key}" value="${q.points}" min="0" max="50" required inputmode="numeric"></label>
            <label class="field"><span>Richtige Antwort(en) <small class="muted">(eine pro Zeile, z. B. bei Gleichstand; Groß-/Kleinschreibung und Satzzeichen sind egal)</small></span>
              <textarea name="antworten_${c.key}" rows="2">${q.correct_answers.join('\n')}</textarea></label>
            <button type="submit" formaction="${base}/frage/${q.id}" name="aktion" value="loeschen" formnovalidate class="btn btn-quiet" data-confirm="Frage „${q.question}“ mit allen Antworten wirklich löschen? Das lässt sich nicht rückgängig machen.">Frage löschen</button>
          </div>
        </details>`
            : html`<span class="muted q-points">${c.points} P.</span>`
        }
      </div>`;
      })}
      </div>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </form>`;
  })}
  <details class="question-edit new">
    <summary>Neue Frage vorschlagen</summary>
    <form method="post" action="${base}/frage-vorschlag" class="stack">
      ${csrfField(ctx)}
      <p class="muted">Neue Fragen nimmt der Betreiber der Seite in die Auswahl auf. Dein Vorschlag geht per E-Mail an ihn.</p>
      <label class="field"><span>Dein Vorschlag</span>
        <input type="text" name="vorschlag" required maxlength="300" autocomplete="off"></label>
      <button type="submit" class="btn btn-primary">Vorschlag senden</button>
    </form>
  </details>`
  }
</section>` : nothing}

${area === 'mitglieder' ? html`
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
            ${m.role === 'member' ? html`<option value="admin">Zum Mit-Spielleiter machen</option>` : html`<option value="member">Zum Mitglied machen</option>`}
            <option value="owner">Spielleitung übergeben</option>
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
</section>` : nothing}

${
  area === 'einstellungen' && access.isOwner
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

export function registerManageRoutes(router: Router<Ctx>) {
  router.get('/r/:slug/verwalten', (ctx) => managePage(ctx));

  const post = (path: string, fn: (ctx: Ctx, access: LeagueAccess) => Promise<Res | string | void>) =>
    router.post(`/r/:slug/verwalten${path}`, async (ctx) => {
      if (!ctx.user) return loginRedirect(ctx);
      const access = await manageAccess(ctx);
      const result = await fn(ctx, access);
      if (typeof result === 'string') return managePage(ctx, result, areaOfPath(ctx.path));
      return result ?? redirect(`${areaHref(access.league.slug, areaOfPath(ctx.path))}&hinweis=gespeichert`);
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
    return redirect(`${areaHref(league.slug, 'uebersicht')}&hinweis=link-erneuert`);
  });

  post('/turnier', async (ctx, { league }) => {
    const id = ctx.form.get('tournament_id');
    if (!isUuid(id)) return 'Bitte wähle ein Turnier aus.';
    await ctx.deps.db.run(
      `insert into league_tournaments (league_id, tournament_id) select $1, t.id from tournaments t where t.id = $2
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
  });

  post('/fragen-auswahl', async (ctx, { league }) => {
    const tid = ctx.form.get('tournament_id');
    if (!isUuid(tid)) return 'Bitte wähle ein Turnier aus.';
    const wanted = new Set(ctx.form.getAll('frage'));
    // Punkte und richtige Antworten vorab prüfen
    const settings = new Map<string, { points: number; answers: string[] }>();
    for (const c of QUESTION_CATALOG) {
      const raw = ctx.form.get(`punkte_${c.key}`);
      if (raw === null) continue;
      const points = intField(raw, 0, 50);
      if (points === null) return 'Bitte gib Punkte von 0 bis 50 ein.';
      settings.set(c.key, { points, answers: lines(ctx.form.get(`antworten_${c.key}`)) });
    }
    await ctx.deps.db.tx(async (q) => {
      const t = await q.one<{ started: boolean }>(
        `select coalesce(tournament_start(lt.tournament_id) <= now(), false) as started
           from league_tournaments lt where lt.league_id = $1 and lt.tournament_id = $2`,
        [league.id, tid],
      );
      if (!t) throw new HttpError(400, 'Dieses Turnier gehört nicht zur Tipprunde.');
      const existing = new Set(
        (await q.query<{ catalog_key: string }>('select catalog_key from bonus_questions where league_id = $1 and tournament_id = $2 and catalog_key is not null', [league.id, tid])).map((r) => r.catalog_key),
      );
      // Nach Turnierstart ist die Auswahl gesperrt (abgewählte Haken werden vom Browser gar nicht mitgeschickt)
      if (!t.started) {
        for (const [i, c] of QUESTION_CATALOG.entries()) {
          if (wanted.has(c.key) && !existing.has(c.key)) {
            await q.run(
              `insert into bonus_questions (league_id, tournament_id, position, question, points, answer_type, choices, catalog_key)
               values ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [league.id, tid, i + 1, c.question, c.points, c.type, c.choices, c.key],
            );
            existing.add(c.key);
          } else if (!wanted.has(c.key) && existing.has(c.key)) {
            await q.run('delete from bonus_questions where league_id = $1 and tournament_id = $2 and catalog_key = $3', [league.id, tid, c.key]);
            existing.delete(c.key);
          }
        }
      } else if (wanted.size > 0 && (wanted.size !== existing.size || [...wanted].some((k) => !existing.has(k)))) {
        throw new HttpError(400, 'Das Turnier hat schon begonnen: Die Auswahl lässt sich nicht mehr ändern. Eine Frage kannst du noch über ihre Einstellungen löschen.');
      }
      for (const [key, v] of settings) {
        if (!existing.has(key)) continue;
        await q.run(
          'update bonus_questions set points = $4, correct_answers = $5 where league_id = $1 and tournament_id = $2 and catalog_key = $3',
          [league.id, tid, key, v.points, v.answers],
        );
      }
    });
    return redirect(`${areaHref(league.slug, 'fragen')}&hinweis=gespeichert`);
  });

  post('/frage/:qid', async (ctx, { league }) => {
    const qid = ctx.params.qid;
    if (!isUuid(qid)) throw new HttpError(404, 'Diese Frage gibt es nicht.');
    if (ctx.form.get('aktion') === 'loeschen') {
      await ctx.deps.db.run('delete from bonus_questions where id = $1 and league_id = $2', [qid, league.id]);
    } else {
      const points = intField(ctx.form.get('points'), 0, 50);
      if (points === null) return 'Bitte gib Punkte von 0 bis 50 ein.';
      await ctx.deps.db.run('update bonus_questions set points = $3, correct_answers = $4 where id = $1 and league_id = $2', [
        qid,
        league.id,
        points,
        lines(ctx.form.get('correct_answers')),
      ]);
    }
    return redirect(`${areaHref(league.slug, 'fragen')}&hinweis=gespeichert`);
  });

  post('/frage-vorschlag', async (ctx, { league }) => {
    const { config, mailer } = ctx.deps;
    const text = cleanName(ctx.form.get('vorschlag'), 300);
    if (!text) return 'Bitte schreib deinen Vorschlag auf (bis 300 Zeichen).';
    if (!config.suggestionsTo) return 'Vorschläge sind gerade nicht möglich: Es ist keine Empfänger-Adresse eingestellt.';
    const user = ctx.user!;
    const body = `Neuer Vorschlag für eine Sonderfrage:\n\n${text}\n\nVon: ${user.display_name} <${user.email}>\nTipprunde: ${league.name}`;
    const page = html`<p>Neuer Vorschlag für eine Sonderfrage:</p><blockquote>${text}</blockquote>
<p>Von: ${user.display_name} &lt;${user.email}&gt;<br>Tipprunde: ${league.name}</p>`;
    await mailer.send({ to: config.suggestionsTo, subject: `Sonderfragen-Vorschlag aus „${league.name}“`, text: body, html: page.value });
    return redirect(`${areaHref(league.slug, 'fragen')}&hinweis=vorschlag-gesendet`);
  });

  post('/mitglied/:uid', async (ctx, access) => {
    const { league } = access;
    const uid = ctx.params.uid;
    if (!access.isOwner) throw new HttpError(403, 'Nur der Spielleiter der Tipprunde kann Mitglieder verwalten.');
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
    if (!access.isOwner) throw new HttpError(403, 'Nur der Spielleiter kann die Tipprunde löschen.');
    if ((ctx.form.get('name') ?? '').trim() !== access.league.name) return 'Der eingegebene Name stimmt nicht. Die Tipprunde wurde nicht gelöscht.';
    await ctx.deps.db.run('delete from leagues where id = $1', [access.league.id]);
    return redirect('/?hinweis=runde-geloescht');
  });
}
