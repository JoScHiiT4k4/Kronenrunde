import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes, formatUptime, parseLoadavg, parseMeminfo, percent } from './system-info.ts';

test('meminfo: belegt = gesamt minus verfügbar, Swap nur wenn vorhanden', () => {
  const t = 'MemTotal:        4000000 kB\nMemFree:          100000 kB\nMemAvailable:    3000000 kB\nSwapTotal:        200000 kB\nSwapFree:         150000 kB\n';
  const r = parseMeminfo(t);
  assert.equal(r.memory!.total, 4000000 * 1024);
  assert.equal(r.memory!.used, 1000000 * 1024);
  assert.equal(percent(r.memory), 25);
  assert.equal(r.swap!.used, 50000 * 1024);
  assert.equal(parseMeminfo('MemTotal: 10 kB\nMemAvailable: 5 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB').swap, null);
  assert.equal(parseMeminfo('Unsinn').memory, null);
});

test('Last, Größen und Laufzeit lesbar', () => {
  assert.deepEqual(parseLoadavg('0.52 0.40 0.31 1/200 1234'), [0.52, 0.4, 0.31]);
  assert.equal(parseLoadavg('kaputt'), null);
  assert.equal(formatBytes(1536 * 1024 * 1024), '1,5 GB');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatUptime(3 * 86400 + 4 * 3600 + 60), '3 Tage 4 Std.');
  assert.equal(formatUptime(5 * 3600 + 12 * 60), '5 Std. 12 Min.');
  assert.equal(percent(null), 0);
});
