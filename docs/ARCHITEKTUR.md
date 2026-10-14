# Architektur und Entscheidungen

Kurzfassung der Grundsatzentscheidungen. Ziel: Erst eine private Tipprunde, später öffentlich,
zuletzt als App im Play Store / App Store – **ohne Neubau** zwischen den Stufen.

## Stufen

1. **Private Runde** als Web-App (Handy und PC, auf den Startbildschirm legbar).
2. **Öffentlich**: jeder kann eigene Tipprunden anlegen; Werbung und Premium möglich.
3. **App Stores**: derselbe Code wird als App verpackt (keine zweite App).

## Grundsätze

| Thema | Entscheidung | Warum |
|---|---|---|
| Tipprunden | Mehrere Tipprunden von Anfang an (`leagues`) | Öffentlich legt jeder seine eigene an – ohne Umbau |
| Turniere | Beliebige Turniere/Spiele (`tournaments`, `game`) | Nicht nur Worlds: MSI, LEC, später andere Spiele |
| Anmeldung | E-Mail-Link ohne Passwort, Logik in der App selbst | An keinen Anbieter gebunden; Konto jederzeit löschbar (App Stores, DSGVO) |
| Datenbank | Standard-PostgreSQL, keine Anbieter-Sonderfunktionen | Läuft gleich auf Supabase (Cloud) und auf eigenem Server |
| Fairness | Tippschluss wird **in der Datenbank** erzwungen | Selbst ein Fehler in der App kann keinen späten Tipp durchlassen |
| Tippschluss | Standard: Beginn des ersten Spiels eines Spieltags (Spiele < 6 h Abstand = ein Spieltag); pro Tipprunde umstellbar auf „jedes Spiel einzeln“ | Uhrzeiten späterer Spiele sind nur geschätzt |
| Punkte-Logik | Reines TypeScript ohne Abhängigkeiten (`src/domain`) | Leicht zu testen, überall gleich |
| Datenquelle | Spielplan/Ergebnisse über eine eigene Zwischenschicht | Erst manuell, später ein Daten-Dienst (API) – ohne Umbau |
| Hosting | Cloud (Vercel + Supabase) **oder** eigener Server (Raspberry Pi 4 / Debian-PC mit Docker) | Gleicher Code; Wechsel = andere Einstellungen |
| Geld verdienen | Vorbereitet: Werbeflächen, Cookie-Banner (zertifiziert, IAB TCF), Premium (`users.premium_until`) | Später ohne Umbau einschaltbar |

## Hinweise für später

- **Vercel Hobby** ist nur für nicht-kommerzielle Nutzung erlaubt. Sobald Werbung läuft: Pro-Tarif oder anderer Anbieter.
- **Supabase Free** pausiert Projekte nach 7 Tagen ohne Nutzung (mit einem Klick wieder aktiv).
- **Raspberry Pi**: 64-Bit-Betriebssystem; Datenbank besser auf USB-SSD statt SD-Karte; Sicherungskopien einrichten.
- **Öffentlich erreichbar machen und Sicherheit** (eigener Server): eigenes Thema vor Stufe 2.
- **Werbung in der EU**: Für personalisierte Anzeigen verlangt Google ein zertifiziertes Cookie-Banner (IAB TCF).

## Aufbau des Projekts

```
db/migrations/   Datenbank-Aufbau (in Reihenfolge ausführen)
db/tests/        Tests für die Datenbank-Regeln
db/seed/         Beispieldaten (Worlds 2026)
src/domain/      Punkte, Tippschluss, Ergebnisse, Sonderfragen, Rangliste
scripts/         Hilfsskripte (z. B. Datenbank-Tests)
```
