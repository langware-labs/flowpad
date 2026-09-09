import { dataContext, isPublishableType } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { errorMessage } from '@src/lib/error-message';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { notify } from '@src/notifications';
import { Loader2, PackageCheck, PackagePlus } from 'lucide-react';
import { useCallback, useState } from 'react';

/**
 * What the toggle reads off an entity: structural on purpose, so a Skill, a
 * SubAgent, an Mcp or a cache-resolved entity all pass without a cast.
 * `setPublished` is APIEntity's; the fields are the base entity's.
 */
interface PublishableEntity {
  typeId?: { type: string; id: string };
  name?: string | null;
  published?: boolean;
  asset_ref?: string | null;
  project_id?: string | null;
  scope?: string | null;
  setPublished(published: boolean, projectId?: string | null): Promise<unknown>;
}

interface PublishedToggleProps {
  entity: PublishableEntity;
  /** The project whose manifest receives the row; defaults to the active project. */
  projectId?: string | null;
  /** `pill` sits in an editor header; `row` sits on a Discover card. */
  variant?: 'pill' | 'row';
  /** Called with the canonical row the backend returned, after adoption. */
  onChanged?: (entity: PublishableEntity) => void;
}

/**
 * The Published toggle — an ASSET publishes, declaring itself "in the box" of
 * its project. ON writes a row into `agentic-assets/project_manifest/
 * project_manifest.json`; OFF removes it. Information only: it grants nothing.
 *
 * The manifest FILE is the truth. This control never writes `published`
 * itself: it calls `entity.setPublished()` and lets the canonical row the
 * backend returns (adopted into the cache) flip the flag — the same discipline
 * as `ProjectCloudLinkButton` and `remote`.
 *
 * Renders nothing when there is nothing honest to offer: the hub runtime (no
 * local file system to write), a type that cannot be published, an asset with
 * no carrier, or one another project owns (a manifest row is a path relative
 * to the project, so such an asset has no row to write here).
 */
export function PublishedToggle({ entity, projectId, variant = 'pill', onChanged }: PublishedToggleProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  const targetProjectId = projectId ?? dataContext.project?.id ?? null;
  const ownedByTarget = !!targetProjectId && entity.project_id === targetProjectId;

  const published = entity.published === true;

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await entity.setPublished(!published, targetProjectId);
      // The action adopted the canonical row into the cache (in place); the
      // caller re-reads from there.
      onChanged?.(entity);
      notify.success({
        title: entity.name || t`Asset`,
        message: published ? t`Removed from the project's published assets.` : t`Published to the project.`,
      });
    } catch (error) {
      notify.error({
        title: published ? t`Could not unpublish` : t`Could not publish`,
        message: errorMessage(error, t`The manifest was not changed.`),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, entity, onChanged, published, t, targetProjectId]);

  if (isHubOnly() || !isPublishableType(entity.typeId?.type) || !entity.asset_ref || entity.scope === 'system') return null;
  if (!ownedByTarget) return null;

  const Icon = busy ? Loader2 : published ? PackageCheck : PackagePlus;
  const label = published ? t`Published` : t`Publish`;
  const title = published
    ? t`Listed in this project's manifest — click to unpublish`
    : t`Add to this project's manifest so others can discover it`;

  const base =
    variant === 'row'
      ? 'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors'
      : 'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors';
  const tone = published
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300'
    : 'border-border bg-muted text-muted-foreground hover:text-foreground';

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void toggle();
      }}
      disabled={busy}
      aria-pressed={published}
      title={title}
      className={`${base} ${tone} flex-shrink-0 disabled:opacity-60`}
      data-testid="published-toggle"
      data-state={published ? 'published' : 'unpublished'}
    >
      <Icon className={`h-3 w-3 shrink-0 ${busy ? 'animate-spin' : ''}`} />
      {label}
    </button>
  );
}
