# Kronenrunde auf dem Raspberry Pi einrichten

Dauer: etwa 45 Minuten, davon viel Warten. Du brauchst den Raspberry Pi 4 mit Netzteil,
eine microSD-Karte (ab 16 GB), deinen PC und dein Handy.

Am Ende läuft die App bei dir zu Hause und ist im Internet unter einer Adresse wie
`https://kronenrunde.tail1234.ts.net` erreichbar. Kosten: keine.

---

## 1. Raspberry Pi vorbereiten

Überspringen, wenn auf deinem Pi schon **Raspberry Pi OS (64-bit)** läuft und du dich per SSH verbinden kannst.

> **Homebridge schon auf dem Pi?** Nicht neu aufspielen, die App läuft daneben (Homebridge hat sein eigenes Node.js und Port 8581, die App Port 3000).
> Vorher in der Homebridge-Oberfläche eine Sicherung herunterladen. Dann per SSH anmelden (`ssh deinname@homebridge.local`) und prüfen:
>
> ```
> grep PRETTY /etc/os-release; dpkg --print-architecture
> ```
>
> Passt, wenn dort **Debian 12** (bookworm) oder neuer und **arm64** steht. Dann weiter mit Schritt 2.
>
> Nutzt du Tailscale schon für Homebridge, bleibt das unverändert. Die App bekommt dann eine Adresse mit `:8443` am Ende.

1. Am PC **Raspberry Pi Imager** installieren: <https://www.raspberrypi.com/software/> → *Download for Windows*.
2. SD-Karte in den PC stecken, Imager öffnen und durchklicken:
   - **Gerät:** Raspberry Pi 4
   - **Betriebssystem:** *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**
   - **Speicher:** deine SD-Karte
   - **Einstellungen:**
     - Hostname: `tippspiel`
     - Benutzername und Passwort: selbst wählen und **merken**
     - WLAN: Name und Passwort deines WLANs (oder später ein LAN-Kabel einstecken)
     - Fernzugriff / SSH: **einschalten**, mit Passwort
   - **Schreiben** und warten, bis der Imager fertig ist.
3. Karte in den Pi, Strom anschließen, **3 Minuten** warten.
4. Am PC: Windows-Taste drücken, `PowerShell` tippen, Enter. Dort eingeben (statt `deinname` dein Benutzername aus Schritt 2):

   ```
   ssh deinname@tippspiel.local
   ```

   Bei der Frage `Are you sure…` → `yes` eingeben, dann dein Pi-Passwort (man sieht beim Tippen nichts, das ist normal).

Ab jetzt tippst du alle Befehle in dieses Fenster. **Einfügen** geht dort mit **Rechtsklick**.

> Kommt `Could not resolve hostname`: In deinem Router (z. B. fritz.box → *Heimnetz*) die Adresse des Geräts „tippspiel“ nachsehen und `ssh deinname@192.168.…` verwenden.

---

## 2. Code holen (GitHub)

Das Repository ist öffentlich, der Pi braucht dafür keinen Schlüssel. Auf dem Pi:

```
sudo apt-get install -y git
git clone https://github.com/JoScHiiT4k4/kronenrunde.git ~/kronenrunde
```

> Nur falls das Repository wieder privat wird: auf dem Pi mit `ssh-keygen -t ed25519 -N "" -f ~/.ssh/kronenrunde`
> einen Schlüssel erzeugen, den Inhalt von `~/.ssh/kronenrunde.pub` auf GitHub unter
> *Settings → Deploy keys → Add deploy key* eintragen (ohne Schreibrecht) und mit
> `git clone -c core.sshCommand="ssh -i ~/.ssh/kronenrunde" git@github.com:JoScHiiT4k4/kronenrunde.git ~/kronenrunde` holen.

---

## 3. Gmail für die Anmelde-Mails

Die App verschickt Mails (z. B. bei „Passwort vergessen“) über ein Gmail-Konto. Dafür braucht sie ein **App-Passwort**, nicht dein normales Passwort.

