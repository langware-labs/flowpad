import { Trans, useLingui } from '@lingui/react/macro';
import { InstallButton } from '@src/components/install/InstallButton';
import { installSnippet } from '@src/components/install/InstallSnippetDialog';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { MarkdownView } from '@src/components/markdown-view';
import { Skeleton } from '@src/components/ui/skeleton';
import { CopyableCommand } from '@src/components/version-popover/version-popover';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Project } from '@sdk';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { DiscoverChrome } from './DiscoverChrome';
import { DiscoverHeaderStrip, DiscoverRow, StateChip } from './DiscoverRow';
import { ProvenanceLink } from './ProvenanceLink';
import { bodyCopyKey, fromDirectoryRow, installCommand, type BodyCopyKey, type DiscoverItem } from './discover-model';
import { useDiscoverBody } from './use-discover-body';
import { useDiscoverDirectory } from './useDiscoverDirectory';

/** Why the document is not readable here, as one sentence per cause. */
export function BodyReason({ reason }: { reason: BodyCopyKey | null }) {
  const { t } = useLingui();
  const copy: Record<BodyCopyKey, string> = {
    type_not_git: t`This type's document isn't stored on the hub yet.`,
    not_on_hub_local: t`Published from a folder that isn't linked to the cloud, so only its row is here.`,
    not_on_hub_git: t`Connect GitHub on the publishing desk and re-publish to put the document on the hub.`,
    not_materialized: t`Registered on the hub, but its files were not snapshotted yet.`,
    project_not_linked: t`Document not on the hub: link the project to the cloud first.`,
    github_not_connected: t`Document not on the hub: connect GitHub on this desk, then publish again.`,
    publish_failed: t`The document could not be put on the hub the last time it was published.`,
  };
  return (
    <p className="text-sm text-muted-foreground" data-testid="discover-body-reason">
      {reason ? copy[reason] : t`No document to show here.`}
    </p>
  );
}

/**
 * One published asset: what it is, where it comes from, how to install it, and
 * the document itself when the hub (or this desk) holds it. A route, not a
 * sheet — the URL is the bookmark.
 */
export default function DiscoverDetailPage() {
  const { t } = useLingui();
  const { typeid = '' } = useParams();
  const { navigation } = useDockNavigation();
  const directory = useDiscoverDirectory();
  const hub = directory.mode === 'hub';

  const [hubItem, setHubItem] = useState<DiscoverItem | null>(null);
  const [siblings, setSiblings] = useState<DiscoverItem[]>([]);
  const [hubLoading, setHubLoading] = useState(hub);
  useEffect(() => {
    if (!hub || !typeid) return;
    let cancelled = false;
    setHubLoading(true);
    void Project.getPublishedDirectory({ typeid })
      .then(async (d) => {
        const row = d.rows[0] ? fromDirectoryRow(d.rows[0]) : null;
        if (cancelled) return;
        setHubItem(row);
        if (row?.sourceProjectId) {
          const more = await Project.getPublishedDirectory({ project: row.sourceProjectId });
          if (!cancelled) setSiblings(more.rows.map(fromDirectoryRow).filter((r) => r.typeid !== typeid));
        }
      })
      .catch(() => {
        if (!cancelled) setHubItem(null);
      })
      .finally(() => {
        if (!cancelled) setHubLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hub, typeid]);

  const item = hub ? hubItem : (directory.items.find((i) => i.typeid === typeid) ?? directory.candidates.find((i) => i.typeid === typeid) ?? null);
  const more = hub ? siblings : directory.items.filter((i) => i.typeid !== typeid);
  const loading = hub ? hubLoading : directory.isLoading;
  const body = useDiscoverBody(item, directory.mode);
  const reason = item ? bodyCopyKey(item) : null;
  const projectId = item?.sourceProjectId ?? directory.project?.id ?? null;
  const hubProject = useMemo(
    () => (hub && projectId ? new Project({ id: projectId }) : null),
    [hub, projectId],
  );
  const Icon = iconForType(item?.type ?? 'markdown');

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <DiscoverChrome />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-5 py-6">
          <button
            type="button"
            onClick={() => navigation.openDiscover(projectId)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="discover-back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <Trans>All published assets</Trans>
          </button>

          {loading && !item ? (
            <div className="py-16 text-center text-muted-foreground">
              <Loader2 className="mx-auto h-8 w-8 animate-spin opacity-50" />
            </div>
          ) : !item ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="discover-not-found">
              <Trans>No published asset with that id is visible to you.</Trans>
            </div>
          ) : (
            <>
              <header className="flex items-start gap-3" data-testid="discover-detail-header">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground/80">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="truncate text-xl font-semibold tracking-tight">{item.name}</h1>
                    <StateChip state={item.state} />
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{labelForType(item.type)}</span>
                    <ProvenanceLink origin={item.origin} />
                    {item.sourceProjectName && (
                      <span>
                        <Trans>from {item.sourceProjectName}</Trans>
                      </span>
                    )}
                    {item.publishedAt && <span className="font-mono">{item.publishedAt}</span>}
                  </p>
                  {item.description && <p className="mt-2 text-sm">{item.description}</p>}
                </div>
              </header>

              <section className="rounded-lg border border-border bg-card p-3" data-testid="discover-detail-install">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <CopyableCommand command={installCommand(item.typeid)} />
                  </div>
                  {hubProject && <InstallButton project={hubProject} typeid={item.typeid} name={item.name} />}
                </div>
                <details className="mt-2 text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer">
                    <Trans>First time on this machine?</Trans>
                  </summary>
                  <div className="mt-1.5 space-y-1.5">
                    {installSnippet(item.typeid).map((line) => (
                      <CopyableCommand key={line} command={line} />
                    ))}
                  </div>
                </details>
              </section>

              <section data-testid="discover-detail-body">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Trans>Document</Trans>
                </h2>
                {body.fsRef ? (
                  body.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-6 w-1/2" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                    </div>
                  ) : body.loadError ? (
                    <p className="text-sm text-muted-foreground">{t`The document could not be read.`}</p>
                  ) : (
                    <div className="rounded-lg border border-border bg-card p-4">
                      <MarkdownView value={body.body} />
                    </div>
                  )
                ) : (
                  <BodyReason reason={reason} />
                )}
              </section>

              {more.length > 0 && (
                <section data-testid="discover-more">
                  <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Trans>More from {item.sourceProjectName ?? t`this project`}</Trans>
                  </h2>
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <DiscoverHeaderStrip />
                    {more.map((s, i) => (
                      <DiscoverRow key={s.typeid} item={s} rank={i + 1} onOpen={() => navigation.openDiscoverAsset(s.typeid, s.sourceProjectId)} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
