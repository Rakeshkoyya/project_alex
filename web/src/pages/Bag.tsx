import { useEffect, useRef, useState } from "react";
import { api, type Course, type Flashcard } from "../api";
import { FacultyFeed, type FeedBlock } from "../components/FacultyFeed";
import { Markdown } from "../components/Markdown";
import type { RunFn } from "./CourseView";

const KIND_ICON: Record<string, string> = { pdf: "📕", text: "📝", web: "🌐", vault: "🏛️", link: "🔗", notes: "🧠" };

/** The student bag: resources, points to remember (with memory aids), notes, flashcards. */
export function Bag({ course, run, busy, feed, refresh }: { course: Course; run: RunFn; busy: boolean; feed: FeedBlock[]; refresh: () => void }) {
  const { bag } = course;
  const [url, setUrl] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const addMaterial = (form: FormData) => run(`/api/courses/${course.id}/resources`, form);

  return (
    <div className="bag">
      {course.research && <ResearchDossier course={course} />}
      <section className="panel">
        <div className="panel-head">
          <h2>Resources <small className="muted">{bag.resources.length}</small></h2>
          <div className="add-material">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a link to add…" />
            <button
              disabled={!url || busy}
              onClick={() => {
                const f = new FormData();
                f.set("url", url);
                addMaterial(f).then(() => setUrl(""));
              }}
            >Add link</button>
            <input ref={file} type="file" multiple hidden accept=".pdf,.txt,.md,.html" onChange={(e) => {
              const f = new FormData();
              Array.from(e.target.files ?? []).forEach((x) => f.append("files", x));
              addMaterial(f);
            }} />
            <button disabled={busy} onClick={() => file.current?.click()}>Upload file</button>
          </div>
        </div>
        {busy && <FacultyFeed blocks={feed.slice(-1)} compact />}
        <ul className="resources">
          {bag.resources.map((r) => (
            <li key={r.id}>
              <span className="kind">{KIND_ICON[r.kind]}</span>
              <div>
                <b>{r.source?.startsWith("http") ? <a href={r.source} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</b>
                <p className="muted">{r.summary}</p>
                <small className="muted">
                  {r.kind === "notes" ? "written by the Librarian (AI), checked against the sources" : r.addedBy === "student" ? "added by you" : "found by the Librarian"}
                  {r.foundBy?.length ? ` · found by ${r.foundBy.join(" + ")}` : ""}
                  {r.quality !== undefined ? ` · quality ${Math.round(r.quality * 100)}%` : ""} · {r.chunkCount ? `${r.chunkCount} passages indexed` : "reference link"}
                </small>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="bag-side">
        <Flashcards course={course} refresh={refresh} />
        <section className="panel">
          <h2>Points to remember <small className="muted">{bag.keyPoints.length}</small></h2>
          <ul className="keypoints">
            {bag.keyPoints.map((k) => (
              <li key={k.id}>
                <p>{k.text}</p>
                {k.aid && <p className="aid"><span className="tag">{k.technique}</span> {k.aid}</p>}
              </li>
            ))}
          </ul>
        </section>
        {bag.notes.length > 0 && (
          <section className="panel">
            <h2>Notes</h2>
            {bag.notes.map((n) => (
              <details key={n.id}>
                <summary>{n.title} <small className="muted">· {n.author}</small></summary>
                <Markdown text={n.body} />
              </details>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/** FSRS-scheduled review: recall first, then reveal and rate. */
function Flashcards({ course, refresh }: { course: Course; refresh: () => void }) {
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [show, setShow] = useState(false);
  useEffect(() => void api.dueCards(course.id).then(setCards), [course.id, course.bag.flashcards.length]);
  const card = cards[0];
  const rate = async (r: number) => {
    await api.reviewCard(course.id, card.id, r);
    setShow(false);
    setCards(cards.slice(1));
    refresh();
  };
  return (
    <section className="panel flash">
      <h2>Spaced review <small className="muted">{cards.length} due · {course.bag.flashcards.length} cards</small></h2>
      {!card ? (
        <p className="muted">Nothing due — your memory is up to date. 🌱</p>
      ) : (
        <div className="flashcard">
          <p className="front">{card.front}</p>
          {show ? (
            <>
              <p className="back">{card.back}</p>
              {card.aid && <p className="aid"><span className="tag">{card.technique}</span> {card.aid}</p>}
              <div className="ratings">
                <button onClick={() => rate(1)}>Again</button>
                <button onClick={() => rate(2)}>Hard</button>
                <button className="primary" onClick={() => rate(3)}>Good</button>
                <button onClick={() => rate(4)}>Easy</button>
              </div>
            </>
          ) : (
            <button className="primary" onClick={() => setShow(true)}>Recall it, then reveal</button>
          )}
        </div>
      )}
    </section>
  );
}

/** The research behind the course: learner profile, plan, sources per topic, Advisor ↔ Librarian requests. */
function ResearchDossier({ course }: { course: Course }) {
  const r = course.research!;
  const res = (id: string) => course.bag.resources.find((x) => x.id === id);
  return (
    <section className="panel dossier">
      <h2>Research dossier</h2>
      {r.profile && (
        <p className="profile">
          🧭 <b>{r.profile.level}</b> · {r.profile.depth} depth{r.profile.assumedKnowledge.length ? <> · builds on {r.profile.assumedKnowledge.join(", ")}</> : null}
          {r.profile.suspectedGaps.length ? <> · watching for gaps in {r.profile.suspectedGaps.join(", ")}</> : null}
          {r.profile.notes && <><br /><span className="muted">{r.profile.notes}</span></>}
        </p>
      )}
      <table className="topics">
        <thead>
          <tr><th>Topic</th><th>Sources</th><th>Notes</th><th>Search</th></tr>
        </thead>
        <tbody>
          {r.topics.map((t) => {
            const sources = t.resourceIds.map(res).filter((x) => x && x.kind !== "notes");
            return (
              <tr key={t.id}>
                <td><span className={`tag ${t.kind}`}>{t.kind}</span> {t.title}</td>
                <td>{sources.length ? sources.map((x) => <div key={x!.id} className="src">{KIND_ICON[x!.kind]} {x!.title}{x!.quality !== undefined && <span className="muted"> · {Math.round(x!.quality * 100)}%</span>}</div>) : <span className="warn">none yet</span>}</td>
                <td>{t.notesId ? "✓" : <span className="muted">…</span>}</td>
                <td className="muted small">{t.searched ? `${t.searched.engines} · ${t.searched.candidates} candidates${t.searched.errors.length ? ` · ${t.searched.errors.length} issue(s)` : ""}` : "queued"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {r.requests.length > 0 && (
        <>
          <h4>Advisor ↔ Librarian</h4>
          <ul className="requests">
            {r.requests.map((q, i) => (
              <li key={i}><b>{q.concept}</b>: {q.need}{q.result && <div className="muted small">↳ {q.result}</div>}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
