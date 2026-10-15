-- Einmalig: zweite Tipprunde „Testspiel“ für den Betreiber (nur er, als normaler Teilnehmer ohne Spielleiter-Rolle),
-- damit der Wechsel zwischen Tipprunden ausprobiert werden kann. Ohne passenden Nutzer passiert nichts.
do $$
declare
  uid uuid;
  lid uuid;
begin
  select id into uid from users where lower(email) = 'betreiber@example.de';
  if uid is null or exists (select 1 from leagues where slug = 'testspiel') then
    return;
  end if;
  insert into leagues (name, slug, owner_id, points_winner, points_exact, lock_mode)
    select 'Testspiel', 'testspiel', null, l.points_winner, l.points_exact, l.lock_mode
      from leagues l join league_members m on m.league_id = l.id and m.user_id = uid
     order by m.joined_at limit 1
    returning id into lid;
  if lid is null then
    insert into leagues (name, slug, owner_id) values ('Testspiel', 'testspiel', null) returning id into lid;
  end if;
  insert into league_members (league_id, user_id, role) values (lid, uid, 'member');
  insert into league_tournaments (league_id, tournament_id)
    select distinct lid, lt.tournament_id from league_tournaments lt
      join league_members m on m.league_id = lt.league_id and m.user_id = uid
     where lt.league_id <> lid;
end $$;
