-- Online-Anzeige: wann ein Nutzer zuletzt eine Seite angemeldet aufgerufen hat.
alter table users add column last_seen_at timestamptz;
