/**
 * The icon showcase — every pack this backend serves, drawn by the SDK.
 *
 * Nothing here draws an icon itself. Every glyph on the page is `<FlowIcon>`,
 * except the one column that deliberately proves no framework is needed
 * (`iconElement` / `iconChip`). If an icon renders here, the SDK can render it
 * anywhere the app can.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as lucideIcons from 'lucide-react';
// Imported module-by-module rather than from the `@sdk` barrel: the barrel
// pulls in every entity class, which this page has no use for and which needs
// build settings a static demo should not have to carry.
import { FlowIcon, FLOW_ICON_SIZES } from '@sdk/react/FlowIcon';
import { useIcon } from '@sdk/react/hooks/useIcon';
import {
  fetchIconPacks,
  iconChip,
  iconElement,
  loadIconPacks,
  registerBundleRenderer,
  resolveIcon,
  type IconPackSpec,
  type IconSpec,
} from '@sdk/icons';
import { DEMO_PACKS } from './demo-packs';
import './gallery.css';

/**
 * The bundle seam, installed once. Without it a `bundle` icon falls back to
 * fetching its SVG — turning tree-shaken inline geometry into one request per
 * glyph. The SDK cannot do this itself: it depends on `dotenv` and nothing else.
 * Lucide exports PascalCase, so the leaf is converted here, where the app knows
 * its own library's convention.
 */
const pascal = (leaf: string) => leaf.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
registerBundleRenderer((name) => (lucideIcons as unknown as Record<string, never>)[pascal(name)]);

/* ------------------------------------------------------------------- parts */

/** The same icon, rendered with no React involved at all. */
function DomGlyph({ tag, packs }: { tag: string; packs: IconPackSpec[] }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (host.current) host.current.replaceChildren(iconElement(tag, packs));
  }, [tag, packs]);
  return <span className="glyph" ref={host} />;
}

/** The chip form — glyph + label, as an inbox row wears it. */
function Chip({ tag, label, compact, packs }: { tag: string; label: string; compact?: boolean; packs: IconPackSpec[] }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (host.current) host.current.replaceChildren(iconChip(tag, label, packs, { compact }));
  }, [tag, label, compact, packs]);
  return <span ref={host} />;
}

/** What a tag resolved to, in words — the page's own diagnostic. */
function Resolved({ tag }: { tag: string }) {
  const { icon, missing, degraded } = useIcon(tag);
  if (missing) return <span className="chip warn">none</span>;
  const resolvedTo = icon.kind === 'asset' || icon.kind === 'bundle' ? icon.tag : icon.kind;
  return (
    <span className="mono resolved">
      {resolvedTo}
      {degraded && <span className="chip warn" style={{ marginInlineStart: 8 }}>degraded</span>}
    </span>
  );
}

function Section({
  title,
  count,
  lede,
  children,
}: {
  title: string;
  count?: string;
  lede: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2>
        {title} {count ? <span className="count">· {count}</span> : null}
      </h2>
      <p className="lede">{lede}</p>
      {children}
    </section>
  );
}

function Row({ children, label, note }: { children: React.ReactNode; label: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="row">
      <div className="swatches">{children}</div>
      <div className="txt">
        <b>{label}</b>
        {note && <div>{note}</div>}
      </div>
    </div>
  );
}

const Swatch = ({ children, caption }: { children: React.ReactNode; caption: string }) => (
  <div className="swatch">
    {children}
    {caption}
  </div>
);

/* -------------------------------------------------------------------- page */

function packRows(pack: IconPackSpec): { tag: string; leaf: string; spec: IconSpec }[] {
  return (pack.icons || []).map((spec) => ({ tag: `${pack.kind}.${spec.kind}`, leaf: spec.kind, spec }));
}

