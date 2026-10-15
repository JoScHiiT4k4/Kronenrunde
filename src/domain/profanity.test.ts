import { test } from 'node:test';
import assert from 'node:assert/strict';

import { maskProfanity } from './profanity.ts';

test('Schimpfwörter werden durch Sterne ersetzt, normale Wörter bleiben', () => {
  assert.equal(maskProfanity('Du Arsch!'), 'Du *****!');
  assert.equal(maskProfanity('So ein Scheiß, verdammt'), 'So ein ******, verdammt');
  assert.equal(maskProfanity('what the FUCK'), 'what the ****');
  assert.equal(maskProfanity('Fickt euch'), '***** euch');
  assert.equal(maskProfanity('Du Arschloch-Team'), 'Du **************');
});

test('Harmlose Wörter mit ähnlichen Buchstaben bleiben unberührt', () => {
  for (const ok of ['Passage', 'Klassiker', 'Assist', 'Hurrikan', 'Tickets', 'Dicke Luft', 'Mongolei', 'Skandinavien', 'Spaß', 'Analyse', 'Kassel', 'Bastian']) {
    assert.equal(maskProfanity(ok), ok, ok);
  }
});

test('Satzzeichen, Umlaute und Länge bleiben erhalten', () => {
  assert.equal(maskProfanity('Wichser, echt jetzt?'), '*******, echt jetzt?');
  assert.equal(maskProfanity('Hurensohn'), '*********');
});
