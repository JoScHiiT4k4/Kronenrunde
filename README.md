# LoL-Tippspiel

Tippspiel-Web-App für League-of-Legends-Turniere – erst für die private Runde, später öffentlich und als App.

## Stand

| Baustein | Status |
|---|---|
| 1. Fundament: Datenbank-Aufbau, Punkte-Logik, Tests | ✅ fertig |
| 2. Bedienoberfläche & Anmeldung | ✅ fertig |
| 3. Online stellen: Raspberry Pi + Tailscale Funnel, Anmelde-Mails über Gmail | ✅ fertig – einrichten mit [deploy/ANLEITUNG.md](deploy/ANLEITUNG.md) |
| 4. Öffentlich: eigene Domain, Impressum/Datenschutz, Werbung | offen |

Was die App kann:

- **Anmelden mit E-Mail und Passwort**; „Passwort vergessen“ schickt einen Link per Mail. Beim Konto-Erstellen wählt man seinen Namen für die Rangliste.
- **Tipprunden** anlegen und per Einladungslink beitreten; mehrere Tipprunden pro Person.
- **Tippen**: Sieger und Ergebnis (Bo1 nur Sieger, Bo3/Bo5 z. B. 2:1 oder 3:1), nach Spieltagen sortiert.
  Team A steht links auf der blauen Seite, Team B rechts auf der roten.
- **Tippschluss** pro Spieltag (Standard) oder pro Spiel – von der Datenbank erzwungen. Ab Tippschluss sieht jeder die Tipps der anderen.
- **Rangliste**: richtiger Sieger + Extrapunkte für exaktes Ergebnis; Gleichstand wird über exakte Ergebnisse entschieden.
- **Sonderfragen** mit Frist (Team-Auswahl, eigene Liste oder Freitext); Schreibweise egal, mehrere richtige Antworten möglich.
  Die typischen Fragen (Weltmeister, Finals-MVP, meistgebannter Champion, …) lassen sich mit einem Klick einfügen.
- **Verwalten** (Leitung der Tipprunde): Einladungslink, Punkte, Tippschluss, Turniere, Sonderfragen, Mitglieder.
- **Admin** (Adressen aus `ADMIN_EMAILS`): Teams, Turniere, Spiele und Ergebnisse eintragen.
- **Turnierdaten einspielen** statt abtippen: `tippspiel daten worlds-2026` (Dateien in `db/daten/`, mehrfach ausführbar).
- **Automatischer Abgleich mit Riot**: Paarungen, Ergebnisse und Anstoßzeiten alle 10 Minuten (lolesports.com), Champion-Liste und Spielerkader alle 6 Stunden – Stand im Admin-Bereich, `tippspiel abgleich` von Hand.
- **Auto-Update** auf dem Pi alle 15 Minuten, nur auf GitHub geprüfte Versionen (Zweig `stabil`).
- **Konto löschen** jederzeit, mit allen Daten.
- Läuft auf Handy und PC und lässt sich auf den Startbildschirm legen; dunkles Design mit Gold, blauer und roter Seite (eigene Formen, freie Schriften Cinzel und Barlow, keine Riot-Grafiken).

Entscheidungen und Plan: siehe [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).

## Auf dem Raspberry Pi betreiben

Schritt für Schritt: **[deploy/ANLEITUNG.md](deploy/ANLEITUNG.md)**. Kurz: `sudo bash deploy/install.sh` richtet alles ein
(Node.js, PostgreSQL, Dienst, nächtliche Sicherung, Tailscale Funnel für `https://….ts.net`).
Danach gibt es den Befehl `tippspiel` (`tippspiel hilfe`), z. B. `tippspiel update` für neue Versionen.

## Zum Ausprobieren starten (PC oder Laptop)

Nötig: **Node.js 22** (oder neuer) und **PostgreSQL 15** (oder neuer). Zusatzpakete braucht die App keine.

```bash
git clone https://github.com/JoScHiiT4k4/LoL-Tippspiel.git
cd lol-tippspiel
cp .env.example .env        # dann .env öffnen: DATABASE_URL und ADMIN_EMAILS eintragen
npm run db:seed             # optional: Beispieldaten Worlds 2026 (nur einmal ausführen)
npm start                   # App läuft dann auf http://localhost:3000
```

Solange `MAIL_MODE=console` eingestellt ist, wird keine E-Mail verschickt: Links zum Passwort-Festlegen erscheinen im Fenster, in dem `npm start` läuft.
Einen Link kann man sich auch direkt erzeugen lassen:

```bash
npm run login-link -- deine@mail.de
```

Für echte Mails über Gmail: `MAIL_MODE=smtp`, `SMTP_USER` = Gmail-Adresse, `SMTP_PASSWORD` = App-Passwort
(siehe `.env.example`). Prüfen mit `npm run mail-test -- deine@mail.de`.

Die Datenbank wird beim Start automatisch auf den neuesten Stand gebracht (`npm run db:migrate` geht auch von Hand).

## Tests

Bei jeder Änderung laufen auf GitHub automatisch alle Tests (Reiter **Actions**).

Lokal:

```bash
npm test                                             # Logik und Server-Bausteine
TEST_DATABASE_URL=postgres://… npm run test:db       # Datenbank-Regeln   (nur mit LEERER Test-Datenbank)
TEST_DATABASE_URL=postgres://… npm run test:app      # ganze App im Ablauf (nur mit LEERER Test-Datenbank)
```

## Aufbau

```
deploy/           Installation auf dem Raspberry Pi (install.sh), Verwaltungsbefehl "tippspiel", Anleitung
src/domain/       Punkte, Tippschluss, Ergebnisse, Sonderfragen, Rangliste (reine Logik)
src/server/       Web-Server: Anmeldung, Seiten, Datenbank-Anschluss
  routes/         Seiten: Tipprunden & Tippen, Verwalten, Admin, Anmeldung
  db/             PostgreSQL-Anschluss und Migrationen
public/           Gestaltung (CSS), kleines JavaScript, App-Symbole
db/migrations/    Datenbank-Aufbau
db/seed/          Beispieldaten
```
