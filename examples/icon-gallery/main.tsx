/**
 * The icon showcase — every pack this backend serves, drawn by the SDK.
 *
 * Nothing here draws an icon itself. Every glyph on the page comes out of
 * `@sdk/icons`: `useIcon` for the React surfaces, `iconElement` for the ones
 * that prove no framework is needed. That is the point of the page — if an icon
 * renders here, the SDK can render it anywhere, including a plain HTML file.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  fetchIconPacks,
  iconElement,
  resolveIcon,
  type IconPackSpec,
  type IconSpec,
} from '@sdk/icons';
import { useIcon } from '@sdk/react/hooks/useIcon';
import './gallery.css';

/* ------------------------------------------------------------------ glyphs */

/** One icon, rendered through the React hook. */
function Glyph({ refStr, className, title }: { refStr: string; className?: string; title?: string }) {
  const { mount, missing } = useIcon(refStr, { title });
  return <span className={`glyph ${className ?? ''}`} ref={mount} data-missing={missing || undefined} />;
}

/** The chip form: glyph + label, the treatment an inbox row is recognised by. */
function Chip({ refStr, label, compact }: { refStr: string; label: string; compact?: boolean }) {
  const { mountChip } = useIcon(refStr, { label, compact });
  return <span ref={mountChip} />;
}

/** The same icon, rendered with no React involved at all. */
function DomGlyph({ refStr, packs }: { refStr: string; packs: IconPackSpec[] }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = host.current;
    if (el) el.replaceChildren(iconElement(refStr, packs));
  }, [refStr, packs]);
  return <span className="glyph" ref={host} />;
}

/* ------------------------------------------------------------------- parts */

/** A badge passed at the call site rather than declared on the spec. */
function AdHocBadge({ base, badge }: { base: string; badge: string }) {
  const { mount } = useIcon(base, { badge });
  return <span className="glyph" ref={mount} />;
}

function Tile({ refStr, name, onCopy }: { refStr: string; name: string; onCopy: (s: string) => void }) {
  return (
    <button className="tile" onClick={() => onCopy(refStr)} title={`Copy "${refStr}"`}>
      <Glyph refStr={refStr} />
      <span className="nm">{name}</span>
      <span className="ref mono">{refStr}</span>
    </button>
  );
}

