import { useEffect, useRef, useState } from "react";
import { api, type Course, type HarnessEvent } from "../api";
import { Markdown } from "../components/Markdown";
import { AssessmentView } from "./AssessmentView";
import type { RunFn } from "./CourseView";

const LADDER = ["Try alone", "Nudge", "Hint", "Specific hint", "Worked example", "Step down"];
const ACT_ICON: Record<string, string> = { review: "🔁", learn: "💡", practice: "✍️", challenge: "🧗", remediate: "🧱", quiz: "🎯" };

interface Msg {
  role: "student" | "tutor";
  text: string;
  tools?: string[];
}

/** The study room: today's plan, live tutor chat, ZPD panel, artifacts, lock-in quiz. */
export function Study({ course, run, busy, refresh }: { course: Course; run: RunFn; busy: boolean; refresh: () => void }) {
  const session = course.sessions.at(-1);
  const live = session && !session.endedAt ? session : undefined;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pending, setPending] = useState<Msg>();
  const [input, setInput] = useState("");
  const [zpd, setZpd] = useState<{ action: string; nextHintLevel: number; pKnown: number; reason: string; tutorMove: string }>();
  const [artifacts, setArtifacts] = useState<{ id: string; kind: string; brief: string }[]>([]);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (live) api.chat(course.id, live.id).then(setMsgs);
  }, [live?.id]);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [msgs, pending]);

  const onEvent = (e: HarnessEvent) => {
    if (e.type === "text" && e.role === "tutor") setPending((p) => ({ role: "tutor", text: (p?.text ?? "") + e.delta, tools: p?.tools ?? [] }));
    if (e.type === "tool_start") setPending((p) => ({ role: "tutor", text: p?.text ?? "", tools: [...(p?.tools ?? []), `${e.role === "tutor" ? "" : e.role + ": "}${e.label}`] }));
    if (e.type === "ui" && e.name === "mastery") setZpd(e.payload);
    if (e.type === "ui" && e.name === "artifact") setArtifacts((a) => [e.payload, ...a].slice(0, 4));
  };

  const finish = async (sid?: string) => {
    const s = sid ?? (await api.course(course.id)).sessions.at(-1)?.id;
    if (s) setMsgs(await api.chat(course.id, s));
    setPending(undefined);
  };

  const start = async () => {
    setMsgs([]);
    setArtifacts([]);
    setZpd(undefined);
    await run(`/api/courses/${course.id}/sessions`, undefined, onEvent);
    await finish();
  };

  const send = async (text: string) => {
    if (!live || !text.trim()) return;
    setInput("");
    setMsgs((m) => [...m, { role: "student", text }]);
    await run(`/api/courses/${course.id}/sessions/${live.id}/messages`, { text }, onEvent);
    await finish(live.id);
  };

  if (course.stage !== "active" && course.stage !== "completed") {
    return <section className="panel"><p className="muted">Study opens once your roadmap is ready.</p></section>;
  }

  if (!live) {
    const lastQuiz = course.assessments.filter((a) => a.kind === "quiz").at(-1);
    return (
      <section className="panel start-session">
        <h2>Ready for today's session?</h2>
        <p className="muted">
          Your tutor will review what's due, pick the next concept in your Zone of Proximal Development, teach it step by step, and close with a short quiz.
          {lastQuiz?.score !== undefined && <> Last quiz: <b>{lastQuiz.score}%</b>.</>}
        </p>
        <button className="primary big" disabled={busy} onClick={start}>{busy ? "Your tutor is preparing…" : "Start today's session →"}</button>
        {pending && <div className="chat"><TutorBubble m={pending} streaming /></div>}
      </section>
    );
  }

  const focus = course.concepts.find((c) => c.id === live.focusConceptId);
  const quiz = course.assessments.find((a) => a.id === live.quizId);
  const hint = zpd?.nextHintLevel ?? focus?.lastHintLevel ?? 0;
  const ladderIdx = zpd?.action === "step-down" ? 5 : hint;
  const module = course.roadmap?.modules.find((m) => m.status === "in-progress");

  return (
    <div className="study">
      <aside className="panel plan">
        <h3>Today's plan</h3>
        <ul>
          {live.plan.map((p) => (
            <li key={p.id} className={p.done ? "done" : ""}>
              <span>{ACT_ICON[p.activity]}</span>
              <div>
                {p.title}
                <small className="muted">{p.minutes} min</small>
              </div>
            </li>
          ))}
        </ul>
        {module && (
          <div className="module-mini">
            <small className="muted">Module</small>
            <b>{module.title}</b>
          </div>
        )}
      </aside>

      <section className="panel chat-panel">
        <div className="chat">
          {msgs.map((m, i) => (m.role === "student" ? <div key={i} className="bubble student">{m.text}</div> : <TutorBubble key={i} m={m} />))}
          {pending && <TutorBubble m={pending} streaming />}
          <div ref={end} />
        </div>
        <div className="quick">
          {["I'm not sure — can I get a hint?", "Can you explain it differently?", "Let's wrap up and quiz me"].map((q) => (
            <button key={q} className="chip" disabled={busy} onClick={() => send(q)}>{q}</button>
          ))}
        </div>
        <form className="composer" onSubmit={(e) => (e.preventDefault(), send(input))}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder={busy ? "Tutor is thinking…" : "Answer, ask, or think out loud…"}
            rows={2}
          />
          <button className="primary" disabled={busy || !input.trim()}>Send</button>
        </form>
      </section>

      <aside className="side">
        <section className="panel">
          <h3>Now learning</h3>
          {focus ? (
            <>
              <b className="focus-title">{focus.title}</b>
              <p className="muted small">{focus.description}</p>
              <div className="mastery">
                <div style={{ width: `${Math.round((zpd?.pKnown ?? focus.pKnown) * 100)}%` }} />
              </div>
              <small className="muted">Mastery {Math.round((zpd?.pKnown ?? focus.pKnown) * 100)}% · zone: {focus.zone} · depth {focus.depth}</small>
            </>
          ) : (
            <p className="muted">—</p>
          )}
          <h4>Scaffolding</h4>
          <ol className="ladder">
            {LADDER.map((l, i) => (
              <li key={l} className={i === ladderIdx ? "on" : i < ladderIdx ? "past" : ""}>{l}</li>
            ))}
          </ol>
          {zpd && <p className="muted small">ZPD engine: <b>{zpd.action}</b> — {zpd.reason}</p>}
        </section>

        {artifacts.length > 0 && (
          <section className="panel">
            <h3>Learning artifacts</h3>
            {artifacts.map((a) => (
              <div key={a.id} className="artifact parked">
                <span className="tag">{a.kind}</span>
                <p>{a.brief}</p>
                <small className="muted">🎬 Generations engine is parked — this slot will show images, animations, mind maps and memory palaces.</small>
              </div>
            ))}
          </section>
        )}

        {quiz && (
          <section className="panel quiz">
            <h3>🎯 Lock-in quiz</h3>
            <AssessmentView assessment={quiz} busy={busy} onSubmit={(responses) => run(`/api/courses/${course.id}/assessments/${quiz.id}/submit`, { responses }).then(refresh)} />
          </section>
        )}
      </aside>
    </div>
  );
}

function TutorBubble({ m, streaming }: { m: Msg; streaming?: boolean }) {
  return (
    <div className="bubble tutor">
      <span className="avatar">🎓</span>
      <div>
        {m.tools && m.tools.length > 0 && (
          <div className="tool-trail">
            {m.tools.map((t, i) => <span key={i}>{t}</span>)}
          </div>
        )}
        {m.text ? <Markdown text={m.text} /> : streaming && <span className="typing"><i /><i /><i /></span>}
      </div>
    </div>
  );
}
