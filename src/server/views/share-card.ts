// Teilen-Bild im Spielerprofil: eine eigenständige SVG-Bild-Karte (Platzierung, Punkte, Abzeichen) zum Herunterladen/Teilen.
// Bewusst ohne Headless-Browser oder Bild-Bibliothek erzeugt (kein Build-Schritt auf dem Pi) – reines, selbstständiges SVG,
// alle Farben und Schriften inline, damit die Datei auch außerhalb der Seite (z. B. in einem Chat) richtig aussieht.

import type { BadgeResult } from '../../domain/badges.ts';
import { html, nothing, type Html } from '../html.ts';

const W = 1080;
const H = 1080;
const CX = W / 2;

const C = {
  bg: '#07111c',
  surface2: '#112235',
  frame: '#5b4520',
  gold: '#c8aa6e',
  goldBright: '#f0e2b6',
  text: '#ece3cd',
  muted: '#a39d8b',
};

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Arial, 'Segoe UI', sans-serif";

/** Vereinfachte Krone (passend zum Logo), einfarbig für die Teilen-Karte. */
function crown(cx: number, cy: number, scale: number): Html {
  const t = `translate(${(cx - 32 * scale).toFixed(1)} ${(cy - 28 * scale).toFixed(1)}) scale(${scale})`;
  return html`<g transform="${t}">
    <path d="M8,46 8,30 14,40 20,24 26,40 32,15 38,40 44,24 50,40 56,30 56,46 56,56 8,56Z" fill="${C.goldBright}" stroke="${C.frame}" stroke-width="1.5" stroke-linejoin="round"/>
    <g fill="${C.goldBright}" stroke="${C.frame}" stroke-width="1.3">
      <circle cx="8" cy="30" r="3"/><circle cx="20" cy="24" r="3"/><circle cx="32" cy="15" r="3.6"/><circle cx="44" cy="24" r="3"/><circle cx="56" cy="30" r="3"/>
    </g>
  </g>`;
}

const TIER_LABEL = ['', 'Bronze', 'Silber', 'Gold'] as const;

/** Ein Abzeichen-Schild: fester mittiger Text, bricht nicht um – daher höchstens 2 nebeneinander und kurze Titel bevorzugt. */
function badgeChip(b: BadgeResult, x: number, y: number, width: number): Html {
  const fill = b.level === 3 ? C.goldBright : b.level === 2 ? '#d7d3c6' : C.gold;
  return html`<g transform="translate(${x} ${y})">
    <rect width="${width}" height="92" rx="10" fill="${C.surface2}" stroke="${C.frame}" stroke-width="1.5"/>
    <circle cx="46" cy="46" r="24" fill="${fill}"/>
    <text x="46" y="55" font-family="${SERIF}" font-size="24" font-weight="700" fill="${C.bg}" text-anchor="middle">${TIER_LABEL[b.level][0]}</text>
    <text x="${width / 2 + 13}" y="42" font-family="${SANS}" font-size="21" font-weight="700" fill="${C.text}" text-anchor="middle">${b.title}</text>
    <text x="${width / 2 + 13}" y="70" font-family="${SANS}" font-size="18" fill="${C.muted}" text-anchor="middle">${TIER_LABEL[b.level]}</text>
  </g>`;
}

export interface ShareCardInput {
  appName: string;
  leagueName: string;
  displayName: string;
  /** Base64-kodiertes JPEG, oder null ohne Profilbild (dann ein Platzhalter mit dem Anfangsbuchstaben). */
  avatarB64: string | null;
  rank: number;
  memberCount: number;
  points: number;
  /** Erreichte Abzeichen, beste zuerst – es werden höchstens 2 gezeigt (Platz für lange Titel). */
  earnedBadges: BadgeResult[];
  /** "15.10.2026" */
  dateText: string;
}

/** Baut die Teilen-Karte als eigenständiges 1080×1080-SVG. */
export function shareCard(o: ShareCardInput): string {
  const badges = o.earnedBadges.slice(0, 2);
  const chipY = 860;
  const chipWidth = badges.length > 1 ? 480 : 520;
  const gap = 24;
  const totalWidth = badges.length * chipWidth + (badges.length - 1) * gap;
  const startX = CX - totalWidth / 2;

  const avatarR = 120;
  const avatarCy = 410;
  const avatar: Html = o.avatarB64
    ? html`<clipPath id="av"><circle cx="${CX}" cy="${avatarCy}" r="${avatarR}"/></clipPath>
    <image href="data:image/jpeg;base64,${o.avatarB64}" x="${CX - avatarR}" y="${avatarCy - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : html`<circle cx="${CX}" cy="${avatarCy}" r="${avatarR}" fill="${C.surface2}"/>
    <text x="${CX}" y="${avatarCy + 40}" font-family="${SERIF}" font-size="120" font-weight="700" fill="${C.goldBright}" text-anchor="middle">${[...o.displayName][0]?.toUpperCase() ?? '?'}</text>`;

  return html`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ergebnis-Karte von ${o.displayName}: Platz ${o.rank} von ${o.memberCount}, ${o.points} Punkte">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="none" stroke="${C.frame}" stroke-width="2"/>
  ${crown(CX, 100, 1.05)}
  <text x="${CX}" y="184" font-family="${SERIF}" font-size="38" font-weight="700" fill="${C.goldBright}" text-anchor="middle" letter-spacing="4">${o.appName.toUpperCase()}</text>
  <text x="${CX}" y="222" font-family="${SANS}" font-size="27" fill="${C.muted}" text-anchor="middle">${o.leagueName}</text>
  <line x1="${CX - 100}" y1="254" x2="${CX + 100}" y2="254" stroke="${C.gold}" stroke-width="2"/>
  <circle cx="${CX}" cy="${avatarCy}" r="${avatarR + 6}" fill="none" stroke="${C.gold}" stroke-width="4"/>
  ${avatar}
  <text x="${CX}" y="606" font-family="${SERIF}" font-size="54" font-weight="700" fill="${C.goldBright}" text-anchor="middle">${o.displayName}</text>
  <text x="${CX}" y="650" font-family="${SANS}" font-size="28" fill="${C.muted}" text-anchor="middle">${o.rank}. Platz von ${o.memberCount}</text>
  <text x="${CX}" y="760" font-family="${SERIF}" font-size="130" font-weight="700" fill="${C.goldBright}" text-anchor="middle">${o.points}</text>
  <text x="${CX}" y="794" font-family="${SANS}" font-size="28" fill="${C.muted}" text-anchor="middle">${o.points === 1 ? 'Punkt' : 'Punkte'}</text>
  ${badges.length ? badges.map((b, i) => badgeChip(b, startX + i * (chipWidth + gap), chipY, chipWidth)) : nothing}
  <text x="${CX}" y="${H - 48}" font-family="${SANS}" font-size="22" fill="${C.muted}" text-anchor="middle">${o.dateText} · ${o.appName}</text>
</svg>`.toString();
}
