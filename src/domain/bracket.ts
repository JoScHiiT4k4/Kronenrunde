// Turnierbaum: Spiele eines Turniers zu Phasen und Runden ordnen und berechnen, wer ausgeschieden ist.
// Reine Logik ohne Datenbank und ohne Seitenaufbau – so lässt sie sich leicht testen.
//
// Phasen entstehen aus den Namen der Abschnitte (stages):
//   "Play-In: oberes Halbfinale"  → Phase "Play-In", Runde "Upper Bracket Semifinal"
//   "Swiss: Runde 3"              → Phase "Swiss", Runde "Round 3"
//   "Viertelfinale", "Halbfinale", "Finale" → zusammen die Phase "Knockout Stage"
// Angezeigt werden die englischen Turnierbegriffe (Upper/Lower Bracket, Quarterfinals …); gespeichert bleiben die Namen aus den Daten.
//
// Wer ausgeschieden ist, richtet sich nach dem Modus der Phase:
//   Swiss   3 Siege = weiter, 3 Niederlagen = ausgeschieden (Worlds-Format)
//   Play-In doppeltes K.o.: 2 Niederlagen = ausgeschieden; wer das Finale der Phase verliert, ebenfalls
//           (nur einer kommt weiter); der Sieger des Finales ist weiter
//   K.o.    jede Niederlage = ausgeschieden; der Sieger des Finales ist Turniersieger
// Für andere Phasen (z. B. Gruppen) wird niemand als ausgeschieden markiert.

export interface BracketTeam {
  id: string;
  name: string;
  short: string | null;
}

export interface BracketMatch {
  id: string;
  /** Name des Abschnitts, z. B. "Swiss: Runde 3" */
  stage: string | null;
  stagePosition: number;
  bestOf: number;
  scheduledAt: Date | null;
  status: 'scheduled' | 'live' | 'finished' | 'cancelled';
  teamA: BracketTeam | null;
  teamB: BracketTeam | null;
  winsA: number | null;
  winsB: number | null;
}

export type PhaseKind = 'swiss' | 'doppel' | 'ko' | 'offen';

/** aktiv: noch dabei · weiter: für die nächste Phase qualifiziert · ausgeschieden · sieger: gewinnt das Finale der K.-o.-Phase */
export type TeamState = 'aktiv' | 'weiter' | 'ausgeschieden' | 'sieger';

export interface TeamRecord {
  team: BracketTeam;
  wins: number;
  losses: number;
  state: TeamState;
  /** Nummer (in zeitlicher Reihenfolge) des Spiels, mit dem das Team ausgeschieden ist */
  outAt: number | null;
  /** Nummer des Spiels, mit dem es weiter ist bzw. gewonnen hat */
  doneAt: number | null;
}

export interface Round {
  name: string;
  position: number;
  matches: BracketMatch[];
}

export interface Phase {
  name: string;
  kind: PhaseKind;
  rounds: Round[];
  matches: BracketMatch[];
  /** Teams der Phase mit Bilanz und Stand, geordnet: Siege ↓, Niederlagen ↑, Name */
  records: TeamRecord[];
  /** Reihenfolge der Spiele (0, 1, 2 …) nach Anstoß – damit "ab diesem Spiel ausgeschieden" eindeutig ist */
  order: Map<string, number>;
  /** Erster geplanter Anstoß (ms) oder Infinity */
  first: number;
}

export const SWISS_WINS = 3;
export const SWISS_LOSSES = 3;
export const DOUBLE_ELIM_LOSSES = 2;

const KNOCKOUT_PHASE = 'Knockout Stage';
const KO_STAGE = /^(?:(?:achtel|viertel|halb)?finale|playoffs?|knockouts?|round of 16|quarterfinals?|semifinals?|finals?)$/i;
const FINAL_ROUND = /^final$/i;

