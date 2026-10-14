-- Auswahllisten für Sonderfragen: Champions (aus Riots Data Dragon) und Spieler der Turnier-Teams
-- (Kader von lolesports.com). Beides holt die App regelmäßig selbst (src/server/abgleich.ts).

create table champions (
  id          text primary key,              -- Kennung bei Riot, z. B. "MonkeyKing"
  name        text not null,                 -- deutscher Name, z. B. "Wukong"
  updated_at  timestamptz not null default now()
);

create table players (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references teams (id) on delete cascade,
  name         text not null,                -- Spielername, z. B. "Faker"
  role         text,                         -- top, jungle, mid, bottom, support
  external_id  text,                         -- Kennung bei lolesports.com
  active       boolean not null default true,  -- false = nicht mehr im Kader
  updated_at   timestamptz not null default now()
);
create unique index players_external_id_key on players (external_id) where external_id is not null;
create index players_team_idx on players (team_id);

-- Wann zuletzt erfolgreich abgeglichen wurde (für den Admin-Bereich)
create table sync_status (
  name        text primary key,              -- 'champions', 'spieler'
  ok_at       timestamptz,
  details     text,
  error       text,
  updated_at  timestamptz not null default now()
);

alter table bonus_questions drop constraint bonus_questions_answer_type_check;
alter table bonus_questions add constraint bonus_questions_answer_type_check
  check (answer_type in ('text', 'team', 'choice', 'champion', 'player'));

-- Die typischen Fragen (Vorlage im Verwalten-Bereich) bekommen die passende Auswahl statt Freitext
update bonus_questions set answer_type = 'champion', hint = null
 where answer_type = 'text' and question = 'Welcher Champion wird am häufigsten gebannt?';
update bonus_questions set answer_type = 'player', hint = null
 where answer_type = 'text' and question = 'Wer wird Finals-MVP?';
update bonus_questions set answer_type = 'player', hint = null,
       choices = case when 'Kein Pentakill' = any(choices) then choices else array_append(choices, 'Kein Pentakill') end
 where answer_type = 'text' and question = 'Welcher Spieler holt den ersten Pentakill?';
