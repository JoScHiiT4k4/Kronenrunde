-- Tests für das Datenbank-Grundgerüst.
-- Aufruf: psql -v ON_ERROR_STOP=1 -f db/migrations/0001_grundgeruest.sql -f db/tests/0001_grundgeruest_test.sql
-- Jeder Block bricht mit einer Fehlermeldung ab, wenn etwas nicht stimmt.

\set QUIET on
set client_min_messages = warning;

-- Hilfsfunktion: erwartet, dass ein SQL-Befehl mit einer bestimmten Meldung scheitert.
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

-- ---------------------------------------------------------------------
-- Testdaten
-- ---------------------------------------------------------------------
insert into users (id, email, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Anna@Example.org', 'Anna'),
  ('00000000-0000-0000-0000-0000000000b1', 'ben@example.org',  'Ben');

insert into teams (id, name) values
  ('00000000-0000-0000-0000-00000000c001', 'Karmine Corp'),
  ('00000000-0000-0000-0000-00000000c002', 'Cloud9'),
  ('00000000-0000-0000-0000-00000000c003', 'MVK Esports'),
  ('00000000-0000-0000-0000-00000000c004', 'FURIA');

insert into tournaments (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Test-Turnier');

-- Spieltag 1: Anstoß in 2 h und in 7 h (5 h Abstand = derselbe Spieltag)
-- Spieltag 2: Anstoß in 26 h (19 h nach dem letzten Spiel = neuer Spieltag)
-- Spiel 4: schon vorbei; Spiel 5: Teams noch offen
insert into matches (id, tournament_id, team_a_id, team_b_id, best_of, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1',
   '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c002', 5, now() + interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1',
   '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000c004', 5, now() + interval '7 hours'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000f1',
   '00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000c004', 1, now() + interval '26 hours'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000f1',
   '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c003', 3, now() - interval '10 hours'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000f1',
   null, null, 5, now() + interval '30 hours');

insert into leagues (id, name, slug, owner_id, lock_mode) values
  ('00000000-0000-0000-0000-0000000000d1', 'Testrunde', 'testrunde', '00000000-0000-0000-0000-0000000000a1', 'matchday');
insert into league_members (league_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', 'member');
insert into league_tournaments (league_id, tournament_id, bonus_deadline_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', now() + interval '2 hours');

-- ---------------------------------------------------------------------
-- Tests
-- ---------------------------------------------------------------------
do $$
declare d1 timestamptz; d2 timestamptz; d3 timestamptz;
begin
  -- E-Mail ohne Groß-/Kleinschreibung eindeutig
  perform pg_temp.expect_error($q$insert into users (email, display_name) values ('anna@example.org', 'Anna 2')$q$, 'users_email_key');

  -- Spieltage
  select matchday_starts_at into d1 from matches where id = '00000000-0000-0000-0000-0000000000e1';
  select matchday_starts_at into d2 from matches where id = '00000000-0000-0000-0000-0000000000e2';
  select matchday_starts_at into d3 from matches where id = '00000000-0000-0000-0000-0000000000e3';
  if d1 is null or d2 <> d1 then raise exception 'TEST FEHLGESCHLAGEN: Spiel 2 sollte zum Spieltag von Spiel 1 gehören'; end if;
  if d3 = d1 then raise exception 'TEST FEHLGESCHLAGEN: Spiel 3 sollte einen neuen Spieltag bilden'; end if;

  -- Verschiebt man Spiel 1 auf übermorgen, rechnen sich die Spieltage neu
  update matches set scheduled_at = now() + interval '48 hours' where id = '00000000-0000-0000-0000-0000000000e1';
  select matchday_starts_at into d2 from matches where id = '00000000-0000-0000-0000-0000000000e2';
  if d2 <> (select scheduled_at from matches where id = '00000000-0000-0000-0000-0000000000e2') then
    raise exception 'TEST FEHLGESCHLAGEN: Spieltag nach Verschieben nicht neu berechnet';
  end if;
  update matches set scheduled_at = now() + interval '2 hours' where id = '00000000-0000-0000-0000-0000000000e1';
end $$;

-- Gültige Tipps
insert into predictions (league_id, match_id, user_id, winner, winner_wins, loser_wins) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'A', 3, 1),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'B', null, null);
-- Tipp ändern vor Tippschluss
update predictions set winner = 'B', winner_wins = 3, loser_wins = 2
 where match_id = '00000000-0000-0000-0000-0000000000e1' and user_id = '00000000-0000-0000-0000-0000000000a1';

do $$
begin
  -- Ergebnis muss zum Format passen
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b1','A',2,1)$q$, 'Ergebnis passt nicht zu Bo5');
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000b1','A',1,0)$q$, 'Bei Bo1 wird nur der Sieger getippt');
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b1','A',3,3)$q$, 'Ergebnis passt nicht');

  -- Teams noch offen
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e5','00000000-0000-0000-0000-0000000000b1','A',3,0)$q$, 'Teams noch nicht fest');

  -- Spiel schon angefangen
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000b1','A',2,0)$q$, 'Tippschluss ist vorbei');

  -- Nur Mitglieder der Tipprunde dürfen tippen
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000ff','A',3,0)$q$, 'foreign key');
end $$;

-- Spieltag-Regel: Spiel 2 (in 7 h) schließt mit Spiel 1 (in 2 h).
-- Wir simulieren "Spieltag hat begonnen", indem Spiel 1 in die Vergangenheit rutscht.
update matches set scheduled_at = now() - interval '1 minute' where id = '00000000-0000-0000-0000-0000000000e1';
update matches set scheduled_at = now() + interval '4 hours' where id = '00000000-0000-0000-0000-0000000000e2';
do $$
begin
  perform pg_temp.expect_error($q$insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000b1','A',3,0)$q$, 'Tippschluss ist vorbei');
  -- Bestehenden Tipp nach Tippschluss ändern geht auch nicht
  perform pg_temp.expect_error($q$update predictions set winner = 'A' where match_id = '00000000-0000-0000-0000-0000000000e1'$q$, 'Tippschluss ist vorbei');
end $$;

-- Mit Einstellung "jedes Spiel einzeln" ist Spiel 2 noch offen
update leagues set lock_mode = 'match' where id = '00000000-0000-0000-0000-0000000000d1';
insert into predictions values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000b1','A',3,0);
update leagues set lock_mode = 'matchday' where id = '00000000-0000-0000-0000-0000000000d1';

-- Admin-Korrektur mit Ausnahme-Schalter
begin;
set local app.bypass_lock = 'on';
update predictions set winner = 'A', winner_wins = 3, loser_wins = 0
 where match_id = '00000000-0000-0000-0000-0000000000e1' and user_id = '00000000-0000-0000-0000-0000000000a1';
commit;

-- Ergebnis eintragen: nur gültige Ergebnisse
do $$
begin
  perform pg_temp.expect_error($q$update matches set wins_a = 3, wins_b = 1 where id = '00000000-0000-0000-0000-0000000000e4'$q$, 'matches_check');
  perform pg_temp.expect_error($q$update matches set wins_a = 2 where id = '00000000-0000-0000-0000-0000000000e4'$q$, 'matches_check');
end $$;
update matches set wins_a = 2, wins_b = 1, status = 'finished' where id = '00000000-0000-0000-0000-0000000000e4';

-- Sonderfragen
insert into bonus_questions (id, league_id, tournament_id, question, points, answer_type, choices) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1',
   'Wer gewinnt?', 4, 'team', '{}'),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1',
   'Erster Pentakill?', 2, 'team', '{"Kein Pentakill"}');
insert into bonus_answers (question_id, league_id, user_id, answer) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Cloud9');
update league_tournaments set bonus_deadline_at = now() - interval '1 minute';
do $$
begin
  perform pg_temp.expect_error($q$insert into bonus_answers values ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','T1')$q$, 'Sonderfragen sind geschlossen');
  perform pg_temp.expect_error($q$update bonus_answers set answer = 'T1'$q$, 'Sonderfragen sind geschlossen');
end $$;

-- Konto löschen: alles des Nutzers verschwindet, auch nach Tippschluss
delete from users where id = '00000000-0000-0000-0000-0000000000a1';
do $$
begin
  if exists (select 1 from predictions where user_id = '00000000-0000-0000-0000-0000000000a1')
     or exists (select 1 from bonus_answers where user_id = '00000000-0000-0000-0000-0000000000a1')
     or exists (select 1 from league_members where user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'TEST FEHLGESCHLAGEN: Daten nach Kontolöschung noch vorhanden';
  end if;
  if (select owner_id from leagues where id = '00000000-0000-0000-0000-0000000000d1') is not null then
    raise exception 'TEST FEHLGESCHLAGEN: Tipprunde sollte ohne Besitzer weiterbestehen';
  end if;
end $$;

\echo 'Alle Datenbank-Tests bestanden.'
