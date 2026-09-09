import flowpadLogo from '@src/assets/logo.png';
import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@src/components/ui/sheet';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { PublishedToggle } from '@src/components/assets/editor/PublishedToggle';
import { InstallButton } from '@src/components/install/InstallButton';
import { installSnippet } from '@src/components/install/InstallSnippetDialog';
import { CopyButton } from '@src/components/ui/copy-button';
import { CopyableCommand } from '@src/components/version-popover/version-popover';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { TypeId, type AnyEntity, type Project, type PublishedRow, type PublishedState, type UnpublishedRow } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { FolderOpen, Grid2x2, Loader2, PackageCheck, Search, Terminal, Trash2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { usePublishedManifest } from './usePublishedManifest';

/* ────────────────────────── metadata ────────────────────────── */

const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

/** One card, from either section. A published row carries a manifest state; a candidate has none. */
interface DiscoverItem {
  typeid: string;
  type: string;
  id: string;
  name: string;
  description: string;
  path: string | null;
  state: PublishedState | null;
  publishedAt: string | null;
}

function fromPublished(r: PublishedRow): DiscoverItem {
  return {
    typeid: r.typeid,
    type: r.type,
    id: r.id,
    name: r.name || '(untitled)',
    description: r.description || '',
    path: r.posix_path ?? r.rel_path ?? null,
    state: r.state,
    publishedAt: r.published_at || null,
  };
}

function fromUnpublished(r: UnpublishedRow): DiscoverItem {
  return {
    typeid: r.typeid,
    type: r.type,
    id: new TypeId(r.typeid).id,
    name: r.name || '(untitled)',
    description: '',
    path: r.posix_path,
    state: null,
    publishedAt: null,
  };
}

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

/** The manifest state of a published row, as a chip. */
function StateChip({ state }: { state: PublishedState }) {
  const { t } = useLingui();
  const copy: Record<PublishedState, { label: string; tone: string; title: string }> = {
    in_use: {
      label: t`In use`,
      tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      title: t`The asset is here and indexed`,
    },
    install: {
      label: t`Installable`,
      tone: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      title: t`Not indexed here yet — install it from its origin`,
    },
    stale: {
      label: t`Changed since publish`,
      tone: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      title: t`The file is newer than its published row`,
    },
    missing: {
      label: t`Missing`,
      tone: 'border-destructive/40 bg-destructive/10 text-destructive',
      title: t`Named by the manifest but gone from disk`,
    },
  };
  const c = copy[state];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${c.tone}`} title={c.title} data-state={state}>
      {c.label}
    </span>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'border-transparent bg-primary text-primary-foreground' : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/* ────────────────────────── asset card ────────────────────────── */

function AssetCard({
  item,
  project,
  onOpen,
  onChanged,
  onRemove,
}: {
  item: DiscoverItem;
  project: Project;
  onOpen: () => void;
  onChanged: () => void;
  onRemove?: () => void;
}) {
  const { t } = useLingui();
  const hub = isHubOnly();
  const published = item.state !== null;
  // The toggle needs the live entity (it adopts the canonical row the action
  // returns). Only a row that HAS one is asked for: not on the hub (no toggle
  // there, and a 401 for an entity the hub never held reads as credential
  // loss), and not a `missing` / `install` row, which has no local entity yet.
  const hasLocalRow = !hub && item.state !== 'missing' && item.state !== 'install';
  const cardTypeId = useMemo(() => (hasLocalRow ? new TypeId(item.type, item.id) : null), [hasLocalRow, item.type, item.id]);
  const entity = useEntity<AnyEntity>(cardTypeId).data ?? null;
  return (
    <article
      onClick={onOpen}
      data-testid="discover-card"
      data-typeid={item.typeid}
      data-published={published ? 'true' : 'false'}
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

      {item.description && <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{item.description}</p>}

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
        <TypeBadge type={item.type} />
        {item.state && <StateChip state={item.state} />}
        <span className="ms-auto" onClick={(e) => e.stopPropagation()}>
          {hub && published && (
            <span className="inline-flex items-center gap-1">
              <InstallButton project={project} typeid={item.typeid} name={item.name} />
              <CopyButton
                value={`flow asset install ${item.typeid}`}
                icon={Terminal}
                title={t`Copy the terminal command: flow asset install ${item.typeid}`}
                className="h-7 rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground hover:text-foreground"
                testId="discover-copy-cli"
                stopPropagation
              />
            </span>
          )}
          {!hub && entity && <PublishedToggle entity={entity} projectId={project.id} variant="row" onChanged={onChanged} />}
          {!hub && !entity && published && onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-medium text-muted-foreground hover:text-destructive"
              title={t`Remove this row from the manifest`}
              data-testid="discover-remove-row"
            >
              <Trash2 className="h-3 w-3" />
              <Trans>Remove</Trans>
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

/* ────────────────────────── detail slide-over ────────────────────────── */

function DetailPanel({ item, onClose }: { item: DiscoverItem; onClose: () => void }) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full max-w-2xl flex-col gap-0 bg-card p-0 sm:max-w-2xl">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-card/85 px-6 py-4 pe-12 backdrop-blur-xl">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground">
            <TypeGlyph type={item.type} className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <SheetTitle className="truncate text-lg font-semibold leading-tight tracking-tight">{item.name}</SheetTitle>
            <SheetDescription className="truncate text-xs text-muted-foreground">{labelForType(item.type)}</SheetDescription>
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={item.type} />
            {item.state && <StateChip state={item.state} />}
          </div>

          <section>
            <h3 className={`mb-2 ${SECTION_TITLE}`}>
              <Trans>Details</Trans>
            </h3>
            <div className="space-y-3 rounded-xl border bg-card p-4 text-sm">
              <p className="leading-relaxed text-muted-foreground">
                {item.description || (
                  <span className="italic opacity-60">
                    <Trans>No description.</Trans>
                  </span>
                )}
              </p>
              {item.path && (
                <div className="flex items-start gap-2 border-t pt-3">
                  <span className={SECTION_TITLE}>
                    <Trans>Path</Trans>
                  </span>
                  <code className="ms-auto break-all text-end font-mono text-xs text-muted-foreground">{item.path}</code>
                </div>
              )}
              {item.publishedAt && (
                <div className="flex items-start gap-2 border-t pt-3">
                  <span className={SECTION_TITLE}>
                    <Trans>Published</Trans>
                  </span>
                  <code className="ms-auto font-mono text-xs text-muted-foreground">{item.publishedAt}</code>
                </div>
              )}
            </div>
          </section>

          {item.state && (
            <section data-testid="discover-cli-snippet">
              <h3 className={`mb-2 ${SECTION_TITLE}`}>
                <Trans>Install from a terminal</Trans>
              </h3>
              <p className="mb-2 text-xs text-muted-foreground">
                <Trans>On a machine with Flowpad already running and signed in, the last line alone is enough.</Trans>
              </p>
              <div className="space-y-1.5">
                {installSnippet(item.typeid).map((line) => (
                  <CopyableCommand key={line} command={line} />
                ))}
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function DiscoverPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { project, projectName, view, rows, unpublished, isLoading, refresh } = usePublishedManifest();
  const hub = isHubOnly();

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<DiscoverItem | null>(null);

  const published = useMemo(() => rows.map(fromPublished), [rows]);
  const candidates = useMemo(() => (hub ? [] : unpublished.map(fromUnpublished)), [hub, unpublished]);

  // Type facets across both sections, with counts.
  const typeFacets = useMemo(() => {
    const counts = new Map<string, number>();
    [...published, ...candidates].forEach((i) => counts.set(i.type, (counts.get(i.type) ?? 0) + 1));
    return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  }, [published, candidates]);

  const matches = (i: DiscoverItem) => {
    const q = query.trim().toLowerCase();
    return (!typeFilter || i.type === typeFilter) && (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  };
  const publishedList = published.filter(matches);
  const candidateList = candidates.filter(matches);

  const removeRow = async (item: DiscoverItem) => {
    if (!project) return;
    try {
      await project.unpublish(item.typeid);
      notify.success({ title: item.name, message: t`Removed from the manifest.` });
      refresh();
    } catch (error) {
      notify.error({ title: t`Could not remove the row`, message: errorMessage(error, t`The manifest was not changed.`) });
    }
  };

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
                <Trans>What this project has published — its skills, agents, servers and documents — for everyone with access to use.</Trans>
              </p>
            </div>
          </section>

          {project == null ? (
            <EmptyState icon={<FolderOpen className="mx-auto mb-3 h-8 w-8 opacity-50" />} text={t`Open a project to see its assets.`} />
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
                      className="w-full rounded-lg border bg-background py-1.5 pe-3 ps-8 text-sm outline-none focus:border-primary"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {typeFacets.map(({ type, count }) => (
                      <FilterChip key={type} active={typeFilter === type} onClick={() => setTypeFilter(typeFilter === type ? null : type)}>
                        <TypeGlyph type={type} className="h-3 w-3" /> {labelForType(type)}
                        <span className="opacity-60">{count}</span>
                      </FilterChip>
                    ))}
                  </div>
                  <div className="ms-auto flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {publishedList.length} {t`published`}
                    </span>
                  </div>
                </div>
              </section>

              {isLoading ? (
                <EmptyState icon={<Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />} text={t`Loading…`} />
              ) : (
                <>
                  {/* ── Published ── */}
                  <section className="pb-10" data-testid="discover-published">
                    <h2 className={`mb-3 flex items-center gap-2 ${SECTION_TITLE}`}>
                      <PackageCheck className="h-3.5 w-3.5" />
                      <Trans>Published</Trans>
                      <span className="opacity-60">{publishedList.length}</span>
                    </h2>
                    {publishedList.length > 0 ? (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {publishedList.map((i) => (
                          <AssetCard key={i.typeid} item={i} project={project} onOpen={() => setOpenItem(i)} onChanged={refresh} onRemove={() => void removeRow(i)} />
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        icon={<Grid2x2 className="mx-auto mb-3 h-8 w-8 opacity-50" />}
                        text={
                          published.length === 0
                            ? hub
                              ? t`This project has not published anything yet.`
                              : t`Nothing published yet — publish an asset below, or from its editor.`
                            : t`No published assets match those filters.`
                        }
                      />
                    )}
                  </section>

                  {/* ── Not yet published (desk only) ── */}
                  {!hub && (
                    <section className="pb-12" data-testid="discover-unpublished">
                      <h2 className={`mb-3 flex items-center gap-2 ${SECTION_TITLE}`}>
                        <Trans>Not yet published</Trans>
                        <span className="opacity-60">{candidateList.length}</span>
                      </h2>
                      {candidateList.length > 0 ? (
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                          {candidateList.map((i) => (
                            <AssetCard key={i.typeid} item={i} project={project} onOpen={() => setOpenItem(i)} onChanged={refresh} />
                          ))}
                        </div>
                      ) : (
                        <EmptyState
                          icon={<Grid2x2 className="mx-auto mb-3 h-8 w-8 opacity-50" />}
                          text={candidates.length === 0 ? t`Everything in this project is published.` : t`No assets match those filters.`}
                        />
                      )}
                    </section>
                  )}
                </>
              )}
            </>
          )}

          {/* ── footer note ── */}
          <footer className="flex flex-col items-center justify-between gap-3 border-t py-8 text-xs text-muted-foreground sm:flex-row">
            <span>
              <Trans>The assets published with this project — its skills, agents, specs, and docs.</Trans>
            </span>
            <span className="font-mono">{view?.manifest.rel_path || (projectName ?? <Trans>discover</Trans>)}</span>
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
