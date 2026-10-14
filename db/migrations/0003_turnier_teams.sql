-- Teilnehmende Teams eines Turniers – auch solche, deren Spiele noch nicht feststehen.
-- Wird für die Team-Auswahl bei Sonderfragen gebraucht (z. B. "Wer wird Weltmeister?").
-- Gefüllt vom Datenimport (tippspiel daten …) und im Admin-Bereich beim Turnier.

create table tournament_teams (
  tournament_id  uuid not null references tournaments (id) on delete cascade,
  team_id        uuid not null references teams (id) on delete cascade,
  primary key (tournament_id, team_id)
);

-- Bisherige Turniere: alle Teams, die dort schon ein Spiel haben
insert into tournament_teams (tournament_id, team_id)
select tournament_id, team_a_id from matches where team_a_id is not null
union
select tournament_id, team_b_id from matches where team_b_id is not null
on conflict do nothing;

-- Wer in einem Spiel des Turniers eingetragen wird, gehört automatisch dazu.
create or replace function trg_matches_tournament_teams() returns trigger
language plpgsql as $$
begin
  insert into tournament_teams (tournament_id, team_id)
  select new.tournament_id, t from unnest(array[new.team_a_id, new.team_b_id]) as t where t is not null
  on conflict do nothing;
  return null;
end $$;

create trigger matches_tournament_teams
  after insert or update of team_a_id, team_b_id, tournament_id on matches
  for each row execute function trg_matches_tournament_teams();
