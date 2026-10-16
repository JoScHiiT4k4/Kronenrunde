import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QR_MAX_BYTES, encodeQr } from './qrcode.ts';

// Unabhängiger Mini-Decoder, nur für diese Tests: liest eine erzeugte Matrix nach dem
// offiziellen Verfahren zurück zu Text (Format-Info per BCH prüfen → Maske ermitteln →
// Zick-Zack-Codewörter lesen → Reed-Solomon gegenprüfen → Byte-Modus dekodieren). Das prüft
// den Encoder unabhängig von seiner eigenen internen Logik, nicht nur, dass er sich selbst
// widerspruchsfrei ist.

const GF_EXP = new Array<number>(512).fill(0);
const GF_LOG = new Array<number>(256).fill(0);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
function polyMul(a: number[], b: number[]): number[] {
  const res = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) res[i + j] ^= gfMul(a[i], b[j]);
  return res;
}
function rsGeneratorPoly(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) g = polyMul(g, [1, GF_EXP[i]]);
  return g;
}
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const res = data.concat(new Array<number>(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

const VERSION_INFO: Record<number, { dataCodewords: number; ecPerBlock: number; blocks: number }> = {
  1: { dataCodewords: 16, ecPerBlock: 10, blocks: 1 },
  2: { dataCodewords: 28, ecPerBlock: 16, blocks: 1 },
  3: { dataCodewords: 44, ecPerBlock: 26, blocks: 1 },
  4: { dataCodewords: 64, ecPerBlock: 18, blocks: 2 },
  5: { dataCodewords: 86, ecPerBlock: 24, blocks: 2 },
  6: { dataCodewords: 108, ecPerBlock: 16, blocks: 4 },
};

const FORMAT_GEN = 0x537;
const FORMAT_MASK = 0x5412;

const MASK_FN: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function decodeQr(matrix: { size: number; modules: boolean[][] }): string {
  const { size, modules } = matrix;
  const version = (size - 17) / 4;
  const info = VERSION_INFO[version];
  if (!info) throw new Error(`Unerwartete Version für Größe ${size}`);

  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) isFunction[r][c] = true;
  };
  const markFinder = (cr: number, cc: number) => {
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) mark(cr + dr, cc + dc);
  };
  const ALIGNMENT_COORD: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
  const markAlignment = (cr: number, cc: number) => {
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(cr + dr, cc + dc);
  };

  markFinder(3, 3);
  markFinder(3, size - 4);
  markFinder(size - 4, 3);
  const alignCoords = ALIGNMENT_COORD[version];
  if (alignCoords.length) markAlignment(alignCoords[alignCoords.length - 1], alignCoords[alignCoords.length - 1]);
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (let i = 0; i <= 5; i++) mark(i, 8);
  mark(7, 8);
  mark(8, 8);
  mark(8, 7);
  for (let i = 9; i < 15; i++) mark(8, 14 - i);
  for (let i = 0; i < 8; i++) mark(8, size - 1 - i);
  for (let i = 8; i < 15; i++) mark(size - 15 + i, 8);
  mark(size - 8, 8);

  // Format-Info (erste Kopie) lesen und per BCH gegenprüfen – Bit i sitzt genau dort, wo der
  // Encoder es hinschreibt (bit(i) = (wert >>> i) & 1, also Zeile 0 = Bit 0, nicht Bit 14).
  const bit = (r: number, c: number) => (modules[r][c] ? 1 : 0);
  let masked = 0;
  const setBit = (i: number, v: number) => {
    if (v) masked |= 1 << i;
  };
  for (let i = 0; i <= 5; i++) setBit(i, bit(i, 8));
  setBit(6, bit(7, 8));
  setBit(7, bit(8, 8));
  setBit(8, bit(8, 7));
  for (let i = 9; i < 15; i++) setBit(i, bit(8, 14 - i));
  const unmasked = masked ^ FORMAT_MASK;
  const data = unmasked >>> 10;
  const ecLevel = data >>> 3;
  const mask = data & 0b111;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GEN);
  assert.equal(((data << 10) | rem) >>> 0, unmasked, 'Format-Info-BCH stimmt nicht');
  assert.equal(ecLevel, 0b00, 'Fehlerkorrektur-Stufe muss M sein');

  const fn = MASK_FN[mask];
  const unmaskedModules = modules.map((row, r) => row.map((v, c) => (!isFunction[r][c] && fn(r, c) ? !v : v)));

  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!isFunction[r][c]) bits.push(unmaskedModules[r][c] ? 1 : 0);
      }
    }
  }

  const totalCodewords = info.dataCodewords + info.ecPerBlock * info.blocks;
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= totalCodewords * 8; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ?? 0);
    codewords.push(b);
  }

  // Codewörter liegen blockweise verschränkt (wie im Encoder zusammengesetzt): erst Byte 0
  // jedes Blocks, dann Byte 1 jedes Blocks, … – erst für die Nutzdaten, dann für die EC-Bytes.
  const blockSize = info.dataCodewords / info.blocks;
  const dataPart = codewords.slice(0, blockSize * info.blocks);
  const ecPart = codewords.slice(blockSize * info.blocks, blockSize * info.blocks + info.ecPerBlock * info.blocks);
  const dataBlocks: number[][] = Array.from({ length: info.blocks }, () => []);
  for (let i = 0; i < blockSize; i++) for (let b = 0; b < info.blocks; b++) dataBlocks[b].push(dataPart[i * info.blocks + b]);
  const ecBlocks: number[][] = Array.from({ length: info.blocks }, () => []);
  for (let i = 0; i < info.ecPerBlock; i++) for (let b = 0; b < info.blocks; b++) ecBlocks[b].push(ecPart[i * info.blocks + b]);
  for (let i = 0; i < info.blocks; i++) {
    const computedEc = rsEncode(dataBlocks[i], info.ecPerBlock);
    assert.deepEqual(computedEc, ecBlocks[i], `Reed-Solomon-Prüfung fehlgeschlagen in Block ${i}`);
  }

  // Die logischen Nutzdaten sind die Blöcke in Reihenfolge hintereinander (vor der
  // Verschränkung für die Übertragung) – mode/Länge/Bytes liegen also schlicht byteweise vor.
  const allData = dataBlocks.flat();
  const mode = allData[0] >>> 4;
  assert.equal(mode, 0b0100, 'Es wird nur Byte-Modus unterstützt');
  const len = ((allData[0] & 0xf) << 4) | (allData[1] >>> 4);
  const out: number[] = [];
  for (let k = 0; k < len; k++) {
    const byte1 = allData[1 + k] << 4;
    const byte2 = allData[2 + k] >>> 4;
    out.push((byte1 | byte2) & 0xff);
  }
  return Buffer.from(out).toString('utf8');
}

