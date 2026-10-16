-- Spoilerschutz bei Ergebnissen: Standard an, jeder Teilnehmer kann ihn unter „Dein Konto“ abschalten.
alter table notification_prefs add column spoiler_protection boolean not null default true;
