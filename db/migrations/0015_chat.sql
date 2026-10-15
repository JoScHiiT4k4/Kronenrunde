-- Chat je Tipprunde. Nachrichten werden nach 7 Tagen automatisch gelöscht.
create table chat_messages (
  id bigserial primary key,
  league_id uuid not null references leagues(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index chat_messages_league on chat_messages (league_id, id);
create index chat_messages_created on chat_messages (created_at);
