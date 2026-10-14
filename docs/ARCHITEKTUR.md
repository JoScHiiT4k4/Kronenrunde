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
| Web-Server | Node.js 22 ohne Zusatzpakete; Seiten werden auf dem Server gebaut, JavaScript im Browser ist nur Komfort | Läuft auf dem Raspberry Pi ohne Bauschritt, wenig Angriffsfläche, nichts muss aktualisiert werden. Funktioniert auch ohne JavaScript |
| Datenbank-Anschluss | Eigener schlanker PostgreSQL-Anschluss (`src/server/db/pg.ts`) mit TLS und SCRAM-Anmeldung, hinter einer kleinen Schnittstelle (`db/index.ts`) | Bei der Entwicklung waren keine Zusatzpakete ladbar. Austauschbar gegen das verbreitete Paket `pg`, indem nur `pg.ts` ersetzt wird |
| Sicherheit | Anmelde-Links und Sitzungen nur als Hash gespeichert; Formular-Schutz (CSRF) mit Token und Herkunfts-Prüfung; strenge Content-Security-Policy; alle Ausgaben maskiert | Übliche Angriffe (fremde Formulare, eingeschleuster Code, gestohlene Datenbank) laufen ins Leere |
| Datenquelle | Spielplan/Ergebnisse im Admin-Bereich von Hand; dieselben Tabellen kann später ein Daten-Dienst (API) füllen | Erst manuell, später automatisch – ohne Umbau |
| Hosting | Eigener Server (Raspberry Pi 4 / Debian-PC) **oder** ein Cloud-Anbieter, der Node.js-Server betreibt, plus PostgreSQL (z. B. Supabase) | Gleicher Code; Wechsel = andere Einstellungen. Auswahl in Baustein 3 |
| E-Mail | Austauschbar über `MAIL_MODE`: Brevo (kostenlos, eigene Domain nicht nötig) oder Resend | Auswahl in Baustein 3 |
| Geld verdienen | Vorbereitet: Werbeflächen, Cookie-Banner (zertifiziert, IAB TCF), Premium (`users.premium_until`) | Später ohne Umbau einschaltbar |

## Hinweise für später

- **Werbung**: Die Content-Security-Policy in `src/server/http.ts` erlaubt nur eigene Dateien. Für Werbung (z. B. Google AdSense) muss sie gezielt erweitert werden.
- **Werbung in der EU**: Für personalisierte Anzeigen verlangt Google ein zertifiziertes Cookie-Banner (IAB TCF).
- **Öffentlich**: Vor Stufe 2 Impressum und Datenschutzerklärung ergänzen.
- **Supabase Free** pausiert Projekte nach 7 Tagen ohne Nutzung (mit einem Klick wieder aktiv).
- **Raspberry Pi**: 64-Bit-Betriebssystem; Datenbank besser auf USB-SSD statt SD-Karte; Sicherungskopien einrichten.
- **Öffentlich erreichbar machen und Sicherheit** (eigener Server): HTTPS über einen vorgeschalteten Proxy (z. B. Caddy oder Cloudflare Tunnel), dann `TRUST_PROXY=1`.
- **Mehrere Server-Instanzen**: Die Begrenzung für Anmelde-Links pro Internet-Adresse zählt pro Instanz im Speicher; die Begrenzung pro E-Mail-Adresse steht in der Datenbank und gilt überall.

## Aufbau des Projekts

```
db/migrations/      Datenbank-Aufbau (wird beim Start automatisch eingespielt)
db/tests/           Tests für die Datenbank-Regeln
db/seed/            Beispieldaten (Worlds 2026)
src/domain/         Punkte, Tippschluss, Ergebnisse, Sonderfragen, Rangliste
src/server/         Web-Server
  main.ts           Start
  app.ts            Anfragen → Anmeldung prüfen → Seite
  auth.ts           E-Mail-Link, Sitzungen, Formular-Schutz
  routes/           Seiten (Tipprunden/Tippen, Verwalten, Admin, Anmeldung)
  views/layout.ts   Seitenrahmen
  db/               PostgreSQL-Anschluss, Migrationen
  cli.ts            Hilfsbefehle (migrate, seed, login-link)
public/             CSS, JavaScript, App-Symbole
scripts/            Test-Skripte
```