**Tipp:** Leg dir ein eigenes Gmail-Konto nur fürs Tippspiel an, z. B. `tippspiel.deinname@gmail.com`
(<https://accounts.google.com/signup>). Dann sehen deine Mitspieler diese Adresse als Absender, und dein privates Postfach bleibt außen vor.

1. Mit diesem Gmail-Konto anmelden und die **Bestätigung in zwei Schritten** einschalten:
   <https://myaccount.google.com/signinoptions/twosv> → einschalten, Handynummer bestätigen.
2. **App-Passwort** erstellen: <https://myaccount.google.com/apppasswords>
   → Name `Tippspiel` → **Erstellen**.
3. Die 16 Buchstaben abschreiben. Google zeigt sie nur **einmal** an.

---

## 4. Installieren

Auf dem Pi:

```
sudo bash ~/kronenrunde/deploy/install.sh
```

Das Skript fragt nach:

- **deiner E-Mail-Adresse**: damit meldest du dich an und darfst Turniere und Ergebnisse eintragen
- **der Gmail-Adresse** aus Schritt 3
- **dem App-Passwort** (beim Tippen unsichtbar)

Danach läuft es etwa 5 bis 10 Minuten. Zweimal brauchst du das Handy:

1. Es erscheint ein Link `https://login.tailscale.com/…`. Am Handy oder PC öffnen und bei **Tailscale** anmelden,
   am einfachsten mit *Sign in with Google*. Fragen beim ersten Mal kannst du beliebig beantworten.
   Danach geht es auf dem Pi von selbst weiter.
2. Eventuell erscheint ein zweiter Link zum Freischalten von **Funnel**. Öffnen und bestätigen.

Am Ende steht **„Fertig! Deine App: https://kronenrunde.….ts.net“**, und du bekommst eine Test-Mail.

---

## 5. Ausprobieren

1. Die Adresse im Browser öffnen, deine E-Mail-Adresse eingeben, in der Mail auf **Jetzt anmelden** tippen.
2. Teams, Turnier und Spiele eintragen – für die Worlds 2026 geht das mit einem Befehl auf dem Pi:
   `tippspiel daten worlds-2026` (sonst oben auf **Admin** von Hand).
3. **Tipprunde erstellen** und den Einladungslink an deine Runde schicken.
4. Auf dem Handy die Seite zum Startbildschirm hinzufügen (iPhone: Teilen → *Zum Home-Bildschirm*; Android: ⋮ → *Zum Startbildschirm hinzufügen*).

---

## Später

Neue Versionen kommen **automatisch**: Der Pi schaut einmal täglich um 08:00 bei GitHub nach – und sofort, wenn GitHub per Webhook meldet, dass es etwas Neues gibt (einmalig einrichten mit `tippspiel webhook-einrichten`). Er holt nur Versionen,
deren automatische Prüfungen grün sind (Zweig `stabil`), sichert vorher die Daten und geht zur alten Version zurück,
falls die neue nicht startet. Von Hand geht es genauso mit:

```
tippspiel update
```

Alle Befehle: `tippspiel hilfe`. Eventuell fragt der Pi dabei nach deinem Pi-Passwort.

Die Datenbank wird jede Nacht gesichert (die letzten 14 Sicherungen bleiben), und Sicherheits-Updates für den Pi laufen automatisch.

Im Administrator-Bereich zeigt der Reiter **Backup**, wann zuletzt gesichert wurde, und hat einen Knopf **Jetzt sichern** für eine Sicherung von Hand.

### Sicherung zusätzlich auf die MyCloud

Die Sicherungen liegen sonst nur auf der SD-Karte des Pi. Damit sie einen Defekt der Karte überstehen, kann jede nächtliche Sicherung zusätzlich per **NFS** auf einen Speicher im Heimnetz kopiert werden, zum Beispiel auf die WD MyCloud.

Vorbereitung an der MyCloud: NFS einschalten und für den Ordner dem Pi (am besten mit fester IP im Router) Schreibrechte geben. NFS braucht kein Passwort, der Speicher erkennt den Pi an der IP-Adresse. Dann auf dem Pi:

```bash
tippspiel nas-einrichten
```

Der Befehl fragt nach der NFS-Adresse (z. B. `nfs://192.168.1.50/nfs/Sicherung`) und einem Unterordner, installiert bei Bedarf das nötige Programm (`nfs-common`) und kopiert gleich die neueste Sicherung als Test. Die neueste Sicherung wird dann täglich um 7 Uhr auf die MyCloud kopiert; dort bleiben die letzten 30 Kopien. Weitere Befehle: `tippspiel nas-test` (jetzt kopieren) und `tippspiel nas-entfernen` (ausschalten).

---

## Umzug vom alten Repository „LoL-Tippspiel“ (einmalig)

Wer die App noch aus dem alten Repository installiert hat, stellt den Pi so auf das neue um (Daten und Einstellungen bleiben):

```
sudo git -C /opt/lol-tippspiel remote set-url origin https://github.com/JoScHiiT4k4/kronenrunde.git
sudo git -C /opt/lol-tippspiel config --unset core.sshCommand
sudo tippspiel update
sudo tippspiel webhook-einrichten
```

Der letzte Befehl zeigt Adresse und Geheimnis für den Webhook – im **neuen** Repository unter
*Settings → Webhooks → Add webhook* eintragen. Den alten Zugangs-Schlüssel braucht der Pi danach nicht mehr.
Ordner und Dienst heißen auf dem Pi vorerst weiter `lol-tippspiel`.

---

## Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| Test-Mail kommt nicht an | Spam-Ordner prüfen. Sonst `tippspiel einstellungen` → Zeilen `SMTP_USER` und `SMTP_PASSWORD` prüfen, speichern mit Strg+O, Enter, Strg+X. Dann `tippspiel mail-test deine@mail.de` |
| Seite lädt nicht | `tippspiel status`. Ist der Pi an und im Internet? Beim allerersten Mal kann es bis zu 10 Minuten dauern. |
| Irgendetwas anderes | `tippspiel protokoll` zeigt die Meldungen der App. Die kannst du mir schicken. |
| Installation bricht ab | Einfach `sudo bash ~/kronenrunde/deploy/install.sh` noch einmal starten. Bereits Erledigtes bleibt erhalten. |
