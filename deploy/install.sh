#!/usr/bin/env bash
# Installiert das LoL-Tippspiel auf einem Raspberry Pi oder Debian-/Ubuntu-PC.
#
#   sudo bash deploy/install.sh
#
# Was passiert:
#   1. Programme: Node.js, PostgreSQL, git, automatische Sicherheits-Updates
#   2. Code nach /opt/lol-tippspiel, Einstellungen in /opt/lol-tippspiel/.env
#   3. Datenbank "tippspiel" mit eigenem Datenbank-Benutzer
#   4. Dienst "lol-tippspiel": startet automatisch, auch nach Stromausfall
#   5. Tägliche Sicherung der Datenbank nach /var/backups/lol-tippspiel
#   6. Tailscale Funnel: macht die App unter https://….ts.net im Internet erreichbar
#   7. Befehl "tippspiel" für Updates, Sicherungen usw. (tippspiel hilfe); Updates laufen automatisch alle 15 Minuten
#
# Das Skript kann gefahrlos mehrfach laufen: Einstellungen und Daten bleiben erhalten.
# "tippspiel update" ruft es mit --update auf (ohne Fragen, ohne Tailscale-Einrichtung).
set -euo pipefail

APP_DIR=/opt/lol-tippspiel
ENV_FILE=$APP_DIR/.env
CONF_DIR=/etc/lol-tippspiel
SERVICE=lol-tippspiel
SERVICE_USER=tippspiel
DB_NAME=tippspiel
DB_USER=tippspiel
BACKUP_DIR=/var/backups/lol-tippspiel
NODE_MAJOR=24
DEFAULT_PORT=3000
TS_HOSTNAME=lol-tippspiel
DEFAULT_REPO=git@github.com:JoScHiiT4k4/LoL-Tippspiel.git
LOG=/var/log/lol-tippspiel-install.log
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

UPDATE=0
[[ "${1:-}" == "--update" ]] && UPDATE=1

step() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# Befehl ausführen, Ausgabe ins Protokoll; bei Fehler die letzten Zeilen zeigen.
run() {
  printf '\n$ %s\n' "$*" >>"$LOG"
  if ! "$@" >>"$LOG" 2>&1; then
    tail -n 15 "$LOG" >&2
    die "Fehlgeschlagen: $* (ganzes Protokoll: $LOG)"
  fi
}

ask() { local a; read -r -p "  $1 " a </dev/tty; printf '%s' "$a"; }
ask_secret() { local a; read -r -s -p "  $1 " a </dev/tty; echo >&2; printf '%s' "$a"; }

# Wert in der .env setzen (vorhandene Zeile ersetzen oder anhängen)
set_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp)
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 1)'
}

port_in_use() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }

# Tailscale-Weiterleitungen lesen (z. B. eine schon vorhandene für Homebridge) und ausgeben:
#   "<HTTPS-Port> <an|aus>"  – Port, auf dem die App schon weitergeleitet wird, und ob Funnel dort an ist
#   "<HTTPS-Port> neu"       – noch keine Weiterleitung für die App; dieser Funnel-Port ist frei
#   ""                       – alle Funnel-Ports (443, 8443, 10000) sind von anderen Programmen belegt
funnel_plan() {
  tailscale serve status --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let j = {}; try { j = JSON.parse(s || "{}") || {}; } catch {}
      const port = process.argv[1], ours = new RegExp("^(https?://)?(127\\.0\\.0\\.1|localhost):" + port + "/?$");
      for (const [hostPort, web] of Object.entries(j.Web || {})) {
        const p = hostPort.split(":").pop();
        if (Object.values((web && web.Handlers) || {}).some(h => h && ours.test(h.Proxy || ""))) {
          console.log(p + " " + ((j.AllowFunnel || {})[hostPort] ? "an" : "aus")); return;
        }
      }
      const used = new Set(Object.keys(j.TCP || {}));
      for (const p of ["443", "8443", "10000"]) if (!used.has(p)) { console.log(p + " neu"); return; }
      console.log("");
    });' "$1"
}

