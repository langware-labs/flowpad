import flowpadLogo from '@src/assets/logo.png';
import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@src/components/ui/sheet';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { FolderOpen, Grid2x2, Loader2, Search } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useProjectPackage, type PackageItem } from './useProjectPackage';

/* ────────────────────────── metadata ────────────────────────── */

const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

// Human-friendly label for a record scope. Falls through to the raw token for
// any scope this bundle predates.
const SCOPE_LABELS: Record<string, string> = { project: 'Project', user: 'Global', system: 'System' };
const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? scope;

/* ────────────────────────── small building blocks ────────────────────────── */

function TypeGlyph({ type, className }: { type: string; className: string }) {
  const Icon = iconForType(type);
  return <Icon className={className} />;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      <TypeGlyph type={type} className="h-3 w-3" /> {labelForType(type)}
    </span>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span className="rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {scopeLabel(scope)}
    </span>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/* ────────────────────────── asset card ────────────────────────── */

function AssetCard({ item, onOpen }: { item: PackageItem; onOpen: () => void }) {
  return (
    <article
      onClick={onOpen}
      className="group flex cursor-pointer flex-col rounded-xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5"
    >
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground">
          <TypeGlyph type={item.type} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-semibold tracking-tight">{item.name}</h3>
          <p className="truncate text-[11px] text-muted-foreground">{labelForType(item.type)}</p>
        </div>
      </div>

      {item.description && (
        <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
        <TypeBadge type={item.type} />
        <ScopeBadge scope={item.scope} />
      </div>
    </article>
  );
}

/* ────────────────────────── detail slide-over ────────────────────────── */

function DetailPanel({ item, onClose }: { item: PackageItem; onClose: () => void }) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full max-w-2xl flex-col gap-0 bg-card p-0 sm:max-w-2xl">
        {/* header */}
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-card/85 px-6 py-4 pr-12 backdrop-blur-xl">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground">
            <TypeGlyph type={item.type} className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <SheetTitle className="truncate text-lg font-semibold leading-tight tracking-tight">
              {item.name}
            </SheetTitle>
            <SheetDescription className="truncate text-xs text-muted-foreground">
              {labelForType(item.type)}
            </SheetDescription>
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={item.type} />
            <ScopeBadge scope={item.scope} />
          </div>

          {/* DETAILS */}
          <section>
            <h3 className={`mb-2 ${SECTION_TITLE}`}><Trans>Details</Trans></h3>
            <div className="space-y-3 rounded-xl border bg-card p-4 text-sm">
              <p className="leading-relaxed text-muted-foreground">
                {item.description || <span className="italic opacity-60"><Trans>No description.</Trans></span>}
              </p>
              {item.path && (
                <div className="flex items-start gap-2 border-t pt-3">
                  <span className={SECTION_TITLE}><Trans>Path</Trans></span>
                  <code className="ml-auto break-all text-right font-mono text-xs text-muted-foreground">{item.path}</code>
                </div>
              )}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function DiscoverPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { projectId, projectName, items, isLoading } = useProjectPackage();

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<PackageItem | null>(null);

  // Type facets present in this project's box, with counts.
  const typeFacets = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((i) => counts.set(i.type, (counts.get(i.type) ?? 0) + 1));
    return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  }, [items]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (!typeFilter || i.type === typeFilter) &&
        (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)),
    );
  }, [items, query, typeFilter]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* ── app chrome header ── */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 px-4 py-2 backdrop-blur-xl">
        <button onClick={() => void navigate('/')} aria-label={t`Back to home`} className="flex items-center">
          <img src={flowpadLogo} alt={t`Flowpad`} className="max-h-7 object-contain dark:brightness-0 dark:invert" />
        </button>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <UserDropdown />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-5">
          {/* ── hero ── */}
          <section className="relative overflow-hidden pb-8 pt-12">
            <div
              className="pointer-events-none absolute inset-0 opacity-60"
              style={{ background: 'radial-gradient(600px 280px at 30% -20%, hsl(var(--primary) / 0.12), transparent 70%)' }}
            />
            <div className="relative">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                {projectName ? projectName : <Trans>No project open</Trans>}
              </div>
              <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
                <Trans>What&apos;s in the box.</Trans>
              </h1>
              <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
                <Trans>Every skill, agent, spec, and document this project ships.</Trans>
              </p>
            </div>
          </section>

          {projectId == null ? (
            <EmptyState
              icon={<FolderOpen className="mx-auto mb-3 h-8 w-8 opacity-50" />}
              text={t`Open a project to see its assets.`}
            />
          ) : (
            <>
              {/* ── filter bar ── */}
              <section className="sticky top-[57px] z-20 -mx-1 mb-6 rounded-xl border bg-card/95 px-3.5 py-3 backdrop-blur">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <div className="relative min-w-[180px] flex-1">
                    <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t`Search this project…`}
                      className="w-full rounded-lg border bg-background py-1.5 pl-8 pr-3 text-sm outline-none focus:border-primary"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {typeFacets.map(({ type, count }) => (
                      <FilterChip
                        key={type}
                        active={typeFilter === type}
                        onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                      >
                        <TypeGlyph type={type} className="h-3 w-3" /> {labelForType(type)}
                        <span className="opacity-60">{count}</span>
                      </FilterChip>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {list.length} {list.length === 1 ? t`asset` : t`assets`}
                    </span>
                  </div>
                </div>
              </section>

              {/* ── grid ── */}
              <section className="pb-12">
                {isLoading ? (
                  <EmptyState icon={<Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />} text={t`Loading…`} />
                ) : list.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {list.map((i) => (
                      <AssetCard key={`${i.type}:${i.id}`} item={i} onOpen={() => setOpenItem(i)} />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={<Grid2x2 className="mx-auto mb-3 h-8 w-8 opacity-50" />}
                    text={items.length === 0 ? t`This project has no assets yet.` : t`No assets match those filters.`}
                  />
                )}
              </section>
            </>
          )}

          {/* ── footer note ── */}
          <footer className="flex flex-col items-center justify-between gap-3 border-t py-8 text-xs text-muted-foreground sm:flex-row">
            <span><Trans>The assets published with this project — its skills, agents, specs, and docs.</Trans></span>
            <span className="font-mono">{projectName ?? <Trans>discover</Trans>}</span>
          </footer>
        </div>
      </main>

      {openItem && <DetailPanel item={openItem} onClose={() => setOpenItem(null)} />}
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="py-20 text-center text-muted-foreground">
      {icon}
      <p className="text-sm">{text}</p>
    </div>
  );
}
