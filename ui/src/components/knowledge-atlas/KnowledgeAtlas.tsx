// Knowledge Atlas — port of the Claude Design "The Atlas" knowledge canvas
// (canvas-app.jsx) onto the docs knowledge browser. Left-to-right tree with
// bézier flows, dashed vermilion cross-link web, pan/zoom/fit, hover/click
// hot-set highlighting, a reading drawer fed by the real markdown, and a ⌘K
// palette. Data comes from /api/v1/docs-graph (native LLMIndexer scan).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DiffContent } from '@src/components/code-editor/DiffContent';
import {
  buildAtlasLayout,
  fetchDiff,
  fetchDoc,
  fetchDocsGraph,
  postStamp,
  treePath,
  xPath,
  type AtlasLayout,
  type AtlasNode,
} from './atlasData';
import './atlas.css';

/* ---- tiny inline icons (from the design's components.jsx) ----------------- */
function Icon({ d, s = 16, sw = 1.6 }: { d: string | string[]; s?: number; sw?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}
const ICONS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4',
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  stamp: ['M5 21h14', 'M12 3v8', 'M8 11h8l1 6H7z'],
};

/** File statuses that count as "changed since last stamp". */
const CHANGED_FILE = new Set(['modified', 'added', 'removed']);

/** Floor for fit-to-view zoom. Doc titles are 16px at scale 1; below ~0.6 they
 *  are illegible, and a whole-repo vault would otherwise fit at ~0.01. When the
 *  graph can't fit above this floor, fit anchors on the root card instead. */
const MIN_FIT_SCALE = 0.65;

/* ---- markdown-lite → design prose blocks ---------------------------------- */
type ProseBlock =
  | { t: 'lead' | 'p' | 'h2'; v: string }
  | { t: 'ul'; v: string[] }
  | { t: 'pre'; v: string };

