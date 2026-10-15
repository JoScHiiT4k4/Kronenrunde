-- Frist der Sonderfragen = Start des ersten Spiels des Turniers (automatisch).
-- Die frühere, von Hand eingestellte Frist (league_tournaments.bonus_deadline_at) wird nicht mehr gelesen.
--
-- Start = frühester Anstoß (oder früheres "läuft"), abgesagte Spiele zählen nicht. Steht noch kein Spiel
-- mit Termin fest, gibt es keine Frist, und Antworten sind möglich.

create or replace function tournament_start(p_tournament uuid) returns timestamptz
language sql stable as $$
  select least(min(scheduled_at), min(live_at))
    from matches
   where tournament_id = p_tournament and status <> 'cancelled';
$$;

create or replace function trg_bonus_answers_check() returns trigger
language plpgsql as $$
declare
  q bonus_questions%rowtype;
  started_at timestamptz;
begin
  select * into q from bonus_questions where id = new.question_id;
  if q.league_id <> new.league_id then
    raise exception 'Die Frage gehört nicht zu dieser Tipprunde.' using errcode = 'P0001';
  end if;
  if not lock_bypassed() then
    started_at := tournament_start(q.tournament_id);
    if started_at is not null and now() >= started_at then
      raise exception 'Die Sonderfragen sind geschlossen.' using errcode = 'P0001';
    end if;
  end if;
  new.submitted_at := now();
  return new;
end $$;
