-- Zwei-Faktor-Authentifizierung (TOTP, RFC 6238), freiwillig zuschaltbar unter "Dein Konto".
-- totp_secret ist erst aktiv, wenn totp_enabled_at gesetzt ist (Einrichtung erst per Code bestätigt).

alter table users add column totp_secret text;
alter table users add column totp_enabled_at timestamptz;

-- Einmal-Codes für den Fall, dass die Authenticator-App nicht verfügbar ist. Gespeichert wird nur ein Hash.
create table totp_backup_codes (
  user_id     uuid not null references users (id) on delete cascade,
  code_hash   text not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  primary key (user_id, code_hash)
);

-- Kurzlebiger Zwischenschritt zwischen richtigem Passwort und bestätigtem Code: die Sitzung
-- startet erst, wenn auch der zweite Faktor stimmt. Gespeichert wird nur ein Hash des Tokens.
create table totp_pending_logins (
  token_hash  text primary key,
  user_id     uuid not null references users (id) on delete cascade,
  next        text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
