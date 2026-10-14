-- Tests für den Tippschluss "automatisch" (Migration 0007). Läuft nach 0001_grundgeruest_test.sql.

\set QUIET on
set client_min_messages = warning;

create or replace function pg_temp.expect_error(sql text, fragment text) returns void
language plpgsql as $$
begin
  execute sql;
  raise exception 'TEST FEHLGESCHLAGEN: erwartet Fehler "%" bei: %', fragment, sql;
exception
  when others then
    if sqlerrm like 'TEST FEHLGESCHLAGEN%' then raise; end if;
    if position(fragment in sqlerrm) = 0 then
      raise exception 'TEST FEHLGESCHLAGEN: falsche Meldung "%" (erwartet "%")', sqlerrm, fragment;
    end if;
end $$;

insert into users (id, email, display_name) values ('00000000-0000-0000-0000-0000000007a1', 'auto@example.org', 'Auto');
insert into teams (id, name) values
  ('00000000-0000-0000-0000-00000000c701', 'Team Eins'), ('00000000-0000-0000-0000-00000000c702', 'Team Zwei'),
  ('00000000-0000-0000-0000-00000000c703', 'Team Drei'), ('00000000-0000-0000-0000-00000000c704', 'Team Vier');
insert into tournaments (id, name) values ('00000000-0000-0000-0000-0000000007f1', 'Auto-Turnier');
-- Spieltag: Spiel 1 in 1 h, Spiel 2 in 5 h (geschätzt); nächster Spieltag in 30 h
insert into matches (id, tournament_id, team_a_id, team_b_id, best_of, scheduled_at) values
  ('00000000-0000-0000-0000-0000000007e1', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000c702', 5, now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000007e2', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-00000000c703', '00000000-0000-0000-0000-00000000c704', 5, now() + interval '5 hours'),
  ('00000000-0000-0000-0000-0000000007e3', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000c703', 1, now() + interval '30 hours');
insert into leagues (id, name, slug, owner_id) values
  ('00000000-0000-0000-0000-0000000007d1', 'Autorunde', 'autorunde', '00000000-0000-0000-0000-0000000007a1');
insert into league_members (league_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-0000000007a1', 'owner');
insert into league_tournaments (league_id, tournament_id) values
  ('00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-0000000007f1');

do $$
declare
  l timestamptz;
  s timestamptz;
begin
  if (select lock_mode from leagues where id = '00000000-0000-0000-0000-0000000007d1') <> 'auto' then
    raise exception 'TEST FEHLGESCHLAGEN: neue Tipprunden sollen "automatisch" haben';
  end if;
  -- Vorher: Spiel 2 schließt zu seiner (geschätzten) Anstoßzeit, nicht mit Spiel 1
  select scheduled_at into s from matches where id = '00000000-0000-0000-0000-0000000007e2';
  l := prediction_lock_time('00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-0000000007e2');
  if l <> s then raise exception 'TEST FEHLGESCHLAGEN: Tippschluss Spiel 2 % statt %', l, s; end if;
end $$;
insert into predictions values ('00000000-0000-0000-0000-0000000007d1','00000000-0000-0000-0000-0000000007e2','00000000-0000-0000-0000-0000000007a1','A',3,0);

-- Spiel 1 ist vorbei (Ergebnis eingetragen): Spiel 2 geht gleich los → kein Tippen mehr
update matches set wins_a = 3, wins_b = 1, status = 'finished' where id = '00000000-0000-0000-0000-0000000007e1';
do $$
begin
  if (select finished_at from matches where id = '00000000-0000-0000-0000-0000000007e1') is null then
    raise exception 'TEST FEHLGESCHLAGEN: finished_at fehlt';
  end if;
  perform pg_temp.expect_error($q$update predictions set winner = 'B' where match_id = '00000000-0000-0000-0000-0000000007e2'$q$, 'Tippschluss ist vorbei');
  -- Der nächste Spieltag bleibt offen
  insert into predictions values ('00000000-0000-0000-0000-0000000007d1','00000000-0000-0000-0000-0000000007e3','00000000-0000-0000-0000-0000000007a1','A',null,null);
end $$;

-- Ergebnis zurückgenommen (Versehen): Spiel 2 ist wieder offen
update matches set wins_a = null, wins_b = null, status = 'scheduled' where id = '00000000-0000-0000-0000-0000000007e1';
update predictions set winner = 'B' where match_id = '00000000-0000-0000-0000-0000000007e2';
do $$
begin
  if (select live_at from matches where id = '00000000-0000-0000-0000-0000000007e1') is not null then
    raise exception 'TEST FEHLGESCHLAGEN: "läuft" vom versehentlichen Ergebnis ist geblieben';
  end if;
end $$;

-- Spiel 2 wird als "läuft" gemeldet: sofort zu
update matches set status = 'live' where id = '00000000-0000-0000-0000-0000000007e2';
do $$
begin
  perform pg_temp.expect_error($q$update predictions set winner = 'A' where match_id = '00000000-0000-0000-0000-0000000007e2'$q$, 'Tippschluss ist vorbei');
end $$;

-- Gleich als vorbei gemeldet (ohne "läuft" dazwischen): das Spiel selbst ist auch zu
update matches set wins_a = 0, wins_b = 1, status = 'finished' where id = '00000000-0000-0000-0000-0000000007e3';
do $$
begin
  perform pg_temp.expect_error($q$update predictions set winner = 'B' where match_id = '00000000-0000-0000-0000-0000000007e3'$q$, 'Tippschluss ist vorbei');
end $$;

-- Erstes Spiel des Spieltags: zur angesetzten Zeit
update matches set scheduled_at = now() - interval '1 minute' where id = '00000000-0000-0000-0000-0000000007e1';
do $$
begin
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000007d1','00000000-0000-0000-0000-0000000007e1','00000000-0000-0000-0000-0000000007a1','A',3,0)$q$, 'Tippschluss ist vorbei');
end $$;

select 'Tippschluss automatisch: alle Tests bestanden' as ergebnis;
