// Turnierbaum zeichnen: Position der Spiele und Verbindungslinien.
// Die Datenbank kennt nicht, welches Spiel in welches weiterführt – die Verbindungen ergeben sich aus der Reihenfolge:
//   K.-o.-Phase: Spiel 1 und 2 einer Runde führen ins Spiel 1 der nächsten Runde, 3 und 4 ins Spiel 2 usw.
//   Play-In (doppeltes K.o.): feste Struktur aus den Rundennamen (Upper/Lower Bracket Semifinal/Final, Final)
// Passt eine Phase in keines der Muster, gibt layoutTree null zurück und die Seite zeigt einfache Spalten.

import { type BracketMatch, type Phase } from './bracket.ts';

export const BOX_W = 250;
export const BOX_H = 92;
/** Höhe der Kopfzeile (Termin, Bo) im Kasten; darunter folgen zwei Teamzeilen */
export const META_H = 26;
export const ROW_H = 33;
const COL_GAP = 110;
const ROW_GAP = 32;
const LEFT = 52;
const TOP = 40;
/** Abstand zwischen Linienende und Kasten, damit Linien nicht in die Formen übergehen */
const PAD = 4;

export interface TreeNode {
  match: BracketMatch;
  x: number;
  y: number;
}

export interface TreeEdge {
  /** win: Sieger zieht weiter (durchgezogen) · lose: Verlierer fällt ins Lower Bracket (gestrichelt, mit Pfeil) */
  kind: 'win' | 'lose';
  d: string;
  arrow: string | null;
}

export interface TreeTitle {
  text: string;
  x: number;
  y: number;
}

export interface TreeLayout {
  width: number;
  height: number;
  nodes: TreeNode[];
  edges: TreeEdge[];
  titles: TreeTitle[];
}

const colX = (c: number) => LEFT + c * (BOX_W + COL_GAP);
const rowY = (n: TreeNode, row: 0 | 1) => n.y + META_H + ROW_H / 2 + row * ROW_H;

/** Linie vom rechten Rand eines Spiels in die Teamzeile des nächsten (Sieger zieht weiter). */
function win(from: TreeNode, to: TreeNode, row: 0 | 1): TreeEdge {
  const x1 = from.x + BOX_W + PAD;
  const y1 = from.y + BOX_H / 2;
  const y2 = rowY(to, row);
  const xm = x1 + (COL_GAP - 2 * PAD) / 2;
  return { kind: 'win', d: `M${x1},${y1} H${xm} V${y2} H${to.x - PAD}`, arrow: null };
}

function arrowDown(x: number, y: number): string {
  return `M${x - 5},${y - 8} L${x},${y} L${x + 5},${y - 8}`;
}

/** Verlierer fällt senkrecht ins Spiel darunter (gleiche Spalte, nichts dazwischen). */
function loseDown(from: TreeNode, to: TreeNode): TreeEdge {
  // rechts im Kasten, damit die Linie nicht durch die Rundenüberschrift läuft
  const x = from.x + BOX_W - 36;
  return { kind: 'lose', d: `M${x},${from.y + BOX_H + PAD} V${to.y - PAD}`, arrow: arrowDown(x, to.y - PAD) };
}

/** Verlierer läuft links am Rand entlang nach unten (ein Spiel dazwischen) und tritt in die Teamzeile ein. */
function loseGutter(from: TreeNode, to: TreeNode, lane: number, row: 0 | 1): TreeEdge {
  const gx = from.x - 16 - lane * 12;
  const y1 = from.y + BOX_H / 2;
  const y2 = rowY(to, row);
  const end = to.x - PAD;
  return { kind: 'lose', d: `M${from.x - PAD},${y1} H${gx} V${y2} H${end}`, arrow: `M${end - 8},${y2 - 5} L${end},${y2} L${end - 8},${y2 + 5}` };
}

function finish(nodes: TreeNode[], edges: TreeEdge[], titles: TreeTitle[], cols: number): TreeLayout {
  const height = Math.max(...nodes.map((n) => n.y + BOX_H)) + 16;
  return { width: colX(cols - 1) + BOX_W + 12, height, nodes, edges, titles };
}