test('encodeQr: kurzer Text (Version 1) lässt sich korrekt zurückdekodieren', () => {
  const text = 'HALLO';
  const matrix = encodeQr(text);
  assert.equal(matrix.size, 21);
  assert.equal(decodeQr(matrix), text);
});

test('encodeQr: Einladungslink lässt sich korrekt zurückdekodieren', () => {
  const text = 'https://kronenrunde.example.de/beitreten/AB12CD34';
  const matrix = encodeQr(text);
  assert.equal(decodeQr(matrix), text);
});

test('encodeQr: längerer Text wählt eine größere Version und bleibt lesbar', () => {
  const text = 'https://kronenrunde.example.de/r/die-rift-runde/beitreten/abcdefghijklmnop0123456789ABCDEFGHIJKLMNOPabcd';
  const matrix = encodeQr(text);
  assert.ok(matrix.size > 21);
  assert.equal(decodeQr(matrix), text);
});

test('encodeQr: ein einzelnes Zeichen', () => {
  const matrix = encodeQr('A');
  assert.equal(decodeQr(matrix), 'A');
});

test('encodeQr: Sonderzeichen/Umlaute (UTF-8) bleiben nach dem Decodieren erhalten', () => {
  const text = 'ä ö ü ß € – kurzer Text mit Sonderzeichen';
  const matrix = encodeQr(text);
  assert.equal(decodeQr(matrix), text);
});

test('encodeQr: Text an der Kapazitätsgrenze (Version 6) wird noch codiert', () => {
  const text = 'x'.repeat(QR_MAX_BYTES);
  const matrix = encodeQr(text);
  assert.equal(matrix.size, 41);
  assert.equal(decodeQr(matrix), text);
});

test('encodeQr: Text über der Kapazitätsgrenze wirft einen verständlichen Fehler', () => {
  assert.throws(() => encodeQr('x'.repeat(QR_MAX_BYTES + 1)), /zu lang/);
});

test('encodeQr: jede Version 1–6 erzeugt eine quadratische, zur Version passende Matrix', () => {
  // Für jede Version die größte Byte-Zahl nehmen, die gerade noch in diese (und keine kleinere) passt
  for (const [version, info] of Object.entries(VERSION_INFO)) {
    const maxBytes = Math.floor((info.dataCodewords * 8 - 12) / 8);
    const text = 'a'.repeat(maxBytes);
    const matrix = encodeQr(text);
    const expectedSize = 17 + 4 * Number(version);
    assert.equal(matrix.size, expectedSize, `Version ${version} sollte Größe ${expectedSize} ergeben`);
    assert.equal(decodeQr(matrix), text);
  }
});
