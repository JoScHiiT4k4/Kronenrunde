import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeQr } from '../../domain/qrcode.ts';
import { qrSvg } from './qr-svg.ts';

test('qrSvg: eigenständiges, quadratisches SVG mit Ruhezone passend zur Version', () => {
  const matrix = encodeQr('https://kronenrunde.example.de/beitreten/AB12CD34');
  const svg = qrSvg(matrix).toString();
  assert.match(svg, /^<svg class="qr-code" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 41 41"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /<rect width="41" height="41" fill="#fff"\/>/);
  assert.match(svg, /<path d="M\d/);
});

test('qrSvg: eigener CSS-Klassenname wird übernommen', () => {
  const matrix = encodeQr('x');
  const svg = qrSvg(matrix, 'andere-klasse').toString();
  assert.match(svg, /^<svg class="andere-klasse"/);
});