/** Englische Turnierbegriffe für Runden (die Daten sind teils deutsch benannt). */
const ROUND_NAMES: [RegExp, string][] = [
  [/^(?:oberes|upper(?: bracket)?) (?:halbfinale|semifinals?)$/i, 'Upper Bracket Semifinal'],
  [/^(?:unteres|lower(?: bracket)?) (?:halbfinale|semifinals?)$/i, 'Lower Bracket Semifinal'],
  [/^(?:oberes|upper(?: bracket)?) (?:finale|final)$/i, 'Upper Bracket Final'],
  [/^(?:unteres|lower(?: bracket)?) (?:finale|final)$/i, 'Lower Bracket Final'],
  [/^achtelfinale$|^round of 16$/i, 'Round of 16'],
  [/^viertelfinale$|^quarterfinals?$/i, 'Quarterfinals'],
  [/^halbfinale$|^semifinals?$/i, 'Semifinals'],
  [/^finale?$|^finals?$/i, 'Final'],
  [/^(?:runde|round) (\d+)$/i, 'Round $1'],
];

export function roundLabel(name: string): string {
  for (const [re, label] of ROUND_NAMES) if (re.test(name)) return name.replace(re, label);
  return name;
}

/** Abschnittsname für die Anzeige, z. B. "Play-In: Upper Bracket Semifinal". */
export function stageLabel(stage: string): string {
  const colon = stage.indexOf(':');
  return colon > 0 ? `${stage.slice(0, colon).trim()}: ${roundOf(stage)}` : roundOf(stage);
}

/** Phase eines Abschnitts: Teil vor dem Doppelpunkt; Viertel-/Halbfinale/Finale bilden zusammen die K.-o.-Phase. */
export function phaseOf(stage: string | null): string {
  const s = (stage ?? '').trim();
  if (!s) return 'Weitere Spiele';
  const colon = s.indexOf(':');
  if (colon > 0) return s.slice(0, colon).trim();
  return KO_STAGE.test(s) ? KNOCKOUT_PHASE : s;
}

/** Runde innerhalb der Phase: Teil nach dem Doppelpunkt, mit großem Anfangsbuchstaben und englischem Begriff. */
export function roundOf(stage: string | null): string {
  const s = (stage ?? '').trim();
  const colon = s.indexOf(':');
  const name = colon > 0 ? s.slice(colon + 1).trim() : s;
  return name ? roundLabel(name[0].toUpperCase() + name.slice(1)) : 'Spiele';
}

export function phaseKind(phase: string): PhaseKind {
  if (/swiss|schweizer/i.test(phase)) return 'swiss';
  if (/play-?in/i.test(phase)) return 'doppel';
  if (phase === KNOCKOUT_PHASE) return 'ko';
  return 'offen';
}

const time = (m: BracketMatch) => m.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;

/** Sieger und Verlierer eines beendeten Spiels mit eingetragenem Ergebnis, sonst null. */
export function outcome(m: BracketMatch): { winner: BracketTeam; loser: BracketTeam } | null {
  if (m.status !== 'finished' || !m.teamA || !m.teamB || m.winsA === null || m.winsB === null || m.winsA === m.winsB) return null;
  return m.winsA > m.winsB ? { winner: m.teamA, loser: m.teamB } : { winner: m.teamB, loser: m.teamA };
}