function Section({
  id,
  title,
  count,
  lede,
  children,
}: {
  id?: string;
  title: string;
  count?: string;
  lede: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id}>
      <h2>
        {title} {count ? <span className="count">· {count}</span> : null}
      </h2>
      <p className="lede">{lede}</p>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------- page */

/** Everything a pack can be asked for, as flat rows. */
function packRows(pack: IconPackSpec): { ref: string; name: string; spec?: IconSpec }[] {
  return (pack.icons || []).map((spec) => ({
    ref: `${pack.name}:${spec.name}`,
    name: spec.name,
    spec,
  }));
}

function App() {
  const [packs, setPacks] = useState<IconPackSpec[] | null>(null);
  const [error, setError] = useState<string>('');
  const [q, setQ] = useState('');
  const [toast, setToast] = useState('');
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [lucideNames, setLucideNames] = useState<string[]>([]);

  useEffect(() => {
    fetchIconPacks()
      .then(setPacks)
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  // A bundle pack enumerates nothing, so the backend publishes the set it
  // actually serves — the same set `is_valid` answers from.
  useEffect(() => {
    const bundle = (packs || []).find((p) => !p.icons || p.icons.length === 0);
    setLucideNames(bundle?.served || []);
  }, [packs]);

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

  if (error) {
    return (
      <div className="wrap">
        <div className="empty">
          <p className="note bad" style={{ textAlign: 'left', margin: '40px auto' }}>
            <b>No backend.</b> This page reads the packs from a running Flowpad backend — that is
            what it is demonstrating. Start one with <code>uv run -m flow_sdk.server.run</code>, or
            point at another instance with <code>?api=http://localhost:PORT</code>.
            <br />
            <br />
            <span className="mono">{error}</span>
          </p>
        </div>
      </div>
    );
  }
  if (!packs) return <div className="wrap"><div className="empty">Loading packs…</div></div>;

  const enumerated = packs.filter((p) => (p.icons || []).length > 0);
  const bundles = packs.filter((p) => (p.icons || []).length === 0);
  const totalNamed = enumerated.reduce((n, p) => n + (p.icons || []).length, 0);
  // `dark` is not a role a caller asks for — CSS picks it — so it belongs to
  // the Theme section, not this one. A role is baked artwork or a composed
  // sub-icon; from the caller's side `@restore` is the same either way.
  const roles = (r: { spec?: IconSpec }) =>
    [...new Set([...Object.keys(r.spec?.variants || {}), ...Object.keys(r.spec?.sub || {})])].filter(
      (v) => v !== 'dark',
    );
  const withVariants = enumerated.flatMap((p) => packRows(p).filter((r) => roles(r).length > 0));
  const tinted = enumerated.flatMap((p) => packRows(p).filter((r) => r.spec?.color));
  const themed = enumerated.flatMap((p) => packRows(p).filter((r) => r.spec?.variants?.dark));

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div>
            <h1>Flowpad Icon Packs</h1>
            <p className="sub">
              {packs.length} packs · {totalNamed} named icons · {lucideNames.length} bundle files ·
              served by the backend, resolved by the SDK
            </p>
          </div>
          <span className="spacer" />
          <input
            type="search"
            placeholder="Filter by name or ref…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="ghost" aria-pressed={dark} onClick={() => setDark((d) => !d)}>
            {dark ? 'Dark' : 'Light'}
          </button>
        </div>
      </header>

      <div className="wrap">
        <Section
          title="The packs"
          lede="A pack is a namespace of names. It either carries artwork it enumerates, or declares a family the renderer already has — lucide ships thousands of glyphs and lists none of them here, because a second copy of that list would drift."
        >
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Pack</th><th>Kind</th><th>Icons</th><th>Base</th><th>Licence</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr key={p.name}>
                    <td><b>{p.name}</b></td>
                    <td>
                      <span className={`chip ${(p.icons || []).length ? 'brand' : ''}`}>
                        {(p.icons || []).length ? 'assets' : 'bundle'}
                      </span>
                    </td>
                    <td>{(p.icons || []).length || `${lucideNames.length} served`}</td>
                    <td className="mono">{p.base || '—'}</td>
                    <td style={{ color: 'hsl(var(--muted-foreground))' }}>{p.license || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="Sub-icons"
          count={`${withVariants.length}`}
          lede={
            <>
              A role, not a separate icon — and composed, not drawn. The repo previously carried a
              hand-made <code>ClaudeRestoreIcon</code>, <code>CodexRestoreIcon</code>,{' '}
              <code>CopilotRestoreIcon</code> and <code>OpenCodeRestoreIcon</code>: four components
              differing only in which mark sits under the same arrow, and which no fifth vendor got
              for free. Now each icon declares <code>sub: {'{'} restore: 'lucide:history' {'}'}</code>{' '}
              and the badge is resolved through the same registry as anything else.
            </>
          }
        >
          <div className="rows">
            {withVariants.map((r) => (
              <div className="row" key={r.ref}>
                <Glyph refStr={r.ref} />
                {roles(r).map((v) => (
                  <Glyph key={v} refStr={`${r.ref}@${v}`} />
                ))}
                <div className="txt">
                  <b className="mono">{r.ref}</b>
                  <div>
                    base, then {roles(r).map((v) => `@${v}`).join(', ')} — {' '}
                    {Object.entries(r.spec?.sub || {}).map(([k, v]) => `${k} = ${v}`).join(', ') ||
                      'baked artwork'}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="lede" style={{ marginTop: 16 }}>
            Because it composes, any glyph can badge any other — nothing needs a new file. These are
            ad-hoc, passed at the call site rather than declared on the spec:
          </p>
          <div className="rows">
            {[
              ['brands:slack', 'lucide:bell', 'a channel with something waiting'],
              ['brands:gmail', 'lucide:shield', 'a mailbox under a policy'],
              ['flowpad:wiki', 'lucide:zap', 'a page with an automation on it'],
              ['lucide:folder', 'lucide:brain', 'a folder that is indexed'],
            ].map(([base, badge, why]) => (
              <div className="row" key={base + badge}>
                <AdHocBadge base={base} badge={badge} />
                <div className="txt">
                  <b className="mono">
                    useIcon('{base}', {'{'} badge: '{badge}' {'}'})
                  </b>
                  <div>{why}</div>
                </div>
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
              untinted brand mark is obvious in a way a 26px tile never makes it. The SDK ships the
              chip so every surface gets one treatment; colours come from the host's tokens.
            </>
          }
        >
          <div className="chips">
            {[
              ['brands:slack', 'Slack'],
              ['brands:gmail', 'Gmail'],
              ['brands:telegram', 'Telegram'],
              ['brands:googledrive', 'Google Drive'],
              ['flowpad:cloud-mailbox', 'Cloud Mailbox'],
              ['brands:notion', 'Notion'],
              ['brands:atlassian', 'Jira'],
              ['brands:linear', 'Linear'],
              ['lucide:rss', 'RSS'],
              ['lucide:message-circle', 'WhatsApp'],
            ].map(([ref, label]) => (
              <Chip key={ref} refStr={ref} label={label} />
            ))}
          </div>
          <p className="lede" style={{ marginTop: 18 }}>
            And the compact treatment, for category chips:
          </p>
          <div className="chips">
            {[
              ['lucide:inbox', 'Inbox'],
              ['lucide:bell', 'Unread'],
              ['lucide:package', 'Archived'],
              ['lucide:life-buoy', 'Help Desk'],
            ].map(([ref, label]) => (
              <Chip key={ref} refStr={ref} label={label} compact />
            ))}
          </div>
        </Section>

        <Section
          title="Colour on a bundle glyph"
          lede={
            <>
              A lucide glyph is tintable like any other, so it takes a colour the same way — which is
              what the terminal strip already does by hand, tinting one shared mark per vendor
              (<code>text-orange-500</code>, <code>text-emerald-500</code>, <code>text-sky-500</code>,{' '}
              <code>text-violet-500</code> in <code>provider-meta.tsx</code>). Declared in a pack it
              is one value; at a call site it is a class on every usage.
            </>
          }
        >
          <div className="rows">
            <div className="row">
              <div className="swatches">
                {[
                  ['lucide:antenna', '#2563eb'],
                  ['lucide:brain', '#7c3aed'],
                  ['lucide:zap', '#f59e0b'],
                  ['lucide:shield', '#16a34a'],
                  ['lucide:recycle', '#dc2626'],
                  ['lucide:database', '#0891b2'],
                ].map(([ref, c]) => (
                  <div className="swatch" key={ref}>
                    <span style={{ color: c }}>
                      <Glyph refStr={ref} />
                    </span>
                    {ref.replace('lucide:', '')}
                  </div>
                ))}
              </div>
              <div className="txt">
                <b>any colour</b>
                <div>a bundle glyph is a mask — it takes currentColor like the rest</div>
              </div>
            </div>
            <div className="row">
              <div className="swatches">
                {[
                  ['brands:claude', '#f97316', 'claude'],
                  ['brands:codex', '#10b981', 'codex'],
                  ['brands:copilot', '#0ea5e9', 'copilot'],
                  ['brands:opencode', '#8b5cf6', 'opencode'],
                  ['flowpad:shell', undefined, 'shell'],
                ].map(([ref, c, nm]) => (
                  <div className="swatch" key={nm}>
                    <span style={{ color: c }}>
                      <Glyph refStr={ref} />
                    </span>
                    {nm}
                  </div>
                ))}
              </div>
              <div className="txt">
                <b>the terminal strip's own tints</b>
                <div>the per-vendor colours provider-meta.tsx applies today, on these packs</div>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="Tinting"
          lede={
            <>
              <code>tintable</code> picks the render strategy, and that is why it is in the spec
              rather than guessed. A tintable glyph is a CSS mask over <code>currentColor</code>, so
              it inherits colour exactly like text. A four-colour brand mark is an <code>&lt;img&gt;</code>,
              which cannot — try the swatches: the first row follows the colour, the second keeps its own.
            </>
          }
        >
          <div className="rows">
            <div className="row">
              <div className="swatches">
                {['inherit', '#2563eb', '#dc2626', '#16a34a', '#a855f7'].map((c) => (
                  <div className="swatch" key={c}>
                    <span style={{ color: c === 'inherit' ? undefined : c }}>
                      <Glyph refStr="brands:github" />
                    </span>
                    {c}
                  </div>
                ))}
              </div>
              <div className="txt"><b>tintable</b><div>brands:github — a mask, follows currentColor</div></div>
            </div>
            <div className="row">
              <div className="swatches">
                {['inherit', '#2563eb', '#dc2626', '#16a34a', '#a855f7'].map((c) => (
                  <div className="swatch" key={c}>
                    <span style={{ color: c === 'inherit' ? undefined : c }}>
                      <Glyph refStr="brands:slack" />
                    </span>
                    {c}
                  </div>
                ))}
              </div>
              <div className="txt"><b>not tintable</b><div>brands:slack — an image, keeps the brand's four colours</div></div>
            </div>
          </div>
        </Section>

        <Section
          title="Declared colour"
          count={`${tinted.length}`}
          lede={
            <>
              A brand that has a colour says so once, in its pack. These were previously wrapped at
              the call site to add a hex — which <code>provider-marks.tsx</code> itself calls the
              wrong place for it: “Colour belongs in the glyph, not at the call site.”
            </>
          }
        >
          <div className="grid">
            {tinted.map((r) => (
              <div className="tile" key={r.ref}>
                <Glyph refStr={r.ref} />
                <span className="nm">{r.name}</span>
                <span className="ref mono">{r.spec?.color}</span>
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
              button, then set the toggle aside and change your OS theme: both work.
            </>
          }
        >
          <div className="rows">
            {themed.map((r) => (
              <div className="row" key={r.ref}>
                <Glyph refStr={r.ref} />
                <div className="txt">
                  <b className="mono">{r.ref}</b>
                  <div>ships light and dark artwork; the page never picks between them</div>
                </div>
                <span className="chip">dark variant</span>
              </div>
            ))}
            {!themed.length && <div className="note">No pack declares a dark variant.</div>}
          </div>
        </Section>

        <Section
          title="React and no-React"
          lede={
            <>
              The left column is <code>useIcon</code>; the right is <code>iconElement</code> called on
              a bare DOM node. They agree because there is only one resolver underneath and both are
              thin wrappers over it — which is the claim, not a coincidence.
            </>
          }
        >
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Reference</th><th>useIcon (React)</th><th>iconElement (no framework)</th><th>Resolved as</th></tr>
              </thead>
              <tbody>
                {['Rss', 'brands:slack', 'brands:claude@restore', 'ClaudeCode', 'flowpad:wiki', 'anthropic'].map((ref) => {
                  const res = resolveIcon(ref, packs);
                  return (
                    <tr key={ref}>
                      <td className="mono">{ref}</td>
                      <td><Glyph refStr={ref} /></td>
                      <td><DomGlyph refStr={ref} packs={packs} /></td>
                      <td className="mono" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {res.kind === 'none' ? 'none' : `${res.kind}${'pack' in res ? ` · ${res.pack}:${res.name}` : ''}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="Fallbacks"
          lede="A name nothing claims resolves to none — the caller draws its own fallback rather than getting a wrong glyph. This is the case the old path handled silently, which is why a misspelling used to look like a document icon."
        >
          <div className="rows">
            {['Nonexsitent', 'brands:nope', 'brands:slack@restore', 'icons/missing.svg'].map((ref) => {
              const res = resolveIcon(ref, packs);
              return (
                <div className="row" key={ref}>
                  <Glyph refStr={ref} />
                  <div className="txt">
                    <b className="mono">{ref}</b>
                    <div>
                      {ref === 'Nonexsitent' && 'a typo — caught, where it used to render as a document'}
                      {ref === 'brands:nope' && 'qualified but unknown in that pack'}
                      {ref === 'brands:slack@restore' && 'a real icon, but it has no such role'}
                      {ref === 'icons/missing.svg' && 'a path — always a location, so it is never a name lookup'}
                    </div>
                  </div>
                  <span className={`chip ${res.kind === 'none' ? 'warn' : ''}`}>{res.kind}</span>
                </div>
              );
            })}
          </div>
        </Section>

        {enumerated.map((pack) => {
          const rows = packRows(pack).filter((r) => match(r.name) || match(r.ref));
          return (
            <Section
              key={pack.name}
              id={pack.name}
              title={pack.name}
              count={`${rows.length}/${(pack.icons || []).length}`}
              lede={pack.license || ''}
            >
              {rows.length ? (
                <div className="grid">
                  {rows.map((r) => <Tile key={r.ref} refStr={r.ref} name={r.name} onCopy={copy} />)}
                </div>
              ) : (
                <div className="empty">Nothing matches “{q}”.</div>
              )}
            </Section>
          );
        })}

        {bundles.map((pack) => {
          const names = lucideNames.filter((n) => match(n));
          return (
            <Section
              key={pack.name}
              id={pack.name}
              title={pack.name}
              count={`${names.length}/${lucideNames.length}`}
              lede={
                <>
                  A declared family. The manifest lists nothing; these are the files the backend
                  actually serves, and that set is exactly what makes a name valid — which is how a
                  typo gets caught in Python and how this page renders a lucide glyph without
                  bundling lucide.
                </>
              }
            >
              {names.length ? (
                <div className="grid">
                  {names.map((n) => (
                    <Tile key={n} refStr={`${pack.name}:${n}`} name={n} onCopy={copy} />
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
