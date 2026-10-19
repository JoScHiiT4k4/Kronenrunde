-- Passkeys (WebAuthn): Anmelden ohne Passwort und ohne Code aus der Authenticator-App.
-- Gespeichert wird nur der öffentliche Schlüssel; der geheime bleibt auf dem Gerät bzw. im Passwort-Manager.

create table passkeys (
  credential_id text primary key,                 -- base64url, vom Gerät vergeben
  user_id       uuid not null references users (id) on delete cascade,
  public_key    text not null,                    -- SPKI (DER), base64url
  alg           integer not null,                 -- COSE-Verfahren: -7 ES256, -8 EdDSA, -257 RS256
  sign_count    bigint not null default 0,
  name          text not null check (char_length(name) between 1 and 60),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user on passkeys (user_id);

-- Einmalige Challenges (5 Minuten gültig). user_id ist beim Anmelden noch unbekannt (null).
create table passkey_challenges (
  challenge   text primary key,                   -- base64url, 32 Zufallsbytes
  user_id     uuid references users (id) on delete cascade,
  purpose     text not null check (purpose in ('register', 'login')),
  next        text,
  expires_at  timestamptz not null
);
