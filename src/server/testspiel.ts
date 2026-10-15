// „Testspiel“: eine Tipprunde nur für den Betreiber, in der er die Teilnehmer-Ansicht prüft.
// Einstellungen, Turniere und Sonderfragen kommen aus dem Hauptspiel; Teilnehmer und Tipps nie.

import type { Db, Queryable } from './db/index.ts';

export interface TestState {
  /** Hauptspiel des Betreibers (die Tipprunde, die er leitet) */
  main: { id: string; name: string } | null;
  /** Das Testspiel gibt es schon */
  exists: boolean;
  /** Der Betreiber sieht es gerade (ist Teilnehmer) */
  visible: boolean;
}

async function mainLeague(q: Queryable, userId: string): Promise<{ id: string; name: string } | null> {
  return q.one<{ id: string; name: string }>(
    `select l.id, l.name from leagues l join league_members m on m.league_id = l.id and m.user_id = $1
      where not l.is_test order by (m.role = 'owner') desc, m.joined_at limit 1`,
    [userId],
  );
}

export async function loadTestState(db: Db, userId: string): Promise<TestState> {
  const [main, test] = await Promise.all([
    mainLeague(db, userId),
    db.one<{ id: string; visible: boolean }>(
      `select l.id, exists (select 1 from league_members m where m.league_id = l.id and m.user_id = $1) as visible from leagues l where l.is_test and l.slug = 'testspiel'`,
      [userId],
    ),
  ]);
  return { main, exists: !!test, visible: !!test?.visible };
}

/** Einstellungen, Turniere und Sonderfragen vom Hauptspiel ins Testspiel kopieren (Teilnehmer und Tipps bleiben unberührt). */
async function syncSettings(q: Queryable, mainId: string, testId: string): Promise<void> {
  await q.run(
    `update leagues t set points_winner = m.points_winner, points_exact = m.points_exact, lock_mode = m.lock_mode
       from leagues m where m.id = $1 and t.id = $2`,
    [mainId, testId],
  );
  await q.run(
    `delete from league_tournaments where league_id = $2 and tournament_id not in (select tournament_id from league_tournaments where league_id = $1)`,
    [mainId, testId],
  );
  await q.run(
    `insert into league_tournaments (league_id, tournament_id, bonus_deadline_at)
       select $2, tournament_id, bonus_deadline_at from league_tournaments where league_id = $1
     on conflict (league_id, tournament_id) do update set bonus_deadline_at = excluded.bonus_deadline_at`,
    [mainId, testId],
  );
  await q.run('delete from bonus_questions where league_id = $1', [testId]);
  await q.run(
    `insert into bonus_questions (league_id, tournament_id, position, question, points, answer_type, choices, hint, correct_answers, catalog_key)
       select $2, tournament_id, position, question, points, answer_type, choices, hint, correct_answers, catalog_key
         from bonus_questions where league_id = $1`,
    [mainId, testId],
  );
}

/** Testspiel anlegen (falls nötig), den Betreiber als normalen Teilnehmer eintragen und alles vom Hauptspiel übernehmen. */
export async function showTestLeague(db: Db, userId: string): Promise<boolean> {
  return db.tx(async (q) => {
    const main = await mainLeague(q, userId);
    if (!main) return false;
    let test = await q.one<{ id: string }>(`select id from leagues where is_test and slug = 'testspiel'`);
    test ??= await q.one<{ id: string }>(`insert into leagues (name, slug, owner_id, is_test) values ('Testspiel', 'testspiel', null, true) returning id`);
    await q.run(`insert into league_members (league_id, user_id, role) values ($1, $2, 'member') on conflict do nothing`, [test!.id, userId]);
    await syncSettings(q, main.id, test!.id);
    return true;
  });
}

/** Testspiel ausblenden: der Betreiber ist dort kein Teilnehmer mehr (seine Test-Tipps verschwinden mit). */
export async function hideTestLeague(db: Db, userId: string): Promise<void> {
  await db.run(`delete from league_members where user_id = $1 and league_id in (select id from leagues where is_test)`, [userId]);
}

export async function syncTestLeague(db: Db, userId: string): Promise<boolean> {
  return db.tx(async (q) => {
    const main = await mainLeague(q, userId);
    const test = await q.one<{ id: string }>(`select id from leagues where is_test and slug = 'testspiel'`);
    if (!main || !test) return false;
    await syncSettings(q, main.id, test.id);
    return true;
  });
}