function koTree(phase: Phase): TreeLayout | null {
  const rounds = phase.rounds;
  if (!rounds.length || rounds.some((r) => !r.matches.length)) return null;
  const cols: TreeNode[][] = [];
  for (const [c, r] of rounds.entries()) {
    const prev = cols[c - 1];
    if (c === 0) cols.push(r.matches.map((match, i) => ({ match, x: colX(0), y: TOP + i * (BOX_H + ROW_GAP) })));
    else if (prev && r.matches.length * 2 === prev.length) cols.push(r.matches.map((match, i) => ({ match, x: colX(c), y: (prev[2 * i].y + prev[2 * i + 1].y) / 2 })));
    else return null;
  }
  if (cols.length < 2) return null;
  const edges: TreeEdge[] = [];
  for (let c = 1; c < cols.length; c++) for (const [i, n] of cols[c].entries()) edges.push(win(cols[c - 1][2 * i], n, 0), win(cols[c - 1][2 * i + 1], n, 1));
  const titles = rounds.map((r, c) => ({ text: r.name, x: colX(c), y: cols[c][0].y - 10 }));
  return finish(cols.flat(), edges, titles, cols.length);
}

function doubleTree(phase: Phase): TreeLayout | null {
  const get = (name: string) => phase.rounds.find((r) => r.name === name)?.matches ?? [];
  const us = get('Upper Bracket Semifinal');
  const ls = get('Lower Bracket Semifinal');
  const uf = get('Upper Bracket Final');
  const lf = get('Lower Bracket Final');
  const f = get('Final');
  if (us.length < 1 || us.length > 2 || ls.length !== 1 || uf.length !== 1 || lf.length !== 1 || f.length !== 1) return null;
  if (phase.rounds.some((r) => !['Upper Bracket Semifinal', 'Lower Bracket Semifinal', 'Upper Bracket Final', 'Lower Bracket Final', 'Final'].includes(r.name))) return null;

  const usN = us.map((match, i): TreeNode => ({ match, x: colX(0), y: TOP + i * (BOX_H + ROW_GAP) }));
  const ufY = (usN[0].y + usN[usN.length - 1].y) / 2;
  const lowerY = TOP + us.length * (BOX_H + ROW_GAP) + 56;
  const ufN: TreeNode = { match: uf[0], x: colX(1), y: ufY };
  const lsN: TreeNode = { match: ls[0], x: colX(0), y: lowerY };
  const lfN: TreeNode = { match: lf[0], x: colX(1), y: lowerY };
  const fN: TreeNode = { match: f[0], x: colX(2), y: (ufN.y + lfN.y) / 2 };

  const edges: TreeEdge[] = [];
  for (const [i, n] of usN.entries()) {
    edges.push(win(n, ufN, i === 0 ? 0 : 1));
    // Linien kreuzen sich nicht: das obere Spiel läuft außen und tritt unten ein, das untere innen und tritt oben ein
    edges.push(loseGutter(n, lsN, us.length - 1 - i, i === 0 ? 1 : 0));
  }
  edges.push(win(lsN, lfN, 0), loseDown(ufN, lfN), win(ufN, fN, 0), win(lfN, fN, 1));

  const titles: TreeTitle[] = [
    { text: 'Upper Bracket Semifinal', x: colX(0), y: usN[0].y - 10 },
    { text: 'Upper Bracket Final', x: colX(1), y: ufN.y - 10 },
    { text: 'Lower Bracket Semifinal', x: colX(0), y: lsN.y - 10 },
    { text: 'Lower Bracket Final', x: colX(1), y: lfN.y - 10 },
    { text: 'Final', x: colX(2), y: fN.y - 10 },
  ];
  return finish([...usN, lsN, ufN, lfN, fN], edges, titles, 3);
}

/** Baum mit Linien für K.-o.-Phase und Play-In; sonst null (dann einfache Spalten). */
export function layoutTree(phase: Phase): TreeLayout | null {
  if (phase.kind === 'ko') return koTree(phase);
  if (phase.kind === 'doppel') return doubleTree(phase);
  return null;
}
