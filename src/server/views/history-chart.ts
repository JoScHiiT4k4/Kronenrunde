// Eigenes SVG-Liniendiagramm für den Tippverlauf im Spielerprofil: Punkteentwicklung über die Zeit.

import type { HistoryStep } from '../../domain/history.ts';
import { formatDate } from '../format.ts';
import { html, type Html } from '../html.ts';

const W = 600;
const H = 180;
const PAD_X = 12;
const PAD_Y = 14;

const n1 = (v: number) => v.toFixed(1);

/** Linien-Diagramm der Gesamtpunktzahl über die Zeit. Mindestens 2 Punkte nötig, sonst ein Hinweistext. */
export function historyChart(steps: HistoryStep[], timeZone: string): Html {
  if (steps.length < 2) {
    return html`<p class="muted">Noch nicht genug gewertete Tipps für einen Verlauf.</p>`;
  }
  const maxY = Math.max(...steps.map((s) => s.total), 1);
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

  const dots = steps.map((s) => {
    const title = `${formatDate(s.at, timeZone)} · ${s.label}${s.gained ? ` (+${s.gained})` : ''} · ${s.total} ${s.total === 1 ? 'Punkt' : 'Punkte'}`;
    return html`<circle class="history-dot" cx="${n1(x(s.at.getTime()))}" cy="${n1(y(s.total))}" r="3.5"><title>${title}</title></circle>`;
  });

  return html`<svg class="history-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Punkteverlauf von ${formatDate(steps[0].at, timeZone)} bis ${formatDate(steps[steps.length - 1].at, timeZone)}, von 0 auf ${steps[steps.length - 1].total} Punkte">
  <path class="history-area" d="${area}"></path>
  <path class="history-line" d="${line}"></path>
  ${dots}
</svg>
<p class="history-range muted"><span>${formatDate(steps[0].at, timeZone)}</span><span>${formatDate(steps[steps.length - 1].at, timeZone)}</span></p>`;
}
