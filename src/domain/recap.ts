// Rückblick am Turnierende: Höhepunkte der Tipprunde und eine Karte je Mitspieler.
// Wie bei den Abzeichen wird alles aus Tipps und Ergebnissen berechnet, nichts davon wird gespeichert.

import { type BadgeKey, computeBadges } from './badges.ts';
import { matchResult } from './results.ts';
import { computeStandings, scorePrediction } from './scoring.ts';
import type { BonusAnswer, BonusQuestion, LeagueRules, Match, Member, Prediction, Side } from './types.ts';

/** Angaben zu einem Spiel, die nur die Datenbank kennt (Teamnamen, Phase). */
export interface MatchInfo {
  teamA: string | null;
  teamB: string | null;
  stage: string | null;
}

export interface RecapInput {
  members: Member[];
  matches: Match[];
  info: Map<string, MatchInfo>;
  predictions: Prediction[];
  rules: LeagueRules;
  bonusQuestions: BonusQuestion[];
  bonusAnswers: BonusAnswer[];
}

export interface TipNote {
  matchId: string;
  /** z. B. "T1 – Gen.G" */
  match: string;
  /** Getippter Sieger */
  picked: string;
  points: number;
  /** Anteil der Runde, der denselben Sieger getippt hat (0 bis 1) */
  share: number;
}

export interface PlayerRecap {
  userId: string;
  displayName: string;
  rank: number;
  points: number;
  correctWinners: number;
  exactResults: number;
  tips: number;
  bestTip: TipNote | null;
  worstTip: TipNote | null;
  bestPhase: { stage: string; points: number } | null;
  favoriteTeam: { team: string; count: number } | null;
  /** Erreichte Abzeichen, die höchsten Stufen zuerst */
  badges: { key: BadgeKey; title: string; level: 1 | 2 | 3 }[];
}

export interface Highlight {
  key: 'exakt' | 'serie' | 'aussenseiter';
  title: string;
  /** Wert, z. B. 7 */
  value: number;
  unit: string;
  names: string[];
}

export interface Recap {
  champions: { name: string; points: number }[];
  highlights: Highlight[];
  players: PlayerRecap[];
}

function teamName(info: MatchInfo | undefined, side: Side): string {
  return (side === 'A' ? info?.teamA : info?.teamB) ?? 'offen';
}

export function computeRecap(input: RecapInput): Recap {
  const { rules } = input;
  const standings = computeStandings(input);
  const time = (m: Match) => m.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const finished = input.matches.filter((m) => matchResult(m)).sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));

  // Tipps je Spiel und Anteil der Runde je Seite
  const byMatch = new Map<string, Map<string, Prediction>>();
  for (const p of input.predictions) {
    let m = byMatch.get(p.matchId);
    if (!m) byMatch.set(p.matchId, (m = new Map()));
    m.set(p.userId, p);
  }
  const shareOf = (matchId: string, side: Side): number => {
    const all = [...(byMatch.get(matchId)?.values() ?? [])];
    return all.length ? all.filter((p) => p.winner === side).length / all.length : 0;
  };

  const counts = new Map<string, { serie: number; aussen: number }>();
  const players: PlayerRecap[] = standings.map((row) => {
    const note = (m: Match, p: Prediction, points: number): TipNote => ({
      matchId: m.id,
      match: `${teamName(input.info.get(m.id), 'A')} – ${teamName(input.info.get(m.id), 'B')}`,
      picked: teamName(input.info.get(m.id), p.winner),
      points,
      share: shareOf(m.id, p.winner),
    });
    const hits: { m: Match; p: Prediction; points: number }[] = [];
    const misses: { m: Match; p: Prediction }[] = [];
    const phases = new Map<string, number>();
    const picked = new Map<string, number>();
    let tips = 0;
    for (const m of finished) {
      const p = byMatch.get(m.id)?.get(row.userId);
      if (!p) continue;
      tips++;
      const points = scorePrediction(p, m, rules).points ?? 0;
      if (points > 0) hits.push({ m, p, points });
      else misses.push({ m, p });
      const stage = input.info.get(m.id)?.stage;
      if (stage && points > 0) phases.set(stage, (phases.get(stage) ?? 0) + points);
      const team = teamName(input.info.get(m.id), p.winner);
      picked.set(team, (picked.get(team) ?? 0) + 1);
    }
    // Bester Tipp: meiste Punkte, bei Gleichstand der seltenere (weniger aus der Runde hatten ihn)
    hits.sort((a, b) => b.points - a.points || shareOf(a.m.id, a.p.winner) - shareOf(b.m.id, b.p.winner) || time(a.m) - time(b.m));
    // Schlechtester Tipp: falsch, und möglichst ganz allein damit
    misses.sort((a, b) => shareOf(a.m.id, a.p.winner) - shareOf(b.m.id, b.p.winner) || time(b.m) - time(a.m));
    const phase = [...phases].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const fav = [...picked].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const badges = computeBadges({ ...input, userId: row.userId, rank: row.rank, points: row.points });
    counts.set(row.userId, { serie: badges.find((b) => b.key === 'serie')?.value ?? 0, aussen: badges.find((b) => b.key === 'aussenseiter')?.value ?? 0 });
    return {
      userId: row.userId,
      displayName: row.displayName,
      rank: row.rank,
      points: row.points,
      correctWinners: row.correctWinners,
      exactResults: row.exactResults,
      tips,
      bestTip: hits[0] ? note(hits[0].m, hits[0].p, hits[0].points) : null,
      worstTip: misses[0] ? note(misses[0].m, misses[0].p, 0) : null,
      bestPhase: phase ? { stage: phase[0], points: phase[1] } : null,
      favoriteTeam: fav && fav[1] >= 2 ? { team: fav[0], count: fav[1] } : null,
      badges: badges.flatMap((b) => (b.level ? [{ key: b.key, title: b.title, level: b.level }] : [])).sort((a, b) => b.level - a.level),
    };
  });

  const top = (value: (p: PlayerRecap) => number): { value: number; names: string[] } => {
    const max = Math.max(0, ...players.map(value));
    return { value: max, names: max > 0 ? players.filter((p) => value(p) === max).map((p) => p.displayName) : [] };
  };
  const highlights: Highlight[] = [];
  const add = (key: Highlight['key'], title: string, unit: string, t: { value: number; names: string[] }) => {
    if (t.names.length) highlights.push({ key, title, unit, value: t.value, names: t.names });
  };
  add('exakt', 'Die meisten Volltreffer', 'Exakte Ergebnisse', top((p) => p.exactResults));
  add('serie', 'Längste Trefferserie', 'Sieger in Folge', top((p) => counts.get(p.userId)!.serie));
  add('aussenseiter', 'Bestes Außenseiter-Gespür', 'Außenseiter-Siege', top((p) => counts.get(p.userId)!.aussen));

  return {
    champions: players.filter((p) => p.rank === 1).map((p) => ({ name: p.displayName, points: p.points })),
    highlights,
    players,
  };
}
