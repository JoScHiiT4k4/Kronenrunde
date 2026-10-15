-- Das Testspiel ist als solches markiert: dort sieht der Betreiber nur die Teilnehmer-Ansicht.
alter table leagues add column is_test boolean not null default false;
update leagues set is_test = true where slug = 'testspiel';