export function buildPhases(matches: BracketMatch[]): Phase[] {
  const byPhase = new Map<string, BracketMatch[]>();
  for (const m of matches) {
    if (m.status === 'cancelled') continue;
    const name = phaseOf(m.stage);
    byPhase.set(name, [...(byPhase.get(name) ?? []), m]);
  }

  const phases: Phase[] = [];
  for (const [name, list] of byPhase) {
    const kind = phaseKind(name);
    const roundMap = new Map<string, Round>();
    for (const m of list) {
      const rn = roundOf(m.stage);
      const r = roundMap.get(rn) ?? { name: rn, position: m.stagePosition, matches: [] };
      r.position = Math.min(r.position, m.stagePosition);
      r.matches.push(m);
      roundMap.set(rn, r);
    }
    const first = (r: Round) => Math.min(...r.matches.map(time));
    const rounds = [...roundMap.values()].sort((a, b) => a.position - b.position || first(a) - first(b) || a.name.localeCompare(b.name, 'de'));
    for (const r of rounds) r.matches.sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));

    // Spiele in zeitlicher Reihenfolge durchgehen und die Bilanz der Teams mitführen
    const chronological = [...list].sort((a, b) => time(a) - time(b) || a.stagePosition - b.stagePosition || a.id.localeCompare(b.id));
    const order = new Map(chronological.map((m, i) => [m.id, i]));
    const finalRound = rounds.find((r) => FINAL_ROUND.test(r.name));
    const records = new Map<string, TeamRecord>();
    const record = (t: BracketTeam) => {
      let r = records.get(t.id);
      if (!r) records.set(t.id, (r = { team: t, wins: 0, losses: 0, state: 'aktiv', outAt: null, doneAt: null }));
      return r;
    };
    for (const m of list) {
      if (m.teamA) record(m.teamA);
      if (m.teamB) record(m.teamB);
    }
    for (const m of chronological) {
      const o = outcome(m);
      if (!o) continue;
      const seq = order.get(m.id)!;
      const w = record(o.winner);
      const l = record(o.loser);
      w.wins++;
      l.losses++;
      const isFinal = !!finalRound && roundOf(m.stage) === finalRound.name;
      if (kind === 'swiss') {
        if (w.wins >= SWISS_WINS && w.doneAt === null) markDone(w, 'weiter', seq);
        if (l.losses >= SWISS_LOSSES && l.outAt === null) markOut(l, seq);
      } else if (kind === 'doppel') {
        if (l.losses >= DOUBLE_ELIM_LOSSES || isFinal) markOut(l, seq);
        if (isFinal) markDone(w, 'weiter', seq);
      } else if (kind === 'ko') {
        markOut(l, seq);
        if (isFinal) markDone(w, 'sieger', seq);
      }
    }

    phases.push({
      name,
      kind,
      rounds,
      matches: list,
      records: [...records.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.team.name.localeCompare(b.team.name, 'de')),
      order,
      first: Math.min(...list.map(time)),
    });
  }

  const position = (p: Phase) => Math.min(...p.rounds.map((r) => r.position));
  return phases.sort((a, b) => position(a) - position(b) || a.first - b.first || a.name.localeCompare(b.name, 'de'));
}

function markOut(r: TeamRecord, seq: number) {
  if (r.outAt !== null) return;
  r.state = 'ausgeschieden';
  r.outAt = seq;
}

function markDone(r: TeamRecord, state: 'weiter' | 'sieger', seq: number) {
  r.state = state;
  r.doneAt = seq;
}

/**
 * Wie soll ein Team in einem bestimmten Spiel gekennzeichnet werden?
 * Ausgeschieden gilt ab dem Spiel, mit dem es ausgeschieden ist (dort ist es der Verlierer) – frühere Spiele
 * bleiben unverändert, damit man den Weg des Teams sieht. Dasselbe gilt für "weiter" und "sieger".
 */
export function markFor(phase: Phase, teamId: string, matchId: string): 'ausgeschieden' | 'weiter' | 'sieger' | null {
  const rec = phase.records.find((r) => r.team.id === teamId);
  const seq = phase.order.get(matchId);
  if (!rec || seq === undefined) return null;
  if (rec.outAt !== null && seq >= rec.outAt) return 'ausgeschieden';
  if (rec.doneAt !== null && seq >= rec.doneAt && (rec.state === 'weiter' || rec.state === 'sieger')) return rec.state;
  return null;
}

/** Welche Phase soll zuerst gezeigt werden? Eine mit laufendem Spiel, sonst die mit dem nächsten offenen Spiel, sonst die letzte. */
export function currentPhase(phases: Phase[]): Phase | undefined {
  const live = phases.find((p) => p.matches.some((m) => m.status === 'live'));
  if (live) return live;
  const open = phases.find((p) => p.matches.some((m) => m.status === 'scheduled'));
  return open ?? phases.at(-1);
}
