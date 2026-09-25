import { useState } from "react";
import type { Assessment } from "../api";

/** Take an assessment (open) or review the examiner's grading (graded). */
export function AssessmentView({ assessment: a, onSubmit, busy }: { assessment: Assessment; onSubmit: (r: Record<string, string>) => void; busy: boolean }) {
  const [resp, setResp] = useState<Record<string, string>>({});
  const set = (id: string, v: string) => setResp((r) => ({ ...r, [id]: v }));

  if (a.status !== "open") {
    return (
      <div className="assessment graded">
        <div className="score-head">
          <div className="score-ring" style={{ ["--p" as any]: a.score ?? 0 }}>
            <span>{a.status === "graded" ? `${a.score}%` : "…"}</span>
          </div>
          <div>
            <h3>{a.title}</h3>
            <p className="muted">{a.status === "graded" ? `Graded by Editorial · ${a.gradedAt?.slice(0, 16).replace("T", " ")}` : "Grading…"}</p>
            {a.summary && <p className="report">📝 {a.summary}</p>}
          </div>
        </div>
        <ol className="questions">
          {a.questions.map((q) => {
            const r = a.results.find((x) => x.questionId === q.id);
            return (
              <li key={q.id} className={r && r.score >= 0.75 ? "right" : r && r.score > 0 ? "partial" : "wrong"}>
                <p>{q.prompt}</p>
                <p className="muted">Your answer: <b>{r?.response || "—"}</b>{q.answer && r && r.score < 1 && <> · expected: <b>{q.answer}</b></>}</p>
                {r && <p className="feedback">{Math.round(r.score * 100)}% — {r.feedback}</p>}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  return (
    <form
      className="assessment"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(resp);
      }}
    >
      <ol className="questions">
        {a.questions.map((q) => (
          <li key={q.id}>
            <p>
              {q.prompt} <span className="tag">{q.bloom}</span>
            </p>
            {q.options ? (
              <div className="options">
                {q.options.map((o, i) => (
                  <label key={o} className={resp[q.id] === o ? "on" : ""}>
                    <input type="radio" name={q.id} checked={resp[q.id] === o} onChange={() => set(q.id, o)} />
                    <span className="letter">{String.fromCharCode(65 + i)}</span> {o}
                  </label>
                ))}
              </div>
            ) : q.type === "numeric" ? (
              <input inputMode="decimal" value={resp[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)} placeholder="Your answer" />
            ) : (
              <textarea rows={3} value={resp[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)} placeholder="Explain in your own words" />
            )}
          </li>
        ))}
      </ol>
      <button className="primary" disabled={busy}>
        {busy ? "Submitted — the examiner is grading…" : `Submit (${Object.keys(resp).length}/${a.questions.length} answered)`}
      </button>
    </form>
  );
}
