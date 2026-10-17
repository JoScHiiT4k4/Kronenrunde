// Erinnerung für Lieblingsteams: 1 Stunde vor dem nächsten Spiel eines favorisierten Teams eine
// Push-Benachrichtigung – vorausgesetzt, die Person hat Push in ihrem Konto aktiviert.
// Eine Nachricht je Nutzer und Spiel (favorite_match_notifications verhindert Doppelte).

import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { loadVapid, sendPush } from './webpush.ts';

interface DueRow {
  user_id: string;
  match_id: string;
  team_name: string;
  team_short: string | null;
  opponent_name: string | null;
  opponent_short: string | null;
}

export async function vapidSubjectFor(config: Config): Promise<string> {
  const admin = [...config.adminEmails][0];
  return config.appUrl.startsWith('https://') ? config.appUrl : `mailto:${admin ?? 'admin@example.com'}`;
}

/** Favorisierte Teams, deren nächstes Spiel in höchstens 1 Stunde beginnt und noch nicht gemeldet wurde. */
async function dueFavoriteMatches(db: Db, now: Date): Promise<DueRow[]> {
  return db.query<DueRow>(
    `select distinct f.user_id, m.id as match_id,
            ft.name as team_name, ft.short_name as team_short,
            ot.name as opponent_name, ot.short_name as opponent_short
       from matches m
       join team_favorites f on f.team_id in (m.team_a_id, m.team_b_id)
       join teams ft on ft.id = f.team_id
       left join teams ot on ot.id = (case when m.team_a_id = f.team_id then m.team_b_id else m.team_a_id end)
       join notification_prefs p on p.user_id = f.user_id and p.push_enabled
       left join favorite_match_notifications n on n.user_id = f.user_id and n.match_id = m.id
      where m.status = 'scheduled' and m.scheduled_at is not null
        and m.scheduled_at > $1 and m.scheduled_at <= $1 + interval '1 hour'
        and n.user_id is null`,
    [now],
  );
}

export async function notifyFavoriteMatches(db: Db, config: Config, now: Date, log: (m: string) => void = () => {}): Promise<number> {
  const due = await dueFavoriteMatches(db, now);
  if (!due.length) return 0;
  let sent = 0;
  const vapid = await loadVapid(db);
  const subject = await vapidSubjectFor(config);
  for (const row of due) {
    const claimed = await db.run(
      `insert into favorite_match_notifications (user_id, match_id) values ($1, $2) on conflict do nothing`,
      [row.user_id, row.match_id],
    );
    if (!claimed) continue;
    const subs = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
      [row.user_id],
    );
    const team = row.team_short || row.team_name;
    const opponent = row.opponent_short || row.opponent_name || 'ein noch offener Gegner';
    let ok = 0;
    for (const s of subs) {
      const r = await sendPush(
        vapid,
        s,
        { title: `${team} beginnt in 1 Stunde`, body: `${team} vs. ${opponent}`, url: '/' },
        subject,
      );
      if (r === 'ok') ok++;
      if (r === 'gone') await db.run('delete from push_subscriptions where id = $1', [s.id]);
    }
    if (ok) sent++;
    else await db.run('delete from favorite_match_notifications where user_id = $1 and match_id = $2', [row.user_id, row.match_id]);
  }
  await db.run(`delete from favorite_match_notifications where sent_at < now() - interval '14 days'`);
  log(`Lieblingsteam-Erinnerungen verschickt: ${sent}`);
  return sent;
}

export function startFavoriteMatchSchedule(db: Db, config: Config, log: (m: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await notifyFavoriteMatches(db, config, new Date(), log);
    } catch (e) {
      log(`Lieblingsteam-Erinnerungen: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 40_000);
  const every = setInterval(tick, 60_000);
  first.unref();
  every.unref();
  return () => (clearTimeout(first), clearInterval(every));
}
