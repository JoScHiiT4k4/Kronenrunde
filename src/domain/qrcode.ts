// Eigener, abhängigkeitsfreier QR-Code-Encoder (ISO/IEC 18004) – kein npm-Paket verfügbar
// (Netzwerk im Build gesperrt). Bewusst eingeschränkt auf das, was diese App braucht:
// Byte-Modus (für URLs: Einladungslink, später otpauth://-URIs), Versionen 1–6 (bis 41×41
// Module) und Fehlerkorrektur-Stufe M. Ab Version 7 bräuchte es zusätzlich eine eigene
// "Versions-Information" (18-Bit-BCH) – das sparen wir uns, die Versionen reichen für alle
// hier vorkommenden kurzen Texte.
//
// Nach dem offiziellen Verfahren: Reed-Solomon-Fehlerkorrektur über GF(256), BCH-kodierte
// Formatinformation, acht Maskierungsmuster mit Penalty-Bewertung (Regel 1–4 aus dem
// Standard). qrcode.test.ts liest die erzeugten Codes mit einem eigenständigen Decoder
// zurück (unabhängig von dieser Datei implementiert) und prüft so, dass sie wirklich
// lesbar sind – zusätzlich beim Entwickeln einmalig mit echten QR-Scannern (Handy-Kamera,
// OpenCV) gegengeprüft.

export interface QrMatrix {
  /** Kantenlänge in Modulen (21 bei Version 1, 25 bei Version 2, … 41 bei Version 6). */
  size: number;
  /** modules[zeile][spalte] – true = dunkel. */
  modules: boolean[][];
}

// ---------------------------------------------------------------------
// GF(256), Primitivpolynom x^8+x^4+x^3+x^2+1 = 0x11D (wie im Standard vorgeschrieben)
// ---------------------------------------------------------------------

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

/** Generatorpolynom vom gegebenen Grad: Produkt aus (x + α^i) für i = 0 … Grad-1. */
function rsGeneratorPoly(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) g = polyMul(g, [1, GF_EXP[i]]);
  return g;
}

