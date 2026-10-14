-- Beispieldaten: LoL Worlds 2026 (Teams, Turnier, Phasen, erste Spiele).
-- Optional – nützlich zum Ausprobieren und Entwickeln. Zeiten in deutscher Zeit (MESZ).

insert into teams (name, region) values
  ('Gen.G', 'LCK'), ('Hanwha Life Esports', 'LCK'), ('T1', 'LCK'), ('Dplus KIA', 'LCK'),
  ('Anyone''s Legend', 'LPL'), ('Bilibili Gaming', 'LPL'), ('Top Esports', 'LPL'), ('Invictus Gaming', 'LPL'),
  ('G2 Esports', 'LEC'), ('Movistar KOI', 'LEC'), ('Karmine Corp', 'LEC'),
  ('Cloud9', 'LCS'), ('Team Liquid', 'LCS'), ('LYON', 'LCS'),
  ('Team Secret Whales', 'LCP'), ('CTBC Flying Oyster', 'LCP'), ('MVK Esports', 'LCP'),
  ('LØS', 'CBLOL'), ('FURIA', 'CBLOL')
on conflict (game, name) do nothing;

with t as (
  insert into tournaments (name, starts_on, ends_on)
  values ('Worlds 2026', '2026-10-15', '2026-11-14')
  returning id
), s as (
  insert into stages (tournament_id, name, position)
  select t.id, x.name, x.pos
    from t, (values ('Play-In', 1), ('Swiss', 2), ('Viertelfinale', 3), ('Halbfinale', 4), ('Finale', 5)) as x(name, pos)
  returning id, tournament_id, name
)
insert into matches (tournament_id, stage_id, team_a_id, team_b_id, best_of, scheduled_at)
select s.tournament_id, s.id,
       (select id from teams where name = m.team_a),
       (select id from teams where name = m.team_b),
       5, m.at::timestamptz
  from s,
       (values ('Karmine Corp', 'Cloud9', '2026-10-15 20:00:00+02'),
               ('MVK Esports',  'FURIA',  '2026-10-16 01:00:00+02')) as m(team_a, team_b, at)
 where s.name = 'Play-In';
