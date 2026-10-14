# Tippspiel auf dem Raspberry Pi einrichten

Dauer: etwa 45 Minuten, davon viel Warten. Du brauchst den Raspberry Pi 4 mit Netzteil,
eine microSD-Karte (ab 16 GB), deinen PC und dein Handy.

Am Ende läuft die App bei dir zu Hause und ist im Internet unter einer Adresse wie
`https://lol-tippspiel.tail1234.ts.net` erreichbar. Kosten: keine.

---

## 1. Raspberry Pi vorbereiten

Überspringen, wenn auf deinem Pi schon **Raspberry Pi OS (64-bit)** läuft und du dich per SSH verbinden kannst.

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

## 2. Zugang zum Code (GitHub)

Dein Repository ist privat. Der Pi bekommt deshalb einen eigenen Schlüssel, mit dem er den Code nur **lesen** darf.

1. Auf dem Pi:

   ```
   sudo apt-get install -y git
   ssh-keygen -t ed25519 -N "" -C "raspberry-pi" -f ~/.ssh/lol-tippspiel
   cat ~/.ssh/lol-tippspiel.pub
   ```

2. Die letzte Zeile (beginnt mit `ssh-ed25519`) mit der Maus markieren und mit **Rechtsklick** kopieren.
3. Im Browser öffnen: <https://github.com/JoScHiiT4k4/lol-tippspiel/settings/keys/new>
   - **Title:** `Raspberry Pi`
   - **Key:** einfügen (Strg+V)
   - **Allow write access:** *nicht* ankreuzen
   - **Add key** klicken
4. Auf dem Pi den Code holen:

   ```
   git clone -c core.sshCommand="ssh -i ~/.ssh/lol-tippspiel -o StrictHostKeyChecking=accept-new" git@github.com:JoScHiiT4k4/lol-tippspiel.git ~/lol-tippspiel
   ```

---

## 3. Gmail für die Anmelde-Mails

Die App verschickt die Anmelde-Links über ein Gmail-Konto. Dafür braucht sie ein **App-Passwort**, nicht dein normales Passwort.

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
sudo bash ~/lol-tippspiel/deploy/install.sh
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

Am Ende steht **„Fertig! Deine App: https://lol-tippspiel.….ts.net“**, und du bekommst eine Test-Mail.

---

## 5. Ausprobieren

1. Die Adresse im Browser öffnen, deine E-Mail-Adresse eingeben, in der Mail auf **Jetzt anmelden** tippen.
2. Oben auf **Admin**: Teams, Turnier und Spiele eintragen.
3. **Tipprunde erstellen** und den Einladungslink an deine Runde schicken.
4. Auf dem Handy die Seite zum Startbildschirm hinzufügen (iPhone: Teilen → *Zum Home-Bildschirm*; Android: ⋮ → *Zum Startbildschirm hinzufügen*).

---

## Später

Neue Version installieren (sichert vorher die Daten; klappt der Start nicht, geht es automatisch zur alten Version zurück):

```
tippspiel update
```

Alle Befehle: `tippspiel hilfe`. Eventuell fragt der Pi dabei nach deinem Pi-Passwort.

Die Datenbank wird jede Nacht gesichert (die letzten 14 Sicherungen bleiben), und Sicherheits-Updates für den Pi laufen automatisch.

---

## Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| `Permission denied (publickey)` in Schritt 2 | Schlüssel bei GitHub eingetragen? Schritt 2.2 und 2.3 wiederholen. |
| Test-Mail kommt nicht an | Spam-Ordner prüfen. Sonst `tippspiel einstellungen` → Zeilen `SMTP_USER` und `SMTP_PASSWORD` prüfen, speichern mit Strg+O, Enter, Strg+X. Dann `tippspiel mail-test deine@mail.de` |
| Seite lädt nicht | `tippspiel status`. Ist der Pi an und im Internet? Beim allerersten Mal kann es bis zu 10 Minuten dauern. |
| Irgendetwas anderes | `tippspiel protokoll` zeigt die Meldungen der App. Die kannst du mir schicken. |
| Installation bricht ab | Einfach `sudo bash ~/lol-tippspiel/deploy/install.sh` noch einmal starten. Bereits Erledigtes bleibt erhalten. |