function App() {
  const [packs, setPacks] = useState<IconPackSpec[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [toast, setToast] = useState('');
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    fetchIconPacks()
      .then((loaded) => {
        // The collision fixtures ride alongside the real packs.
        const all = [...loaded, ...DEMO_PACKS].sort((a, b) => a.kind.localeCompare(b.kind));
        loadIconPacks(all);
        setPacks(all);
      })
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark);
    try {
      localStorage.setItem('fp-gallery-theme', dark ? 'dark' : 'light');
    } catch {
      /* private window — the page still renders, it just will not remember */
    }
  }, [dark]);

  const copy = (s: string) => {
    void navigator.clipboard?.writeText(s);
    setToast(`Copied ${s}`);
    setTimeout(() => setToast(''), 1400);
  };

  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());

  const stats = useMemo(() => {
    const named = (packs || []).reduce((n, p) => n + (p.icons || []).length, 0);
    const served = (packs || []).reduce((n, p) => n + (p.served || []).length, 0);
    return { named, served };
  }, [packs]);

  if (error) {
    return (
      <div className="wrap">
        <p className="note bad" style={{ margin: '48px auto' }}>
          <b>No backend.</b> This page reads the packs from a running Flowpad backend — that is what
          it is demonstrating. Start one with <code>uv run -m flow_sdk.server.run</code>, or point at
          another instance with <code>?api=http://localhost:PORT</code>.
          <br />
          <br />
          <span className="mono">{error}</span>
        </p>
      </div>
    );
  }
  if (!packs) return <div className="wrap"><div className="empty">Loading packs…</div></div>;

  const enumerated = packs.filter((p) => (p.icons || []).length > 0);
  const bundles = packs.filter((p) => (p.icons || []).length === 0);
  const withSub = enumerated.flatMap((p) => packRows(p).filter((r) => Object.keys(r.spec.sub || {}).length));
  const tinted = enumerated.flatMap((p) => packRows(p).filter((r) => r.spec.color));
  const themed = enumerated.flatMap((p) => packRows(p).filter((r) => r.spec.dark));

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div>
            <h1>Flowpad Icon Packs</h1>
            <p className="sub">
              {packs.length} packs · {stats.named} named icons · {stats.served} bundle files · every
              glyph is <code>&lt;FlowIcon&gt;</code>
            </p>
          </div>
          <span className="spacer" />
          <input type="search" placeholder="Filter by tag…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="ghost" aria-pressed={dark} onClick={() => setDark((d) => !d)}>
            {dark ? 'Dark' : 'Light'}
          </button>
        </div>
      </header>

      <div className="wrap">
        <Section
          title="The packs"
          lede={
            <>
              An icon is named by a dot tag in the repo's one grammar — <code>brands.slack</code>,{' '}
              <code>lucide.rss</code>. A pack declares the parent <code>kind</code>, each icon the
              leaf. <code>demo-a</code> and <code>demo-b</code> are fixtures injected by this page,
              not shipped artwork.
            </>
          }
        >
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Pack</th><th>Kind</th><th>Icons</th><th>Base</th><th>Licence</th></tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr key={p.kind}>
                    <td><b className="mono">{p.kind}</b></td>
                    <td>
                      <span className={`chip ${(p.icons || []).length ? 'brand' : ''}`}>
                        {(p.icons || []).length ? 'assets' : 'bundle'}
                      </span>
                    </td>
                    <td>{(p.icons || []).length || `${(p.served || []).length} served`}</td>
                    <td className="mono">{p.base || '—'}</td>
                    <td style={{ color: 'hsl(var(--muted-foreground))' }}>{p.license || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ─────────────────────────────── collisions ─────────────────────── */}
        <Section
          title="Collisions"
          lede={
            <>
              Two packs both declare the leaf <code>slack</code>. They do not collide, because the
              full tag is the identity — each is addressed by its own. Asking the bare name instead
              gets whichever pack answers first, which is arbitrary and labelled as such.
            </>
          }
        >
          <div className="rows">
            {[
              ['demo-a.slack', 'the full tag selects A', false],
              ['demo-b.slack', 'the same leaf, the other pack — selected exactly', false],
              ['slack', 'bare name: arbitrary, whichever pack answers first', true],
            ].map(([tag, why, arbitrary]) => (
              <div className="row" key={tag as string}>
                <FlowIcon icon={tag as string} className="glyph-lg" />
                <div className="txt">
                  <b className="mono">{tag as string}</b>
                  <div>{why as string}</div>
                </div>
                {arbitrary ? <span className="chip warn">arbitrary</span> : <span className="chip brand">exact</span>}
                <Resolved tag={tag as string} />
              </div>
            ))}
          </div>
          <p className="lede" style={{ marginTop: 18 }}>
            The same holds one level deeper. A role is one more segment, and best-match answers with
            the deepest tag that exists — so a role an icon does not have degrades to its base rather
            than to nothing, and the page says when that happened:
          </p>
          <div className="rows">
            {[
              ['brands.claude.restore', 'the role exists — composed with its sub-icon'],
              ['brands.slack.restore', 'no such role: degrades to brands.slack'],
              ['brands.slack.typo', 'a misspelled leaf on a valid path — degrades too, which is why the fence tests exactness'],
              ['Nonexsitent', 'nothing on any path claims it'],
            ].map(([tag, why]) => (
              <div className="row" key={tag}>
                <FlowIcon icon={tag} className="glyph-lg" />
                <div className="txt">
                  <b className="mono">{tag}</b>
                  <div>{why}</div>
                </div>
                <Resolved tag={tag} />
              </div>
            ))}
          </div>
        </Section>

        {/* ─────────────────────────────── families ───────────────────────── */}
        <Section
          title="Sizes"
          lede={
            <>
              The named scale maps to what the app actually uses — <code>h-3.5 w-3.5</code> at 654
              sites, <code>h-4 w-4</code> at 519, <code>h-3 w-3</code> at 436. <code>className</code>{' '}
              passes straight through on every strategy, which is what makes the component
              droppable into those ~1,600 call sites unchanged.
            </>
          }
        >
          <div className="rows">
            <Row label="size prop" note="the named scale">
              {(Object.keys(FLOW_ICON_SIZES) as (keyof typeof FLOW_ICON_SIZES)[]).map((s) => (
                <Swatch key={s} caption={`${s} · ${FLOW_ICON_SIZES[s]}`}>
                  <FlowIcon icon="brands.slack" size={s} />
                </Swatch>
              ))}
            </Row>
            <Row label="className" note="the same sizes spelled the way the app already spells them">
              {['h-3 w-3', 'h-3.5 w-3.5', 'h-4 w-4', 'h-5 w-5', 'h-6 w-6'].map((c) => (
                <Swatch key={c} caption={c}>
                  <FlowIcon icon="lucide.rss" className={c} />
                </Swatch>
              ))}
            </Row>
            <Row label="size={n}" note="a live pattern: 35 call sites pass a number, and EntityIcon derives one from its density">
              {[12, 14, 16, 22, 26].map((n) => (
                <Swatch key={n} caption={`${n}px`}>
                  <FlowIcon icon="brands.gmail" size={n} />
                </Swatch>
              ))}
            </Row>
          </div>
        </Section>

        <Section
          title="Colour"
          lede={
            <>
              Three sources, in order of precedence: the <code>color</code> prop, the spec's declared{' '}
              <code>color</code>, then whatever <code>currentColor</code> the surface provides. Only a
              tintable glyph can take any of them — an <code>&lt;img&gt;</code> keeps its own.
            </>
          }
        >
          <div className="rows">
            <Row label="currentColor" note="lucide.brain — a mask inherits colour like text does">
              {['inherit', '#2563eb', '#dc2626', '#16a34a', '#a855f7'].map((c) => (
                <Swatch key={c} caption={c}>
                  <span style={{ color: c === 'inherit' ? undefined : c }}>
                    <FlowIcon icon="lucide.brain" className="glyph-lg" />
                  </span>
                </Swatch>
              ))}
            </Row>
            <Row label="declared in the pack" note={`${tinted.length} brands carry their own colour`}>
              {tinted.map((r) => (
                <Swatch key={r.tag} caption={`${r.leaf} · ${r.spec.color}`}>
                  <FlowIcon icon={r.tag} className="glyph-lg" />
                </Swatch>
              ))}
            </Row>
            <Row label="color prop overrides" note="for a colour scoped to one surface, like Anthropic's clay on the connections screen">
              {['#D97757', '#10A37F', '#94A3B8'].map((c) => (
                <Swatch key={c} caption={c}>
                  <FlowIcon icon="brands.claude" className="glyph-lg" color={c} />
                </Swatch>
              ))}
            </Row>
            <Row label="not tintable" note="brands.slack keeps its four brand colours whatever you ask for">
              {['inherit', '#2563eb', '#dc2626'].map((c) => (
                <Swatch key={c} caption={c}>
                  <span style={{ color: c === 'inherit' ? undefined : c }}>
                    <FlowIcon icon="brands.slack" className="glyph-lg" />
                  </span>
                </Swatch>
              ))}
            </Row>
          </div>
        </Section>

        <Section
          title="Accessibility, state and the escape hatch"
          lede={
            <>
              <code>title</code> present makes the glyph an image with a name; absent leaves it
              decorative, which is the rule every call site already follows — the label lives beside
              the icon. Everything else spreads onto the element, so a class that animates just
              works.
            </>
          }
        >
          <div className="rows">
            <Row label="title" note="inspect these two: role=img + aria-label, vs aria-hidden">
              <Swatch caption="with title"><FlowIcon icon="brands.gmail" className="glyph-lg" title="Gmail" /></Swatch>
              <Swatch caption="decorative"><FlowIcon icon="brands.gmail" className="glyph-lg" /></Swatch>
            </Row>
            <Row label="animation" note="plain className — the app animates icons 254 times and every one is a class">
              <Swatch caption="animate-spin"><FlowIcon icon="lucide.recycle" className="glyph-lg animate-spin" /></Swatch>
              <Swatch caption="animate-pulse"><FlowIcon icon="lucide.bell" className="glyph-lg animate-pulse" /></Swatch>
            </Row>
            <Row
              label="strokeWidth — a limit, shown not hidden"
              note="it reaches a bundle glyph, which is a real SVG; a masked asset has no strokes, so it is inert there. Only 5 icon call sites pass it, so the limit is cheap — but it is real."
            >
              <Swatch caption="bundle · 1"><FlowIcon icon="lucide.database" className="glyph-lg" strokeWidth={1} /></Swatch>
              <Swatch caption="bundle · 3"><FlowIcon icon="lucide.database" className="glyph-lg" strokeWidth={3} /></Swatch>
              <Swatch caption="asset · 1"><FlowIcon icon="flowpad.wiki" className="glyph-lg" strokeWidth={1} /></Swatch>
              <Swatch caption="asset · 3"><FlowIcon icon="flowpad.wiki" className="glyph-lg" strokeWidth={3} /></Swatch>
            </Row>
            <Row label="base / badge classes" note="addressed separately, as IconWithBadge's call sites require">
              <Swatch caption="default">
                <FlowIcon icon="brands.claude" role="restore" className="glyph-lg" />
              </Swatch>
              <Swatch caption="tinted badge">
                <FlowIcon icon="brands.claude" role="restore" className="glyph-lg" badgeClassName="text-blue-500" />
              </Swatch>
            </Row>
            <Row label="onClick" note="rest props land on the element">
              <Swatch caption="click me">
                <FlowIcon
                  icon="lucide.bell"
                  className="glyph-lg"
                  style={{ cursor: 'pointer' }}
                  onClick={() => copy('clicked lucide.bell')}
                />
              </Swatch>
            </Row>
          </div>
        </Section>

        <Section
          title="Sub-icons"
          count={`${withSub.length}`}
          lede={
            <>
              A role, composed rather than drawn. The repo previously carried a hand-made{' '}
              <code>ClaudeRestoreIcon</code>, <code>CodexRestoreIcon</code>,{' '}
              <code>CopilotRestoreIcon</code> and <code>OpenCodeRestoreIcon</code> — four components
              differing only in which mark sat under the same arrow, and which no fifth vendor got
              for free. Each icon now declares{' '}
              <code>sub: {'{'} restore: 'lucide.history' {'}'}</code>.
            </>
          }
        >
          <div className="rows">
            {withSub.map((r) => (
              <div className="row" key={r.tag}>
                <FlowIcon icon={r.tag} className="glyph-lg" />
                {Object.keys(r.spec.sub || {}).map((role) => (
                  <FlowIcon key={role} icon={r.tag} role={role} className="glyph-lg" />
                ))}
                <div className="txt">
                  <b className="mono">{r.tag}</b>
                  <div>
                    base, then {Object.entries(r.spec.sub || {}).map(([k, v]) => `.${k} = ${v}`).join(', ')}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="lede" style={{ marginTop: 16 }}>
            Because it composes, any glyph can badge any other — passed at the call site rather than
            declared on the spec:
          </p>
          <div className="rows">
            {[
              ['brands.slack', 'lucide.bell', 'a channel with something waiting'],
              ['brands.gmail', 'lucide.shield', 'a mailbox under a policy'],
              ['flowpad.wiki', 'lucide.zap', 'a page with an automation on it'],
              ['lucide.folder', 'lucide.brain', 'a folder that is indexed'],
            ].map(([base, badge, why]) => (
              <div className="row" key={base + badge}>
                <FlowIcon icon={base} badge={badge} className="glyph-lg" />
                <div className="txt">
                  <b className="mono">{`<FlowIcon icon="${base}" badge="${badge}" />`}</b>
                  <div>{why}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Theme"
          lede={
            <>
              A <code>dark</code> variant is chosen by CSS, never by a caller passing a theme in. The
              viewer has three states and only two are visible to JS — an explicit choice stamps the
              document, and the default “system” setting stamps nothing at all. Toggle the header
              button, then set it aside and change your OS theme: both work.
            </>
          }
        >
          <div className="rows">
            {themed.map((r) => (
              <div className="row" key={r.tag}>
                <FlowIcon icon={r.tag} className="glyph-lg" />
                <div className="txt">
                  <b className="mono">{r.tag}</b>
                  <div>ships light and dark artwork; the page never picks between them</div>
                </div>
                <span className="chip">dark variant</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Chips"
          lede={
            <>
              The glyph with its name, as an inbox row wears it — this is where the icon system is
              actually judged. At 14px beside 10px text, on a muted plate, a wrong glyph or an
              untinted brand mark is obvious in a way a 26px tile never makes it.
            </>
          }
        >
          <div className="chips">
            {[
              ['brands.slack', 'Slack'], ['brands.gmail', 'Gmail'], ['brands.telegram', 'Telegram'],
              ['brands.googledrive', 'Google Drive'], ['flowpad.cloud-mailbox', 'Cloud Mailbox'],
              ['brands.notion', 'Notion'], ['brands.atlassian', 'Jira'], ['brands.linear', 'Linear'],
              ['lucide.rss', 'RSS'], ['lucide.message-circle', 'WhatsApp'],
            ].map(([tag, label]) => <Chip key={tag} tag={tag} label={label} packs={packs} />)}
          </div>
          <p className="lede" style={{ marginTop: 18 }}>And the compact treatment, for category chips:</p>
          <div className="chips">
            {[
              ['lucide.inbox', 'Inbox'], ['lucide.bell', 'Unread'],
              ['lucide.package', 'Archived'], ['lucide.life-buoy', 'Help Desk'],
            ].map(([tag, label]) => <Chip key={tag} tag={tag} label={label} compact packs={packs} />)}
          </div>
        </Section>

        <Section
          title="React and no-React"
          lede={
            <>
              The left column is <code>&lt;FlowIcon&gt;</code>; the right is{' '}
              <code>iconElement</code> on a bare DOM node. They agree because one resolver sits
              underneath both — which is the claim, not a coincidence. The bundle rows differ in one
              way that matters: <code>FlowIcon</code> draws them from the registered lucide
              renderer with no request, while the plain path fetches the served file.
            </>
          }
        >
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Tag</th><th>&lt;FlowIcon&gt;</th><th>iconElement</th><th>Resolved as</th></tr>
              </thead>
              <tbody>
                {['lucide.rss', 'brands.slack', 'brands.claude.restore', 'ClaudeCode', 'flowpad.wiki', 'anthropic'].map(
                  (tag) => {
                    const res = resolveIcon(tag, packs);
                    return (
                      <tr key={tag}>
                        <td className="mono">{tag}</td>
                        <td><FlowIcon icon={tag} className="glyph-lg" /></td>
                        <td><DomGlyph tag={tag} packs={packs} /></td>
                        <td className="mono" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          {res.kind === 'none' ? 'none' : `${res.kind} · ${'tag' in res ? res.tag : ''}`}
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>
        </Section>

        {enumerated.map((pack) => {
          const rows = packRows(pack).filter((r) => match(r.tag));
          return (
            <Section key={pack.kind} title={pack.kind} count={`${rows.length}/${(pack.icons || []).length}`} lede={pack.license || ''}>
              {rows.length ? (
                <div className="grid">
                  {rows.map((r) => (
                    <button className="tile" key={r.tag} onClick={() => copy(r.tag)} title={`Copy "${r.tag}"`}>
                      <FlowIcon icon={r.tag} className="glyph-lg" />
                      <span className="nm">{r.leaf}</span>
                      <span className="ref mono">{r.tag}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty">Nothing matches “{q}”.</div>
              )}
            </Section>
          );
        })}

        {bundles.map((pack) => {
          const names = (pack.served || []).filter((n) => match(`${pack.kind}.${n}`));
          return (
            <Section
              key={pack.kind}
              title={pack.kind}
              count={`${names.length}/${(pack.served || []).length}`}
              lede={
                <>
                  A declared family. The manifest lists nothing; these are the files the backend
                  serves, and that set is what makes a name valid — which is how a typo is caught in
                  Python. Here they are drawn from the registered lucide renderer, so none of them
                  costs a request.
                </>
              }
            >
              {names.length ? (
                <div className="grid">
                  {names.map((n) => (
                    <button className="tile" key={n} onClick={() => copy(`${pack.kind}.${n}`)}>
                      <FlowIcon icon={`${pack.kind}.${n}`} className="glyph-lg" />
                      <span className="nm">{n}</span>
                      <span className="ref mono">{pack.kind}.{n}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty">Nothing matches “{q}”.</div>
              )}
            </Section>
          );
        })}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
