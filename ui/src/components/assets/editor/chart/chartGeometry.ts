import ELK from 'elkjs/lib/elk.bundled.js';

/** Geometry every chart type's layout shares: the one ELK engine, text wrapping, rounded edge paths. */

export const elk = new ELK();

/** Word-wrap to at most `lines` lines of `chars` characters; the last line ends in "…" when cut. */
export function wrap(text: string, chars: number, lines: number): string[] {
  const out: string[] = [];
  let cur = '';
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= chars) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = w.length > chars ? `${w.slice(0, chars - 1)}…` : w;
    if (out.length === lines) {
      out[lines - 1] = `${out[lines - 1].slice(0, chars - 1)}…`;
      return out;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1].slice(0, chars - 1)}…`;
  }
  return out;
}

/** An orthogonal route with softly rounded corners. */
export function pathOf(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  const R = 8;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(R, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const ux = Math.sign(c.x - p.x), uy = Math.sign(c.y - p.y), vx = Math.sign(n.x - c.x), vy = Math.sign(n.y - c.y);
    d += ` L${c.x - ux * r},${c.y - uy * r} Q${c.x},${c.y} ${c.x + vx * r},${c.y + vy * r}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}
