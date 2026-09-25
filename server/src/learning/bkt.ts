/**
 * Bayesian Knowledge Tracing (Corbett & Anderson, 1994).
 *
 * Every observed attempt on a concept updates P(known). We make the evidence
 * *hint-aware*: a correct answer given after heavy scaffolding is weaker
 * evidence of independent mastery, so the effective guess rate rises with the
 * scaffold level that was needed.
 */

export const BKT = {
  pLearn: 0.15, // chance of learning on each practice opportunity
  pSlip: 0.1, // knows it but answers wrong
  pGuess: 0.2, // doesn't know it but answers right (unaided)
};

export function bktUpdate(pKnown: number, correct: boolean, hintLevel = 0): number {
  const slip = BKT.pSlip;
  const guess = Math.min(0.6, BKT.pGuess + 0.08 * hintLevel);
  const posterior = correct
    ? (pKnown * (1 - slip)) / (pKnown * (1 - slip) + (1 - pKnown) * guess)
    : (pKnown * slip) / (pKnown * slip + (1 - pKnown) * (1 - guess));
  const next = posterior + (1 - posterior) * BKT.pLearn;
  return clamp(next, 0.01, 0.99);
}

/**
 * Initial P(known) from a diagnostic score in [0,1]. Capped below the mastery
 * threshold: a couple of right answers on a diagnostic earns "probably known,
 * confirm quickly", not "mastered" — the tutor verifies with one unaided attempt.
 */
export function priorFromScore(score: number): number {
  return clamp(0.05 + 0.75 * score, 0.05, 0.8);
}

export const MASTERY_THRESHOLD = 0.85;
export const READY_THRESHOLD = 0.6;

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
