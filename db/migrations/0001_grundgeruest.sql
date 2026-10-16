-- =====================================================================
-- Kronenrunde – Grundgerüst der Datenbank (PostgreSQL 15+)
--
-- Läuft unverändert auf Supabase (Cloud) und auf einem eigenen Server
-- (Raspberry Pi / PC mit Docker). Keine anbieterspezifischen Funktionen.
--
-- Grundsätze:
--   * Mehrere Tipprunden (leagues) von Anfang an – privat und später öffentlich.
--   * Mehrere Turniere und Spiele (game), nicht nur LoL Worlds.
--   * Fairness wird in der Datenbank erzwungen: Nach Tippschluss lassen sich
--     Tipps und Sonderfragen-Antworten nicht mehr anlegen oder ändern.
--   * Konten lassen sich vollständig löschen (ON DELETE CASCADE),
--     wie es die App Stores und die DSGVO verlangen.
-- =====================================================================

create extension if not exists citext;    -- E-Mail-Adressen ohne Groß-/Kleinschreibung vergleichen
create extension if not exists pgcrypto;  -- sichere Zufallswerte (Einladungscodes)

-- ---------------------------------------------------------------------
-- Nutzer & Anmeldung (Anmeldung per E-Mail-Link, ohne Passwort)
-- ---------------------------------------------------------------------

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          citext not null unique,
  display_name   text not null check (char_length(display_name) between 1 and 40),
  locale         text not null default 'de',
  premium_until  timestamptz,               -- Vorbereitung: werbefreies Premium-Angebot
  created_at     timestamptz not null default now()
);

