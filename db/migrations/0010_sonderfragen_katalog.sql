-- Sonderfragen kommen aus einem Katalog (src/domain/questions.ts). Die Kennung zeigt, welche Katalogfrage
-- eine Frage ist; so lässt sich in "Verwalten" per Checkbox an- und abwählen.

alter table bonus_questions add column catalog_key text;

-- Bisherige Fragen mit dem Text einer Katalogfrage übernehmen (nur die erste je Turnier)
update bonus_questions q set catalog_key = c.key
  from (values
    ('weltmeister',       'Wer wird Weltmeister?'),
    ('finals-mvp',        'Wer wird Finals-MVP?'),
    ('meistgebannt',      'Welcher Champion wird am häufigsten gebannt?'),
    ('kuerzestes-spiel',  'Welches Team verliert das kürzeste Spiel?'),
    ('pentakill-team',    'Welches Team holt den ersten Pentakill?'),
    ('pentakill-spieler', 'Welcher Spieler holt den ersten Pentakill?')
  ) as c (key, question)
 where q.question = c.question
   and q.id = (select min(x.id::text)::uuid from bonus_questions x
                where x.league_id = q.league_id and x.tournament_id = q.tournament_id and x.question = q.question);

create unique index bonus_questions_catalog_key on bonus_questions (league_id, tournament_id, catalog_key) where catalog_key is not null;