/** Fehlerkorrektur-Codewörter für einen Datenblock (Polynomdivision über GF(256)). */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const res = data.concat(new Array<number>(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

// ---------------------------------------------------------------------
// Versionstabellen (nur Versionen 1–6, Fehlerkorrektur-Stufe M)
// ---------------------------------------------------------------------

/** Mittelpunkt-Koordinaten der Ausrichtungsmuster je Achse; Versionen 1–6 haben höchstens eins (unten rechts). */
const ALIGNMENT_COORD: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

/** Datencodewörter, EC-Codewörter je Block und Anzahl Blöcke – Stufe M. Alle Blöcke sind hier gleich groß. */
const VERSION_INFO: Record<number, { dataCodewords: number; ecPerBlock: number; blocks: number }> = {
  1: { dataCodewords: 16, ecPerBlock: 10, blocks: 1 },
  2: { dataCodewords: 28, ecPerBlock: 16, blocks: 1 },
  3: { dataCodewords: 44, ecPerBlock: 26, blocks: 1 },
  4: { dataCodewords: 64, ecPerBlock: 18, blocks: 2 },
  5: { dataCodewords: 86, ecPerBlock: 24, blocks: 2 },
  6: { dataCodewords: 108, ecPerBlock: 16, blocks: 4 },
};

export const QR_MAX_VERSION = 6;

/** Höchstens so viele Byte passen (Version 6, Stufe M, Byte-Modus) – zur Vorabprüfung durch Aufrufer. */
export const QR_MAX_BYTES = (() => {
  const info = VERSION_INFO[QR_MAX_VERSION];
  return Math.floor((info.dataCodewords * 8 - 12) / 8);
})();

// ---------------------------------------------------------------------
// Bitstrom aus den Nutzdaten (Byte-Modus) + Auswahl der kleinsten passenden Version
// ---------------------------------------------------------------------

class BitWriter {
  bits: number[] = [];
  push(value: number, len: number) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function bitsToCodewords(bits: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    out.push(byte);
  }
  return out;
}

function encodeDataCodewords(bytes: Uint8Array): { version: number; codewords: number[] } {
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    const info = VERSION_INFO[version];
    const capacityBits = info.dataCodewords * 8;
    const neededBits = 4 + 8 + bytes.length * 8; // Modus-Indikator + Längenfeld (8 Bit, Version ≤ 9) + Daten
    if (neededBits > capacityBits) continue;

    const w = new BitWriter();
    w.push(0b0100, 4); // Byte-Modus
    w.push(bytes.length, 8);
    for (const b of bytes) w.push(b, 8);
    const remaining = capacityBits - w.bits.length;
    w.push(0, Math.min(4, remaining)); // Terminator
    while (w.bits.length % 8 !== 0) w.bits.push(0);

    const codewords = bitsToCodewords(w.bits);
    const pad = [0xec, 0x11];
    for (let p = 0; codewords.length < info.dataCodewords; p++) codewords.push(pad[p % 2]);
    return { version, codewords };
  }
  throw new Error(`Text zu lang für einen QR-Code (höchstens ${QR_MAX_BYTES} Byte, Version 1–${QR_MAX_VERSION}, Byte-Modus/Stufe M).`);
}

/** Datencodewörter in Blöcke aufteilen, je Block Reed-Solomon anwenden, Daten- und EC-Teil verschränken. */
function buildFinalCodewords(version: number, dataCodewords: number[]): number[] {
  const info = VERSION_INFO[version];
  const blockSize = info.dataCodewords / info.blocks;
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let i = 0; i < info.blocks; i++) {
    const block = dataCodewords.slice(i * blockSize, (i + 1) * blockSize);
    blocks.push(block);
    ecBlocks.push(rsEncode(block, info.ecPerBlock));
  }
  const out: number[] = [];
  for (let i = 0; i < blockSize; i++) for (const b of blocks) out.push(b[i]);
  for (let i = 0; i < info.ecPerBlock; i++) for (const e of ecBlocks) out.push(e[i]);
  return out;
}

// ---------------------------------------------------------------------
// Modul-Matrix: Suchmuster, Zeitgebermuster, Ausrichtungsmuster, Formatinformation, Daten, Maskierung
// ---------------------------------------------------------------------

const FORMAT_GEN = 0x537; // Generatorpolynom für die 10-Bit-BCH-Prüfsumme der Formatinformation
const FORMAT_MASK = 0x5412; // feste XOR-Maske nach Standard

/** 15-Bit-Formatinformation (2 Bit Fehlerkorrektur-Stufe "00" = M, 3 Bit Maskennummer, 10 Bit BCH), maskiert. */
function formatInfoBits(mask: number): number {
  const data = (0b00 << 3) | mask; // Stufe M = "00"
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GEN);
  return ((data << 10) | rem) ^ FORMAT_MASK;
}

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

