# Hinweise für dieses Projekt

- Alles muss am PC-Browser **und** am Handy passen und zusammen aussehen.
- Reiter (Tabs) unterscheiden: Am PC stehen sie in einer Zeile; am Handy müssen sie umbrechen bzw. gut erreichbar bleiben, nichts darf abgeschnitten werden oder Inhalt verdecken. Bei neuen Reitern beide Größen bedenken.
- Nutzer wollen kurze Rückmeldungen (Checkliste + PR-Link), Texte auf Deutsch.
- Die Versionsnummer setzt sich von selbst zusammen (Haupt.Neben aus `package.json` + Anzahl der Commits). **Nicht** pro PR in `package.json` hochzählen – das verursacht nur Merge-Konflikte. Haupt/Neben ändert nur der Betreiber auf Wunsch.
- Datumsfilter (Von/Bis): In den Tipprunden ist das früheste wählbare Datum der Tag des ersten Spiels des gesamten Turniers, das späteste der Tag des Finales (gilt auch für künftige Turniere). Im Administrator-Bereich gilt stattdessen: frühestens der Tag der Inbetriebnahme der Seite, spätestens heute.
- Die Rangliste rechts fehlt auf den Reitern Rangliste, Turnierbaum, Verwalten und im Administrator-Bereich; sie lässt sich ein- und ausklappen (Standard ausgeklappt).
- Keine persönlichen Daten in Code, Doku, Commits oder PR-Texten: keine echten E-Mail-Adressen, Namen, IP-Adressen oder Hostnamen des Betreibers oder der Mitspieler. Beispiele mit `example.de`, `deinname`, `192.168.1.50`; Betreiber-Adressen kommen nur aus `.env` (`ADMIN_EMAILS`).
- Der Code ist urheberrechtlich geschützt, alle Rechte vorbehalten (`LICENSE`), keine Open-Source-Lizenz. Fremden Code nur übernehmen, wenn seine Lizenz das erlaubt, und die Lizenz dann mitliefern (wie bei den Schriften in `docs/LIZENZ-*.txt`).
- Pull Requests darf Claude nach erfolgreichen Tests (CI grün) selbst mergen (Erlaubnis des Betreibers); der Betreiber muss nicht mehr mergen. Bei Konflikten selbst auflösen, nie mit roter CI mergen.
