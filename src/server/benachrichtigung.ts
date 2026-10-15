// Erinnerungen an fehlende Tipps: per E-Mail und/oder Push, eine Nachricht je Nutzer, Tipprunde und Tippschluss.

import { missingTips } from '../domain/missing.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { formatDateTime, formatRemaining } from './format.ts';
import { html } from './html.ts';
import type { Mailer } from './mail.ts';
import { leagueMatches, toDomainMatch } from './routes/league-data.ts';
import { loadVapid, sendPush } from './webpush.ts';

interface Recipient {
  user_id: string;
  email: string;
  email_enabled: boolean;
  push_enabled: boolean;
  lead_minutes: number;
}

/** "2 Std. 30 Min." für die Einstellungen und Meldungen */
export function leadLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} Std.` : '', m ? `${m} Min.` : ''].filter(Boolean).join(' ') || '0 Min.';
}

export function vapidSubject(config: Config): string {
  const admin = [...config.adminEmails][0];
  return config.appUrl.startsWith('https://') ? config.appUrl : `mailto:${admin ?? 'admin@example.com'}`;
}

export async function notifyDue(db: Db, config: Config, mailer: Mailer, now: Date, log: (m: string) => void = () => {}): Promise<number> {
  const leagues = await db.query<{ id: string; name: string; slug: string; lock_mode: 'auto' | 'matchday' | 'match' }>(
    `select distinct l.id, l.name, l.slug, l.lock_mode
       from leagues l join league_members lm on lm.league_id = l.id
       join notification_prefs p on p.user_id = lm.user_id and (p.email_enabled or p.push_enabled)`,
  );
  let sent = 0;
  let vapid: Awaited<ReturnType<typeof loadVapid>> | null = null;
  for (const league of leagues) {
    const people = await db.query<Recipient>(
      `select u.id as user_id, u.email, p.email_enabled, p.push_enabled, p.lead_minutes
         from league_members lm join users u on u.id = lm.user_id
         join notification_prefs p on p.user_id = u.id and (p.email_enabled or p.push_enabled)
        where lm.league_id = $1`,
      [league.id],
    );
    const [matches, tipped] = await Promise.all([
      leagueMatches(db, league.id),
      db.query<{ user_id: string; match_id: string }>('select user_id, match_id from predictions where league_id = $1', [league.id]),
    ]);
    const missing = missingTips(
      people.map((p) => p.user_id),
      matches.map(toDomainMatch),
      new Set(tipped.map((t) => `${t.user_id}:${t.match_id}`)),
      league.lock_mode,
      now,
    );
    for (const item of missing) {
      const who = people.find((p) => p.user_id === item.userId)!;
      if (item.nextLock.getTime() - now.getTime() > who.lead_minutes * 60_000) continue;
      const when = `${formatDateTime(item.nextLock, config.timeZone)} Uhr (${formatRemaining(item.nextLock, now)})`;
      const what = `${item.missing} ${item.missing === 1 ? 'Tipp fehlt' : 'Tipps fehlen'}`;
      const link = `${config.appUrl}/r/${league.slug}/tippen`;
      const claim = (channel: 'email' | 'push') =>
        db.run(
          `insert into notification_log (user_id, league_id, lock_at, channel) values ($1, $2, $3, $4) on conflict do nothing`,
          [item.userId, league.id, item.nextLock, channel],
        );
      const unclaim = (channel: 'email' | 'push') =>
        db.run('delete from notification_log where user_id = $1 and league_id = $2 and lock_at = $3 and channel = $4', [item.userId, league.id, item.nextLock, channel]);

      if (who.email_enabled && (await claim('email'))) {
        try {
          const text = `Hallo!\n\nIn „${league.name}“ ${item.missing === 1 ? 'fehlt' : 'fehlen'} dir noch ${item.missing} ${item.missing === 1 ? 'Tipp' : 'Tipps'}. Tippschluss: ${when}.\n\n${link}\n\nDiese Erinnerung stellst du unter „Dein Konto“ ein.`;
          const body = html`<p>Hallo!</p><p>In „${league.name}“ ${item.missing === 1 ? 'fehlt' : 'fehlen'} dir noch <strong>${item.missing} ${item.missing === 1 ? 'Tipp' : 'Tipps'}</strong>. Tippschluss: ${when}.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#c8aa6e;color:#1c1407;text-decoration:none;font-weight:bold">Jetzt tippen</a></p>
<p style="color:#666">Diese Erinnerung stellst du unter „Dein Konto“ ein.</p>`;
          await mailer.send({ to: who.email, subject: `${what} – ${league.name}`, text, html: body.value });
          sent++;
        } catch (e) {
          await unclaim('email');
          log(`Erinnerung per E-Mail fehlgeschlagen: ${(e as Error).message}`);
        }
      }

      if (who.push_enabled && (await claim('push'))) {
        const subs = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
          'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
          [item.userId],
        );
        vapid ??= await loadVapid(db);
        let ok = 0;
        for (const s of subs) {
          const r = await sendPush(vapid, s, { title: `${what} – ${league.name}`, body: `Tippschluss: ${when}`, url: `/r/${league.slug}/tippen` }, vapidSubject(config));
          if (r === 'ok') ok++;
          if (r === 'gone') await db.run('delete from push_subscriptions where id = $1', [s.id]);
        }
        if (ok) sent++;
        else await unclaim('push');
      }
    }
  }
  await db.run(`delete from notification_log where sent_at < now() - interval '14 days'`);
  return sent;
}

export function startNotifySchedule(db: Db, config: Config, mailer: Mailer, log: (m: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await notifyDue(db, config, mailer, new Date(), log);
      if (n) log(`Erinnerungen verschickt: ${n}`);
    } catch (e) {
      log(`Erinnerungen: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 30_000);
  const every = setInterval(tick, 60_000);
  first.unref();
  every.unref();
  return () => (clearTimeout(first), clearInterval(every));
}
