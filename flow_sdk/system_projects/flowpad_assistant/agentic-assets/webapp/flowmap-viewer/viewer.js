// How a flowmap looks — the viewer for `flowmap.map` (a skill's map) and `flowmap.run` (one run laid on it).
//
// One picture: how you start the skill (dark pills), its blocks coloured by type, where each leads, and what you
// get (green pills). A block opens as properties on the right; ☰ lists the ways in and the blocks. A run adds the
// traveled path — a counter on every edge it took, everything it did not take dimmed, time and cost on every
// block — and a timeline that replays it frame by frame. The layout is computed from the links (rows = longest
// path from an entry, columns = entries), so a map carries no positions unless it wants to (`lane`, `row`).
// Self-contained: imports nothing. Contract: ts_sdk/src/viewers/contract.ts. Kinds: agentic-assets/data_schema/flowmap.*

export const contract = 1;

const TYPES = { instructions: 'Instructions', code: 'Code', screen: 'Screen' };
const ICON = {
  instructions: '<svg viewBox="0 0 16 16"><path d="M4 2.5h8v11H4z M6 5.5h4 M6 8h4 M6 10.5h2.5"/></svg>',
  code: '<svg viewBox="0 0 16 16"><path d="M6 4.5 2.5 8 6 11.5 M10 4.5 13.5 8 10 11.5"/></svg>',
  screen: '<svg viewBox="0 0 16 16"><path d="M2 3h12v10H2z M2 6h12"/></svg>',
};
const NW = 200, NH = 46, LP = 240, RP = 78, PAD = 36;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (s) => { s = Math.round(s); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const usd = (c) => `$${(+c || 0).toFixed(2)}`;

const STYLE = `
.fmv { --fi: 252 62% 56%; --fc: 172 70% 30%; --fs: 24 88% 46%; --fo: 142 60% 32%; --fr: 217 91% 52%; --fb: 0 72% 48%; --soft: .09;
  font: 14px/1.45 var(--font-sans, system-ui, sans-serif); color: hsl(var(--foreground)); display: grid; grid-template-columns: minmax(0,1fr); gap: 20px; }
.dark .fmv, .fmv.dark { --fi: 252 85% 76%; --fc: 168 60% 58%; --fs: 30 92% 62%; --fo: 142 55% 60%; --fr: 213 94% 68%; --fb: 0 84% 68%; --soft: .16; }
.fmv.open { grid-template-columns: minmax(0,1fr) 300px; }
.fmv svg { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.fmv .t-instructions { --t: var(--fi); } .fmv .t-code { --t: var(--fc); } .fmv .t-screen { --t: var(--fs); }
.fmv-top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.fmv-top h1 { margin: 0; font-size: 26px; letter-spacing: -.02em; } .fmv-top p { margin: 0; color: hsl(var(--muted-foreground)); flex: 1 1 260px; }
.fmv-btn { font: inherit; font-size: 13px; cursor: pointer; border: 1px solid hsl(var(--border)); background: hsl(var(--card)); color: inherit; border-radius: 9px; height: 32px; padding: 0 11px; }
.fmv-btn:hover { background: hsl(var(--muted)); }
.fmv-stale { font-size: 12px; color: hsl(var(--fb)); }
.fmv-map { overflow-x: auto; padding: 8px 0; background: radial-gradient(hsl(var(--foreground) / .07) 1px, transparent 1px) 0 0 / 18px 18px; border-radius: 12px; }
.fmv-canvas { display: block; margin: 0 auto; height: auto; overflow: visible; }
.fmv-edge { stroke: hsl(var(--foreground) / .55); stroke-width: 1.5; } .fmv-loop { stroke-dasharray: 5 4; }
.fmv .ah { fill: hsl(var(--foreground) / .6); stroke: none; } .fmv .ahr { fill: hsl(var(--fr)); stroke: none; }
.fmv-lb rect { fill: hsl(var(--card)); stroke: hsl(var(--border)); stroke-width: 1; } .fmv svg .fmv-lb text { font-size: 11px; fill: hsl(var(--foreground)); stroke: none; }
.fmv-n { all: unset; box-sizing: border-box; width: 100%; height: 100%; display: flex; align-items: center; gap: 9px; padding: 0 10px; border-radius: 10px;
  border: 1.5px solid hsl(var(--t) / .55); background: hsl(var(--card)); background-image: linear-gradient(hsl(var(--t) / var(--soft)), hsl(var(--t) / var(--soft)));
  font-size: 12.5px; font-weight: 600; line-height: 1.2; color: hsl(var(--foreground)); transition: opacity .25s; }
button.fmv-n { cursor: pointer; } button.fmv-n:hover, .fmv-n.sel { box-shadow: inset 0 0 0 2px hsl(var(--t)); border-color: hsl(var(--t)); }
.fmv-n .ic { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: hsl(var(--t) / .16); color: hsl(var(--t)); }
.fmv-n .ic svg { width: 15px; height: 15px; } .fmv-n .tt { min-width: 0; }
.fmv-in { --t: var(--foreground); border-radius: 999px; background: hsl(var(--foreground)); background-image: none; color: hsl(var(--background)); border-color: hsl(var(--foreground)); }
.fmv-in .ic { background: hsl(var(--background) / .18); color: inherit; border-radius: 50%; font-size: 9px; }
.fmv-out { --t: var(--fo); border-radius: 999px; } .fmv-out .ic { border-radius: 50%; font-size: 12px; }
.fmv-stat { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; flex: none; padding-left: 6px; }
.fmv-stat b { font-size: 11.5px; } .fmv-stat i { font-style: normal; font-size: 11px; font-weight: 400; color: hsl(var(--muted-foreground)); }
.fmv-stat[hidden], .fmv-cnt[hidden], .fmv-side[hidden], .fmv-props[hidden], .fmv-list[hidden] { display: none; }
.fmv-n.cur { box-shadow: inset 0 0 0 2.5px hsl(var(--fr)), inset 0 0 14px hsl(var(--fr) / .35); border-color: hsl(var(--fr)); }
.fmv .off { opacity: .22; } .fmv-n.off { filter: grayscale(1); opacity: .3; }
.fmv-edge.ran { stroke: hsl(var(--fr)); stroke-width: 2.6; }
.fmv-cnt circle { fill: hsl(var(--fr)); stroke: hsl(var(--card)); stroke-width: 2; } .fmv svg .fmv-cnt text { fill: #fff; stroke: none; font-size: 10.5px; font-weight: 700; }
.fmv-key { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; margin-top: 6px; font-size: 12px; color: hsl(var(--muted-foreground)); }
.fmv-key span { display: inline-flex; align-items: center; gap: 6px; } .fmv-key i { width: 9px; height: 9px; border-radius: 3px; background: hsl(var(--t)); }
.fmv-key .kr i { background: hsl(var(--fr)); height: 3px; width: 16px; }
.fmv-strip { display: grid; grid-template-columns: auto minmax(0,1fr) auto auto; gap: 8px 14px; align-items: center; border: 1px solid hsl(var(--fr) / .4);
  background: hsl(var(--fr) / .07); border-radius: 12px; padding: 10px 14px; margin: 12px 0 4px; }
.fmv-play { width: 36px; height: 36px; border-radius: 50%; border: 0; cursor: pointer; background: hsl(var(--fr)); color: #fff; font-size: 13px; }
.fmv-tl { display: flex; gap: 2px; height: 22px; min-width: 0; }
.fmv-seg { border: 0; padding: 0; min-width: 5px; border-radius: 3px; cursor: pointer; background: hsl(var(--t, var(--foreground))); opacity: .22; }
.fmv-seg.done { opacity: .95; } .fmv-seg.cur { outline: 2px solid hsl(var(--foreground)); outline-offset: 1px; }
.fmv-seg.bad { box-shadow: inset 0 -5px 0 hsl(var(--fb)); } .fmv-seg.dot { flex: 0 0 9px !important; height: 9px; align-self: center; border-radius: 50%; }
.fmv-kpi { display: flex; flex-direction: column; min-width: 62px; } .fmv-kpi b { font-size: 18px; font-variant-numeric: tabular-nums; } .fmv-kpi i { font-style: normal; font-size: 11px; color: hsl(var(--muted-foreground)); }
.fmv-cap { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 13px; }
.fmv-cap span:last-child { color: hsl(var(--muted-foreground)); font-size: 12.5px; }
.fmv-side { border-left: 1px solid hsl(var(--border)); padding: 4px 0 20px 18px; position: relative; }
.fmv-x { all: unset; cursor: pointer; position: absolute; top: 2px; right: 0; padding: 2px 7px; border-radius: 6px; color: hsl(var(--muted-foreground)); }
.fmv-x:hover { background: hsl(var(--muted)); }
.fmv-side h2 { margin: 0 28px 8px 0; font-size: 16px; } .fmv-side h3 { margin: 18px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: hsl(var(--muted-foreground)); }
.fmv-side ul { list-style: none; margin: 0; padding: 0; } .fmv-cmds li { display: flex; gap: 10px; padding: 6px 0; border-top: 1px solid hsl(var(--border)); font-size: 13px; }
.fmv-cmds b { flex: 0 0 74px; } .fmv-cmds span { color: hsl(var(--muted-foreground)); }
.fmv-blks button { all: unset; box-sizing: border-box; width: 100%; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 5px 8px; border-radius: 7px; font-size: 13px; }
.fmv-blks button:hover { background: hsl(var(--muted)); } .fmv-blks i { width: 9px; height: 9px; border-radius: 3px; background: hsl(var(--t)); flex: none; }
.fmv-back { all: unset; cursor: pointer; font-size: 12.5px; color: hsl(var(--muted-foreground)); margin-bottom: 10px; display: inline-block; }
.fmv-ph { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 650; margin: 0 28px 12px 0; }
.fmv-ph .ic { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: hsl(var(--t) / .16); color: hsl(var(--t)); }
.fmv-props dl { display: grid; grid-template-columns: 70px 1fr; margin: 0; font-size: 13px; }
.fmv-props dt, .fmv-props dd { margin: 0; padding: 8px 0; border-top: 1px solid hsl(var(--border)); }
.fmv-props dt { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: hsl(var(--muted-foreground)); padding-top: 10px; }
.fmv-props .ty { color: hsl(var(--t)); font-weight: 600; } .fmv-props .run { background: hsl(var(--fr) / .06); }
`;

// ── layout ──────────────────────────────────────────────────────────────────────────────────────────────
function layout(m) {
  const nodes = new Map();
  (m.entries || []).forEach((n) => nodes.set(n.id, { ...n, k: 'in', title: n.name }));
  (m.steps || []).forEach((n) => nodes.set(n.id, { ...n, k: 'step' }));
  (m.outcomes || []).forEach((n) => nodes.set(n.id, { ...n, k: 'out' }));
  const links = (m.links || []).filter((l) => nodes.has(l.from) && nodes.has(l.to)).map((l) => ({ ...l }));
  const out = (id) => links.filter((l) => l.from === id && !l.loop);
  // A forward link that closes a cycle is drawn as a loop even when the map did not say so.
  const seen = new Map();
  const dfs = (id) => { seen.set(id, 1); for (const l of out(id)) { const s = seen.get(l.to); if (s === 1) l.loop = true; else if (!s) dfs(l.to); } seen.set(id, 2); };
  [...nodes.values()].filter((n) => n.k === 'in').forEach((n) => !seen.get(n.id) && dfs(n.id));
  [...nodes.keys()].forEach((id) => !seen.get(id) && dfs(id));
  // Rows: the longest forward path from an entry.
  const row = new Map(); const fwd = links.filter((l) => !l.loop);
  // An entry that starts from inside the flow (a button in the skill's own output) says where it sits.
  for (const n of nodes.values()) row.set(n.id, n.k === 'in' ? (Number.isInteger(n.row) ? n.row : 0) : -1);
  for (let pass = 0; pass < nodes.size; pass++) {
    let moved = false;
    for (const l of fwd) { const r = row.get(l.from); if (r >= 0 && row.get(l.to) < r + 1) { row.set(l.to, r + 1); moved = true; } }
    if (!moved) break;
  }
  for (const n of nodes.values()) { if (Number.isInteger(n.row)) row.set(n.id, n.row); if (row.get(n.id) < 0) row.set(n.id, 0); }
  // Lanes: entries in order; a node sits under the average of what leads into it; a row's nodes keep 1 lane apart.
  const lane = new Map(); let i = 0;
  for (const n of nodes.values()) if (n.k === 'in') lane.set(n.id, typeof n.lane === 'number' ? n.lane : i++);
  const maxRow = Math.max(0, ...row.values());
  for (let r = 1; r <= maxRow; r++) {
    const here = [...nodes.values()].filter((n) => row.get(n.id) === r);
    for (const n of here) {
      if (n.k === 'in') continue;
      const src = fwd.filter((l) => l.to === n.id && lane.has(l.from)).map((l) => lane.get(l.from));
      lane.set(n.id, typeof n.lane === 'number' ? n.lane : src.length ? src.reduce((a, b) => a + b, 0) / src.length : 0);
    }
    here.sort((a, b) => lane.get(a.id) - lane.get(b.id));
    for (let k = 1; k < here.length; k++) {
      const prev = lane.get(here[k - 1].id), cur = lane.get(here[k].id);
      if (cur < prev + 1) lane.set(here[k].id, prev + 1);
    }
  }
  const minLane = Math.min(0, ...lane.values());
  for (const n of nodes.values()) {
    n.x = PAD + NW / 2 + (lane.get(n.id) - minLane) * LP;
    n.y = PAD + row.get(n.id) * RP;
    n.r = row.get(n.id);
  }
  const W = Math.max(...[...nodes.values()].map((n) => n.x)) + NW / 2 + PAD + 40;
  const H = PAD * 2 + maxRow * RP;
  return { nodes, links, W, H };
}

function route(L, l, loopIx) {
  const a = L.nodes.get(l.from), b = L.nodes.get(l.to);
  if (l.loop) {
    const x = Math.max(a.x, b.x) + NW / 2 + 22 + loopIx * 14;
    return [[a.x + NW / 2, a.y], [x, a.y], [x, b.y], [b.x + NW / 2, b.y]];
  }
  const ax = a.x + (l.ox || 0), bx = b.x + (l.ix || 0);
  const p0 = [ax, a.y + NH / 2], p3 = [bx, b.y - NH / 2];
  // A block standing in the target's column on the way down.
  const blocked = [...L.nodes.values()].some((n) => n !== b && Math.abs(n.x - b.x) < NW / 2 && n.r > a.r && n.r < b.r);
  if (Math.abs(ax - bx) < 1) {
    if (!blocked) return [p0, p3];
    const x = a.x - NW / 2 - 18;   // skips blocks in its own column: around them, on the left
    return [[a.x - NW / 2, a.y], [x, a.y], [x, b.y], [b.x - NW / 2, b.y]];
  }
  // Turn just under the source, so arrows into one block keep their own lines (and labels) — unless the way
  // down the target's column is blocked; then turn just above the target instead.
  const mid = blocked ? b.y - NH / 2 - 16 : a.y + NH / 2 + 16;
  return [p0, [ax, mid], [bx, mid], p3];
}

function rounded(pts, r = 10) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const to = (x, y) => { const dx = x - cx, dy = y - cy, len = Math.max(Math.hypot(dx, dy), 1), k = Math.min(r, len / 2) / len; return [cx + dx * k, cy + dy * k]; };
    const [a1, a2] = to(px, py), [b1, b2] = to(nx, ny);
    d += ` L${a1} ${a2} Q${cx} ${cy} ${b1} ${b2}`;
  }
  return `${d} L${pts.at(-1)[0]} ${pts.at(-1)[1]}`;
}

