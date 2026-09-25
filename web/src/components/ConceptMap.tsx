import type { Course } from "../api";

/**
 * Layered concept graph: foundations at the bottom, course targets at the top,
 * arrows from prerequisite to dependent. Colour = mastery (P(known)).
 */
export function ConceptMap({ course, focusId }: { course: Course; focusId?: string }) {
  const concepts = course.concepts;
  if (!concepts.length) return <p className="muted">The concept map appears after the Advisor has mapped the course.</p>;
  const maxDepth = Math.max(...concepts.map((c) => c.depth));
  const layers: (typeof concepts)[] = [];
  for (let d = 0; d <= maxDepth; d++) layers.push(concepts.filter((c) => c.depth === d));
  const W = 760;
  const rowH = 96;
  const widest = Math.max(...layers.map((l) => l.length));
  const nodeW = Math.min(150, W / widest - 10);
  const top = 44; // room for same-layer arcs
  const H = top + rowH * layers.length;
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, d) => {
    layer.forEach((c, i) => {
      pos.set(c.id, { x: ((i + 0.5) * W) / layer.length, y: top + d * rowH + 24 });
    });
  });
  const color = (p: number) => (p >= 0.85 ? "var(--ok)" : p >= 0.6 ? "var(--ready)" : p >= 0.3 ? "var(--warn)" : "var(--weak)");

  return (
    <div className="concept-map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Concept map">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)" />
          </marker>
        </defs>
        {concepts.flatMap((c) =>
          c.prerequisites.map((p) => {
            const a = pos.get(p);
            const b = pos.get(c.id);
            if (!a || !b) return null;
            // Same layer: arc over the top so the edge never crosses a node.
            const d = a.y === b.y ? `M${a.x},${a.y - 20} Q${(a.x + b.x) / 2},${a.y - 20 - Math.min(40, Math.abs(b.x - a.x) / 4)} ${b.x},${b.y - 22}` : `M${a.x},${a.y - 20} L${b.x},${b.y + 22}`;
            return <path key={`${p}-${c.id}`} d={d} fill="none" stroke="var(--line-strong)" strokeWidth={1.2} markerEnd="url(#arrow)" />;
          }),
        )}
        {concepts.map((c) => {
          const p = pos.get(c.id)!;
          return (
            <g key={c.id} transform={`translate(${p.x - nodeW / 2},${p.y - 20})`} className={`node ${c.status} ${focusId === c.id ? "focus" : ""}`}>
              <title>{`${c.title}\n${c.description}\nP(known) ${Math.round(c.pKnown * 100)}% · ${c.zone} · ${c.status}`}</title>
              <rect className="box" width={nodeW} height={42} rx={10} />
              <rect width={nodeW * c.pKnown} height={4} y={38} rx={2} fill={color(c.pKnown)} />
              <text x={nodeW / 2} y={18} textAnchor="middle" className="n-title">{c.title.length > nodeW / 7 ? c.title.slice(0, Math.floor(nodeW / 7) - 1) + "…" : c.title}</text>
              <text x={nodeW / 2} y={32} textAnchor="middle" className="n-sub">{Math.round(c.pKnown * 100)}% · {c.status}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span><i style={{ background: "var(--weak)" }} /> gap</span>
        <span><i style={{ background: "var(--warn)" }} /> emerging</span>
        <span><i style={{ background: "var(--ready)" }} /> in your ZPD</span>
        <span><i style={{ background: "var(--ok)" }} /> mastered</span>
        <span className="muted">↑ targets · foundations ↓</span>
      </div>
    </div>
  );
}