class Builder {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];

  constructor(version: number) {
    this.size = 17 + 4 * version;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFn(r: number, c: number, dark: boolean) {
    if (r < 0 || r >= this.size || c < 0 || c >= this.size) return;
    this.modules[r][c] = dark;
    this.isFunction[r][c] = true;
  }

  private drawFinder(cr: number, cc: number) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        this.setFn(cr + dr, cc + dc, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cr: number, cc: number) {
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) this.setFn(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }

  private drawTiming() {
    for (let i = 0; i < this.size; i++) {
      if (!this.isFunction[6][i]) this.setFn(6, i, i % 2 === 0);
      if (!this.isFunction[i][6]) this.setFn(i, 6, i % 2 === 0);
    }
  }

  private drawFormat(mask: number) {
    const bits = formatInfoBits(mask);
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFn(i, 8, bit(i));
    this.setFn(7, 8, bit(6));
    this.setFn(8, 8, bit(7));
    this.setFn(8, 7, bit(8));
    for (let i = 9; i < 15; i++) this.setFn(8, 14 - i, bit(i));
    for (let i = 0; i < 8; i++) this.setFn(8, this.size - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) this.setFn(this.size - 15 + i, 8, bit(i));
    this.setFn(this.size - 8, 8, true); // dunkles Modul, fest
  }

  private drawFunctionPatterns(version: number) {
    this.drawFinder(3, 3);
    this.drawFinder(3, this.size - 4);
    this.drawFinder(this.size - 4, 3);
    const coords = ALIGNMENT_COORD[version];
    if (coords.length) this.drawAlignment(coords[coords.length - 1], coords[coords.length - 1]);
    this.drawTiming();
    this.drawFormat(0); // reserviert die Felder schon mal (Platzhalter-Maske 0)
  }

  private drawCodewords(codewords: number[]) {
    const bitLen = codewords.length * 8;
    const bitAt = (i: number) => ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[r][c] && i < bitLen) {
            this.modules[r][c] = bitAt(i);
            i++;
          }
        }
      }
    }
  }

  private applyMask(mask: number) {
    const fn = MASK_FN[mask];
    for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) if (!this.isFunction[r][c] && fn(r, c)) this.modules[r][c] = !this.modules[r][c];
  }

  private penalty(): number {
    const n = this.size;
    const m = this.modules;
    let total = 0;

    // Regel 1: 5+ gleichfarbige Module in Folge, je Zeile und Spalte
    const runPenalty = (get: (i: number) => boolean) => {
      let runLen = 1;
      let prev = get(0);
      for (let i = 1; i < n; i++) {
        const v = get(i);
        if (v === prev) runLen++;
        else {
          if (runLen >= 5) total += 3 + (runLen - 5);
          runLen = 1;
          prev = v;
        }
      }
      if (runLen >= 5) total += 3 + (runLen - 5);
    };
    for (let r = 0; r < n; r++) runPenalty((c) => m[r][c]);
    for (let c = 0; c < n; c++) runPenalty((r) => m[r][c]);

    // Regel 2: 2×2-Blöcke gleicher Farbe
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const v = m[r][c];
        if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) total += 3;
      }
    }

    // Regel 3: Suchmuster-ähnliches Verhältnis 1:1:3:1:1 (mit 4 hellen Modulen Abstand)
    const PAT_A = [true, false, true, true, true, false, true, false, false, false, false];
    const PAT_B = [false, false, false, false, true, false, true, true, true, false, true];
    const matches = (get: (i: number) => boolean, start: number) => {
      for (const pat of [PAT_A, PAT_B]) {
        let ok = true;
        for (let i = 0; i < 11; i++) if (get(start + i) !== pat[i]) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    };
    for (let r = 0; r < n; r++) for (let c = 0; c + 11 <= n; c++) if (matches((i) => m[r][i], c)) total += 40;
    for (let c = 0; c < n; c++) for (let r = 0; r + 11 <= n; r++) if (matches((i) => m[i][c], r)) total += 40;

    // Regel 4: Anteil dunkler Module möglichst nah an 50 %
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) dark++;
    const percent = (dark * 100) / (n * n);
    const prevMultiple = Math.floor(percent / 5) * 5;
    const a = Math.abs(prevMultiple - 50) / 5;
    const b = Math.abs(prevMultiple + 5 - 50) / 5;
    total += Math.min(a, b) * 10;

    return total;
  }

  build(version: number, codewords: number[]): QrMatrix {
    this.drawFunctionPatterns(version);
    this.drawCodewords(codewords);

    let bestMask = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormat(mask);
      const p = this.penalty();
      if (p < bestPenalty) {
        bestPenalty = p;
        bestMask = mask;
      }
      this.applyMask(mask); // rückgängig (XOR ist selbstinvers)
    }
    this.applyMask(bestMask);
    this.drawFormat(bestMask);

    return { size: this.size, modules: this.modules };
  }
}

/** Erzeugt einen QR-Code (Byte-Modus, Stufe M, Version 1–6) für den gegebenen Text (als UTF-8-Bytes kodiert). */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const { version, codewords: dataCodewords } = encodeDataCodewords(bytes);
  const final = buildFinalCodewords(version, dataCodewords);
  return new Builder(version).build(version, final);
}
