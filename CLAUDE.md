# Hinweise für dieses Projekt

- Alles muss am PC-Browser **und** am Handy passen und zusammen aussehen.
- Reiter (Tabs) unterscheiden: Am PC stehen sie in einer Zeile; am Handy müssen sie umbrechen bzw. gut erreichbar bleiben, nichts darf abgeschnitten werden oder Inhalt verdecken. Bei neuen Reitern beide Größen bedenken.
- Nutzer wollen kurze Rückmeldungen (Checkliste + PR-Link), Texte auf Deutsch.
- Die Versionsnummer setzt sich von selbst zusammen (Haupt.Neben aus `package.json` + Anzahl der Commits). **Nicht** pro PR in `package.json` hochzählen – das verursacht nur Merge-Konflikte. Haupt/Neben ändert nur der Betreiber auf Wunsch.
- Datumsfilter (Von/Bis): In den Tipprunden ist das früheste wählbare Datum der Tag des ersten Spiels des gesamten Turniers, das späteste der Tag des Finales (gilt auch für künftige Turniere). Im Administrator-Bereich gilt stattdessen: frühestens der Tag der Inbetriebnahme der Seite, spätestens heute.
- Die Rangliste rechts fehlt auf den Reitern Rangliste, Turnierbaum, Verwalten und im Administrator-Bereich; sie lässt sich ein- und ausklappen (Standard ausgeklappt).
- Pull Requests darf Claude nach erfolgreichen Tests (CI grün) selbst mergen (Erlaubnis des Betreibers); der Betreiber muss nicht mehr mergen. Bei Konflikten selbst auflösen, nie mit roter CI mergen.
