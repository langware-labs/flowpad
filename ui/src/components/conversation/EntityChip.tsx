import { useEffect, useMemo, useRef } from 'react';
import { ExternalLink, FileCheck2, FileText, FolderOpen, GitBranch, MessageSquare, Sparkles, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { APIEntity, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useChipPrewarm } from '@src/navigation/useChipPrewarm';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Minimal shape we need to render an entity as a clickable label. Covers the
 * common cases (Project, Task, Conversation, Spec) without forcing the caller
 * to import the full entity type.
 */
export interface EntityChipEntity {
  /** TypeId or string like `project-<id>`. */
  typeId?: TypeId | { type: string; id: string } | null;
  /** Convenience — when typeId isn't handy, pass type/id explicitly. */
  type?: string;
  id?: string | null;
  /** Display string. Falls back to id if missing. */
  name?: string | null;
  /** Optional Lucide icon override. We pick a sensible default by entity.type otherwise. */
  icon?: LucideIcon;
  /** Asset entities (skill / agent / markdown) open in the Assets editor by
   *  their VFS path — pass it here. Falls back to the entity id when absent. */
  assetRef?: string | null;
}

interface EntityChipProps {
  /** The entity to render (the "A" in /dock/A/<id>/B/<id>). */
  entity: EntityChipEntity;
  /**
   * The entity this chip is being shown *inside* (the "B" in /dock/A/<id>/B/<id>).
   * When omitted, clicks navigate to the bare /dock/<A>/<id> URL.
   */
  inside?: { type: string; id: string };
  /** Optional click override — bypass the standard A-inside-B navigation. */
  onClick?: () => void;
  /** Tooltip text. Defaults to "Open <name>". */
  title?: string;
  /** Visual size — "chip" matches the conversation-toolbar buttons. Default "chip". */
  size?: 'chip' | 'inline';
}

/**
 * Per-entity-type icon registry. Re-used by surfaces that render entities
 * (chips, tab strips). Add new entry types here as they appear.
 *
 * `skill` and `markdown` are tab content kinds, not entities, but they
 * render in the same tab strip — keeping them here means the strip and any
 * entity chip stay visually consistent.
 */
export const ICON_BY_TYPE: Record<string, LucideIcon> = {
  project: FolderOpen,
  task: FileText,
  conversation: MessageSquare,
  spec: FileCheck2,
  user: User,
  skill: Sparkles,
  markdown: FileText,
  git_repo: GitBranch,
};

/**
 * Per-entity-type styling. Stable across the app so a "project" chip always
 * looks like a project chip, no matter where it's rendered. Add new entry
 * types here as they appear (the fallback is muted/neutral).
 */
const STYLE_BY_TYPE: Record<string, string> = {
  project:
    'border border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300',
  task:
    'border border-violet-500/40 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300',
  conversation:
    'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300',
  spec:
    'border border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300',
  git_repo:
    'border border-slate-500/40 bg-slate-500/10 text-slate-700 hover:bg-slate-500/20 dark:text-slate-300',
};
const DEFAULT_STYLE =
  'border border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground';

function resolveTypeAndId(entity: EntityChipEntity): { type: string; id: string } | null {
  if (entity.typeId) {
    if (typeof (entity.typeId as TypeId).toString === 'function' && 'type' in (entity.typeId as TypeId)) {
      const tid = entity.typeId as TypeId;
      if (tid.type && tid.id) return { type: tid.type, id: String(tid.id) };
    }
    const raw = entity.typeId as { type?: string; id?: string };
    if (raw.type && raw.id) return { type: raw.type, id: raw.id };
  }
  if (entity.type && entity.id) return { type: entity.type, id: String(entity.id) };
  // Type without id is fine for "decorative" chips (Approve & Execute, prompt
  // preview) — they get the type's icon + style but no navigation target.
  if (entity.type) return { type: entity.type, id: '' };
  return null;
}

/**
 * Generic clickable chip that renders any entity (Project, Task, Spec, …) as
 * a pill with an icon + name. Clicking it navigates to the canonical
 * "this entity inside the surrounding entity" dock URL — e.g. an
 * `<EntityChip entity={project} inside={conversation} />` rendered inside
 * a Conversation view jumps to `/dock/project/<id>/conversation/<id>`.
 *
 * When `inside` is omitted it falls back to the bare entity URL. When the
 * entity has no id (decorative use, e.g. an "Approve & Execute" prompt
 * chip) the chip looks the same but only fires `onClick`.
 */
export function EntityChip({ entity, inside, onClick, title, size = 'chip' }: EntityChipProps) {
  const { navigation } = useDockNavigation();
  const resolved = resolveTypeAndId(entity);
  const Icon = entity.icon ?? (resolved ? ICON_BY_TYPE[resolved.type] : undefined) ?? ExternalLink;
  const label = entity.name ?? (resolved?.id || '(unnamed)');
  const typeStyle = (resolved && STYLE_BY_TYPE[resolved.type]) ?? DEFAULT_STYLE;
  const typeWord = resolved
    ? resolved.type.charAt(0).toUpperCase() + resolved.type.slice(1).replace(/_/g, ' ')
    : '';
  const tooltip = title ?? (resolved ? `Open ${typeWord}: ${label}` : `Open ${label}`);

  const handleClick = useMemo(() => {
    return () => {
      if (onClick) {
        onClick();
        return;
      }
      if (!resolved || !resolved.id) return;
      const pointer = buildDockPointer(
        resolved as { type: string; id: string },
        inside,
        entity.assetRef ?? undefined,
      );
      if (pointer) navigation.openDock(pointer);
    };
  }, [onClick, resolved, inside, navigation, entity.assetRef]);

  const baseLayout =
    size === 'chip'
      ? 'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors'
      : 'inline-flex items-center gap-1 text-[11px] font-medium transition-colors';

  return (
    <button
      type="button"
      onClick={handleClick}
      title={tooltip}
      className={`${baseLayout} ${typeStyle}`}
    >
      <Icon className="h-3 w-3" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Map an entity-type pair to the right DockPointer factory.
 * Centralised here so `EntityChip` itself stays declarative.
 *
 * For unknown entity types, falls back to a generic
 * ``/dock/<type>/<id>`` pointer via ``DockPointer.fromUrl``. The dock
 * router validates and 404s gracefully if there is no matching view —
 * silent no-ops on click are worse than a visible "unknown view" page.
 */
export function buildDockPointer(
  resolved: { type: string; id: string },
  inside: { type: string; id: string } | undefined,
  assetRef?: string,
): DockPointer | null {
  switch (resolved.type) {
    case 'project':
      return DockPointer.forProject(resolved.id, inside?.type === 'conversation' ? { conversationId: inside.id } : undefined);
    case 'task':
      return DockPointer.forTasks(resolved.id, inside?.type === 'conversation' ? { conversationId: inside.id } : undefined);
    case 'spec':
      return DockPointer.forSpec(resolved.id);
    case 'conversation':
      return DockPointer.forConversation(resolved.id);
    // Asset entities open in the Assets editor by VFS path. When
    // ``assetRef`` is missing the chip data hasn't loaded yet (recipient is
    // still fetching the entity row from a freshly arrived share); return
    // null so the click is a no-op. ``ContextEntityChip`` defers the
    // navigation until the entity resolves — falling back to ``resolved.id``
    // here would bake the entity UUID into the URL, which the asset editor's
    // path-keyed ``useEntityByPath`` can never resolve.
    case 'skill':
    case 'agent':
    case 'markdown':
      if (!assetRef) return null;
      return DockPointer.forAssetEditor(resolved.type, assetRef);
    default:
      try {
        return DockPointer.fromUrl(resolved.type, resolved.id);
      } catch {
        // The view-type registry rejected this type. Log so the
        // misconfiguration is visible during development; return null so
        // the click is a no-op rather than throwing into the React tree.
        console.warn(`[EntityChip] no dock target for type=${resolved.type}`);
        return null;
      }
  }
}

interface ContextEntityChipProps {
  /** TypeId from one of an entity's two context buckets
   *  (``sharedContextEntities`` or ``privateContextEntities``). */
  typeId: TypeId;
  inside?: { type: string; id: string };
  onClick?: () => void;
  title?: string;
  size?: 'chip' | 'inline';
  /** Sidecar `data.path` harvested by the BE at cross-link time for this
   *  typeid (looked up on the parent entity via
   *  ``parent.getContextEntryData(typeId)?.path``). When set, the chip
   *  fires `GET /graph/<type>/<id>?hint_path=<path>` before navigation so
   *  the dock view finds a self-healed row even if the indexer hasn't
   *  walked this file yet. Optional — when undefined the chip behaves
   *  exactly as it did pre-v1.2 (direct navigation, possible 404). */
  hintPath?: string;
}

/**
 * Renders one entry from one of an entity's two dynamic context lists as an
 * ``EntityChip`` — looks up the target entity to populate the chip's display
 * name (``title`` for Spec/Plan, ``name`` for Project/User, etc.), then
 * delegates rendering. This is the data-driven counterpart to ``EntityChip``:
 * callers iterating ``entity.sharedContextEntities`` /
 * ``entity.privateContextEntities`` use this wrapper instead of
 * hand-constructing each chip.
 */
const ASSET_CHIP_TYPES = new Set(['skill', 'agent', 'markdown']);

export function ContextEntityChip({ typeId, inside, onClick, title, size, hintPath }: ContextEntityChipProps) {
  const { data } = useEntity<APIEntity<any>>(typeId);
  const resolvedName = data?.displayName ?? typeId.toString();
  // Asset entities (skill / agent / markdown) carry an `asset_ref` VFS path —
  // the address the Assets editor opens. Forward it so the chip navigates to
  // the real file rather than falling back to the bare entity id.
  const assetRef = (data as unknown as { asset_ref?: string | null })?.asset_ref ?? null;

  // Deferred-click handling for asset chips whose entity row hasn't arrived
  // yet (typical right after Alice shares a skill — the FlowMessage shows up
  // first, the Skill row is materialized once the eager bundle pull lands).
  // Without this, clicking before ``assetRef`` resolves would either no-op
  // (post-fix) or — pre-fix — bake the entity UUID into the URL, where the
  // asset editor's path-keyed lookup would 404 and cache that forever.
  const { navigation } = useDockNavigation();
  const prewarm = useChipPrewarm();
  const pendingNavRef = useRef(false);
  const needsDeferral = ASSET_CHIP_TYPES.has(typeId.type) && !assetRef;

  useEffect(() => {
    if (!pendingNavRef.current) return;
    if (!assetRef) return;
    pendingNavRef.current = false;
    const pointer = DockPointer.forAssetEditor(typeId.type, assetRef);
    if (pointer) navigation.openDock(pointer);
  }, [assetRef, typeId.type, navigation]);

  // On click:
  //   * If `onClick` was overridden, prewarm then defer to it.
  //   * If the chip needs deferral (asset chip without resolved assetRef),
  //     ARM `pendingNavRef` SYNCHRONOUSLY before awaiting prewarm — otherwise
  //     the deferral useEffect (deps: [assetRef, typeId.type, navigation])
  //     can fire on assetRef arrival during the await with pendingNavRef
  //     still false, and won't re-run later when the flag flips. Then
  //     await prewarm; the effect picks up navigation when assetRef lands.
  //   * Otherwise, do the default type+id navigation via buildDockPointer
  //     (exported so we don't duplicate its dispatch table here).
  const handleClick = async () => {
    if (onClick) {
      await prewarm(typeId, hintPath);
      onClick();
      return;
    }
    if (needsDeferral) {
      pendingNavRef.current = true;
      await prewarm(typeId, hintPath);
      // If assetRef already arrived while we awaited, fire navigation now
      // since the effect's last run was before pendingNavRef was set.
      if (assetRef) {
        pendingNavRef.current = false;
        const pointer = DockPointer.forAssetEditor(typeId.type, assetRef);
        if (pointer) navigation.openDock(pointer);
      }
      return;
    }
    await prewarm(typeId, hintPath);
    const pointer = buildDockPointer(
      { type: typeId.type, id: typeId.id },
      inside,
      assetRef ?? undefined,
    );
    if (pointer) navigation.openDock(pointer);
  };

  return (
    <EntityChip
      entity={{ typeId, type: typeId.type, id: typeId.id, name: resolvedName, assetRef }}
      inside={inside}
      onClick={handleClick}
      title={title}
      size={size}
    />
  );
}
