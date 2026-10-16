import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Ein doppelt eingefügter Block in app.js führt dazu, dass Klicks zweimal verarbeitet werden (z. B. Spoilerschutz schaltet sofort zurück)
test('public/app.js: kein Abschnitt kommt doppelt vor', () => {
  const lines = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8').split('\n');
  const headings = lines.filter((l) => /^\/\/ [^-\s]/.test(l));
  const dupes = headings.filter((h, i) => headings.indexOf(h) !== i);
  assert.deepEqual(dupes, []);
  for (const needle of ["closest('[data-spoiler]')", 'data-rank-toggle', 'form[data-auto-filter]']) {
    assert.equal(lines.filter((l) => l.includes(needle)).length, 1, `${needle} genau einmal`);
  }
});
