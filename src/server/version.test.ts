import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeVersion } from './version.ts';

test('composeVersion: Haupt.Neben aus package.json, Patch = Anzahl der Commits', () => {
  assert.equal(composeVersion('0.26.0', 134), '0.26.134');
  assert.equal(composeVersion('1.2.9', 5), '1.2.5');
  assert.equal(composeVersion('0.26.0', null), '0.26.0', 'ohne Git-Verlauf bleibt die Version aus package.json');
  assert.equal(composeVersion('?', 134), '?');
});
