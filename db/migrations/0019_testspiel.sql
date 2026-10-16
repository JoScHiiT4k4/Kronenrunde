-- Früher: legte einmalig die Tipprunde „Testspiel“ für eine fest eingetragene Betreiber-Adresse an.
-- Auf dem laufenden Server ist das längst erledigt. Das Testspiel legt inzwischen die App selbst an
-- (src/server/testspiel.ts), deshalb tut diese Migration nichts mehr. Die Datei bleibt, weil Migrationen
-- über ihren Namen nachverfolgt werden; eine persönliche E-Mail-Adresse gehört nicht in den Code.
select 1;
