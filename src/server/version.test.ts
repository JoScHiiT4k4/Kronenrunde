import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeVersion, parseChanges } from './version.ts';

test('composeVersion: Feature erhöht die Nebenversion (Fix auf 0), Fix die dritte Zahl', () => {
  assert.equal(composeVersion('0.27.0', []), '0.27.0');
  assert.equal(composeVersion('0.27.0', ['fix']), '0.27.1');
  assert.equal(composeVersion('0.27.0', ['fix', 'fix', 'feature']), '0.28.0');
  assert.equal(composeVersion('0.27.0', ['fix', 'feature', 'fix']), '0.28.1');
  assert.equal(composeVersion('1.0.0', ['feature', 'feature']), '1.2.0', 'die erste Zahl ändert sich nie von selbst');
  assert.equal(composeVersion('0.27.0', null), '0.27.0', 'ohne Git-Verlauf bleibt die Version aus package.json');
  assert.equal(composeVersion('?', ['fix']), '?');
});

test('parseChanges: liest die Zeilen "Version: …" aus dem Commit-Verlauf', () => {
  assert.deepEqual(parseChanges('Fix\n\x1e\n\x1eFeature\n\x1e fix \x1eirgendwas\x1e'), ['fix', 'feature', 'fix']);
  assert.deepEqual(parseChanges(''), []);
});