wait_healthy() {
  local url=$1 tries=${2:-30}
  shift 2 || shift $#
  for _ in $(seq "$tries"); do
    curl -fsS -m 10 "$@" "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Bitte mit sudo starten:  sudo bash $0"
[[ -r /etc/os-release ]] || die "Unbekanntes Betriebssystem."
# shellcheck disable=SC1091
. /etc/os-release
[[ " ${ID:-} ${ID_LIKE:-} " == *" debian "* ]] || die "Dieses Skript ist für Raspberry Pi OS, Debian oder Ubuntu."
ARCH=$(dpkg --print-architecture)
[[ $ARCH == arm64 || $ARCH == amd64 ]] ||
  die "Bitte ein 64-Bit-System verwenden (gefunden: $ARCH). Beim Raspberry Pi: 'Raspberry Pi OS (64-bit)' aufspielen."
: >>"$LOG"
chmod 600 "$LOG"

if [[ $UPDATE == 1 ]]; then
  [[ -f $ENV_FILE ]] || die "Noch nicht installiert. Bitte zuerst:  sudo bash $APP_DIR/deploy/install.sh"
else
  printf '\n\033[1mLoL-Tippspiel – Installation\033[0m\n'
fi

# --- Fragen (nur bei der ersten Installation) --------------------------------
# (Antworten lassen sich auch vorab übergeben: ADMIN_EMAIL=… GMAIL=… GMAIL_PASS=… sudo -E bash install.sh)
ADMIN_EMAIL=${ADMIN_EMAIL:-} GMAIL_PASS=${GMAIL_PASS:-}
if [[ ! -f $ENV_FILE ]]; then
  step "Ein paar Angaben"
  while [[ $ADMIN_EMAIL != *@*.* ]]; do
    ADMIN_EMAIL=$(ask "Deine E-Mail-Adresse (damit darfst du Turniere und Ergebnisse eintragen):")
  done
  ADMIN_EMAIL=$(printf '%s' "$ADMIN_EMAIL" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  if [[ -z ${GMAIL+gesetzt} ]]; then
    note ""
    note "Die Anmelde-Mails werden über Gmail verschickt (siehe Anleitung, Schritt 3)."
    GMAIL=$(ask "Gmail-Adresse für den Versand (leer lassen = später einrichten):")
  fi
  GMAIL=$(printf '%s' "$GMAIL" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  if [[ -n $GMAIL ]]; then
    while [[ -z $GMAIL_PASS ]]; do
      GMAIL_PASS=$(ask_secret "App-Passwort dieser Gmail-Adresse (16 Buchstaben, wird nicht angezeigt):")
      GMAIL_PASS=$(printf '%s' "$GMAIL_PASS" | tr -d '[:space:]')
    done
    [[ ${#GMAIL_PASS} == 16 ]] || warn "Das App-Passwort hat ${#GMAIL_PASS} statt 16 Zeichen. Falls die Test-Mail scheitert: tippspiel einstellungen"
  fi
fi

# --- 1. Programme ------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
if [[ $UPDATE == 1 ]] && command -v psql >/dev/null && command -v git >/dev/null && command -v ss >/dev/null &&
  command -v flock >/dev/null && node_ok; then
  : # Beim Update ist alles schon da – kein apt (schneller, und kein Konflikt mit den automatischen Sicherheits-Updates)
else
  step "Programme installieren (kann einige Minuten dauern)"
  run apt-get update
  # Vor dem Installieren prüfen, damit auf einem zu alten System nichts halb eingerichtet wird
  PG_CAND=$(apt-cache policy postgresql 2>/dev/null | awk '/Candidate:/ { print $2 }' | grep -oE '^[0-9]+' || true)
  [[ -z $PG_CAND || $PG_CAND -ge 15 ]] ||
    die "Dieses System bietet nur PostgreSQL $PG_CAND an (mindestens 15 nötig). Bitte ein System ab Debian 12 verwenden (z. B. aktuelles Raspberry Pi OS)."
  run apt-get install -y ca-certificates curl gnupg git iproute2 openssh-client postgresql unattended-upgrades
  ok "PostgreSQL, git und automatische Sicherheits-Updates"

  if [[ ! -f /etc/apt/apt.conf.d/20auto-upgrades ]]; then
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
  fi

  if ! node_ok; then
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg ||
      die "Node.js-Paketquelle nicht erreichbar. Ist der Pi mit dem Internet verbunden?"
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      >/etc/apt/sources.list.d/nodesource.list
    run apt-get update
    run apt-get install -y nodejs
    node_ok || die "Node.js konnte nicht installiert werden (gefunden: $(node -v 2>/dev/null || echo nichts))."
  fi
fi
NODE_BIN=$(command -v node)
ok "Node.js $(node -v)"

PG_MAJOR=$(psql --version | grep -oE '[0-9]+' | head -n 1)
[[ $PG_MAJOR -ge 15 ]] || die "PostgreSQL $PG_MAJOR ist zu alt (mindestens 15). Bitte ein aktuelles Raspberry Pi OS verwenden."
run systemctl enable postgresql
run systemctl start postgresql
for _ in $(seq 30); do runuser -u postgres -- psql -Xqtc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
runuser -u postgres -- psql -Xqtc 'select 1' >/dev/null 2>&1 || die "PostgreSQL startet nicht. Details: journalctl -u postgresql"
ok "PostgreSQL $PG_MAJOR läuft"

# --- 2. Benutzer und Code ----------------------------------------------------
step "App einrichten"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -m 700 "$CONF_DIR"
GIT_SSH="ssh -i $CONF_DIR/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$CONF_DIR/known_hosts -o StrictHostKeyChecking=yes"
# Fingerabdruck von github.com (veröffentlicht von GitHub) – schützt vor gefälschten Servern
echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' >"$CONF_DIR/known_hosts"

if [[ ! -d $APP_DIR/.git ]]; then
  REPO=$DEFAULT_REPO
  if [[ -f $SRC_DIR/.git/config ]]; then
    REPO=$(git config -f "$SRC_DIR/.git/config" --get remote.origin.url || echo "$DEFAULT_REPO")
  fi
  if [[ $REPO == git@* || $REPO == ssh://* ]]; then
    # Privates Repository: den Zugangs-Schlüssel aus Schritt 2 der Anleitung übernehmen
    KEY=''
    for k in "${DEPLOY_KEY:-}" "/home/${SUDO_USER:-nobody}/.ssh/lol-tippspiel" /root/.ssh/lol-tippspiel; do
      [[ -n $k && -f $k ]] && KEY=$k && break
    done
    [[ -n $KEY ]] || die "Zugangs-Schlüssel ~/.ssh/lol-tippspiel nicht gefunden (Anleitung, Schritt 2)."
    install -m 600 "$KEY" "$CONF_DIR/deploy_key"
    [[ -f $KEY.pub ]] && install -m 644 "$KEY.pub" "$CONF_DIR/deploy_key.pub"
    run env GIT_SSH_COMMAND="$GIT_SSH" git clone -q "$REPO" "$APP_DIR"
    git -C "$APP_DIR" config core.sshCommand "$GIT_SSH"
  else
    run git clone -q "$REPO" "$APP_DIR"
  fi
  ok "Code von GitHub geladen nach $APP_DIR"
fi
chown -R root:root "$APP_DIR"
chmod 755 "$APP_DIR"
chmod +x "$APP_DIR/deploy/tippspiel" "$APP_DIR/deploy/install.sh"
ln -sf "$APP_DIR/deploy/tippspiel" /usr/local/bin/tippspiel
ok "Code in $APP_DIR, Befehl 'tippspiel' eingerichtet"

# --- 3. Einstellungen ----------------------------------------------------------
if [[ ! -f $ENV_FILE ]]; then
  DB_PASS=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
  SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  # Läuft auf dem Gerät schon etwas anderes auf Port 3000, nimmt die App den nächsten freien.
  APP_PORT=$DEFAULT_PORT
  while port_in_use "$APP_PORT"; do APP_PORT=$((APP_PORT + 1)); done
  [[ $APP_PORT == "$DEFAULT_PORT" ]] || note "Port $DEFAULT_PORT ist von einem anderen Programm belegt – die App nimmt Port $APP_PORT."
  umask 027
  cat >"$ENV_FILE" <<EOF
# Einstellungen für das LoL-Tippspiel (angelegt von deploy/install.sh am $(date +%d.%m.%Y)).
# Ändern mit:  tippspiel einstellungen   (startet die App danach neu)

DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
APP_URL=http://127.0.0.1:$APP_PORT
HOST=127.0.0.1
PORT=$APP_PORT
APP_SECRET=$SECRET
APP_TIMEZONE=Europe/Berlin
# Dürfen Turniere, Teams, Spiele und Ergebnisse pflegen (mehrere mit Komma trennen)
ADMIN_EMAILS=$ADMIN_EMAIL

# Anmelde-Mails über Gmail (App-Passwort: https://myaccount.google.com/apppasswords)
MAIL_MODE=$([[ -n $GMAIL ]] && echo smtp || echo console)
MAIL_FROM_NAME=LoL-Tippspiel
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=$GMAIL
SMTP_PASSWORD=$GMAIL_PASS

# Die App ist nur über Tailscale Funnel erreichbar; der trägt die Besucher-Adresse ein.
TRUST_PROXY=1
EOF
  umask 022
  ok "Einstellungen angelegt"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
PORT=$(get_env PORT); PORT=${PORT:-$DEFAULT_PORT}

# --- 4. Datenbank --------------------------------------------------------------
DB_PASS=$(DATABASE_URL=$(get_env DATABASE_URL) node -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).password))')
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v pw="$DB_PASS" -v db="$DB_NAME" -v usr="$DB_USER" >>"$LOG" 2>&1 <<'SQL' ||
select format('create role %I login password %L', :'usr', :'pw') where not exists (select 1 from pg_roles where rolname = :'usr') \gexec
select format('alter role %I with login password %L', :'usr', :'pw') \gexec
select format('create database %I owner %I', :'db', :'usr') where not exists (select 1 from pg_database where datname = :'db') \gexec
SQL
  die "Datenbank konnte nicht angelegt werden (Protokoll: $LOG)"
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" \
  -c 'create extension if not exists citext' -c 'create extension if not exists pgcrypto' >>"$LOG" 2>&1 ||
  die "Datenbank-Erweiterungen fehlen (Protokoll: $LOG)"
ok "Datenbank '$DB_NAME' bereit"

# --- 5. Dienst und tägliche Sicherung ------------------------------------------
install -d -m 750 -o root -g "$SERVICE_USER" "$BACKUP_DIR"
cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=LoL-Tippspiel
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$NODE_BIN --experimental-strip-types --disable-warning=ExperimentalWarning src/server/main.ts
Restart=always
RestartSec=5
# /run/$SERVICE: hier legt die App Anfragen ab (z. B. "Update jetzt" aus dem Administrator-Bereich)
RuntimeDirectory=$SERVICE
RuntimeDirectoryPreserve=yes
# Schutz: Die App darf nur lesen und übers Netzwerk sprechen.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/$SERVICE-sicherung.service <<EOF
[Unit]
Description=LoL-Tippspiel: Sicherung der Datenbank
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/tippspiel sicherung
EOF

cat >/etc/systemd/system/$SERVICE-sicherung.timer <<EOF
[Unit]
Description=LoL-Tippspiel: tägliche Sicherung

[Timer]
OnCalendar=*-*-* 04:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Automatische Updates: alle 15 Minuten nach einer neuen, auf GitHub geprüften Version schauen
cat >/etc/systemd/system/$SERVICE-update.service <<EOF
[Unit]
Description=LoL-Tippspiel: neue geprüfte Version von GitHub holen
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/usr/local/bin/tippspiel update --auto
EOF

cat >/etc/systemd/system/$SERVICE-update.timer <<EOF
[Unit]
Description=LoL-Tippspiel: alle 15 Minuten nach Updates schauen

[Timer]
OnCalendar=*:0/15
RandomizedDelaySec=90
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Update sofort: Der Administrator legt im Browser eine Anfrage-Datei ab, systemd startet daraufhin das Update (als root)
cat >/etc/systemd/system/$SERVICE-update-jetzt.service <<EOF
[Unit]
Description=LoL-Tippspiel: Update sofort (im Administrator-Bereich angefordert)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=/root
ExecStartPre=/bin/rm -f /run/$SERVICE/update-anfrage
ExecStart=/usr/local/bin/tippspiel update --auto
EOF

cat >/etc/systemd/system/$SERVICE-update-jetzt.path <<EOF
[Unit]
Description=LoL-Tippspiel: wartet auf die Update-Anfrage aus dem Administrator-Bereich

[Path]
PathExists=/run/$SERVICE/update-anfrage
Unit=$SERVICE-update-jetzt.service

[Install]
WantedBy=multi-user.target
EOF

# Sicherung sofort: wie beim Update legt der Administrator eine Anfrage-Datei ab, systemd startet daraufhin die Sicherung (als root)
cat >/etc/systemd/system/$SERVICE-sicherung-jetzt.service <<EOF
[Unit]
Description=LoL-Tippspiel: Sicherung sofort (im Administrator-Bereich angefordert)
After=postgresql.service

[Service]
Type=oneshot
Environment=HOME=/root
ExecStartPre=/bin/rm -f /run/$SERVICE/sicherung-anfrage
ExecStart=/usr/local/bin/tippspiel sicherung manuell
EOF

cat >/etc/systemd/system/$SERVICE-sicherung-jetzt.path <<EOF
[Unit]
Description=LoL-Tippspiel: wartet auf die Sicherungs-Anfrage aus dem Administrator-Bereich

[Path]
PathExists=/run/$SERVICE/sicherung-anfrage
Unit=$SERVICE-sicherung-jetzt.service

[Install]
WantedBy=multi-user.target
EOF

# Kopie der neuesten Sicherung auf den Heimnetz-Speicher (MyCloud): täglich um 7 Uhr; ohne eingerichteten Speicher tut sie nichts
cat >/etc/systemd/system/$SERVICE-nas.service <<EOF
[Unit]
Description=LoL-Tippspiel: neueste Sicherung auf den Heimnetz-Speicher kopieren
After=network-online.target

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/usr/local/bin/tippspiel nas-kopie
EOF

cat >/etc/systemd/system/$SERVICE-nas.timer <<EOF
[Unit]
Description=LoL-Tippspiel: Kopie auf die MyCloud, täglich um 7 Uhr

[Timer]
OnCalendar=*-*-* 07:00:00
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
EOF

run systemctl daemon-reload
run systemctl enable "$SERVICE.service" "$SERVICE-sicherung.timer" "$SERVICE-nas.timer" "$SERVICE-update.timer" "$SERVICE-update-jetzt.path" "$SERVICE-sicherung-jetzt.path"
run systemctl start "$SERVICE-sicherung.timer" "$SERVICE-nas.timer" "$SERVICE-update.timer" "$SERVICE-update-jetzt.path" "$SERVICE-sicherung-jetzt.path"
run systemctl restart "$SERVICE.service"
if ! wait_healthy "http://127.0.0.1:$PORT/gesund"; then
  journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true
  die "Die App startet nicht. Die Meldungen oben zeigen, warum."
fi
ok "App läuft (startet automatisch nach jedem Neustart)"
touch "$APP_DIR/.update-installed"   # die Server-Seite zeigt, wann zuletzt eine Version installiert wurde
ok "Tägliche Sicherung um 4 Uhr nach $BACKUP_DIR (Kopie auf die MyCloud um 7 Uhr, falls eingerichtet)"
ok "Automatische Updates alle 15 Minuten (nur auf GitHub geprüfte Versionen)"

[[ $UPDATE == 1 ]] && exit 0

# --- 6. Tailscale Funnel: öffentlich erreichbar unter https://….ts.net ---------
# OHNE_TAILSCALE=1 überspringt diesen Schritt (für Tests oder einen anderen Weg ins Internet).
if [[ ${OHNE_TAILSCALE:-0} == 1 ]]; then
  step "Tailscale übersprungen (OHNE_TAILSCALE=1)"
  APP_URL=$(get_env APP_URL)
else
  step "Im Internet erreichbar machen (Tailscale)"
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale-install.sh || die "tailscale.com nicht erreichbar."
    run sh /tmp/tailscale-install.sh
    rm -f /tmp/tailscale-install.sh
  fi
  run systemctl enable --now tailscaled

  ts_state() { tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.BackendState+" "+((j.Self&&j.Self.DNSName)||"").replace(/\.$/,""))}catch{console.log("? ")}})'; }

  read -r STATE TS_NAME <<<"$(ts_state)"
  if [[ $STATE != Running ]]; then
    note "Gleich erscheint ein Link (https://login.tailscale.com/…)."
    note "Öffne ihn auf dem Handy oder PC und melde dich an, z. B. mit deinem Google-Konto."
    note "Danach geht es hier von selbst weiter."
    tailscale up --hostname="$TS_HOSTNAME" </dev/tty || die "Anmeldung bei Tailscale hat nicht geklappt. Einfach das Skript noch einmal starten."
    read -r STATE TS_NAME <<<"$(ts_state)"
  fi
  [[ $STATE == Running && -n $TS_NAME ]] || die "Tailscale läuft nicht richtig (Zustand: $STATE)."
  ok "Tailscale verbunden als $TS_NAME"

  # Vorhandene Weiterleitungen anderer Programme (z. B. Homebridge) bleiben unangetastet.
  read -r FUNNEL_PORT FUNNEL_STATE <<<"$(funnel_plan "$PORT")"
  [[ -n ${FUNNEL_PORT:-} ]] ||
    die "Tailscale leitet die Ports 443, 8443 und 10000 schon an andere Programme weiter (anzeigen: tailscale serve status). Einen davon freigeben und das Skript noch einmal starten."
  if [[ $FUNNEL_STATE == an ]]; then
    ok "Funnel ist schon eingeschaltet"
  else
    if [[ $FUNNEL_STATE == neu && $FUNNEL_PORT != 443 ]]; then
      note "Tailscale leitet Port 443 schon an ein anderes Programm weiter (z. B. Homebridge)."
      note "Das bleibt so – die App bekommt Port $FUNNEL_PORT."
    fi
    note "Falls gleich ein Link zum Freischalten von 'Funnel' erscheint: öffnen, bestätigen, hier geht es dann weiter."
    tailscale funnel --bg --https="$FUNNEL_PORT" "$PORT" </dev/tty || die "Funnel konnte nicht eingeschaltet werden. Einfach das Skript noch einmal starten."
    ok "Funnel eingeschaltet"
  fi

  APP_URL="https://$TS_NAME"
  [[ $FUNNEL_PORT == 443 ]] || APP_URL="$APP_URL:$FUNNEL_PORT"
  if [[ $(get_env APP_URL) != "$APP_URL" ]]; then
    set_env APP_URL "$APP_URL"
    set_env HOST 127.0.0.1
    set_env TRUST_PROXY 1
    run systemctl restart "$SERVICE.service"
    wait_healthy "http://127.0.0.1:$PORT/gesund" || die "Die App startet nach dem Umstellen nicht: journalctl -u $SERVICE"
  fi

  note "Prüfe die Adresse (beim ersten Mal kann das ein, zwei Minuten dauern) …"
  TS_IP=$(tailscale ip -4 2>/dev/null | head -n 1)
  if wait_healthy "$APP_URL/gesund" 20 ${TS_IP:+--resolve "$TS_NAME:$FUNNEL_PORT:$TS_IP"}; then
    ok "Erreichbar unter $APP_URL"
  else
    warn "Noch nicht erreichbar. Das kann bis zu 10 Minuten dauern. Danach einfach $APP_URL im Browser öffnen."
  fi
fi

# --- 7. Test-Mail --------------------------------------------------------------
ADMIN_EMAIL=$(get_env ADMIN_EMAILS | cut -d, -f1)
if [[ $(get_env MAIL_MODE) == smtp && -n $ADMIN_EMAIL ]]; then
  step "Test-Mail an $ADMIN_EMAIL"
  if /usr/local/bin/tippspiel mail-test "$ADMIN_EMAIL"; then
    ok "Verschickt – schau in dein Postfach."
  else
    warn "Die Test-Mail hat nicht geklappt. Gmail-Adresse und App-Passwort ändern mit:  tippspiel einstellungen"
  fi
fi

printf '\n\033[1;32m✔ Fertig! Deine App: %s\033[0m\n\n' "$APP_URL"
if [[ $(get_env MAIL_MODE) == console ]]; then
  cat <<EOF
  E-Mails sind noch nicht eingerichtet ("Passwort vergessen" geht dann nicht). Einen Link zum
  Passwort-Festlegen bekommst du bis dahin mit:
    tippspiel login-link ${ADMIN_EMAIL:-deine@mail.de}
  Gmail einrichten (Anleitung, Schritt 3):  tippspiel einstellungen

EOF
fi
cat <<EOF
  So geht's los: Adresse öffnen → "Konto erstellen" mit deiner E-Mail-Adresse (der Admin-Adresse)
  und einem Passwort. Den Link zur App kannst du an deine Runde schicken.

  Nützliche Befehle (Übersicht: tippspiel hilfe):
    tippspiel status          Läuft alles?
    tippspiel update          Neueste Version von GitHub installieren
    tippspiel einstellungen   Einstellungen ändern (z. B. Gmail)
    tippspiel sicherung       Datenbank jetzt sichern

EOF
if [[ -n ${SUDO_USER:-} && -d /home/$SUDO_USER/lol-tippspiel && $SRC_DIR == "/home/$SUDO_USER/lol-tippspiel" ]]; then
  note "Den Ordner ~/lol-tippspiel brauchst du nicht mehr:  rm -rf ~/lol-tippspiel"
  echo
fi
