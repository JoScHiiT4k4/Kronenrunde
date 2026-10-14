-- Tippschluss "automatisch" (neuer Standard): jedes Spiel einzeln, und zwar zum frühesten dieser Zeitpunkte:
--   1. das vorherige Spiel desselben Spieltags ist vorbei (Ergebnis eingetragen) – dann geht es gleich los,
--   2. das Spiel selbst wird als "läuft" (oder gleich als vorbei) gemeldet,
--   3. spätestens zur angesetzten Anstoßzeit (Sicherheitsnetz, falls niemand ein Ergebnis einträgt).
-- Ergebnisse und "läuft" trägt der Abgleich mit lolesports.com an Spieltagen alle 2 Minuten ein.

alter table matches add column live_at timestamptz;      -- seit wann als "läuft" gemeldet
alter table matches add column finished_at timestamptz;  -- seit wann vorbei (Ergebnis eingetragen)
update matches set finished_at = updated_at where (wins_a is not null or status = 'finished') and finished_at is null;
update matches set live_at = updated_at where status = 'live' and live_at is null;
update matches set live_at = finished_at where finished_at is not null and live_at is null;

create or replace function trg_matches_progress() returns trigger
language plpgsql as $$
begin
  if new.status = 'live' and new.live_at is null then
    new.live_at := now();
  end if;
  if (new.wins_a is not null or new.status = 'finished') and new.finished_at is null then
    new.finished_at := now();
  elsif new.wins_a is null and new.status <> 'finished' then
    new.finished_at := null;  -- Ergebnis wurde zurückgenommen
    if tg_op = 'UPDATE' then
      if new.live_at = old.finished_at and new.status <> 'live' then
        new.live_at := null;  -- "läuft" kam nur vom versehentlichen Ergebnis
      end if;
    end if;
  end if;
  -- Wer vorbei ist, hat auch angefangen (falls "läuft" zwischen zwei Abgleichen untergegangen ist)
  if new.finished_at is not null and new.live_at is null then
    new.live_at := new.finished_at;
  end if;
  return new;
end $$;

create trigger matches_progress
  before insert or update on matches
  for each row execute function trg_matches_progress();

-- Vorheriges Spiel desselben Spieltags (gleiche Reihenfolge wie auf der Tippseite)
create or replace function previous_match_finished_at(p_match uuid) returns timestamptz
language sql stable as $$
  select p.finished_at
    from matches m
    join matches p on p.tournament_id = m.tournament_id
                  and p.matchday_starts_at = m.matchday_starts_at
                  and p.status <> 'cancelled'
                  and (p.scheduled_at, p.id) < (m.scheduled_at, m.id)
   where m.id = p_match
   order by p.scheduled_at desc, p.id desc
   limit 1;
$$;

alter table leagues drop constraint leagues_lock_mode_check;
alter table leagues add constraint leagues_lock_mode_check check (lock_mode in ('auto', 'matchday', 'match'));
alter table leagues alter column lock_mode set default 'auto';
-- Bisheriger Standard (ganzer Spieltag beim ersten Anstoß) → neuer Standard
update leagues set lock_mode = 'auto' where lock_mode = 'matchday';

create or replace function prediction_lock_time(p_league uuid, p_match uuid) returns timestamptz
language sql stable as $$
  select case l.lock_mode
           when 'match' then m.scheduled_at
           when 'auto' then least(m.scheduled_at, m.live_at, previous_match_finished_at(m.id))
           else coalesce(m.matchday_starts_at, m.scheduled_at)
         end
    from leagues l, matches m
   where l.id = p_league and m.id = p_match;
$$;
