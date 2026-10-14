# LoL-Tippspiel

Tippspiel-Web-App für League-of-Legends-Turniere – erst für die private Runde, später öffentlich und als App.

## Stand

| Baustein | Status |
|---|---|
| 1. Fundament: Datenbank-Aufbau, Punkte-Logik, Tests | ✅ fertig |
| 2. Bedienoberfläche & Anmeldung | ⏳ als Nächstes |
| 3. Online stellen (Cloud oder Raspberry Pi) | offen |

Was die App fachlich kann (wie das bisherige Google-Sheets-Tippspiel):

- Sieger und Ergebnis tippen (Bo1: nur Sieger, Bo3/Bo5 z. B. 2:1 oder 3:1)
- Punkte: richtiger Sieger + Extrapunkte für exaktes Ergebnis (pro Tipprunde einstellbar)
- Tippschluss pro Spieltag oder pro Spiel; danach sind alle Tipps sichtbar
- Sonderfragen mit Frist, mehrere richtige Antworten, Schreibweise egal
- Rangliste mit Gleichstand-Regel

Entscheidungen und Plan: siehe [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).

## Tests

Bei jeder Änderung laufen auf GitHub automatisch alle Tests (Reiter **Actions**).

Lokal (Node.js 22 nötig):

```bash
npm test                     # Punkte-Logik
TEST_DATABASE_URL=postgres://… npm run test:db   # Datenbank (nur mit LEERER Test-Datenbank)
```
