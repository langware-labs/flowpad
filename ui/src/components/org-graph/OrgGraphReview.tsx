// Organization entities review — the "your world" graph. Data is fetched
// access-scoped from the org_graph action; rendering (canvas edges + a culled
// DOM-card overlay, pan/zoom/hover/drag, radial vs tree layout) is handled
// imperatively by createEngine so it scales to thousands of nodes. This
// component owns the React surface: data load, the chrome (zoom bar + layout
// toggle + counts), and the detail drawer.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { buildOrgAtlasLayout, fetchOrgGraph, type AtlasLayout } from './orgAtlasData';
import { createEngine, type Engine, type LayoutMode } from './orgAtlasEngine';
import './atlas.css';

function Icon({ d, s = 16, sw = 1.6 }: { d: string | string[]; s?: number; sw?: number }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}
const ICONS = {
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  org: ['M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z', 'M10 6h4', 'M10 10h4', 'M10 14h4'],
  circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  tree: ['M4 4h6M4 12h6M4 20h6', 'M10 4v16'],
};

export type OrgGraphReviewProps = {
  // Where to root the tree. 'viewer' (default) is the "your world" graph rooted
  // at the signed-in user; 'organization' re-roots at the caller's organization
  // node so the tree reads org → teams → people. Same data, same engine — only
  // the BFS root differs.
  rootPreference?: 'viewer' | 'organization';
  // When set, keep only nodes of these entity types (and edges between them)
  // before layout — e.g. ['organization', 'team', 'user'] for a clean org view
  // that hides unrelated reachable assets (projects, conversations, skills).
  filterTypes?: string[];
  title?: string;
  subtitle?: string;
  emptyText?: string;
};

