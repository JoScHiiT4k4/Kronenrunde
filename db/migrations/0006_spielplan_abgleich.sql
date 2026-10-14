-- Automatischer Abgleich von Spielplan und Ergebnissen mit lolesports.com
--   tournaments.source:  woher das Turnier abgeglichen wird, z. B. 'lolesports:worlds'
--   matches.source_id:   Kennung des Spiels dort (wird beim ersten Abgleich über die Anstoßzeit verknüpft)

alter table tournaments add column source text;
alter table matches add column source_id text;
create unique index matches_source_id_key on matches (tournament_id, source_id) where source_id is not null;
