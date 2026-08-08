import { useEffect, useMemo, useState } from 'react';
import { LayoutGrid, type LucideIcon } from 'lucide-react';
import { APIEntity, dataManager, Project, Tab, TypeId, Wiki, WikiEntry } from '@sdk';
import { DEFAULT_WIKI_SPACE } from '@src/navigation/asset-doc-types';
import { wikiAuthorityForPage } from '@src/components/wiki/resolve-wiki';
import { useWikiResolveResult } from '@src/routes/loaders/wiki-resolve-store';
import { buildDockPointer } from '@src/components/conversation/EntityChip';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { resolveAncestorChain, type AncestorNode } from '@src/navigation/entity-ancestors';
import { getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { useContext } from '@src/hooks/useContext';

/**
 * The address bar's contents: `Project / …ancestors… / current`.
 *
 * The chain is the entity's CONTAINMENT (`parent_type_id`) — where the thing
 * lives, not how you got to it. Two consequences worth knowing before reading a
 * bug report about this:
 *
 *  - Most entity types carry `parent_type_id === null`, so the usual shape is
 *    `Project / Document` with an EMPTY middle. Deep chains (task→spec,
 *    comment→doc) are the exception, not the rule. This is by design; we
 *    deliberately do not synthesize crumbs out of folder paths.
 *  - The same entity always shows the same crumbs, whatever route you took to
 *    it. That is the point of choosing containment over the tab-opener chain.
 *
 * Resolution is staged so the bar NEVER blocks on the network:
 *
 *   Phase 0 (sync, first frame) — project from context, current entity from the
 *     URL's own target. If the dock target is already the context's active
 *     entity, its display name is in hand immediately.
 *   Phase 1 (microtask on a warm cache) — `Tab.resolveDockTarget` upgrades the
 *     label and covers path-addressed docks the URL alone can't name.
 *   Phase 2 — the ancestor walk fills the middle in.
 *
 * So the bar paints `Project / Something` on the first frame and sharpens; it
 * never blanks and never waits.
 *
 * A WIKI route is the exception to "the middle is the containment chain": it
 * reads `Project / <Wiki> / <word>`, where the middle is the NAMESPACE the word
 * resolved through rather than a parent. See `DockPointer.wikiRef`.
 */

export interface Crumb {
  /** Stable React key: the TypeId string, or 'project' / 'view'. */
  key: string;
  label: string;
  /** Always resolved through the backend type registry — never a literal. */
  Icon: LucideIcon;
  /** null ⇒ not navigable (the current page, or a type no dock can address). */
  pointer: DockPointer | null;
  kind: 'project' | 'ancestor' | 'current';
  /**
   * Where the thing LIVES on disk, when it is file-backed — the absolute machine
   * path and the real basename (with extension, unlike `label`). Both null for a
   * conversation, a process or a list, which have no file. Only the current
   * crumb carries them; they are what its details popover shows, and they moved
   * here when the asset editor's own header row was removed.
   */
  path?: string | null;
  filename?: string | null;
}

export interface EntityBreadcrumbs {
  crumbs: Crumb[];
  /** The dock's target entity. Shared with the actions cluster so the dock is
   *  resolved ONCE per navigation, not once per consumer. */
  targetTypeId: TypeId | null;
  targetTitle: string;
}

/** The "this dock has no entity at all" glyph. Not a per-type icon map — there
 *  is no type here to look up. */
const VIEW_CRUMB_ICON = LayoutGrid;

/** A label good enough for a crumb, never a raw `type-uuid`. `displayName`
 *  falls back to a fabricated id string when an entity has no real name; the
 *  type's own label reads far better in an address bar. */
function entityLabel(entity: APIEntity<any> | null, typeId: TypeId | null): string {
  const synthetic = (entity as { hasSyntheticDisplayName?: boolean } | null)?.hasSyntheticDisplayName;
  const name = entity?.displayName?.trim();
  if (name && !synthetic) return name;
  return typeId ? labelForType(typeId.type) : '';
}

/** What the last crumb says on the app root, which has no dock at all. Without
 *  it the address would read as just the project name and look truncated. */
const HOME_CRUMB_LABEL = 'Start';

/** What the last crumb says on the project's own page, where the target IS the
 *  leading crumb and repeating the name would read "Acme › Acme". */
const PROJECT_HOME_CRUMB_LABEL = 'Home';

/** Basename of an `asset_ref`, trailing separators ignored. */
function basename(ref: string | null): string | null {
  if (!ref) return null;
  return ref.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null;
}

/** Human label for a dock with no target entity (assets list, settings, a bare
 *  shell). The open tab already carries the app's canonical name for it. */
function viewLabel(dock: DockPointer | null): string {
  if (!dock) return HOME_CRUMB_LABEL;
  const tab = getAllTabsSnapshot().find((t) => t.getKey() === dock.tabHash);
  return tab?.name?.trim() || labelForType(dock.viewType ?? '') || HOME_CRUMB_LABEL;
}

export function useEntityBreadcrumbs(dock: DockPointer | null): EntityBreadcrumbs {
  const { project, activeEntity, activeEntityTypeId } = useContext();

  // Identity of what this dock ADDRESSES, as a string.
  //
  // Deliberately not `tabHash`: that identifies the TAB, and one tab shows many
  // things — every document opened inside the assets tab shares the hash
  // `assets|project:<id>`. Keying on it left the address stuck on the list while
  // the user read a document. viewType + pointer is what actually changes with
  // the content; `focus` carries the target for worldview docks, whose pointer
  // does not.
  const dockKey = dock ? `${dock.viewType ?? ''}|${dock.pointer ?? ''}|${dock.options?.focus ?? ''}` : null;

  // Phase 0 — straight off the URL, no awaits, available on the first frame.
  const urlTargetTypeId = useMemo(() => dock?.targetTypeId ?? null, [dockKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A wiki route names its subject instead of identifying it (see
  // `DockPointer.wikiRef`), so nothing here fetches what the route already did:
  // the word is the label, the space is the Wiki's id, and the loader has
  // parked the resolved target in the wiki-resolve store.
  const wikiRef = useMemo(() => dock?.wikiRef ?? null, [dockKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Authority from the PAGE, through the shared helper the loader uses — the
  // store is keyed by it, so assuming 'local' would miss every hub resolve.
  const wikiResolve = useWikiResolveResult(
    wikiRef?.space ?? '',
    wikiRef?.name ?? '',
    wikiAuthorityForPage(dock?.page),
  );
  const wikiPageTypeId = wikiResolve?.kind === 'resolved' ? wikiResolve.target_typeid : null;
  const [wikiCrumb, setWikiCrumb] = useState<{ typeId: TypeId; label: string } | null>(null);

  const [resolved, setResolved] = useState<{ typeId: TypeId | null; entity: APIEntity<any> | null }>({
    typeId: null,
    entity: null,
  });
  const [ancestors, setAncestors] = useState<AncestorNode[]>([]);

  // The Wiki the page lives in, as its own crumb. `@local` is an alias for the
  // active project's default wiki rather than an id, so it takes the same
  // resolution the wiki route itself uses.
  useEffect(() => {
    let live = true;
    setWikiCrumb(null);
    const space = wikiRef?.space;
    if (!space) return;

    void (async () => {
      const wiki =
        space === DEFAULT_WIKI_SPACE
          ? await project?.getDefaultWiki().catch(() => null)
          : await dataManager.getByTypeId<Wiki>(new TypeId(Wiki.type, space)).catch(() => null);
      if (!live || !wiki) return;
      setWikiCrumb({ typeId: wiki.typeId, label: entityLabel(wiki as APIEntity<any>, wiki.typeId) });
    })();

    return () => {
      live = false;
    };
  }, [wikiRef?.space, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyed on the string, not the DockPointer: identity of the CONTENT is what
  // should re-run this, and it survives a pointer instance being re-minted.
  // `wikiPageTypeId` joins the key because a wiki route's target arrives from
  // the resolve store AFTER the dock does — without it the effect would never
  // re-run to pick the page up.
  useEffect(() => {
    let live = true;
    setAncestors([]);
    setResolved({ typeId: null, entity: null });

    if (!dock) return;
    // `resolveDockTarget` structurally cannot answer for a wiki route — it reads
    // `targetTypeId` and `vfsPath`, both null by construction there — so calling
    // it would burn a pass and re-run this whole effect when the store lands.
    if (wikiRef && !wikiPageTypeId) return;

    void (async () => {
      try {
        const { targetTypeId, target } = wikiPageTypeId
          ? {
              targetTypeId: wikiPageTypeId,
              target: await dataManager.getByTypeId<APIEntity<any>>(wikiPageTypeId).catch(() => null),
            }
          : await Tab.resolveDockTarget(dock);
        if (!live) return;
        setResolved({ typeId: targetTypeId ?? null, entity: (target as APIEntity<any>) ?? null });

        const parentRef = (target as { parent_type_id?: string | null } | null)?.parent_type_id ?? null;
        const chain = await resolveAncestorChain(parentRef, () => live);
        if (!live) return;
        setAncestors(chain);
      } catch {
        // A dock we can't resolve still deserves an address bar — Phase 0's
        // crumbs stand on their own.
        if (live) setAncestors([]);
      }
    })();

    return () => {
      live = false;
    };
  }, [dockKey, wikiPageTypeId?.toString()]); // eslint-disable-line react-hooks/exhaustive-deps

  const targetTypeId = resolved.typeId ?? urlTargetTypeId;

  const targetTitle = useMemo(() => {
    // The wiki word, ahead of the resolved page's own name: it is right on the
    // first frame — before the route has resolved, and still when it resolves
    // to nothing. The CANONICAL form, not the raw URL segment: the backend
    // resolves `Docs/Child` as `Docs`, and echoing the segment would name a
    // page that was never opened.
    if (wikiRef) return wikiRef.word;
    if (resolved.entity) return entityLabel(resolved.entity, targetTypeId);
    // Before Phase 1 lands, the context's active entity is often already the
    // thing this dock points at — an exact label with no fetch.
    if (targetTypeId && activeEntityTypeId?.toString() === targetTypeId.toString()) {
      return entityLabel(activeEntity as APIEntity<any>, targetTypeId);
    }
    if (targetTypeId) return labelForType(targetTypeId.type);
    return viewLabel(dock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.entity, targetTypeId, activeEntity, activeEntityTypeId, wikiRef, dockKey]);

  const crumbs = useMemo<Crumb[]>(() => {
    const out: Crumb[] = [];

    // The project always leads — except on the hub, or in the transient window
    // where no project is selected, where there simply isn't one.
    //
    // The one crumb that does NOT navigate: clicking it opens the projects
    // list, which is what the chip it replaced did. Opening the project itself
    // is the briefcase button up in the nav cluster — a destination, next to
    // the other destinations, rather than a second meaning for this click.
    if (project) {
      out.push({
        key: 'project',
        label: project.displayName,
        Icon: iconForType(Project.type),
        pointer: null,
        kind: 'project',
      });
    }

    // The Wiki the page is IN. Not an ancestor in the `parent_type_id` sense —
    // a wiki page is a plain markdown asset whose containment is its folder —
    // but it IS the namespace the route resolved the word through, so it is the
    // honest middle segment of a wiki address. Not navigable: no editor claims
    // the `wiki` type, so there is no dock that opens a Wiki itself, and a dead
    // link reads worse than plain text.
    if (wikiCrumb) {
      out.push({
        key: wikiCrumb.typeId.toString(),
        label: wikiCrumb.label,
        Icon: iconForType(wikiCrumb.typeId.type),
        pointer: null,
        kind: 'ancestor',
      });
    }

    // Walked nearest-first; the address reads outermost-first.
    for (const node of [...ancestors].reverse()) {
      out.push({
        key: node.typeId.toString(),
        label: entityLabel(node.entity, node.typeId),
        Icon: iconForType(node.typeId.type),
        pointer: buildDockPointer(
          { ...(node.entity as object), type: node.typeId.type, id: node.typeId.id },
          undefined,
        ),
        kind: 'ancestor',
      });
    }

    // On the project's OWN page the target is the project, so naming it again
    // would read "Acme › Acme". It's the same shape as a site's root crumb — the
    // trail still needs a last segment, it just isn't the name a second time.
    //
    // Both routes there count: `/dock/project/<id>` addresses the project as an
    // entity, while a bare `/dock/project` has no target at all and would
    // otherwise fall back to the view's type label ("Project").
    const isProjectHome =
      !!dock?.isProjectShell ||
      (!!project && targetTypeId?.type === Project.type && targetTypeId.id === project.id);

    // Same precedence the asset editor's header used before it was removed: the
    // route's own VFS path first (parsed, no fetch, right on the first frame),
    // then the resolved entity's `asset_ref` for a typeid-addressed asset.
    const assetRef = (resolved.entity as { asset_ref?: string | null } | null)?.asset_ref ?? null;
    const path = dock?.resourceVfsPath?.machinePath || assetRef || null;
    const filename = dock?.resourceVfsPath?.filename || basename(assetRef) || null;

    out.push(
      targetTypeId
        ? {
            key: targetTypeId.toString(),
            label: isProjectHome ? PROJECT_HOME_CRUMB_LABEL : targetTitle,
            Icon: iconForType(targetTypeId.type),
            pointer: null,
            kind: 'current',
            path,
            filename,
          }
        : {
            key: 'view',
            label: isProjectHome ? PROJECT_HOME_CRUMB_LABEL : targetTitle,
            // A wiki word that hasn't resolved yet (or resolves to nothing) is
            // still a wiki word, not an unidentified view — the registry has a
            // glyph for exactly that. `iconForType`, so it moves with TypeInfo.
            Icon: isProjectHome
              ? iconForType(Project.type)
              : wikiRef
                ? iconForType(WikiEntry.type)
                : VIEW_CRUMB_ICON,
            pointer: null,
            kind: 'current',
            path,
            filename,
          },
    );

    return out;
  }, [project, ancestors, wikiCrumb, wikiRef, targetTypeId, targetTitle, dock?.isProjectShell, dockKey, resolved.entity]); // eslint-disable-line react-hooks/exhaustive-deps

  return { crumbs, targetTypeId, targetTitle };
}
