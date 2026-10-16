#!/usr/bin/env bash
# Datenschutz-Prüfung: Im Repository dürfen keine privaten Daten stehen – weder in Dateien noch in Commits.
#
#   bash scripts/datenschutz.sh                Dateien + Autoren aller Commits prüfen
#   bash scripts/datenschutz.sh <von>..<bis>   Dateien + Autoren nur dieser Commits prüfen
#
# Geprüft wird:
#   1. E-Mail-Adressen – erlaubt sind nur Beispiel-Adressen (example.de …) und bekannte Platzhalter
#   2. IP-Adressen aus dem Heimnetz (192.168.x.x, 10.x.x.x …) – erlaubt ist nur der Platzhalter 192.168.1.50
#   3. Tailscale-Namen (….ts.net) – erlaubt ist nur der Platzhalter tail1234
#   4. Autor und Committer jedes Commits – nur Noreply-Adressen
#   5. Geheime Suchmuster aus DATENSCHUTZ_MUSTER (eine Zeile je Muster, z. B. echte E-Mail, IP, Nachname).
#      Auf GitHub ist das ein Secret gleichen Namens – die Muster selbst stehen nie im Repository.
#      Gefundene Stellen werden nur mit Datei und Zeile gemeldet, nie mit Inhalt.
set -euo pipefail
cd "$(dirname "$0")/.."

range=${1:-HEAD}
fehler=0
# Jede Version in den geprüften Commits durchsuchen – auch was ein späterer Commit wieder gelöscht hat
mapfile -t revs < <(git rev-list "$range")
((${#revs[@]} > 0)) || { echo "Datenschutz-Prüfung: keine Commits in $range."; exit 0; }

# Ausgabe: <Datei>:<Zeile>:<Fund>:<Commit> – jede Fundstelle (Datei + Fund) nur einmal, aus dem neuesten Commit
suche() { # <grep-Optionen …>
  git grep -I -n "$@" "${revs[@]}" -- . ':!scripts/datenschutz.sh' 2>/dev/null |
    awk -F: '{ rev=$1; file=$2; line=$3; sub(/^[^:]*:[^:]*:[^:]*:/, ""); key=file SUBSEP $0; if (!(key in seen)) { seen[key]=1; print file ":" line ":" $0 ":" substr(rev,1,7) } }' || true
}

melde() { # <Datei> <Zeile> <Text>
  fehler=$((fehler + 1))
  if [[ -n ${GITHUB_ACTIONS:-} && $1 == Commit\ * ]]; then
    echo "::error title=Datenschutz ($1)::$3"
  elif [[ -n ${GITHUB_ACTIONS:-} ]]; then
    echo "::error file=$1,line=$2,title=Datenschutz::$3"
  else
    echo "  ✗ $1:$2 – $3"
  fi
}

# --- 1. E-Mail-Adressen ---
erlaubt_mail() {
  local m=${1,,}
  case $m in
    *@example.de | *@example.org | *@example.com | *@example.net | *.example.com | *@*.local) return 0 ;;
    *@users.noreply.github.com | noreply@github.com | noreply@anthropic.com) return 0 ;;
    # Platzhalter in Anleitung und Tests
    deine@mail.de | name@mail.de | tipp@gmail.com | tippspiel.deinname@gmail.com | git@github.com | a@b.de | x@y.de | u@x.de) return 0 ;;
  esac
  return 1
}
while IFS=: read -r datei zeile treffer rev; do
  treffer=${treffer#-}
  erlaubt_mail "$treffer" || melde "$datei" "$zeile" "E-Mail-Adresse „$treffer“ (Commit $rev) – bitte durch eine Adresse mit example.de ersetzen"
done < <(suche -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')

# --- 2. IP-Adressen aus dem Heimnetz ---
while IFS=: read -r datei zeile treffer rev; do
  [[ $treffer == 192.168.1.50 ]] && continue
  melde "$datei" "$zeile" "Heimnetz-IP „$treffer“ (Commit $rev) – bitte den Platzhalter 192.168.1.50 verwenden"
done < <(suche -o -E '\b(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\.[0-9]{1,3}\.[0-9]{1,3}\b')

# --- 3. Tailscale-Namen ---
while IFS=: read -r datei zeile treffer rev; do
  [[ $treffer == *tail1234.ts.net ]] && continue
  melde "$datei" "$zeile" "Tailscale-Name „$treffer“ (Commit $rev) – bitte den Platzhalter tail1234 verwenden"
done < <(suche -o -E '[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net')

# --- 4. Autoren und Committer ---
noreply() {
  case ${1,,} in
    *@users.noreply.github.com | noreply@github.com | noreply@anthropic.com) return 0 ;;
  esac
  return 1
}
while IFS=$'\t' read -r hash autor committer; do
  noreply "$autor" && noreply "$committer" && continue
  melde "Commit ${hash:0:7}" 1 "Autor oder Committer mit echter E-Mail-Adresse – auf GitHub „Keep my email addresses private“ einschalten und mit der Noreply-Adresse committen"
done < <(git log --format='%H%x09%ae%x09%ce' "$range")

# --- 5. Geheime Suchmuster ---
if [[ -n ${DATENSCHUTZ_MUSTER:-} ]]; then
  muster=$(mktemp)
  trap 'rm -f "$muster"' EXIT
  printf '%s\n' "$DATENSCHUTZ_MUSTER" | sed -e 's/\r$//' -e '/^[[:space:]]*$/d' >"$muster"
  if [[ -s $muster ]]; then
    # Nur Datei, Zeile und Commit melden – nie den Inhalt (der wäre ja gerade das Private)
    while IFS=: read -r datei zeile rev; do
      melde "$datei" "$zeile" "Enthält ein geheimes Suchmuster (Commit $rev)"
    done < <(git grep -I -n -i -F -f "$muster" "${revs[@]}" -- . 2>/dev/null |
      awk -F: '{ key=$2 SUBSEP $3; if (!(key in seen)) { seen[key]=1; print $2 ":" $3 ":" substr($1,1,7) } }' || true)
    while read -r hash; do
      melde "Commit ${hash:0:7}" 1 "Commit-Text oder -Autor enthält ein geheimes Suchmuster (private Daten)"
    done < <(git log --format='%H%x09%an%x09%ae%x09%cn%x09%ce%x09%B%x00' "$range" | grep -z -i -F -f "$muster" | tr '\0' '\n' | grep -oE '^[0-9a-f]{40}' || true)
  fi
else
  echo "Hinweis: DATENSCHUTZ_MUSTER ist nicht gesetzt – die geheimen Suchmuster werden übersprungen."
fi

if ((fehler > 0)); then
  echo "Datenschutz-Prüfung: $fehler Fundstelle(n). Private Daten gehören nicht ins Repository."
  exit 1
fi
echo "Datenschutz-Prüfung: keine privaten Daten gefunden."
