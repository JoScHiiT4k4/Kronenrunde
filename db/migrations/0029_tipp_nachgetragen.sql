-- Vom Administrator nachgetragene Tipps (z. B. bei technischen Problemen, auch nach Tippschluss):
-- wer den Tipp eingetragen hat. Bei eigenen Tipps bleibt die Spalte leer.
alter table predictions add column entered_by uuid references users (id) on delete set null;
