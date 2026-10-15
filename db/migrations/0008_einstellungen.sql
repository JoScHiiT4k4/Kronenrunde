-- Einstellungen der App, die der Admin im Admin-Bereich ändert
create table app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Wer neue Tipprunden anlegen darf: 'admins' = nur Admins (Standard, für den Freundeskreis),
-- 'alle' = jeder mit Konto. Beitreten per Einladungslink geht immer.
insert into app_settings (key, value) values ('league_creation', 'admins');
