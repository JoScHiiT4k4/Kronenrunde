// Abzeichen im Profil: kleine Symbole (SVG, nur Attribute und Klassen – keine Inline-Styles wegen der Content-Security-Policy).

import { html, type Html } from '../html.ts';
import { type BadgeKey, type BadgeResult, TIER_NAMES } from '../../domain/badges.ts';

/** Zeichnungen im Raster 24×24 (Linien, die Farbe kommt aus dem CSS) */
const ICONS: Record<BadgeKey, Html> = {
  // Zielscheibe
  volltreffer: html`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" class="badge-fill"/>`,
  // Blitz
  serie: html`<path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z" class="badge-fill"/>`,
  // Kalender mit Haken
  spieltag: html`<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M8.5 15l2.5 2.5 4.5-5"/>`,
  // Glühbirne
  aussenseiter: html`<path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/><path d="M9.5 19h5M10.5 21.5h3"/>`,
  // Pokal
  tagessieger: html`<path d="M7.5 4h9v5.5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6H4v1.5A3 3 0 0 0 7 10.5M16.5 6H20v1.5a3 3 0 0 1-3 3M12 14v4M8.5 20.5h7"/>`,
  // Stift
  vielspieler: html`<path d="M4 20l1-4.5L15.8 4.7a1.6 1.6 0 0 1 2.3 0l1.2 1.2a1.6 1.6 0 0 1 0 2.3L8.5 19z"/><path d="M14 6.5l3.5 3.5"/>`,
  // Fragezeichen im Kreis
  sonderfragen: html`<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1 1-1.1 1.8"/><circle cx="12" cy="16.8" r="0.5" class="badge-fill"/>`,
  // Krone
  spitze: html`<path d="M3.5 8l4.2 4L12 5l4.3 7 4.2-4-1.8 11H5.3z" class="badge-fill"/>`,
};

/** Ein Abzeichen: Sechseck in Bronze/Silber/Gold (oder grau, solange noch nicht erreicht) mit dem Symbol darin. */
export function badgeIcon(key: BadgeKey, level: number): Html {
  return html`<svg class="badge-icon badge-l${level}" viewBox="0 0 56 56" width="56" height="56" aria-hidden="true" focusable="false">
    <polygon class="badge-hex" points="28,2 51,15 51,41 28,54 5,41 5,15"/>
    <g class="badge-glyph" transform="translate(16 16)" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</g>
  </svg>`;
}

function progressText(b: BadgeResult): string {
  if (b.key === 'spitze') return b.level === 0 ? 'Unter die ersten drei kommen' : b.level === 3 ? 'Führt die Rangliste an' : `Aktuell Platz ${4 - b.level}`;
  if (b.level === 3) return `${b.value} ${b.what}`;
  const nextName = TIER_NAMES[b.level + 1];
  return `${b.value} von ${b.next} ${b.what} – bis ${nextName}`;
}

export function badgeGrid(badges: BadgeResult[]): Html {
  return html`<ul class="badge-grid">${badges.map(
    (b) => html`<li class="badge-card badge-l${b.level}">
    ${badgeIcon(b.key, b.level)}
    <div class="badge-text">
      <strong>${b.title}</strong>
      <span class="badge-tier">${b.level ? TIER_NAMES[b.level] : 'noch nicht erreicht'}</span>
      <small>${progressText(b)}</small>
    </div>
  </li>`,
  )}</ul>`;
}
