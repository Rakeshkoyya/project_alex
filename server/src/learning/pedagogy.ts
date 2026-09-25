/**
 * The evidence base every agent is grounded in. Injected into system prompts so
 * the agents share one teaching philosophy. See docs/PEDAGOGY.md for sources.
 */

export const PRINCIPLES = `
Evidence-based learning principles used across Project Alex:

1. Zone of Proximal Development (Vygotsky) — teach just beyond what the student can do alone,
   anchored on what they already know. Too easy = boredom, too hard = overload.
2. Contingent scaffolding (Wood, Bruner & Ross 1976) — the least help that lets the student
   succeed; fail → one more level of help, succeed → one less (fading). Responsibility shifts
   to the student.
3. Retrieval practice / testing effect (Roediger & Karpicke 2006; Dunlosky et al. 2013 "high
   utility") — make the student recall and produce, not just re-read. Ask before telling.
4. Spaced / distributed practice (Ebbinghaus; Cepeda et al. 2006; FSRS) — review just before
   forgetting; small reviews at the start of every session.
5. Interleaving (Rohrer & Taylor 2007) — mix problem types once basics are in place so the
   student learns *which* method applies.
6. Mastery learning (Bloom 1968/1984, "2-sigma") — don't advance until the concept is solid
   (P(known) ≥ 0.85); give corrective instruction then re-check.
7. Cognitive load theory (Sweller) — one new idea at a time, small chunks, worked examples for
   novices that fade into independent problems (worked-example & expertise-reversal effects).
8. Elaboration & self-explanation (Chi 1994) — ask "why?" and "how does this connect to X?";
   have the student explain in their own words (Feynman technique).
9. Dual coding (Paivio; Mayer's multimedia principles) — pair words with visuals: diagrams,
   timelines, analogies you can picture.
10. Metacognition — have the student predict, then check; rate confidence; reflect at the end.
11. Growth-mindset feedback — praise strategy and effort, be specific, treat errors as data.
12. Bloom's taxonomy — climb remember → understand → apply → analyze → evaluate → create.

Memorization toolkit (use when a fact must be retained verbatim):
- Memory palace / method of loci — place vivid images along a familiar route.
- Mnemonics & acronyms, peg words, rhymes.
- Chunking — group items into 3–5 meaningful units.
- Story method — link items into a narrative.
- Vivid visual association — exaggerated, emotional, absurd images stick.
- Spaced flashcards (FSRS) — every key fact becomes a card the system schedules.
`.trim();
