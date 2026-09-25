import { useRef, useState } from "react";
import { api } from "../api";
import { go } from "../App";

/** Step 0: the student states a goal and/or drops their own material. */
export function Intake() {
  const [goal, setGoal] = useState("");
  const [level, setLevel] = useState("");
  const [deadline, setDeadline] = useState("");
  const [hours, setHours] = useState(5);
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const f = new FormData();
    f.set("goal", goal);
    f.set("currentLevel", level);
    f.set("deadline", deadline);
    f.set("hoursPerWeek", String(hours));
    files.forEach((x) => f.append("files", x));
    try {
      const c = await api.create(f);
      go(`/course/${c.id}/prepare`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const examples = ["Understand photosynthesis for my grade 9 biology exam", "Learn Python from zero to writing small programs", "Master fractions — I get lost when adding them"];

  return (
    <section className="intake">
      <div className="intake-copy">
        <h1>What do you want to learn?</h1>
        <p className="lede">
          Tell Alex your goal or drop in your textbook. Our faculty — a <b>Librarian</b>, an <b>Advisor</b>, a <b>Tutor</b> and an independent <b>Editorial</b> examiner — will gather material, find exactly where your knowledge ends, and teach you from there, one step beyond what you can do alone.
        </p>
        <ol className="journey">
          <li><span>1</span>Goal &amp; material</li>
          <li><span>2</span>Diagnostic</li>
          <li><span>3</span>Personal roadmap</li>
          <li><span>4</span>Daily tutoring</li>
          <li><span>5</span>Quiz &amp; lock in</li>
        </ol>
      </div>
      <form className="card intake-form" onSubmit={submit}>
        <label>
          Your goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Understand photosynthesis for my grade 9 biology exam" rows={3} />
        </label>
        <div className="chips">
          {examples.map((x) => (
            <button type="button" key={x} className="chip" onClick={() => setGoal(x)}>{x}</button>
          ))}
        </div>
        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            setFiles([...files, ...Array.from(e.dataTransfer.files)]);
          }}
          onClick={() => input.current?.click()}
        >
          <input ref={input} type="file" multiple accept=".pdf,.txt,.md,.html" hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
          {files.length ? (
            <ul>{files.map((f) => <li key={f.name}>📄 {f.name}</li>)}</ul>
          ) : (
            <span>Drop your book, notes or PDFs here <small>(optional)</small></span>
          )}
        </div>
        <label>
          Where are you now? <small>(optional)</small>
          <input value={level} onChange={(e) => setLevel(e.target.value)} placeholder="e.g. grade 9, but chemistry was never my thing" />
        </label>
        <div className="row">
          <label>
            Deadline <small>(optional)</small>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <label>
            Hours per week
            <input type="number" min={1} max={40} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </label>
        </div>
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy || (!goal.trim() && !files.length)}>
          {busy ? "Enrolling…" : "Enroll & build my course →"}
        </button>
      </form>
    </section>
  );
}
