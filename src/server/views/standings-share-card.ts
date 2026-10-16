// Teilen-Bild der ganzen Rangliste: eigenständige SVG-Bild-Karte (wie share-card.ts) zum
// Herunterladen/Teilen – zeigt die oberen Plätze einer Tipprunde auf einen Blick.

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
  podium: ['#f0e2b6', '#d7d3c6', '#c8aa6e'], // Gold, Silber, Bronze
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

export interface StandingsShareRow {
  rank: number;
  displayName: string;
  points: number;
}

export interface StandingsShareCardInput {
  appName: string;
  leagueName: string;
  rows: StandingsShareRow[];
  /** Wie viele Mitglieder insgesamt (für den Hinweis "+ N weitere", wenn mehr als gezeigt werden). */
  memberCount: number;
  /** "15.10.2026" */
  dateText: string;
}

const MAX_ROWS = 10;
const ROW_H = 72;
const ROWS_TOP = 300;

/** Baut die Teilen-Karte der ganzen Rangliste als eigenständiges 1080×1080-SVG. */
export function standingsShareCard(o: StandingsShareCardInput): string {
  const shown = o.rows.slice(0, MAX_ROWS);
  const more = o.memberCount - shown.length;
  const rowsBottom = ROWS_TOP + shown.length * ROW_H;

  const row = (r: StandingsShareRow, i: number): Html => {
    const y = ROWS_TOP + i * ROW_H;
    const podiumColor = r.rank <= 3 ? C.podium[r.rank - 1] : null;
    return html`<g transform="translate(60 ${y})">
    ${i % 2 === 1 ? html`<rect x="0" y="0" width="${W - 120}" height="${ROW_H}" fill="${C.surface2}"/>` : nothing}
    <text x="30" y="${ROW_H / 2 + 10}" font-family="${SERIF}" font-size="30" font-weight="700" fill="${podiumColor ?? C.muted}" text-anchor="middle">${r.rank}</text>
    <text x="80" y="${ROW_H / 2 + 10}" font-family="${SANS}" font-size="30" fill="${podiumColor ?? C.text}" font-weight="${podiumColor ? '700' : '400'}">${r.displayName}</text>
    <text x="${W - 180}" y="${ROW_H / 2 + 10}" font-family="${SERIF}" font-size="32" font-weight="700" fill="${podiumColor ?? C.goldBright}" text-anchor="end">${r.points}</text>
  </g>`;
  };

  return html`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rangliste von ${o.leagueName}, ${o.rows.length} Mitspieler">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="none" stroke="${C.frame}" stroke-width="2"/>
  ${crown(CX, 100, 1.05)}
  <text x="${CX}" y="184" font-family="${SERIF}" font-size="38" font-weight="700" fill="${C.goldBright}" text-anchor="middle" letter-spacing="4">${o.appName.toUpperCase()}</text>
  <text x="${CX}" y="222" font-family="${SANS}" font-size="27" fill="${C.muted}" text-anchor="middle">Rangliste – ${o.leagueName}</text>
  <line x1="${CX - 100}" y1="254" x2="${CX + 100}" y2="254" stroke="${C.gold}" stroke-width="2"/>
  ${shown.map(row)}
  ${more > 0 ? html`<text x="${CX}" y="${rowsBottom + 46}" font-family="${SANS}" font-size="24" fill="${C.muted}" text-anchor="middle">+ ${more} weitere</text>` : nothing}
  <text x="${CX}" y="${H - 48}" font-family="${SANS}" font-size="22" fill="${C.muted}" text-anchor="middle">${o.dateText} · ${o.appName}</text>
</svg>`.toString();
}
