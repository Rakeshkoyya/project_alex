import type { Course } from "../api";
import { ConceptMap } from "../components/ConceptMap";

/** The Advisor's personalised programme: rationale, timeline, modules, concept map. */
export function Roadmap({ course }: { course: Course }) {
  const r = course.roadmap;
  const title = (id: string) => course.concepts.find((c) => c.id === id)?.title ?? id;
  return (
    <div className="roadmap">
      {!r ? (
        <section className="panel">
          <h2>Roadmap</h2>
          <p className="muted">{course.stage === "planning" ? "The Advisor is designing your roadmap…" : "Your roadmap is designed after the diagnostic."}</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <h2>{r.title}</h2>
            <p className="rationale">🧭 {r.rationale}</p>
            <div className="timeline">
              <div className="axis">
                {Array.from({ length: Math.min(12, r.totalDays) + 1 }, (_, i) => Math.round((i * r.totalDays) / Math.min(12, r.totalDays))).map((d) => (
                  <span key={d} style={{ left: `${(d / r.totalDays) * 100}%` }}>d{d}</span>
                ))}
              </div>
              {r.modules.map((m) => (
                <div key={m.id} className="tl-row">
                  <span className="tl-label">{m.title}</span>
                  <div className="tl-track">
                    <div className={`tl-bar ${m.status}`} style={{ left: `${(m.startDay / r.totalDays) * 100}%`, width: `${(m.durationDays / r.totalDays) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
          <div className="modules">
            {r.modules.map((m, i) => (
              <section key={m.id} className={`panel module ${m.status}`}>
                <div className="module-head">
                  <span className="num">{i + 1}</span>
                  <div>
                    <h3>{m.title}</h3>
                    <small className="muted">Day {m.startDay + 1}–{m.startDay + m.durationDays} · {m.status}</small>
                  </div>
                </div>
                <p>{m.summary}</p>
                <div className="cols">
                  <div>
                    <h4>Objectives</h4>
                    <ul>{m.objectives.map((o) => <li key={o}>{o}</li>)}</ul>
                  </div>
                  <div>
                    <h4>Concepts</h4>
                    <ul>{m.conceptIds.map((id) => <li key={id}>{title(id)}</li>)}</ul>
                  </div>
                  <div>
                    <h4>Exercises</h4>
                    <ul>{m.exercises.map((o) => <li key={o}>{o}</li>)}</ul>
                  </div>
                  <div>
                    <h4>Memory techniques</h4>
                    <ul>{m.memoryTechniques.map((o) => <li key={o}>{o}</li>)}</ul>
                  </div>
                </div>
                <p className="checkpoint">✅ Checkpoint: {m.assessment}</p>
              </section>
            ))}
          </div>
        </>
      )}
      <section className="panel">
        <h2>Concept map</h2>
        <p className="muted">Each concept rests on the ones below it. You learn a concept once its foundations are solid — that's your Zone of Proximal Development.</p>
        <ConceptMap course={course} />
      </section>
    </div>
  );
}
