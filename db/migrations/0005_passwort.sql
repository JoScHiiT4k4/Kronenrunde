-- Anmeldung mit E-Mail und Passwort. Gespeichert wird nur ein Hash (scrypt), nie das Passwort selbst.
-- Bestehende Konten haben noch kein Passwort; sie legen es beim nächsten Anmelden über einen Mail-Link fest.

alter table users add column password_hash text;
alter table users add column password_changed_at timestamptz;

-- Fehlversuche beim Anmelden (gegen Durchprobieren von Passwörtern)
create table login_failures (
  email       citext not null,
  created_at  timestamptz not null default now()
);
create index login_failures_email_idx on login_failures (email, created_at);