function drawMap(m, sid, withRun) {
  const L = layout(m);
  // Spread several arrows leaving one bottom / arriving at one top so they do not sit on each other.
  const spread = (key, side) => {
    const by = new Map();
    for (const l of L.links.filter((x) => !x.loop)) { const k = l[key]; (by.get(k) || by.set(k, []).get(k)).push(l); }
    for (const [, ls] of by) {
      if (ls.length < 2) continue;
      const other = key === 'from' ? 'to' : 'from';
      ls.sort((p, q) => L.nodes.get(p[other]).x - L.nodes.get(q[other]).x);
      ls.forEach((l, i) => { l[side] = (i - (ls.length - 1) / 2) * Math.min(30, (NW - 40) / ls.length); });
    }
  };
  spread('from', 'ox'); spread('to', 'ix');
  let loops = 0;
  const paths = [], over = [];
  for (const l of L.links) {
    const pts = route(L, l, l.loop ? loops++ : 0);
    const pair = `${l.from}>${l.to}`;
    paths.push(`<path d="${rounded(pts)}" class="fmv-edge${l.loop ? ' fmv-loop' : ''}" data-pair="${esc(pair)}" marker-end="url(#ah-${sid})"/>`);
    let best = [pts[0], pts[1]];
    for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1])) best = [pts[i], pts[i + 1]];
    let cx = (best[0][0] + best[1][0]) / 2, cy = (best[0][1] + best[1][1]) / 2;
    if (l.label) {
      const w = l.label.length * 6.1 + 16;
      over.push(`<g class="fmv-lb" data-lb="${esc(pair)}"><rect x="${cx - w / 2}" y="${cy - 10}" width="${w}" height="20" rx="10"/><text x="${cx}" y="${cy + 4}" text-anchor="middle">${esc(l.label)}</text></g>`);
      if (best[0][0] === best[1][0]) cy += 22; else cx += w / 2 + 12;
    }
    if (withRun) over.push(`<g class="fmv-cnt" data-cnt="${esc(pair)}" hidden><circle cx="${cx}" cy="${cy}" r="9.5"/><text x="${cx}" y="${cy + 3.8}" text-anchor="middle"></text></g>`);
  }
  const boxes = [...L.nodes.values()].map((n) => {
    let inner;
    if (n.k === 'step') {
      const stat = withRun ? '<span class="fmv-stat" hidden><b></b><i></i></span>' : '';
      inner = `<button type="button" class="fmv-n t-${esc(n.type)}" data-node="${esc(n.id)}"><span class="ic">${ICON[n.type] || ''}</span><span class="tt">${esc(n.title)}</span>${stat}</button>`;
    } else {
      inner = `<div class="fmv-n ${n.k === 'in' ? 'fmv-in' : 'fmv-out'}" data-node="${esc(n.id)}"><span class="ic">${n.k === 'in' ? '▶' : '✓'}</span><span class="tt">${esc(n.title)}</span></div>`;
    }
    return `<foreignObject x="${n.x - NW / 2}" y="${n.y - NH / 2}" width="${NW}" height="${NH}">${inner}</foreignObject>`;
  });
  return `<svg class="fmv-canvas" viewBox="0 0 ${L.W} ${L.H}" width="${L.W}" role="img" aria-label="The flow of ${esc(m.skill)}">
<defs><marker id="ah-${sid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="ah"/></marker>
<marker id="ahr-${sid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="ahr"/></marker></defs>
${paths.join('')}${boxes.join('')}${over.join('')}</svg>`;
}

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────
let seq = 0;

