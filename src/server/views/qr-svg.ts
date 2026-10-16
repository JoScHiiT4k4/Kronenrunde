// Stellt eine QR-Code-Matrix (aus src/domain/qrcode.ts) als eingebettetes, skalierbares SVG
// dar – ohne Bild-Bibliothek, passt sich per CSS der verfügbaren Breite an (PC wie Handy).

import type { QrMatrix } from '../../domain/qrcode.ts';
import { html, type Html } from '../html.ts';

/** Baut ein quadratisches SVG aus der Modul-Matrix. Ruhezone (4 Module) ist eingerechnet. */
export function qrSvg(matrix: QrMatrix, className = 'qr-code'): Html {
  const quiet = 4;
  const n = matrix.size + quiet * 2;
  let path = '';
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r][c]) path += `M${c + quiet},${r + quiet}h1v1h-1z`;
    }
  }
  return html`<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" role="img" aria-label="QR-Code zum Einladungslink">
  <rect width="${n}" height="${n}" fill="#fff"/>
  <path d="${path}" fill="#000"/>
</svg>`;
}