-- Einmal-Links zum Anmelden. Gespeichert wird nur ein Hash des Tokens.
create table login_tokens (
  token_hash  text primary key,
  email       citext not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index login_tokens_email_idx on login_tokens (email);

-- Angemeldete Sitzungen. Gespeichert wird nur ein Hash des Sitzungs-Tokens.
create table sessions (
  id          text primary key,
  user_id     uuid not null references users (id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

-- ---------------------------------------------------------------------
-- Turniere, Phasen, Teams, Spiele (gemeinsam für alle Tipprunden)
-- ---------------------------------------------------------------------

create table teams (
  id           uuid primary key default gen_random_uuid(),
  game         text not null default 'lol',
  name         text not null,
  short_name   text,
  region       text,
  external_id  text,                         -- Kennung bei einer späteren Datenquelle (API)
  unique (game, name)
);

create table tournaments (
  id           uuid primary key default gen_random_uuid(),
  game         text not null default 'lol',
  name         text not null,
  starts_on    date,
  ends_on      date,
  external_id  text,
  created_at   timestamptz not null default now()
);

create table stages (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references tournaments (id) on delete cascade,
  name           text not null,              -- z. B. "Play-In", "Swiss Runde 1", "Finale"
  position       integer not null default 0,
  unique (tournament_id, name)
);

create table matches (
  id                  uuid primary key default gen_random_uuid(),
  tournament_id       uuid not null references tournaments (id) on delete cascade,
  stage_id            uuid references stages (id) on delete set null,
  team_a_id           uuid references teams (id),
  team_b_id           uuid references teams (id),
  best_of             smallint not null check (best_of in (1, 3, 5)),
  scheduled_at        timestamptz,           -- geplanter Anstoß laut offiziellem Spielplan
  matchday_starts_at  timestamptz,           -- automatisch: Anstoß des ersten Spiels dieses Spieltags
  wins_a              smallint,
  wins_b              smallint,
  status              text not null default 'scheduled'
                        check (status in ('scheduled', 'live', 'finished', 'cancelled')),
  external_id         text,
  updated_at          timestamptz not null default now(),
  check (team_a_id is null or team_b_id is null or team_a_id <> team_b_id),
  check ((wins_a is null) = (wins_b is null)),
  check (wins_a is null or (wins_a >= 0 and wins_b >= 0
         and greatest(wins_a, wins_b) <= (best_of + 1) / 2
         and wins_a <> wins_b))
);
create index matches_tournament_time_idx on matches (tournament_id, scheduled_at);

-- ---------------------------------------------------------------------
-- Tipprunden
-- ---------------------------------------------------------------------

create table leagues (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 60),
  slug           text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),   -- für die Adresse /r/<slug>
  owner_id       uuid references users (id) on delete set null,
  visibility     text not null default 'private' check (visibility in ('private', 'public')),
  invite_code    text not null unique default encode(gen_random_bytes(6), 'hex'),
  points_winner  smallint not null default 1 check (points_winner >= 0),
  points_exact   smallint not null default 1 check (points_exact >= 0),  -- Extra bei exaktem Ergebnis (Bo3/Bo5)
  lock_mode      text not null default 'matchday' check (lock_mode in ('matchday', 'match')),
  created_at     timestamptz not null default now()
);

create table league_members (
  league_id  uuid not null references leagues (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (league_id, user_id)
);
create index league_members_user_idx on league_members (user_id);

-- Welche Turniere eine Tipprunde tippt, inkl. Frist für die Sonderfragen.
create table league_tournaments (
  league_id          uuid not null references leagues (id) on delete cascade,
  tournament_id      uuid not null references tournaments (id) on delete cascade,
  bonus_deadline_at  timestamptz,
  primary key (league_id, tournament_id)
);

-- ---------------------------------------------------------------------
-- Tipps
-- ---------------------------------------------------------------------

create table predictions (
  league_id     uuid not null,
  match_id      uuid not null references matches (id) on delete cascade,
  user_id       uuid not null,
  winner        char(1) not null check (winner in ('A', 'B')),
  winner_wins   smallint,                   -- bei Bo3/Bo5 das getippte Ergebnis, z. B. 3:1
  loser_wins    smallint,
  submitted_at  timestamptz not null default now(),
  primary key (league_id, match_id, user_id),
  foreign key (league_id, user_id) references league_members (league_id, user_id) on delete cascade,
  check ((winner_wins is null) = (loser_wins is null)),
  check (winner_wins is null or (loser_wins >= 0 and loser_wins < winner_wins))
);
create index predictions_match_idx on predictions (match_id);

-- ---------------------------------------------------------------------
-- Sonderfragen
-- ---------------------------------------------------------------------

create table bonus_questions (
  id               uuid primary key default gen_random_uuid(),
  league_id        uuid not null,
  tournament_id    uuid not null,
  position         integer not null default 0,
  question         text not null,
  points           smallint not null check (points >= 0),
  answer_type      text not null check (answer_type in ('text', 'team', 'choice')),
  choices          text[] not null default '{}',   -- zusätzliche Auswahl, z. B. {"Kein Pentakill"}
  hint             text,
  correct_answers  text[] not null default '{}',   -- mehrere richtige Antworten möglich
  created_at       timestamptz not null default now(),
  foreign key (league_id, tournament_id) references league_tournaments (league_id, tournament_id) on delete cascade
);

create table bonus_answers (
  question_id   uuid not null references bonus_questions (id) on delete cascade,
  league_id     uuid not null,
  user_id       uuid not null,
  answer        text not null check (char_length(answer) between 1 and 200),
  submitted_at  timestamptz not null default now(),
  primary key (question_id, user_id),
  foreign key (league_id, user_id) references league_members (league_id, user_id) on delete cascade
);

-- =====================================================================
-- Spieltage: Alle Spiele, deren Anstoß weniger als 6 Stunden auseinander
-- liegt, bilden einen Spieltag. Grund: Die Uhrzeiten späterer Spiele sind
-- nur geschätzt – endet ein Bo5 früher, beginnt das nächste Spiel früher.
-- =====================================================================

create or replace function refresh_matchdays(p_tournament uuid) returns void
language sql as $$
  with ordered as (
    select id, scheduled_at,
           case when scheduled_at - lag(scheduled_at) over (order by scheduled_at, id) < interval '6 hours'
                then 0 else 1 end as new_day
    from matches
    where tournament_id = p_tournament and scheduled_at is not null
  ), grouped as (
    select id, scheduled_at,
           sum(new_day) over (order by scheduled_at, id rows unbounded preceding) as day_no
    from ordered
  ), starts as (
    select id, min(scheduled_at) over (partition by day_no) as day_start
    from grouped
  )
  update matches m
     set matchday_starts_at = s.day_start
    from starts s
   where m.id = s.id
     and m.matchday_starts_at is distinct from s.day_start;

  update matches
     set matchday_starts_at = null
   where tournament_id = p_tournament and scheduled_at is null and matchday_starts_at is not null;
$$;

create or replace function trg_matches_refresh_matchdays() returns trigger
language plpgsql as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform refresh_matchdays(new.tournament_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or old.tournament_id <> new.tournament_id) then
    perform refresh_matchdays(old.tournament_id);
  end if;
  return null;
end $$;

create trigger matches_refresh_matchdays_ins
  after insert on matches
  for each row execute function trg_matches_refresh_matchdays();
create trigger matches_refresh_matchdays_upd
  after update of scheduled_at, tournament_id on matches
  for each row execute function trg_matches_refresh_matchdays();
create trigger matches_refresh_matchdays_del
  after delete on matches
  for each row execute function trg_matches_refresh_matchdays();

create or replace function trg_matches_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger matches_touch
  before update on matches
  for each row execute function trg_matches_touch();

-- =====================================================================
-- Tippschluss: je nach Einstellung der Tipprunde der Beginn des Spieltags
-- ('matchday') oder der Anstoß des einzelnen Spiels ('match').
-- =====================================================================

create or replace function prediction_lock_time(p_league uuid, p_match uuid) returns timestamptz
language sql stable as $$
  select case when l.lock_mode = 'match' then m.scheduled_at
              else coalesce(m.matchday_starts_at, m.scheduled_at) end
    from leagues l, matches m
   where l.id = p_league and m.id = p_match;
$$;

-- Ausnahme für Korrekturen durch Admins / Datenimporte:
--   set local app.bypass_lock = 'on';   (gilt nur innerhalb der Transaktion)
create or replace function lock_bypassed() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.bypass_lock', true), '') = 'on';
$$;

create or replace function trg_predictions_check() returns trigger
language plpgsql as $$
declare
  m matches%rowtype;
  needed smallint;
  lock_at timestamptz;
begin
  select * into m from matches where id = new.match_id;

  if m.team_a_id is null or m.team_b_id is null then
    raise exception 'Für dieses Spiel stehen die Teams noch nicht fest.' using errcode = 'P0001';
  end if;

  -- Ergebnis muss zum Format passen: Bo1 ohne Ergebnis, Bo3 z. B. 2:1, Bo5 z. B. 3:2
  needed := (m.best_of + 1) / 2;
  if m.best_of = 1 then
    if new.winner_wins is not null then
      raise exception 'Bei Bo1 wird nur der Sieger getippt.' using errcode = 'P0001';
    end if;
  elsif new.winner_wins is distinct from needed or new.loser_wins is null or new.loser_wins >= needed then
    raise exception 'Ergebnis passt nicht zu Bo%.', m.best_of using errcode = 'P0001';
  end if;

  if not lock_bypassed() then
    lock_at := prediction_lock_time(new.league_id, new.match_id);
    if lock_at is null then
      raise exception 'Für dieses Spiel steht die Anstoßzeit noch nicht fest.' using errcode = 'P0001';
    end if;
    if now() >= lock_at then
      raise exception 'Tippschluss ist vorbei.' using errcode = 'P0001';
    end if;
    if tg_op = 'UPDATE' and now() >= prediction_lock_time(old.league_id, old.match_id) then
      raise exception 'Tippschluss ist vorbei.' using errcode = 'P0001';
    end if;
  end if;

  new.submitted_at := now();
  return new;
end $$;

create trigger predictions_check
  before insert or update on predictions
  for each row execute function trg_predictions_check();

-- Hinweis: Löschen bleibt immer erlaubt. Ein gelöschter Tipp bringt niemandem
-- einen Vorteil, und Kontolöschungen (App Stores, DSGVO) müssen jederzeit gehen.

create or replace function trg_bonus_answers_check() returns trigger
language plpgsql as $$
declare
  q bonus_questions%rowtype;
  deadline timestamptz;
begin
  select * into q from bonus_questions where id = new.question_id;
  if q.league_id <> new.league_id then
    raise exception 'Die Frage gehört nicht zu dieser Tipprunde.' using errcode = 'P0001';
  end if;
  if not lock_bypassed() then
    select bonus_deadline_at into deadline
      from league_tournaments where league_id = q.league_id and tournament_id = q.tournament_id;
    if deadline is null or now() >= deadline then
      raise exception 'Die Sonderfragen sind geschlossen.' using errcode = 'P0001';
    end if;
  end if;
  new.submitted_at := now();
  return new;
end $$;

create trigger bonus_answers_check
  before insert or update on bonus_answers
  for each row execute function trg_bonus_answers_check();
