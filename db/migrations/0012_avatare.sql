-- Profilbild: kleines JPEG (128x128, im Browser verkleinert), als Base64-Text gespeichert.
alter table users
  add column avatar_b64 text check (avatar_b64 is null or char_length(avatar_b64) <= 80000),
  add column avatar_updated_at timestamptz;
