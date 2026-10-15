-- E-Mail-Adresse ändern: Die neue Adresse wird erst nach Klick auf den Link in der Bestätigungs-Mail übernommen.
create table email_changes (
  token_hash  text primary key,
  user_id     uuid not null references users (id) on delete cascade,
  new_email   citext not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index email_changes_user_idx on email_changes (user_id);