export default function OrgGraphReview({
  rootPreference = 'viewer',
  filterTypes,
  title = 'Organization entities',
  subtitle = 'your world',
  emptyText = 'You don’t belong to an organization yet.',
}: OrgGraphReviewProps = {}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);

  const [layout, setLayout] = useState<AtlasLayout | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<LayoutMode>('radial');
  const modeRef = useRef(mode); // latest mode, read when (re)creating the engine without forcing a rebuild
  modeRef.current = mode;
  const [zoomPct, setZoomPct] = useState(100);
  const [focus, setFocus] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  /* data */
  useEffect(() => {
    let cancelled = false;
    setLoadErr(null);
    setLayout(null);
    void (async () => {
      try {
        const { nodes, edges, viewer } = await fetchOrgGraph();
        // Optional type-scoping: keep only the requested entity types, and the
        // edges whose BOTH endpoints survive — so an org view drops unrelated
        // reachable assets without any backend change.
        const nodesIn = filterTypes ? nodes.filter((n) => filterTypes.includes(n.type)) : nodes;
        const kept = new Set(nodesIn.map((n) => n.key));
        const edgesIn = filterTypes
          ? edges.filter((e) => kept.has(`${e.from.type}-${e.from.id}`) && kept.has(`${e.to.type}-${e.to.id}`))
          : edges;
        // Re-root at the organization node when asked; fall back to the viewer
        // if the caller has no org (buildOrgAtlasLayout also falls back on its own).
        const root =
          rootPreference === 'organization' ? (nodesIn.find((n) => n.type === 'organization')?.key ?? viewer) : viewer;
        if (!cancelled) setLayout(buildOrgAtlasLayout(nodesIn, edgesIn, root));
      } catch (e) {
        if (!cancelled) setLoadErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, rootPreference, filterTypes]);

  const openNode = useCallback((id: string) => {
    setFocus(id);
    setDrawerOpen(true);
    engineRef.current?.setFocus(id);
  }, []);

  /* engine lifecycle — created once the layout and stage exist, torn down on reload */
  useEffect(() => {
    if (!layout || !stageRef.current || layout.nodes.length === 0) return;
    const engine = createEngine(stageRef.current, layout, {
      onOpenNode: openNode,
      onZoom: setZoomPct,
      initialMode: modeRef.current,
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [layout, openNode]);

  useEffect(() => {
    engineRef.current?.setMode(mode);
  }, [mode]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    engineRef.current?.setFocus(null);
    setTimeout(() => setFocus(null), 320);
  }, []);

  const counts = layout?.counts ?? { organization: 0, team: 0, user: 0 };
  const focusNode = focus && layout ? layout.byId[focus] : null;
  const partners =
    focusNode && layout ? [...(layout.adj[focusNode.id] ?? [])].map((id) => layout.byId[id]).filter(Boolean) : [];
  const roleOf = (aId: string, bId: string): string | null => {
    const e = layout?.tedges.find((t) => (t.a === aId && t.b === bId) || (t.a === bId && t.b === aId));
    return e?.summary ?? null;
  };
  const isEmpty = !loadErr && layout && layout.nodes.length === 0;

  return (
    <div className="kb-atlas" ref={stageRef}>
      {loadErr && <div className="kb-status err">{loadErr}</div>}
      {!loadErr && !layout && <div className="kb-status">Loading organization…</div>}
      {isEmpty && <div className="kb-status">{emptyText}</div>}

      {/* chrome */}
      <div className="chrome">
        <div className="topbar">
          <div className="brand">
            <span className="mark" />
            <div>
              <b>{title}</b>
              <span>{subtitle}</span>
            </div>
          </div>
          <div className="og-modes" role="group" aria-label="Layout">
            <button className={mode === 'radial' ? 'on' : ''} onClick={() => setMode('radial')} title="Circle layout">
              <Icon d={ICONS.circle} s={13} /> Circle
            </button>
            <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')} title="Tree layout">
              <Icon d={ICONS.tree} s={13} /> Tree
            </button>
          </div>
          <div className="spacer" />
          <div className="pill">
            <Icon d={ICONS.org} s={14} />
            <span>
              {counts.organization} org · {counts.team} teams · {counts.user} people
            </span>
          </div>
        </div>

        <div className="zoomer">
          <button onClick={() => engineRef.current?.zoomBy(1.25)} title="Zoom in">
            <Icon d="M12 5v14M5 12h14" s={16} sw={2} />
          </button>
          <div className="lvl">{zoomPct}</div>
          <button onClick={() => engineRef.current?.zoomBy(0.8)} title="Zoom out">
            <Icon d="M5 12h14" s={16} sw={2} />
          </button>
          <button onClick={() => engineRef.current?.fit()} title="Fit">
            <Icon d={['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5']} s={15} />
          </button>
          <button onClick={() => setReloadKey((k) => k + 1)} title="Reload">
            <Icon d={ICONS.refresh} s={15} />
          </button>
        </div>

        <div className="legend">
          <div className="lt">Legend</div>
          <div className="lr">
            <svg width="22" height="8">
              <path d="M1 4 C8 4 14 4 21 4" fill="none" stroke="var(--flow)" strokeWidth="1.8" />
            </svg>
            Membership (role)
          </div>
          <div className="lr">
            <svg width="22" height="8">
              <path
                d="M1 4 C8 4 14 4 21 4"
                fill="none"
                stroke="var(--rubric)"
                strokeWidth="1.6"
                strokeDasharray="2 4"
              />
            </svg>
            Also a member of
          </div>
        </div>

        {!drawerOpen && layout && layout.nodes.length > 0 && (
          <div className="hint">Drag to pan · scroll to zoom · click a card</div>
        )}
      </div>

      {/* drawer */}
      <div className={'drawer-scrim' + (drawerOpen ? ' open' : '')} onClick={closeDrawer} />
      <aside className={'drawer' + (drawerOpen ? ' open' : '')}>
        {focusNode && (
          <>
            <div className="drawer-head">
              <div>
                <div className="eye">
                  {focusNode.entityType}
                  {focusNode.sub ? ` · ${focusNode.sub}` : ''}
                </div>
                <h2>{focusNode.title}</h2>
              </div>
              <button className="drawer-x" onClick={closeDrawer}>
                <Icon d="M6 6l12 12M18 6L6 18" s={16} sw={2} />
              </button>
            </div>
            <div className="drawer-body">
              <div className="d-meta">
                <div className="m">
                  <div className="k">Type</div>
                  <div className="v">{focusNode.entityType}</div>
                </div>
                <div className="m">
                  <div className="k">Id</div>
                  <div className="v">{focusNode.id.replace(/^[^-]+-/, '')}</div>
                </div>
              </div>
              {partners.length > 0 && (
                <div className="d-links">
                  <div className="lh">Connected · {partners.length}</div>
                  {partners.map((p) => {
                    const role = roleOf(focusNode.id, p.id);
                    return (
                      <span className="d-chip" key={p.id} onClick={() => openNode(p.id)}>
                        <span className="cd" />
                        {p.title}
                        <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 11 }}>{role ?? p.entityType}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
