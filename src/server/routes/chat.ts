// Chat einer Tipprunde: kleine Nachrichten zwischen den Mitgliedern, nach 7 Tagen automatisch gelöscht.

import type { Ctx } from '../app.ts';
import type { Db } from '../db/index.ts';
import { HttpError, type Res, type Router } from '../http.ts';
import { loginRedirect } from './common.ts';
import { loadLeague } from './league-data.ts';

export const CHAT_DAYS = 7;
const MAX_LEN = 500;
const PER_MINUTE = 15;

const json = (body: unknown, status = 200): Res => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

interface Row {
  id: string;
  user_id: string;
  name: string;
  created_at: Date;
  body: string;
}

const view = (r: Row) => ({ id: Number(r.id), u: r.user_id, n: r.name, t: r.created_at.toISOString(), x: r.body });

/** Nachrichten löschen, die älter als 7 Tage sind. */
export async function purgeOldMessages(db: Db): Promise<number> {
  return db.run(`delete from chat_messages where created_at < now() - interval '${CHAT_DAYS} days'`);
}

export function startChatCleanup(db: Db, log: (m: string) => void): () => void {
  const run = () => purgeOldMessages(db).catch((e: Error) => log(`Chat aufräumen: ${e.message}`));
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, 3_600_000);
  first.unref();
  every.unref();
  return () => (clearTimeout(first), clearInterval(every));
}

export function registerChatRoutes(router: Router<Ctx>) {
  // Neueste 50 Nachrichten (ohne "nach") oder alle neueren als die Nummer in "nach"
  router.get('/r/:slug/chat/nachrichten', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { league } = await loadLeague(ctx, ctx.params.slug);
    const after = /^\d{1,15}$/.test(ctx.query.get('nach') ?? '') ? Number(ctx.query.get('nach')) : null;
    const select = `select m.id::text, m.user_id, u.display_name as name, m.created_at, m.body
                      from chat_messages m join users u on u.id = m.user_id`;
    const rows =
      after === null
        ? (await ctx.deps.db.query<Row>(`${select} where m.league_id = $1 order by m.id desc limit 50`, [league.id])).reverse()
        : await ctx.deps.db.query<Row>(`${select} where m.league_id = $1 and m.id > $2 order by m.id limit 100`, [league.id, after]);
    return json({ me: ctx.user.id, messages: rows.map(view) });
  });

  router.post('/r/:slug/chat', async (ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    const { league } = await loadLeague(ctx, ctx.params.slug);
    const text = (ctx.form.get('text') ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_LEN) throw new HttpError(400, `Bitte schreibe 1 bis ${MAX_LEN} Zeichen.`);
    const { db } = ctx.deps;
    const recent = await db.one<{ n: number }>(`select count(*)::int as n from chat_messages where user_id = $1 and created_at > now() - interval '1 minute'`, [ctx.user.id]);
    if ((recent?.n ?? 0) >= PER_MINUTE) throw new HttpError(429, 'Nicht so schnell – bitte warte einen Moment.');
    const row = await db.one<Row>(
      `with ins as (insert into chat_messages (league_id, user_id, body) values ($1, $2, $3) returning id, user_id, created_at, body)
       select ins.id::text, ins.user_id, u.display_name as name, ins.created_at, ins.body from ins join users u on u.id = ins.user_id`,
      [league.id, ctx.user.id, text],
    );
    return json({ message: view(row!) }, 201);
  });
}
