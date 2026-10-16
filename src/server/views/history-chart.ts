// Eigenes SVG-Liniendiagramm für den Tippverlauf im Spielerprofil: Punkteentwicklung über die Zeit,
// zum Vergleich daneben der Rundenschnitt, und jeder Tipp als Punkt eingefärbt nach Treffer (exakt/
// nur Sieger/falsch) – damit sich auf einen Blick ablesen lässt, ob's gerade gut läuft.

import type { HistoryStep } from '../../domain/history.ts';
import { formatDate } from '../format.ts';
import { html, nothing, type Html } from '../html.ts';

const W = 600;
const H = 180;
const PAD_X = 12;
const PAD_Y = 14;

const n1 = (v: number) => v.toFixed(1);

function dotClass(s: HistoryStep): string {
  if (s.kind === 'sonderfragen') return 'history-dot history-dot-bonus';
  if (s.exact) return 'history-dot history-dot-exact';
  if (s.correctWinner) return 'history-dot history-dot-winner';
  return 'history-dot history-dot-miss';
}

/**
 * Linien-Diagramm der Gesamtpunktzahl über die Zeit, mit dem Rundenschnitt zum Vergleich.
 * `average` sind die Durchschnittswerte an denselben Zeitpunkten wie die Linie (ein Wert mehr,
 * nämlich auch für den Start-Punkt bei 0) – oder null, wenn kein Vergleich möglich ist (z. B. nur
 * ein Mitglied). Mindestens 2 Schritte nötig, sonst ein Hinweistext.
 */
export function historyChart(steps: HistoryStep[], average: number[] | null, timeZone: string): Html {
  if (steps.length < 2) {
    return html`<p class="muted">Noch nicht genug gewertete Tipps für einen Verlauf.</p>`;
  }
  const hasAverage = !!average && average.length === steps.length + 1;
  const maxY = Math.max(...steps.map((s) => s.total), ...(hasAverage ? average! : []), 1);
  const minT = steps[0].at.getTime();
  const maxT = steps[steps.length - 1].at.getTime();
  const spanT = Math.max(maxT - minT, 1);

  const x = (t: number) => PAD_X + ((t - minT) / spanT) * (W - PAD_X * 2);
  const y = (v: number) => H - PAD_Y - (v / maxY) * (H - PAD_Y * 2);

  // Linie beginnt bei 0, kurz vor dem ersten gewerteten Tipp.
  const points = [{ x: x(minT), y: y(0) }, ...steps.map((s) => ({ x: x(s.at.getTime()), y: y(s.total) }))];
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n1(p.x)},${n1(p.y)}`).join(' ');
  const base = n1(H - PAD_Y);
  const area = `${line} L${n1(points[points.length - 1].x)},${base} L${n1(points[0].x)},${base} Z`;

  const avgLine = hasAverage ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n1(p.x)},${n1(y(average![i]))}`).join(' ') : null;

  const dots = steps.map((s) => {
    const result = s.kind === 'sonderfragen' ? '' : ` · ${s.exact ? 'exakt richtig' : s.correctWinner ? 'Sieger richtig' : 'falsch getippt'}`;
    const title = `${formatDate(s.at, timeZone)} · ${s.label}${result}${s.gained ? ` (+${s.gained})` : ''} · ${s.total} ${s.total === 1 ? 'Punkt' : 'Punkte'}`;
    return html`<circle class="${dotClass(s)}" cx="${n1(x(s.at.getTime()))}" cy="${n1(y(s.total))}" r="3.5"><title>${title}</title></circle>`;
  });

  const ownTotal = steps[steps.length - 1].total;
  const diff = hasAverage ? Math.round((ownTotal - average![average!.length - 1]) * 10) / 10 : null;
  const comparison =
    diff === null
      ? nothing
      : html`<p class="history-comparison muted">${
          diff > 0 ? html`<strong class="history-dot-exact">${diff}</strong> Punkte über dem Rundenschnitt` : diff < 0 ? html`<strong class="history-dot-miss">${-diff}</strong> Punkte unter dem Rundenschnitt` : html`genau im Rundenschnitt`
        }</p>`;

  return html`${comparison}<svg class="history-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Punkteverlauf von ${formatDate(steps[0].at, timeZone)} bis ${formatDate(steps[steps.length - 1].at, timeZone)}, von 0 auf ${ownTotal} Punkte">
  <path class="history-area" d="${area}"></path>
  ${avgLine ? html`<path class="history-avg-line" d="${avgLine}"></path>` : nothing}
  <path class="history-line" d="${line}"></path>
  ${dots}
</svg>
<p class="history-range muted"><span>${formatDate(steps[0].at, timeZone)}</span><span>${formatDate(steps[steps.length - 1].at, timeZone)}</span></p>
<p class="history-legend muted">
  <span><i class="history-dot-exact"></i> exakt richtig</span>
  <span><i class="history-dot-winner"></i> Sieger richtig</span>
  <span><i class="history-dot-miss"></i> falsch</span>
  ${hasAverage ? html`<span><i class="history-avg-swatch"></i> Rundenschnitt</span>` : nothing}
</p>`;
}
