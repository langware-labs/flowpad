import { Trans, useLingui } from '@lingui/react/macro';
import { PublishedToggle } from '@src/components/assets/editor/PublishedToggle';
import { InstallButton } from '@src/components/install/InstallButton';
import { CopyButton } from '@src/components/ui/copy-button';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { TypeId, type AnyEntity, type Project } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { FolderOpen, Grid2x2, Loader2, PackageCheck, Terminal, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CommandBlock } from './CommandBlock';
import { DiscoverChrome } from './DiscoverChrome';
import { DiscoverHeaderStrip, DiscoverRow } from './DiscoverRow';
import { DiscoverToolbar } from './DiscoverToolbar';
import { filterItems, installCommand, projectFacets, sortItems, typeFacets, type DiscoverItem, type SortKey } from './discover-model';
import { useDiscoverDirectory } from './useDiscoverDirectory';

/* ────────────────────────── row actions per mode ────────────────────────── */

/** Install is an action on the row's PUBLISHER project, whichever project the page is scoped to. */
function HubActions({ item }: { item: DiscoverItem }) {
  const { t } = useLingui();
  const project = useMemo(
    () => (item.sourceProjectId ? ({ id: item.sourceProjectId, typeId: new TypeId('project', item.sourceProjectId) } as unknown as Project) : null),
    [item.sourceProjectId],
  );
  if (!project) return null;
  return (
    <>
      <InstallButton project={project} typeid={item.typeid} name={item.name} />
      <CopyButton
        value={installCommand(item.typeid)}
        icon={Terminal}
        title={t`Copy the terminal command: ${installCommand(item.typeid)}`}
        className="h-7 rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground hover:text-foreground"
        testId="discover-copy-cli"
        stopPropagation
      />
    </>
  );
}

/**
 * The desk row's toggle needs the live entity (it adopts the canonical row the
 * action returns). Only a row that HAS one is asked for — never a `missing` or
 * `install` row, which has no local entity yet.
 */
function DeskActions({ item, projectId, onChanged, onRemove }: { item: DiscoverItem; projectId: string; onChanged: () => void; onRemove: () => void }) {
  const { t } = useLingui();
  const hasLocalRow = item.state !== 'missing' && item.state !== 'install';
  const typeId = useMemo(() => (hasLocalRow ? new TypeId(item.type, item.id) : null), [hasLocalRow, item.type, item.id]);
  const entity = useEntity<AnyEntity>(typeId).data ?? null;
  if (entity) return <PublishedToggle entity={entity} projectId={projectId} variant="row" onChanged={onChanged} />;
  if (item.state === null) return null;
  return (
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
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function DiscoverPage() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [params] = useSearchParams();
  const { mode, items, candidates, project, isLoading, error, refresh } = useDiscoverDirectory();
  const hub = mode === 'hub';

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('published_at');
  const [hovered, setHovered] = useState<DiscoverItem | null>(null);
  // On the hub the project facet IS the URL's scope (`openDiscover(projectId)`
  // preselects it); on the desk the page is the active project's.
  const projectFacet = hub ? params.get('scope-activeProjectId') : null;

  const everything = useMemo(() => [...items, ...candidates], [items, candidates]);
  const types = useMemo(() => typeFacets(everything), [everything]);
  const projects = useMemo(() => projectFacets(items), [items]);
  const published = useMemo(() => sortItems(filterItems(items, { query, type: typeFilter, projectId: projectFacet }), sort), [items, query, typeFilter, projectFacet, sort]);
  const candidateList = useMemo(() => sortItems(filterItems(candidates, { query, type: typeFilter }), 'name'), [candidates, query, typeFilter]);

  const removeRow = async (item: DiscoverItem) => {
    const owner = (await import('@sdk')).dataContext.project;
    if (!owner) return;
    try {
      await owner.unpublish(item.typeid);
      notify.success({ title: item.name, message: t`Removed from the manifest.` });
      refresh();
    } catch (err) {
      notify.error({ title: t`Could not remove the row`, message: errorMessage(err, t`The manifest was not changed.`) });
    }
  };

  const openItem = (item: DiscoverItem) => navigation.openDiscoverAsset(item.typeid, item.sourceProjectId ?? project?.id ?? null);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <DiscoverChrome />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 px-5 py-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="mb-1 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/5 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {hub ? (projectFacet && projects.find((p) => p.id === projectFacet)?.name) || t`Everything you can see` : project?.name || t`No project open`}
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">
                <Trans>Discover</Trans>
              </h1>
              <p className="text-sm text-muted-foreground">
                {hub ? <Trans>Skills, agents, servers and documents published by projects you can read.</Trans> : <Trans>What this project has published, and what it could.</Trans>}
              </p>
            </div>
          </div>

          <CommandBlock typeid={hovered?.typeid ?? null} />

          {!hub && !project ? (
            <EmptyState icon={<FolderOpen className="mx-auto mb-3 h-8 w-8 opacity-50" />} text={t`Open a project to see its assets.`} />
          ) : (
            <>
              <DiscoverToolbar
                query={query}
                onQuery={setQuery}
                type={typeFilter}
                onType={setTypeFilter}
                types={types}
                projectId={projectFacet}
                onProject={(id) => navigation.openDiscover(id)}
                projects={hub ? projects : []}
                sort={sort}
                onSort={setSort}
                count={published.length}
              />

              {error && <p className="text-sm text-destructive">{error}</p>}

              {isLoading ? (
                <EmptyState icon={<Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />} text={t`Loading…`} />
              ) : (
                <>
                  <section data-testid="discover-published">
                    <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <PackageCheck className="h-3.5 w-3.5" />
                      <Trans>Published</Trans>
                      <span className="opacity-60">{published.length}</span>
                    </h2>
                    {published.length > 0 ? (
                      <div className="overflow-hidden rounded-lg border border-border bg-card">
                        <DiscoverHeaderStrip />
                        {published.map((item, i) => (
                          <DiscoverRow
                            key={item.typeid}
                            item={item}
                            rank={i + 1}
                            selected={hovered?.typeid === item.typeid}
                            onOpen={() => openItem(item)}
                            onHover={setHovered}
                            actions={
                              hub
                                ? <HubActions item={item} />
                                : project && <DeskActions item={item} projectId={project.id} onChanged={refresh} onRemove={() => void removeRow(item)} />
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        icon={<Grid2x2 className="mx-auto mb-3 h-8 w-8 opacity-50" />}
                        text={
                          items.length === 0
                            ? hub
                              ? t`Nothing published yet by the projects you can see.`
                              : t`Nothing published yet — publish an asset below, or from its editor.`
                            : t`No published assets match those filters.`
                        }
                      />
                    )}
                  </section>

                  {!hub && (
                    <section data-testid="discover-unpublished">
                      <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <Trans>Not yet published</Trans>
                        <span className="opacity-60">{candidateList.length}</span>
                      </h2>
                      {candidateList.length > 0 ? (
                        <div className="overflow-hidden rounded-lg border border-border bg-card">
                          <DiscoverHeaderStrip />
                          {candidateList.map((item, i) => (
                            <DiscoverRow
                              key={item.typeid}
                              item={item}
                              rank={i + 1}
                              onOpen={() => openItem(item)}
                              actions={project && <DeskActions item={item} projectId={project.id} onChanged={refresh} onRemove={() => undefined} />}
                            />
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
        </div>
      </main>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-6 py-12 text-center text-muted-foreground">
      {icon}
      <p className="text-sm">{text}</p>
    </div>
  );
}
