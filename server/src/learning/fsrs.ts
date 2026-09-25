/**
 * FSRS (Free Spaced Repetition Scheduler) — compact implementation of the
 * DSR memory model (Difficulty, Stability, Retrievability) with the FSRS-4.5
 * default weights. Used for the student's flashcards / "points to remember"
 * so review lands just before they would be forgotten (distributed practice +
 * retrieval practice: the two "high utility" techniques in Dunlosky et al. 2013).
 */
import type { Flashcard } from "../store/types.js";

const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const F = 19 / 81;
const C = -0.5;
export const DESIRED_RETENTION = 0.9;

export type Rating = 1 | 2 | 3 | 4; // again | hard | good | easy

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const DAY = 86_400_000;

export function retrievability(elapsedDays: number, stability: number) {
  return Math.pow(1 + (F * elapsedDays) / stability, C);
}

export function intervalDays(stability: number, retention = DESIRED_RETENTION) {
  return Math.max(1, Math.round((stability / F) * (Math.pow(retention, 1 / C) - 1)));
}

const initialDifficulty = (g: Rating) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);

export function newCardState(now = new Date()): Pick<Flashcard, "stability" | "difficulty" | "reps" | "lapses" | "due"> {
  // New cards are due immediately so they get a first retrieval attempt.
  return { stability: 0, difficulty: 0, reps: 0, lapses: 0, due: now.toISOString() };
}

export function review(card: Flashcard, rating: Rating, now = new Date()): Flashcard {
  let { stability: s, difficulty: d } = card;
  if (card.reps === 0 || s === 0) {
    s = W[rating - 1];
    d = initialDifficulty(rating);
  } else {
    const elapsed = card.lastReview ? (now.getTime() - new Date(card.lastReview).getTime()) / DAY : 0;
    const r = retrievability(Math.max(0, elapsed), s);
    if (rating === 1) {
      s = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
    } else {
      const hard = rating === 2 ? W[15] : 1;
      const easy = rating === 4 ? W[16] : 1;
      s = s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1);
    }
    const dNext = d - W[6] * (rating - 3);
    d = clampD(W[7] * initialDifficulty(4) + (1 - W[7]) * dNext);
  }
  const days = rating === 1 ? 0 : intervalDays(s);
  const due = new Date(now.getTime() + (rating === 1 ? 10 * 60_000 : days * DAY));
  return {
    ...card,
    stability: s,
    difficulty: d,
    reps: card.reps + 1,
    lapses: card.lapses + (rating === 1 ? 1 : 0),
    lastReview: now.toISOString(),
    due: due.toISOString(),
  };
}

export const isDue = (card: Flashcard, now = new Date()) => new Date(card.due).getTime() <= now.getTime();