function mountFlowmap(el, m, run) {
  const sid = `fmv${++seq}`;
  const steps = new Map((m.steps || []).map((s) => [s.id, s]));
  const titles = new Map([...(m.entries || []).map((e) => [e.id, e.name]), ...(m.steps || []).map((s) => [s.id, s.title]), ...(m.outcomes || []).map((o) => [o.id, o.title])]);
  const types = [...new Set((m.steps || []).map((s) => s.type))];
  const frames = run?.frames || [];
  const total = frames.reduce((a, f) => a + (+f.seconds || 0), 0);
  const strip = run ? `<div class="fmv-strip"><button type="button" class="fmv-play" aria-label="Play the run">▶</button>
<div class="fmv-tl">${frames.map((f, i) => {
    const s = steps.get(f.node);
    const tip = `${titles.get(f.node) || f.node}${s ? ` · ${fmt(f.seconds)} · ${usd(f.cost)}` : ''}${f.note ? ` · ${f.note}` : ''}`;
    return `<button type="button" class="fmv-seg ${s ? `t-${esc(s.type)}` : 'dot'}${/fail|undone/.test(f.note || '') ? ' bad' : ''}" data-i="${i}" style="flex:${Math.max(+f.seconds || 0, total * 0.012)} 1 0" title="${esc(tip)}" aria-label="${esc(tip)}"></button>`;
  }).join('')}</div>
<div class="fmv-kpi"><b class="fmv-t"></b><i>of ${fmt(total)}</i></div><div class="fmv-kpi"><b class="fmv-c"></b><i>of ${usd(run.cost)}</i></div>
<div class="fmv-cap"><span class="fmv-now"></span><span>Run of ${esc(new Date(run.when).toLocaleString())}${run.said ? ` · “${esc(run.said.slice(0, 90))}”` : ''}</span></div></div>` : '';
  const key = types.map((t) => `<span class="t-${esc(t)}"><i></i>${TYPES[t] || esc(t)}</span>`).join('')
    + (run ? '<span class="kr"><i></i>traveled — the number is how many times</span>' : '');
  el.innerHTML = `<style>${STYLE}</style><div class="fmv${document.documentElement.classList.contains('dark') ? ' dark' : ''}">
<div class="fmv-main"><div class="fmv-top"><h1>${esc(m.skill)}</h1><p>${esc(m.line)}</p>
<button type="button" class="fmv-btn" data-menu aria-label="What it is made of" title="What it is made of">☰</button></div>
${strip}<div class="fmv-map">${drawMap(m, sid, !!run)}</div><div class="fmv-key">${key}</div></div>
<aside class="fmv-side" hidden><button type="button" class="fmv-x" aria-label="Close">✕</button>
<div class="fmv-list"><h2>${esc(m.skill)}</h2><h3>Ways to start it</h3><ul class="fmv-cmds">${(m.entries || []).map((e) => `<li><b>${esc(e.name)}</b><span>${esc(e.gives)}</span></li>`).join('')}</ul>
<h3>Blocks</h3><ul class="fmv-blks">${(m.steps || []).map((s) => `<li><button type="button" class="t-${esc(s.type)}" data-open="${esc(s.id)}"><i></i>${esc(s.title)}</button></li>`).join('')}</ul></div>
<div class="fmv-props" hidden><button type="button" class="fmv-back">‹ All blocks</button><div class="fmv-ph"></div><dl></dl></div></aside></div>`;

  const root = el.querySelector('.fmv'), side = root.querySelector('.fmv-side'), list = side.querySelector('.fmv-list'), props = side.querySelector('.fmv-props');
  const stats = new Map();   // node -> {n, t, c} for the frames shown so far
  const unsel = () => root.querySelectorAll('.fmv-n.sel').forEach((n) => n.classList.remove('sel'));
  const close = () => { unsel(); side.hidden = true; root.classList.remove('open'); };
  const openList = () => { unsel(); props.hidden = true; list.hidden = false; side.hidden = false; root.classList.add('open'); };
  const openStep = (id) => {
    const s = steps.get(id); if (!s) return;
    unsel(); root.querySelector(`[data-node="${CSS.escape(id)}"]`)?.classList.add('sel');
    props.className = `fmv-props t-${s.type}`;
    props.querySelector('.fmv-ph').innerHTML = `<span class="ic">${ICON[s.type] || ''}</span>${esc(s.title)}`;
    const rows = [['Type', TYPES[s.type] || s.type, 'ty'], ...(s.by ? [['Done by', s.by]] : []), ['Takes', s.takes], ['Gives', s.gives], ['Written in', s.source]];
    if (run) {
      const st = stats.get(id);
      rows.push(...(st ? [['Ran', `${st.n} ${st.n === 1 ? 'time' : 'times'}`, 'run'], ['Time', fmt(st.t), 'run'], ['Cost', usd(st.c), 'run']] : [['Ran', 'not in this run', 'run']]));
    }
    props.querySelector('dl').innerHTML = rows.map(([k, v, c]) => `<dt class="${c || ''}">${k}</dt><dd class="${c || ''}">${esc(v)}</dd>`).join('');
    list.hidden = true; props.hidden = false; side.hidden = false; root.classList.add('open');
  };
  root.querySelector('[data-menu]').addEventListener('click', () => (!side.hidden && !list.hidden ? close() : openList()));
  side.querySelector('.fmv-x').addEventListener('click', close);
  side.querySelector('.fmv-back').addEventListener('click', openList);
  root.querySelectorAll('button[data-node]').forEach((b) => b.addEventListener('click', () => openStep(b.dataset.node)));
  side.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openStep(b.dataset.open)));
  if (!run) return;

  // ── the replay: k = how many frames are shown (all of them at rest) ──
  const play = root.querySelector('.fmv-play'), segs = [...root.querySelectorAll('.fmv-seg')];
  let k = frames.length, timer = null;
  const render = () => {
    stats.clear(); const cnt = new Map(); let t = 0, c = 0;
    for (let i = 0; i < k; i++) {
      const f = frames[i], s = stats.get(f.node) || { n: 0, t: 0, c: 0 };
      s.n++; s.t += +f.seconds || 0; s.c += +f.cost || 0; stats.set(f.node, s); t += +f.seconds || 0; c += +f.cost || 0;
      if (i) { const p = `${frames[i - 1].node}>${f.node}`; cnt.set(p, (cnt.get(p) || 0) + 1); }
    }
    const cur = k && k < frames.length ? frames[k - 1].node : null;
    root.querySelectorAll('[data-pair]').forEach((e) => {
      const on = cnt.has(e.dataset.pair); e.classList.toggle('ran', on); e.classList.toggle('off', !on);
      e.setAttribute('marker-end', `url(#${on ? 'ahr' : 'ah'}-${sid})`);
    });
    root.querySelectorAll('[data-cnt]').forEach((g) => { const n = cnt.get(g.dataset.cnt); g.toggleAttribute('hidden', !n); g.querySelector('text').textContent = n || ''; });
    root.querySelectorAll('[data-lb]').forEach((g) => g.classList.toggle('off', !cnt.has(g.dataset.lb)));
    root.querySelectorAll('.fmv-n[data-node]').forEach((n) => {
      const s = stats.get(n.dataset.node), st = n.querySelector('.fmv-stat');
      n.classList.toggle('off', !s); n.classList.toggle('cur', n.dataset.node === cur);
      if (st) { st.hidden = !s; if (s) { st.querySelector('b').textContent = fmt(s.t); st.querySelector('i').textContent = usd(s.c); } }
    });
    segs.forEach((b, j) => { b.classList.toggle('done', j < k); b.classList.toggle('cur', k < frames.length && j === k - 1); });
    root.querySelector('.fmv-t').textContent = fmt(t); root.querySelector('.fmv-c').textContent = usd(c);
    const f = k ? frames[k - 1] : null;
    const off = frames.slice(1, k).filter((x, i) => !(m.links || []).some((l) => l.from === frames[i].node && l.to === x.node)).length;
    root.querySelector('.fmv-now').textContent = k >= frames.length
      ? `The whole run — ${frames.length} frames${off ? ` · ${off} moves the map does not have` : ''}`
      : !f ? 'Ready' : `Frame ${k} of ${frames.length} · ${titles.get(f.node) || f.node}${steps.has(f.node) ? ` · ${fmt(f.seconds)} · ${usd(f.cost)}` : ''}${f.note ? ` — ${f.note}` : ''}`;
    const open = root.querySelector('.fmv-props:not([hidden])') && root.querySelector('.fmv-n.sel');
    if (open) openStep(open.dataset.node);
  };
  const stop = () => { clearInterval(timer); timer = null; play.textContent = '▶'; };
  play.addEventListener('click', () => {
    if (timer) return stop();
    if (k >= frames.length) k = 0;
    play.textContent = '❚❚'; k++; render();
    timer = setInterval(() => { k++; render(); if (k >= frames.length) stop(); }, 700);
  });
  segs.forEach((b) => b.addEventListener('click', () => { stop(); k = +b.dataset.i + 1; render(); }));
  render();
  return { unmount: stop };
}

const mapViewer = { async mount(el, req) { return mountFlowmap(el, req.value || {}, null) || {}; } };
const runViewer = { async mount(el, req) { const v = req.value || {}; return mountFlowmap(el, v.map || {}, v) || {}; } };

export const viewers = {
  'flowmap.map': { single: mapViewer },
  'flowmap.run': { single: runViewer },
};
