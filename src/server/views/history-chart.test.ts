import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryStep } from '../../domain/history.ts';
import { historyChart } from './history-chart.ts';

const TZ = 'Europe/Berlin';

const step = (at: string, total: number, extra: Partial<HistoryStep> = {}): HistoryStep => ({
  at: new Date(at),
  gained: 0,
  total,
  label: 'A vs B',
  kind: 'spiel',
  ...extra,
});

test('historyChart: weniger als zwei Schritte → Hinweistext statt Diagramm', () => {
  assert.match(historyChart([], null, TZ).toString(), /Noch nicht genug gewertete Tipps/);
  assert.match(historyChart([step('2026-10-18T17:00:00Z', 2)], null, TZ).toString(), /Noch nicht genug gewertete Tipps/);
});

test('historyChart: zeichnet die Linie und färbt die Punkte nach Treffer ein', () => {
  const steps = [
    step('2026-10-18T17:00:00Z', 2, { gained: 2, correctWinner: true, exact: true }),
    step('2026-10-19T17:00:00Z', 2, { gained: 0, correctWinner: false, exact: false }),
    step('2026-10-20T17:00:00Z', 4, { gained: 2, correctWinner: true, exact: false }),
    step('2026-10-21T17:00:00Z', 9, { gained: 5, label: 'Sonderfragen', kind: 'sonderfragen' }),
  ];
  const svg = historyChart(steps, null, TZ).toString();
  assert.match(svg, /<svg class="history-chart"/);
  assert.match(svg, /class="history-dot history-dot-exact"/);
  assert.match(svg, /class="history-dot history-dot-miss"/);
  assert.match(svg, /class="history-dot history-dot-winner"/);
  assert.match(svg, /class="history-dot history-dot-bonus"/);
  assert.doesNotMatch(svg, /history-avg-line/); // kein Vergleich ohne average
  assert.doesNotMatch(svg, /Rundenschnitt/);
});

test('historyChart: Vergleich mit dem Rundenschnitt (über/unter/gleichauf)', () => {
  const steps = [step('2026-10-18T17:00:00Z', 2, { correctWinner: true }), step('2026-10-20T17:00:00Z', 6, { correctWinner: true })];

  const over = historyChart(steps, [0, 1, 3], TZ).toString(); // eigene 6 Punkte, Schnitt 3 → +3
  assert.match(over, /<strong class="history-dot-exact">3<\/strong> Punkte über dem Rundenschnitt/);
  assert.match(over, /class="history-avg-line"/);
  assert.match(over, /Rundenschnitt/);

  const under = historyChart(steps, [0, 1, 9], TZ).toString(); // Schnitt 9 → -3
  assert.match(under, /<strong class="history-dot-miss">3<\/strong> Punkte unter dem Rundenschnitt/);

  const even = historyChart(steps, [0, 1, 6], TZ).toString();
  assert.match(even, /genau im Rundenschnitt/);
});
