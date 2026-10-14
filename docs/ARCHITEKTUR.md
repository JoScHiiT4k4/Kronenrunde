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
| Hosting | **Raspberry Pi 4 zu Hause** (Raspberry Pi OS 64-bit), öffentlich über **Tailscale Funnel** (`https://lol-tippspiel.….ts.net`). Einrichtung per `deploy/install.sh` | Kostenlos, keine offenen Ports am Router, HTTPS automatisch. Dasselbe Skript läuft auf jedem Debian/Ubuntu (z. B. gemieteter Server) – Umzug = installieren + Sicherung einspielen |
| Betrieb | systemd-Dienst mit Schutz-Einstellungen, App lauscht nur auf 127.0.0.1; nächtliche Sicherung (14 Stück); automatische Sicherheits-Updates; `tippspiel update` sichert vorher und geht bei Startproblemen automatisch zurück | Wenig Pflege, nichts Wichtiges geht verloren |
| E-Mail | Ohne eigene Domain: **Gmail per SMTP** mit App-Passwort (`MAIL_MODE=smtp`, bis 500 Empfänger/Tag). Mit eigener Domain später: Brevo oder Resend | Brevo schreibt Gmail-Absender auf `@brevosend.com` um, das landet eher im Spam. Eigener SMTP-Client ohne Zusatzpakete (`src/server/smtp.ts`), Passwort nur verschlüsselt |
| Geld verdienen | Vorbereitet: Werbeflächen, Cookie-Banner (zertifiziert, IAB TCF), Premium (`users.premium_until`) | Später ohne Umbau einschaltbar |

## Hinweise für später

- **Riot-Regeln** ([Legal Jibber Jabber](https://www.riotgames.com/de/rechtliches), [Developer Policies](https://developer.riotgames.com/policies/general)), Stand Okt. 2026 – keine Rechtsberatung:
  - Gut sichtbarer Hinweis, dass Riot das Projekt nicht unterstützt (steht in der Fußzeile).
  - Keine Riot-Logos, -Marken, -Schriften oder Spielgrafiken; das Design nutzt nur eigene Formen und freie Schriften.
  - **Domain und App-Name**: „League of Legends“ ist als Marke eingetragen (u. a. EU Nr. 008243487), „LoL“ allein
    offenbar nicht (nur „LOL ESPORTS“ in den USA angemeldet) – gilt aber als Abkürzung der Marke. Riot verbietet
    seine Marken in Fan-Domains. Für Stufe 2 daher am sichersten ein neutraler Name ohne LoL/League; vorher prüfen (TMview).
  - Werbung („passiv“) ist erlaubt, Paywalls/Crowdfunding nur mit Lizenz; keine Wetten oder Geldeinsätze.
  - App Store / Play Store nur mit Lizenz oder registriertem API-Key – vor Stufe 3 bei Riot anfragen.
- **Datenquelle lolesports.com**: Die Seite nutzt eine inoffizielle, nicht dokumentierte Schnittstelle
  (`scripts/lolesports.mjs`, Abgleich über Actions → „Spielplan von lolesports.com“). Für die private Runde
  praktisch, für die öffentliche Version nicht verlässlich genug (kann sich jederzeit ändern, nicht von Riot freigegeben).
  Alternativen: Leaguepedia (Lizenz CC BY-SA) oder ein lizenzierter Datenanbieter.
- **Werbung**: Die Content-Security-Policy in `src/server/http.ts` erlaubt nur eigene Dateien. Für Werbung (z. B. Google AdSense) muss sie gezielt erweitert werden.
- **Werbung in der EU**: Für personalisierte Anzeigen verlangt Google ein zertifiziertes Cookie-Banner (IAB TCF).
- **Öffentlich**: Vor Stufe 2 Impressum und Datenschutzerklärung ergänzen.
- **Supabase Free** pausiert Projekte nach 7 Tagen ohne Nutzung (mit einem Klick wieder aktiv).
- **Raspberry Pi**: 64-Bit-Betriebssystem (prüft das Skript); Datenbank besser auf USB-SSD statt SD-Karte.
- **Öffentlich erreichbar**: Tailscale Funnel ist (Stand Okt. 2026) noch Beta und hat nicht näher genannte Bandbreiten-Grenzen; eigene Domains gehen damit nicht. Für Stufe 2 mit eigener Domain: Cloudflare Tunnel (Domain bei Cloudflare) – die App bleibt gleich, nur `APP_URL` ändert sich.
- **Proxy**: Mit `TRUST_PROXY=1` zählt der **letzte** Eintrag in `X-Forwarded-For` (den trägt der Proxy ein; Tailscale ersetzt den Kopf ganz).
- **Werbung braucht eine eigene Domain** (eine `ts.net`-Adresse gehört Tailscale) – vor dem Einschalten von Werbung also umziehen.
- **Sicherungen** liegen auf derselben SD-Karte wie die Datenbank. Sobald echte Daten drin sind: regelmäßig eine Kopie auf ein anderes Gerät.
- **Mehrere Server-Instanzen**: Die Begrenzung für Anmelde-Links pro Internet-Adresse zählt pro Instanz im Speicher; die Begrenzung pro E-Mail-Adresse steht in der Datenbank und gilt überall.

## Aufbau des Projekts

```
db/migrations/      Datenbank-Aufbau (wird beim Start automatisch eingespielt)
db/tests/           Tests für die Datenbank-Regeln
db/seed/            Beispieldaten (Worlds 2026)
src/domain/         Punkte, Tippschluss, Ergebnisse, Sonderfragen, Rangliste
deploy/             install.sh (Einrichtung/Update auf Debian/Raspberry Pi OS), tippspiel (Verwaltungsbefehl), ANLEITUNG.md
src/server/         Web-Server
  main.ts           Start
  app.ts            Anfragen → Anmeldung prüfen → Seite
  auth.ts           E-Mail-Link, Sitzungen, Formular-Schutz
  routes/           Seiten (Tipprunden/Tippen, Verwalten, Admin, Anmeldung)
  views/layout.ts   Seitenrahmen
  db/               PostgreSQL-Anschluss, Migrationen
  mail.ts, smtp.ts  E-Mail-Versand (Gmail/SMTP, Brevo, Resend)
  cli.ts            Hilfsbefehle (migrate, seed, login-link, mail-test)
public/             CSS, JavaScript, App-Symbole
scripts/            Test-Skripte
```
