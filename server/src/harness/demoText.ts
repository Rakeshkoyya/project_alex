import { tokenize } from "../library/bm25.js";

/** Text utilities the demo brain uses to build questions from the student's own material. */

export function sentences(text: string): string[] {
  return text
    .split("\n")
    .filter((line, i) => !(i === 0 && !/[.!?]$/.test(line.trim()) && line.length < 80)) // drop a leading heading
    .join(" ")
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 260 && !/^#/.test(s));
}

/** Pick the most "teachable" word in a sentence: a long content word or a formula/term. */
export function keyTerm(sentence: string, avoid: Set<string> = new Set()): string | undefined {
  const words = sentence.match(/[A-Za-z][A-Za-z0-9₀-₉-]{3,}/g) ?? [];
  const cands = words.filter((w) => tokenize(w).length && !avoid.has(w.toLowerCase()) && !GENERIC.has(w.toLowerCase()));
  return cands.sort((a, b) => score(b) - score(a))[0];
}

const score = (w: string) => w.length + (/[A-Z0-9]/.test(w.slice(1)) ? 4 : 0) + (/[A-Z]/.test(w[0]) ? 1 : 0);

const GENERIC = new Set("because through between without another however therefore something important different example examples called means which their there these those about other using while where would could should including process things".split(" "));

export interface Cloze {
  sentence: string;
  term: string;
  prompt: string;
}

export function makeCloze(sentence: string, avoid?: Set<string>): Cloze | undefined {
  const term = keyTerm(sentence, avoid);
  if (!term) return undefined;
  const prompt = sentence.replace(new RegExp(`\\b${escape(term)}\\b`), "_____");
  if (prompt === sentence) return undefined;
  return { sentence, term, prompt };
}

export function distractors(term: string, pool: string[], n = 3): string[] {
  const seen = new Set([term.toLowerCase()]);
  const out: string[] = [];
  for (const w of pool) {
    if (out.length >= n) break;
    if (seen.has(w.toLowerCase()) || w.length < 4) continue;
    seen.add(w.toLowerCase());
    out.push(w);
  }
  const fillers = ["energy", "structure", "reaction", "function", "variable", "system", "pattern"];
  for (const f of fillers) if (out.length < n && !seen.has(f)) out.push(f);
  return out;
}

/** Deterministic shuffle so the answer isn't always option A. */
export function placeAnswer<T>(answer: T, others: T[], seed: number): T[] {
  const pos = seed % (others.length + 1);
  return [...others.slice(0, pos), answer, ...others.slice(pos)];
}

/** Build a first-letter mnemonic from key words of a sentence. */
export function acronym(sentence: string): string | undefined {
  const words = (sentence.match(/[A-Za-z]{4,}/g) ?? []).filter((w) => !GENERIC.has(w.toLowerCase())).slice(0, 5);
  if (words.length < 3) return undefined;
  return `${words.map((w) => w[0].toUpperCase()).join("")} — ${words.join(", ")}`;
}

export const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
