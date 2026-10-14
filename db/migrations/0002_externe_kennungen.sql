-- Kennungen für eingespielte Daten (Datei in db/daten oder später eine Datenquelle/API):
-- Ist eine Kennung gesetzt, darf es sie nur einmal geben. So legt ein zweiter Import
-- nichts doppelt an, sondern aktualisiert die vorhandenen Einträge.

create unique index tournaments_external_id_key on tournaments (game, external_id) where external_id is not null;
create unique index teams_external_id_key on teams (game, external_id) where external_id is not null;
create unique index matches_external_id_key on matches (tournament_id, external_id) where external_id is not null;
