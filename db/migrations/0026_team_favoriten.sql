-- Lieblingsteams: Grundlage für die globale Suche und die Team-Seite. Wer ein Team favorisiert,
-- bekommt (bei aktivierten Push-Benachrichtigungen) 1 Stunde vor dessen nächstem Spiel einen Hinweis.

create table team_favorites (
  user_id    uuid not null references users (id) on delete cascade,
  team_id    uuid not null references teams (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, team_id)
);
create index team_favorites_team_idx on team_favorites (team_id);

-- Schon verschickte "Spiel beginnt in 1 Stunde"-Hinweise für Lieblingsteams, je Nutzer und Spiel einmal.
create table favorite_match_notifications (
  user_id  uuid not null references users (id) on delete cascade,
  match_id uuid not null references matches (id) on delete cascade,
  sent_at  timestamptz not null default now(),
  primary key (user_id, match_id)
);
