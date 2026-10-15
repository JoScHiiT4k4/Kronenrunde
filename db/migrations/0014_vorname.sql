-- Vorname (für das Profil); bei älteren Konten leer, bis er im Konto nachgetragen wird.
alter table users add column first_name text check (first_name is null or char_length(first_name) between 1 and 40);
