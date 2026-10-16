// Abzeichen eines Mitspielers: werden allein aus Tipps und Ergebnissen berechnet, nichts davon wird gespeichert oder gepflegt.
// Jedes Abzeichen hat bis zu drei Stufen (Bronze, Silber, Gold) und eine Zählgröße, z. B. "exakte Ergebnisse".

import { bonusPoints } from './bonus.ts';
import { matchResult } from './results.ts';
import { scorePrediction } from './scoring.ts';
import type { BonusAnswer, BonusQuestion, LeagueRules, Match, Member, Prediction } from './types.ts';

export type BadgeKey = 'volltreffer' | 'serie' | 'spieltag' | 'aussenseiter' | 'tagessieger' | 'vielspieler' | 'sonderfragen' | 'spitze';

export interface BadgeDef {
  key: BadgeKey;
  title: string;
  /** Wofür es das Abzeichen gibt, z. B. "exakte Ergebnisse getippt" */
  what: string;
  /** Benötigte Zählgröße für Bronze, Silber, Gold */
  tiers: [number, number, number];
}

export const BADGES: BadgeDef[] = [
  { key: 'volltreffer', title: 'Volltreffer', what: 'exakte Ergebnisse getippt', tiers: [1, 5, 15] },
  { key: 'serie', title: 'Trefferserie', what: 'Sieger in Folge richtig getippt', tiers: [3, 5, 8] },
  { key: 'spieltag', title: 'Perfekter Spieltag', what: 'Spieltage mit lauter richtigen Siegern (ab 3 Spielen)', tiers: [1, 3, 5] },
  { key: 'aussenseiter', title: 'Außenseiter-Gespür', what: 'Siege richtig getippt, die höchstens ein Drittel der Runde auf dem Zettel hatte', tiers: [1, 3, 6] },
  { key: 'tagessieger', title: 'Tagessieger', what: 'Spieltage mit den meisten Punkten (ab 2 Spielen)', tiers: [1, 3, 7] },
  { key: 'vielspieler', title: 'Vielspieler', what: 'gewertete Tipps abgegeben', tiers: [10, 40, 100] },
  { key: 'sonderfragen', title: 'Sonderfragen-Kenner', what: 'Sonderfragen richtig beantwortet', tiers: [1, 3, 6] },
  { key: 'spitze', title: 'An der Spitze', what: 'aktueller Platz in der Rangliste (Platz 3, 2 oder 1)', tiers: [1, 2, 3] },
];

export const TIER_NAMES = ['noch nicht erreicht', 'Bronze', 'Silber', 'Gold'] as const;

export interface BadgeResult extends BadgeDef {
  /** Aktueller Wert der Zählgröße (bei "An der Spitze": 1 bis 3 Stufen, siehe unten) */
  value: number;
  /** 0 = noch nicht erreicht, 1 = Bronze, 2 = Silber, 3 = Gold */
  level: 0 | 1 | 2 | 3;
  /** Wert für die nächste Stufe; null, wenn Gold erreicht ist */
  next: number | null;
}

export interface BadgeInput {
  userId: string;
  members: Member[];
  matches: Match[];
  predictions: Prediction[];
  rules: LeagueRules;
  bonusQuestions: BonusQuestion[];
  bonusAnswers: BonusAnswer[];
  /** Aktueller Platz des Mitspielers und seine Punkte */
  rank: number;
  points: number;
}

const levelOf = (value: number, tiers: [number, number, number]): 0 | 1 | 2 | 3 => (value >= tiers[2] ? 3 : value >= tiers[1] ? 2 : value >= tiers[0] ? 1 : 0);

/** Spieltag eines Spiels als Schlüssel: Anstoß des ersten Spiels, sonst der Kalendertag. */
function dayKey(m: Match): string {
  if (m.matchdayStartsAt) return String(m.matchdayStartsAt.getTime());
  return m.scheduledAt ? m.scheduledAt.toISOString().slice(0, 10) : 'ohne-termin';
}

export function computeBadges(input: BadgeInput): BadgeResult[] {
  const { userId, rules } = input;
  const time = (m: Match) => m.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const finished = input.matches.filter((m) => matchResult(m)).sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));

  const byMatch = new Map<string, Map<string, Prediction>>();
  for (const p of input.predictions) {
    let m = byMatch.get(p.matchId);
    if (!m) byMatch.set(p.matchId, (m = new Map()));
    m.set(p.userId, p);
  }
  const pointsOf = (m: Match, uid: string): number => {
    const p = byMatch.get(m.id)?.get(uid);
    return p ? (scorePrediction(p, m, rules).points ?? 0) : 0;
  };

  let exact = 0;
  let played = 0;
  let underdog = 0;
  let streak = 0;
  let bestStreak = 0;
  for (const m of finished) {
    const mine = byMatch.get(m.id)?.get(userId);
    const score = mine ? scorePrediction(mine, m, rules) : null;
    if (mine) played++;
    if (score?.exact) exact++;
    if (score?.correctWinner) {
      streak++;
      bestStreak = Math.max(bestStreak, streak);
      // Wie viele der Tipper haben denselben Sieger gewählt?
      const all = [...(byMatch.get(m.id)?.values() ?? [])];
      if (all.length >= 4 && all.filter((p) => p.winner === mine!.winner).length * 3 <= all.length) underdog++;
    } else {
      streak = 0;
    }
  }

  // Spieltage, an denen alle Spiele ein Ergebnis haben
  const days = new Map<string, Match[]>();
  for (const m of input.matches) {
    const k = dayKey(m);
    days.set(k, [...(days.get(k) ?? []), m]);
  }
  let perfectDays = 0;
  let dayWins = 0;
  for (const list of days.values()) {
    if (!list.every((m) => matchResult(m))) continue;
    if (list.length >= 3 && list.every((m) => byMatch.get(m.id)?.get(userId) && scorePrediction(byMatch.get(m.id)!.get(userId)!, m, rules).correctWinner)) perfectDays++;
    if (list.length >= 2) {
      const totals = input.members.map((mem) => ({ id: mem.userId, pts: list.reduce((sum, m) => sum + pointsOf(m, mem.userId), 0) }));
      const top = Math.max(...totals.map((t) => t.pts));
      if (top > 0 && totals.find((t) => t.id === userId)!.pts === top) dayWins++;
    }
  }

  const questionById = new Map(input.bonusQuestions.map((q) => [q.id, q]));
  const rightAnswers = input.bonusAnswers.filter((a) => {
    const q = questionById.get(a.questionId);
    return a.userId === userId && q && (bonusPoints(a.answer, q) ?? 0) > 0;
  }).length;

  // Platz 1 → Gold, 2 → Silber, 3 → Bronze (nur mit Punkten und mindestens drei Mitspielern)
  const top = input.points > 0 && input.members.length >= 3 && input.rank <= 3 ? 4 - input.rank : 0;

  const values: Record<BadgeKey, number> = {
    volltreffer: exact,
    serie: bestStreak,
    spieltag: perfectDays,
    aussenseiter: underdog,
    tagessieger: dayWins,
    vielspieler: played,
    sonderfragen: rightAnswers,
    spitze: top,
  };
  return BADGES.map((def) => {
    const value = values[def.key];
    const level = levelOf(value, def.tiers);
    return { ...def, value, level, next: level === 3 ? null : def.tiers[level] };
  });
}
