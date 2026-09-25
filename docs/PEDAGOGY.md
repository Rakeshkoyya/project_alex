# Teaching method

Alex teaches the way the best one-to-one tutors do, using techniques that have strong research behind them. Each principle below is either written into the agents' prompts (`server/src/learning/pedagogy.ts`) or enforced in code, so it doesn't depend on the model remembering to do it.

## Core: the Zone of Proximal Development

**Vygotsky's ZPD** is the band between what a learner can do alone and what they can't do yet, even with help. Learning happens in that band. Alex puts it into practice with the **ZPD engine** (`server/src/learning/zpd.ts`):

| Idea | Research | How Alex implements it |
|---|---|---|
| Anchor on prior knowledge | Vygotsky; Ausubel ("the most important factor is what the learner already knows") | The Advisor's concept map includes foundations (depth 1, 2, …). The diagnostic probes them, and the roadmap starts where solid ground ends. |
| Contingent scaffolding | Wood, Bruner & Ross (1976); Wood & Middleton "contingent shift" | A 6-level ladder: try alone → metacognitive nudge → conceptual hint → specific hint → worked example → step down. `record_attempt` returns the next move: **fail → one level more help, succeed → one level less (fading)**. |
| Step down to the missing basics | Knowledge-space / prerequisite-graph tutoring | A student who fails even after a worked example has a gap *below* the concept. The engine walks the prerequisite graph and returns the weakest, most basic foundation first. The Tutor can also `add_prerequisite` when it finds a gap that isn't on the map yet, e.g. grade-5 fractions under grade-9 chemistry. |
| Frontier | ZPD, mastery learning | A concept is "ready" only when its prerequisites are at P(known) ≥ 0.6. The roadmap's current module comes first. |

## Knowing what the student knows

* **Bayesian Knowledge Tracing** (Corbett & Anderson, 1994), in `bkt.ts`. Every practice attempt and quiz answer updates P(known) per concept. Alex's version accounts for hints: a correct answer after a worked example counts as weaker evidence of mastery than an unaided one.
* **Mastery learning** (Bloom, 1968; the "2-sigma" tutoring result, 1984). Mastery means P(known) ≥ 0.85. A roadmap module is marked done only when all of its concepts are mastered.
* **Diagnostic priors are capped at 0.8.** A right answer on a diagnostic means "probably known, confirm quickly", not "mastered".

## Making it stick

* **Retrieval practice / the testing effect** (Roediger & Karpicke, 2006). Dunlosky et al. (2013) rate it one of the two highest-utility techniques. The Tutor asks before it tells, every session ends with a lock-in quiz, and flashcards ask for recall before revealing the answer.
* **Spaced repetition** (Ebbinghaus; Cepeda et al., 2006). This is the other "high utility" technique. Flashcards are scheduled with **FSRS** (the Difficulty–Stability–Retrievability model, FSRS-4.5 weights) at 90% target retention, in `fsrs.ts`. Due reviews open each session plan.
* **Interleaving** (Rohrer & Taylor, 2007). Once the basics are in place, challenges mix in earlier modules.
* **Elaboration and self-explanation** (Chi, 1994) and the **Feynman technique**. The Tutor asks "why?", asks the student to explain ideas back, and uses short-answer items graded against a rubric.
* **Cognitive load theory** (Sweller) and the **worked-example / expertise-reversal effects**. One idea at a time, in small chunks. Worked examples are for novices and fade into independent problems.
* **Dual coding** (Paivio; Mayer's multimedia principles). The Tutor calls `show_artifact` for visuals. The Generations engine that renders them is parked, so for now the Tutor describes the visual in words.
* **Metacognition and growth-mindset feedback.** The Tutor prompts reflection, praises strategy rather than talent, and treats errors as information.

## Memorization toolkit

Facts that must be kept word for word become "points to remember" with a memory aid, and each one also becomes an FSRS flashcard:

* **Memory palace / method of loci**: vivid images placed along a familiar route.
* **Mnemonics and acronyms**, peg words, rhymes.
* **Chunking**: grouping items into 3–5 meaningful units.
* **Story method**: linking items into one narrative.
* **Vivid visual association**: exaggerated, absurd, emotional images.
* **Analogy and elaboration** for conceptual facts.

## Unbiased assessment

The **Editorial** role is a separate examiner. It never teaches during an assessment. Objective items (MCQ, true/false, numeric) are graded **in code**, and only open-ended answers go to Editorial, graded against a rubric. Grades update the knowledge model, and the examiner's report goes into the student's record.

## Sources

* Dunlosky, Rawson, Marsh, Nathan & Willingham (2013). *Improving Students' Learning With Effective Learning Techniques.* Psychological Science in the Public Interest. — https://journals.sagepub.com/doi/abs/10.1177/1529100612453266 · summary: https://www.aft.org/ae/fall2013/dunlosky
* Wood, Bruner & Ross (1976). *The role of tutoring in problem solving.* — overview: https://www.simplypsychology.org/zone-of-proximal-development.html
* FSRS algorithm — https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm · https://borretti.me/article/implementing-fsrs-in-100-lines
* Bloom (1984). *The 2 Sigma Problem.* Educational Researcher.
* Corbett & Anderson (1994). *Knowledge tracing.* User Modeling and User-Adapted Interaction.
* Roediger & Karpicke (2006). *Test-enhanced learning.* Psychological Science.
