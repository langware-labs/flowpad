import { useLingui } from '@lingui/react/macro';
import { ClaudeSession, TypeId } from '@sdk';
import { ContextMenuButton } from '@src/components/entity-actions/ContextMenuButton';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { ViewType } from '@src/types/ViewType';
import { EntityActionsToolbar } from '@src/components/entity-actions/EntityActionsToolbar';
import { favoriteTargetForDock } from '@src/components/favorites/favorite-target';
import { chromeActionClusterClassName } from '@src/components/entity-actions/action-button-styles';
import { BookmarksStarButton } from './BookmarksStarButton';
import { PageShareButton } from './PageShareButton';
import { RecordScreenButton } from './RecordScreenButton';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * Record / bookmark / share / pop-out for whatever the bar is currently addressing.
 *
 * Every one of these is an existing surface — this only picks the target and
 * mounts them. In particular the cluster is the SAME `EntityActionsToolbar` the
 * asset editor header uses, in the same order, so the actions don't drift into
 * two dialects of themselves. Record screen leads the row in both branches.
 *
 * Chat about a document is NOT here: it is per viewer (`ViewerChatToggle`).
 */
export function TopBarActions({
  targetTypeId,
  targetTitle,
  dock,
}: {
  targetTypeId: TypeId | null;
  targetTitle: string;
  dock: DockPointer | null;
}) {
  const { t } = useLingui();

  // The star is rendered HERE in both branches, never by the toolbar
  // (`hideFavorite`). It has to be wrapped to carry the bookmarks menu, and the
  // toolbar's copy would be a second star sitting beside it.
  const favorite = favoriteTargetForDock(
    dock,
    targetTypeId ? { typeId: targetTypeId, entity: null } : null,
    targetTitle || t`Bookmarked view`,
  );

  if (targetTypeId) {
    return (
      <EntityActionsToolbar
        typeId={targetTypeId}
        favoriteTitle={targetTitle}
        variant="compact"
        // The chrome size is applied from the bar, not inside the toolbar —
        // the toolbar's compact size belongs to the entity headers that share
        // it.
        className={`shrink-0 ${chromeActionClusterClassName}`}
        leading={<RecordScreenButton />}
        // The bar owns the star (it carries the bookmarks menu), so the toolbar
        // must not draw a second one. Riding the `trailing` slot keeps it inside
        // the toolbar's own row rather than in a wrapper repeating its classes.
        hideFavorite
        showContext
        trailing={favorite && <BookmarksStarButton favorite={favorite} />}
      />
    );
  }

  // No entity to act on (an assets list, settings, a bare shell). The view is
  // still bookmarkable BY ITS DOCK — resolved through the same rule the
  // bookmarks menu uses, so a star set here is the row shown there. Sharing has
  // no subject, except a standalone page (shared as the artifact that names it,
  // minted on click); pop-out gates itself.
  if (!dock) return null;
  const transcript = transcriptSessionOf(dock);
  return (
    <div className={`flex shrink-0 items-center gap-0.5 ${chromeActionClusterClassName}`} data-testid="top-nav-actions">
      <RecordScreenButton />
      {transcript && !isHubOnly() && <ContextMenuButton typeId={transcript} title={targetTitle} />}
      <PageShareButton dock={dock} />
      {favorite && <BookmarksStarButton favorite={favorite} />}
    </div>
  );
}

const SESSION_FILE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * The session a transcript page shows when it is addressed by FILE (a received transcript) and so
 * has no entity target of its own: a transcript file is named by its session's id. The page keeps
 * its path address — only the Context button learns which session it is.
 */
function transcriptSessionOf(dock: DockPointer | null): TypeId | null {
  if (dock?.viewType !== ViewType.LENS || !dock.pointer) return null;
  const lens = DockPointer.parseLensPointer(dock.pointer);
  if (lens?.category !== 'claude' || lens.type !== 'transcript') return null;
  let ref = lens.ref;
  try {
    ref = decodeURIComponent(ref);
  } catch {
    // not an encoded path — match it as it is
  }
  const id = SESSION_FILE.exec(ref)?.[1];
  return id ? new TypeId(ClaudeSession.type, id) : null;
}