function mdToBlocks(md: string): ProseBlock[] {
  let text = md;
  if (text.startsWith('---')) {
    const fm = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(text);
    if (fm) text = text.slice(fm[0].length);
  }
  const blocks: ProseBlock[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let pre: string[] | null = null;
  let sawLead = false;
  let skippedH1 = false;

  const flushPara = () => {
    const v = para.join(' ').trim();
    para = [];
    if (!v) return;
    blocks.push({ t: sawLead ? 'p' : 'lead', v });
    sawLead = true;
  };
  const flushList = () => {
    if (list?.length) blocks.push({ t: 'ul', v: list });
    list = null;
  };

  for (const raw of text.split('\n')) {
    if (pre !== null) {
      if (raw.trim().startsWith('```')) {
        blocks.push({ t: 'pre', v: pre.join('\n') });
        pre = null;
      } else pre.push(raw);
      continue;
    }
    const line = raw.trim();
    if (line.startsWith('```')) { flushPara(); flushList(); pre = []; continue; }
    if (!line) { flushPara(); flushList(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      if (h[1].length === 1 && !skippedH1) { skippedH1 = true; continue; } // title lives in the drawer head
      blocks.push({ t: 'h2', v: h[2] });
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) { flushPara(); if (!list) list = []; list.push(li[1]); continue; }
    if (list) flushList();
    para.push(line);
  }
  if (pre) blocks.push({ t: 'pre', v: pre.join('\n') });
  flushPara(); flushList();
  return blocks;
}

/* ---- inline prose: [[wiki|label]] + `code` -------------------------------- */
const WIKI_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function renderInline(
  text: string,
  resolve: (target: string) => AtlasNode | undefined,
  onNav: (id: string) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  const pushPlain = (chunk: string) => {
    // render `code` spans inside plain text
    const segs = chunk.split(/(`[^`]+`)/g);
    for (const s of segs) {
      if (!s) continue;
      if (s.startsWith('`') && s.endsWith('`') && s.length > 2) out.push(<code key={out.length}>{s.slice(1, -1)}</code>);
      else out.push(s);
    }
  };
  let last = 0;
  let m: RegExpExecArray | null;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(text))) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    const target = m[1].trim();
    const node = resolve(target);
    const label = (m[2] ?? node?.title ?? m[1]).trim();
    if (node) {
      const id = node.id;
      out.push(
        <a key={out.length} className="wlink" onClick={(e) => { e.preventDefault(); onNav(id); }}>
          {label}
        </a>,
      );
    } else out.push(label);
    last = WIKI_RE.lastIndex;
  }
  if (last < text.length) pushPlain(text.slice(last));
  return out;
}

function ProseBlocks({ blocks, resolve, onNav }: {
  blocks: ProseBlock[];
  resolve: (t: string) => AtlasNode | undefined;
  onNav: (id: string) => void;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'lead': return <p key={i} className="lead">{renderInline(b.v, resolve, onNav)}</p>;
          case 'p': return <p key={i}>{renderInline(b.v, resolve, onNav)}</p>;
          case 'h2': return <h2 key={i}><span className="h2-no">§</span>{b.v}</h2>;
          case 'ul': return <ul key={i}>{b.v.map((li, j) => <li key={j}>{renderInline(li, resolve, onNav)}</li>)}</ul>;
          case 'pre': return <pre key={i}><code>{b.v}</code></pre>;
          default: return null;
        }
      })}
    </>
  );
}

/* ---- command palette (from the design's components.jsx) ------------------- */
function CommandPalette({ open, docs, onClose, onNav }: {
  open: boolean;
  docs: AtlasNode[];
  onClose: () => void;
  onNav: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 20); }
  }, [open]);

  const results = useMemo(() => {
    if (!q.trim()) return docs;
    const ql = q.toLowerCase();
    return docs
      .map((d) => {
        const title = d.title.toLowerCase();
        const hay = `${title} ${d.relPath.toLowerCase()} ${(d.kicker ?? '').toLowerCase()}`;
        let score = -1;
        if (title.startsWith(ql)) score = 100;
        else if (title.includes(ql)) score = 60;
        else if (hay.includes(ql)) score = 30;
        return { d, score };
      })
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.d);
  }, [q, docs]);

  useEffect(() => { setSel(0); }, [q]);

  const choose = useCallback((i: number) => {
    const r = results[i];
    if (r) { onNav(r.id); onClose(); }
  }, [results, onNav, onClose]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, results, sel, choose, onClose]);

  if (!open) return null;

  const hl = (text: string): ReactNode => {
    if (!q.trim()) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
  };

  return (
    <div className="cmd-scrim" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmd-in">
          <span style={{ color: 'var(--ink-faint)' }}><Icon d={ICONS.search} s={18} /></span>
          <input ref={inputRef} value={q} placeholder="Search the docs…" onChange={(e) => setQ(e.target.value)} />
          <span className="esc">ESC</span>
        </div>
        <div className="cmd-list">
          {results.length === 0 ? (
            <div className="cmd-empty">Nothing in the docs matches “{q}”.</div>
          ) : (
            <>
              <div className="cmd-grp">{q.trim() ? 'Results' : 'All entries'} · {results.length}</div>
              {results.map((r, i) => (
                <div key={r.id} className={'cmd-item' + (i === sel ? ' sel' : '')}
                  onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
                  <span className="ci-ic"><Icon d={ICONS.doc} s={13} /></span>
                  <span className="ci-t">{hl(r.title)}</span>
                  <span className="ci-s">{r.kicker ?? ''}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- the Atlas ------------------------------------------------------------ */
export function KnowledgeAtlas({ root }: { root: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const [layout, setLayout] = useState<AtlasLayout | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const [animate, setAnimate] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null); // doc whose content fills the drawer
  const [drawerOpen, setDrawerOpen] = useState(false); // gates the slide-in (separate frame)
  const [cmdOpen, setCmdOpen] = useState(false);
  const [docBody, setDocBody] = useState<{ blocks: ProseBlock[]; loading: boolean }>({ blocks: [], loading: false });
  const [changesMode, setChangesMode] = useState(false);
  const [stamping, setStamping] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'doc' | 'changes'>('doc');
  const [diffBody, setDiffBody] = useState<{ diff: string; skipped: string | null; loading: boolean }>({
    diff: '', skipped: null, loading: false,
  });

  const rootName = useMemo(() => root.replace(/\/+$/, '').split('/').pop() || root, [root]);

  /* data */
  useEffect(() => {
    let cancelled = false;
    setLoadErr(null);
    setLayout(null);
    (async () => {
      try {
        const { nodes, edges } = await fetchDocsGraph(root);
        if (!cancelled) setLayout(buildAtlasLayout(nodes, edges));
      } catch (e) {
        if (!cancelled) setLoadErr(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [root, reloadKey]);

  const drawerW = useCallback(() => {
    const w = stageRef.current?.clientWidth ?? window.innerWidth;
    return Math.min(560, w * 0.46);
  }, []);

  const fit = useCallback((withDrawer: boolean) => {
    const el = stageRef.current;
    if (!el || !layout) return;
    const W = el.clientWidth - (withDrawer ? drawerW() : 0), H = el.clientHeight;
    const b = layout.bounds, padX = 90, padY = 70;
    const cw = Math.max(1, b.maxX - b.minX), ch = Math.max(1, b.maxY - b.minY);
    const s = Math.min((W - padX * 2) / cw, (H - padY * 2) / ch, 1.15);
    let next: { s: number; tx: number; ty: number };
    if (s >= MIN_FIT_SCALE) {
      next = {
        s,
        tx: padX + (W - padX * 2 - cw * s) / 2 - b.minX * s,
        ty: padY + (H - padY * 2 - ch * s) / 2 - b.minY * s,
      };
    } else {
      // Too large to fit readably — open at the floor, root card at the left
      // edge and vertically centered, so the view starts where the tree does.
      const rootNode = layout.nodes.find((n) => n.type === 'root');
      next = {
        s: MIN_FIT_SCALE,
        tx: padX - b.minX * MIN_FIT_SCALE,
        ty: H / 2 - (rootNode?.cy ?? b.minY + ch / 2) * MIN_FIT_SCALE,
      };
    }
    setAnimate(true); setView(next);
    setTimeout(() => setAnimate(false), 480);
  }, [layout, drawerW]);

  useLayoutEffect(() => { if (layout) fit(false); }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const centerOn = useCallback((node: AtlasNode) => {
    const el = stageRef.current;
    if (!el || !node) return;
    const s = Math.max(view.s, 0.85);
    const visCx = (el.clientWidth - drawerW()) / 2;
    const tx = visCx - node.cx * s;
    const ty = el.clientHeight / 2 - node.cy * s;
    setAnimate(true); setView({ s, tx, ty });
    setTimeout(() => setAnimate(false), 480);
  }, [view.s, drawerW]);

  const openDoc = useCallback((id: string) => {
    const n = layout?.byId[id];
    if (!n || n.type !== 'doc') return;
    setFocus(id);
    // Ghosts have no on-disk doc — land on the Changes tab (old vs nothing).
    setDrawerTab(n.isGhost ? 'changes' : 'doc');
    if (drawerRef.current) drawerRef.current.scrollTop = 0;
    // commit a closed frame first, THEN add .open so the slide-in transition
    // fires. setTimeout (not rAF) so it runs even when painting is throttled.
    setTimeout(() => { setDrawerOpen(true); centerOn(n); }, 20);
  }, [layout, centerOn]);

  const closeDoc = useCallback(() => {
    setDrawerOpen(false);
    setTimeout(() => setFocus(null), 340);
  }, []);

  /* drawer content */
  useEffect(() => {
    const n = focus ? layout?.byId[focus] : null;
    if (!n || !n.relPath || n.isGhost) { setDocBody({ blocks: [], loading: false }); return; }
    let cancelled = false;
    setDocBody({ blocks: [], loading: true });
    fetchDoc(root, n.relPath)
      .then(({ content }) => { if (!cancelled) setDocBody({ blocks: mdToBlocks(content), loading: false }); })
      .catch(() => { if (!cancelled) setDocBody({ blocks: [], loading: false }); });
    return () => { cancelled = true; };
  }, [focus, layout, root]);

  /* drawer diff (Changes tab) */
  useEffect(() => {
    const n = focus ? layout?.byId[focus] : null;
    if (!n || !n.relPath || drawerTab !== 'changes') {
      setDiffBody({ diff: '', skipped: null, loading: false });
      return;
    }
    let cancelled = false;
    setDiffBody({ diff: '', skipped: null, loading: true });
    fetchDiff(root, n.relPath)
      .then(({ diff, skipped }) => { if (!cancelled) setDiffBody({ diff, skipped, loading: false }); })
      .catch(() => { if (!cancelled) setDiffBody({ diff: '', skipped: 'error', loading: false }); });
    return () => { cancelled = true; };
  }, [focus, layout, root, drawerTab]);

  /* stamp (explicit user action) */
  const stamp = useCallback(async () => {
    if (!root || stamping) return;
    setStamping(true);
    try {
      await postStamp(root);
      setReloadKey((k) => k + 1); // rescan → fresh statuses
    } catch { /* surfaced by the rescan state */ } finally {
      setStamping(false);
    }
  }, [root, stamping]);

  /* pan */
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.node') || t.closest('.chrome') || t.closest('.drawer') || t.closest('.cmd-scrim')) return;
    pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    stageRef.current?.classList.add('panning');
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      // Snapshot the pan origin NOW — the setView updater runs later (React
      // batches), and mouseup may null the ref in between (end-of-drag race).
      const p = pan.current;
      if (!p) return;
      const tx = p.tx + (e.clientX - p.x);
      const ty = p.ty + (e.clientY - p.y);
      setView((v) => ({ ...v, tx, ty }));
    };
    const up = () => { pan.current = null; stageRef.current?.classList.remove('panning'); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  /* zoom — manual non-passive wheel listener so preventDefault works */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.drawer') || (e.target as HTMLElement).closest('.cmd-scrim')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      setView((v) => {
        const ns = Math.min(2.2, Math.max(0.32, v.s * (1 - e.deltaY * 0.0016)));
        const k = ns / v.s;
        return { s: ns, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoom = (dir: number) => {
    const el = stageRef.current;
    if (!el) return;
    const px = el.clientWidth / 2, py = el.clientHeight / 2;
    setView((v) => {
      const ns = Math.min(2.2, Math.max(0.32, v.s * (dir > 0 ? 1.25 : 0.8)));
      const k = ns / v.s;
      return { s: ns, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
    });
  };

  /* keyboard */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); setCmdOpen((o) => !o); }
      else if (e.key === 'Escape') { if (cmdOpen) setCmdOpen(false); else if (drawerOpen) closeDoc(); }
      else if (e.key.toLowerCase() === 'f' && !cmdOpen && (document.activeElement as HTMLElement)?.tagName !== 'INPUT') fit(!!focus);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [cmdOpen, drawerOpen, focus, fit, closeDoc]);

  /* changed-since-stamp set (files + their stale folder chain) */
  const changedSet = useMemo(() => {
    if (!layout) return new Set<string>();
    const s = new Set<string>();
    for (const n of layout.nodes) {
      if (n.type === 'doc' && CHANGED_FILE.has(n.status)) s.add(n.id);
      if (n.type !== 'doc' && (n.status === 'stale' || n.status === 'removed')) s.add(n.id);
    }
    return s;
  }, [layout]);
  const changedCount = useMemo(
    () => (layout ? layout.nodes.filter((n) => n.type === 'doc' && CHANGED_FILE.has(n.status)).length : 0),
    [layout],
  );

  /* highlight set — hover/focus adjacency wins; else changes-mode lights the changed web */
  const hot = hover || focus;
  const hotSet = useMemo(() => {
    if (hot && layout) {
      const s = new Set([hot]);
      layout.adj[hot]?.forEach((x) => s.add(x));
      return s;
    }
    if (changesMode && changedSet.size > 0) return changedSet;
    return null;
  }, [hot, layout, changesMode, changedSet]);

  /* wiki target resolution: file stem or folder name → node */
  const resolveTarget = useMemo(() => {
    const byStem = new Map<string, AtlasNode>();
    if (layout) {
      for (const n of layout.nodes) {
        if (n.type === 'doc') {
          const stem = (n.relPath.split('/').pop() ?? '').replace(/\.mdx?$/i, '');
          if (stem && !byStem.has(stem)) byStem.set(stem, n);
        } else if (!byStem.has(n.title)) byStem.set(n.title, n);
      }
    }
    return (t: string) => byStem.get(t);
  }, [layout]);

  const docNodes = useMemo(() => (layout ? layout.nodes.filter((n) => n.type === 'doc') : []), [layout]);
  const focusNode = focus && layout ? layout.byId[focus] : null;
  const partners = useMemo(() => {
    if (!focusNode || !layout) return [];
    return [...(layout.adj[focusNode.id] ?? [])]
      .map((id) => layout.byId[id])
      .filter((n): n is AtlasNode => !!n && n.type === 'doc');
  }, [focusNode, layout]);

  return (
    <div className="kb-atlas" ref={stageRef} onMouseDown={onDown}>
      {loadErr && <div className="kb-status err">{loadErr}</div>}
      {!loadErr && !layout && <div className="kb-status">Scanning docs…</div>}

      {layout && (
        <div className="world" style={{
          transform: `translate(${view.tx}px,${view.ty}px) scale(${view.s})`,
          transition: animate ? 'transform .46s cubic-bezier(.4,0,.1,1)' : 'none',
        }}>
          <svg className="edges">
            {/* cross-link web (under tree) */}
            {layout.xedges.map((e) => {
              const a = layout.byId[e.a], b = layout.byId[e.b];
              if (!a || !b) return null;
              const isHot = hotSet && (e.a === hot || e.b === hot);
              const cls = 'xlink' + (isHot ? ' hot' : hotSet ? ' fade' : '');
              return <path key={e.id} className={cls} d={xPath(a, b)} />;
            })}
            {/* structural tree — with the indexed summary flowing along the edge */}
            {layout.tedges.map((e, i) => {
              const a = layout.byId[e.a], b = layout.byId[e.b];
              if (!a || !b) return null;
              const isHot = hotSet && hotSet.has(e.a) && hotSet.has(e.b);
              const cls = 'flow-edge' + (isHot ? ' hot' : hotSet ? ' dim' : '');
              const pid = `kb-te-${i}`;
              const label = e.summary
                ? (e.summary.length > 96 ? e.summary.slice(0, 96) + '…' : e.summary)
                : null;
              return (
                <g key={e.id}>
                  <path id={pid} className={cls} d={treePath(a, b)} />
                  {label && (
                    <text className={'edge-label' + (isHot ? ' hot' : hotSet ? ' dim' : '')} dy={-5}>
                      <textPath href={`#${pid}`} startOffset="50%" textAnchor="middle">
                        {label}
                      </textPath>
                    </text>
                  )}
                </g>
              );
            })}
            {/* anchor dots on tree endpoints */}
            {layout.nodes.map((n) => (
              <circle key={'a' + n.id} className="anchor" r="3"
                cx={n.type === 'doc' ? n.cx - n.halfW : n.cx + n.halfW} cy={n.cy} />
            ))}
          </svg>

          {layout.nodes.map((n) => {
            const faded = hotSet && !hotSet.has(n.id);
            const active = focus === n.id || hover === n.id;
            return (
              <div key={n.id}
                className={
                  'node ' + n.type + ' st-' + n.status + (n.isGhost ? ' ghost' : '') +
                  (active ? ' active' : '') + (faded ? ' faded' : '')
                }
                style={{ left: n.cx, top: n.cy }}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
                onClick={() => { if (n.type === 'doc') openDoc(n.id); }}>
                <div className="card">
                  {n.kicker && <div className="kic"><span className="pip" />{n.kicker}</div>}
                  <div className="ttl">{n.title}</div>
                  {n.sub && <div className="sub">{n.sub}</div>}
                  {n.type === 'doc' && n.deg > 0 && <div className="deg">{n.deg}</div>}
                  {n.type === 'doc' && n.status !== 'fresh' && n.status !== 'manual' && (
                    <div className={'st st-' + n.status} data-testid="kb-status-badge" title={n.status}>
                      {n.status === 'added' ? '+' : n.status === 'removed' ? '−' : n.status === 'modified' ? '●' : '○'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* chrome */}
      <div className="chrome">
        <div className="topbar">
          <div className="brand"><span className="mark" /><div><b>Knowledge Atlas</b><span>{rootName}</span></div></div>
          <div className="spacer" />
          {changedCount > 0 && (
            <div
              className={'pill warn' + (changesMode ? ' on' : '')}
              data-testid="kb-changed-chip"
              title="Highlight changes since the last stamp"
              onClick={() => setChangesMode((m) => !m)}
            >
              <span className="wdot" /><span>{changedCount} changed</span>
            </div>
          )}
          <div className="pill" data-testid="kb-stamp" title="Stamp the current state as the baseline" onClick={stamp}>
            <Icon d={ICONS.stamp} s={14} /><span>{stamping ? 'Stamping…' : 'Stamp baseline'}</span>
          </div>
          <div className="pill" onClick={() => setCmdOpen(true)}>
            <Icon d={ICONS.search} s={14} /><span>Search</span><span className="kbd">⌘K</span>
          </div>
        </div>

        <div className="zoomer">
          <button onClick={() => zoom(1)} title="Zoom in"><Icon d="M12 5v14M5 12h14" s={16} sw={2} /></button>
          <div className="lvl">{Math.round(view.s * 100)}</div>
          <button onClick={() => zoom(-1)} title="Zoom out"><Icon d="M5 12h14" s={16} sw={2} /></button>
          <button onClick={() => fit(!!focus)} title="Fit (f)"><Icon d={['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5']} s={15} /></button>
          <button onClick={() => setReloadKey((k) => k + 1)} title="Rescan docs"><Icon d={ICONS.refresh} s={15} /></button>
        </div>

        <div className="legend">
          <div className="lt">Legend</div>
          <div className="lr"><svg width="22" height="8"><path d="M1 4 C8 4 14 4 21 4" fill="none" stroke="var(--flow)" strokeWidth="1.8" /></svg>Structure</div>
          <div className="lr"><svg width="22" height="8"><path d="M1 4 C8 4 14 4 21 4" fill="none" stroke="var(--rubric)" strokeWidth="1.6" strokeDasharray="2 4" /></svg>Cross-link</div>
          <div className="lr"><span className="sw warn" />Changed</div>
          <div className="lr"><span className="sw ghost" />Removed</div>
        </div>

        {!drawerOpen && layout && <div className="hint">Drag to pan · scroll to zoom · click a node to read</div>}
      </div>

      {/* drawer */}
      <div className={'drawer-scrim' + (drawerOpen ? ' open' : '')} onClick={closeDoc} />
      <aside className={'drawer' + (drawerOpen ? ' open' : '')}>
        {focusNode && (
          <>
            <div className="drawer-head">
              <div>
                <div className="eye">
                  {focusNode.kicker ?? 'Docs'}
                  {focusNode.status !== 'fresh' && focusNode.status !== 'unindexed' ? ` · ${focusNode.status}` : ''}
                </div>
                <h2>{focusNode.title}</h2>
              </div>
              <button className="drawer-x" onClick={closeDoc}><Icon d="M6 6l12 12M18 6L6 18" s={16} sw={2} /></button>
            </div>
            <div className="drawer-body" ref={drawerRef}>
              <div className="d-meta">
                <div className="m"><div className="k">Path</div><div className="v">{focusNode.relPath}</div></div>
                {focusNode.deg > 0 && (
                  <div className="m"><div className="k">Cross-links</div><div className="v">{focusNode.deg}</div></div>
                )}
              </div>
              {(CHANGED_FILE.has(focusNode.status)) && (
                <div className="d-tabs">
                  {!focusNode.isGhost && (
                    <span className={'d-tab' + (drawerTab === 'doc' ? ' active' : '')}
                      onClick={() => setDrawerTab('doc')}>Entry</span>
                  )}
                  <span className={'d-tab' + (drawerTab === 'changes' ? ' active' : '')}
                    data-testid="kb-changes-tab" onClick={() => setDrawerTab('changes')}>Changes</span>
                </div>
              )}
              {drawerTab === 'changes' ? (
                <div className="d-diff" data-testid="kb-diff-panel">
                  {diffBody.loading ? (
                    <p className="d-diff-note">Computing diff…</p>
                  ) : diffBody.skipped ? (
                    <p className="d-diff-note">Diff unavailable ({diffBody.skipped}).</p>
                  ) : diffBody.diff ? (
                    <DiffContent diffString={diffBody.diff} sideBySide={false} />
                  ) : (
                    <p className="d-diff-note">No line changes vs the stamped baseline.</p>
                  )}
                </div>
              ) : focusNode.isGhost ? (
                <div className="d-prose">
                  <p className="lead">This entry was removed since the last stamp — it exists only in the baseline.</p>
                </div>
              ) : (
                <>
                  <div className="d-prose">
                    {docBody.loading
                      ? <p className="lead" style={{ color: 'var(--ink-faint)', fontStyle: 'italic' }}>Reading…</p>
                      : <ProseBlocks blocks={docBody.blocks} resolve={resolveTarget} onNav={openDoc} />}
                  </div>
                  {partners.length > 0 && (
                    <div className="d-links">
                      <div className="lh">Connected · {partners.length}</div>
                      {partners.map((p) => (
                        <span className="d-chip" key={p.id} onClick={() => openDoc(p.id)}>
                          <span className="cd" />{p.title}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </aside>

      <CommandPalette open={cmdOpen} docs={docNodes} onClose={() => setCmdOpen(false)} onNav={openDoc} />
    </div>
  );
}
