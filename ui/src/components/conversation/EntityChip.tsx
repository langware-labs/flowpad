import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import { APIEntity, TypeId, dataManager, workerFromSessionType, type AnyEntity } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
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
  /** Project shell to use when the chip opens an asset editor pointer. */
  projectId?: string | null;
  /** Tooltip text. Defaults to "Open <name>". */
  title?: string;
  /** Visual size — "chip" matches the conversation-toolbar buttons. Default "chip". */
  size?: 'chip' | 'inline';
  /**
   * Render greyed-out and non-navigable. Used when the referenced entity has no
   * local row (a 404'd context reference) — the chip shows the type/id as
   * "unavailable" instead of looking clickable or re-fetching.
   */
  muted?: boolean;
  /**
   * Staged (downloaded, reviewable, NOT installed/indexed): dashed border but
   * CLICKABLE — clicking fires `onClick` (the review/install modal), never dock
   * navigation. Distinct from `muted`, which is inert.
   */
  staged?: boolean;
}

/**
 * Per-entity-type icon registry. Re-used by surfaces that render entities
 * (chips, tab strips). Add new entry types here as they appear.
 *
 * `skill` and `markdown` are tab content kinds, not entities, but they
 * render in the same tab strip — keeping them here means the strip and any
 * entity chip stay visually consistent.
 */
/** Icon for an entity type from the SchemaRegistry (backend TypeInfo.icon is
 *  the single source of truth), with an ExternalLink fallback. */
export function iconForEntity(type: string): LucideIcon {
  // Guarded: dataManager may be uninitialized in isolated unit tests that mount
  // a component before bootstrap/loadTypes ran.
  const name = dataManager?.iconForType?.(type);
  return (name && lucideByName(name)) || ExternalLink;
}

/**
 * Backwards-compatible map facade over {@link iconForEntity}. Reads icons from
 * the SchemaRegistry (no hardcoded list); ``ICON_BY_TYPE[type]`` and
 * ``ICON_BY_TYPE.task`` both resolve a LucideIcon, or undefined when the type
 * has no backend icon (so existing ``?? ExternalLink`` fallbacks still work).
 */
export const ICON_BY_TYPE: Record<string, LucideIcon> = new Proxy({} as Record<string, LucideIcon>, {
  get(_t, prop): LucideIcon | undefined {
    // The trap also fires for symbol keys + introspection props like
    // `toString` (React-refresh / Object spread). Only resolve real
    // string type-names; everything else is "no icon".
    if (typeof prop !== 'string') return undefined;
    const name = dataManager?.iconForType?.(prop);
    return name ? lucideByName(name) : undefined;
  },
});

/**
 * Per-entity-type styling. Stable across the app so a "project" chip always
 * looks like a project chip, no matter where it's rendered. Add new entry
 * types here as they appear (the fallback is muted/neutral).
 */
const STYLE_BY_TYPE: Record<string, string> = {
  project: 'border border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300',
  task: 'border border-violet-500/40 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300',
  conversation:
    'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300',
  spec: 'border border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300',
};
const DEFAULT_STYLE = 'border border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground';
/** Greyed, non-interactive style for a context ref whose entity 404'd. */
const MUTED_STYLE = 'border border-dashed border-border bg-transparent text-muted-foreground line-through';
/** Staged (downloaded, not installed): dashed + clickable — AttachmentChip's
 *  "not yet local, click to act" idiom. */
const STAGED_STYLE =
  'border border-dashed border-primary/60 bg-background text-foreground hover:bg-muted/40 cursor-pointer';

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
export function EntityChip({
  entity,
  inside,
  onClick,
  projectId,
  title,
  size = 'chip',
  muted = false,
  staged = false,
}: EntityChipProps) {
  const { navigation } = useDockNavigation();
  const resolved = resolveTypeAndId(entity);
  const Icon = entity.icon ?? (resolved ? ICON_BY_TYPE[resolved.type] : undefined) ?? ExternalLink;
  const label = entity.name ?? (resolved?.id || '(unnamed)');
  const typeWord = resolved ? resolved.type.charAt(0).toUpperCase() + resolved.type.slice(1).replace(/_/g, ' ') : '';
  const typeStyle = muted
    ? MUTED_STYLE
    : staged
      ? STAGED_STYLE
      : ((resolved && STYLE_BY_TYPE[resolved.type]) ?? DEFAULT_STYLE);
  const tooltip = muted
    ? `${typeWord || 'Entity'} unavailable (not found locally)`
    : staged
      ? (title ?? `Downloaded — click to review & install ${typeWord}: ${label}`)
      : (title ?? (resolved ? `Open ${typeWord}: ${label}` : `Open ${label}`));

  const handleClick = useMemo(() => {
    return () => {
      if (muted) return;
      if (onClick) {
        onClick();
        return;
      }
      // A staged chip never dock-navigates: its entity has no local row yet.
      if (staged) return;
      if (!resolved || !resolved.id) return;
      const pointer = buildDockPointer(resolved as { type: string; id: string }, inside);
      if (pointer) navigation.openDock(DockPointer.rebaseAssetsOntoProject(pointer, projectId));
    };
  }, [muted, staged, onClick, resolved, inside, navigation, projectId]);

  const baseLayout =
    size === 'chip'
      ? 'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors'
      : 'inline-flex items-center gap-1 text-[11px] font-medium transition-colors';

  return (
    <button
      type="button"
      onClick={handleClick}
      title={tooltip}
      disabled={muted}
      aria-disabled={muted}
      data-testid={`entity-chip-${entity.type}-${entity.id}`}
      className={`${baseLayout} ${typeStyle}${muted ? 'cursor-default opacity-60' : ''}`}
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
): DockPointer | null {
  switch (resolved.type) {
    case 'project':
      return DockPointer.forProject(
        resolved.id,
        inside?.type === 'conversation' ? { conversationId: inside.id } : undefined,
      );
    case 'task':
      return DockPointer.forTasks(
        resolved.id,
        inside?.type === 'conversation' ? { conversationId: inside.id } : undefined,
      );
    case 'spec':
      return DockPointer.forSpec(resolved.id);
    case 'flowpad_diagnosis':
      // Entity type is `flowpad_diagnosis` but the view type is `diagnosis`, so the
      // generic fallback can't resolve it — map explicitly to the diagnosis viewer.
      return DockPointer.forDiagnosis(resolved.id);
    case 'conversation':
      return DockPointer.forConversation(resolved.id);
    case 'claude_session':
    case 'codex_session':
    case 'copilot_session': {
      const worker = workerFromSessionType(resolved.type) as 'claude' | 'codex' | 'copilot';
      // Transcripts are the ONLY type addressed by location rather than by
      // TypeId (they have no asset-editor entry — they open through the lens,
      // which takes a worker + a file). So unlike every other case here, a bare
      // {type, id} is NOT enough to build a working pointer, and the caller must
      // pass the resolved entity.
      const session = resolved as { asset_ref?: string | null; received?: boolean };
      const ref = session.asset_ref?.trim();
      if (ref) return DockPointer.forLensTranscript(worker, ref);
      // No path in hand. The session-id form is answered by
      // ``resolve_session_jsonl``, which searches THIS machine's CLI dir — right
      // for a locally-run session, and guaranteed to 404 for a received one
      // ("NOT_FOUND: ~/.claude/projects/ ... cannot resolve session <id>"). So
      // only take it on an entity that explicitly says it ran here. `undefined`
      // means the caller handed us a stub and we simply don't know — returning
      // null lets them fall back instead of opening a broken tab.
      if (session.received === false) return DockPointer.forLensTranscript(worker, resolved.id);
      return null;
    }
    default: {
      // Asset-editor types (markdown family, agent, skill, workflow, whiteboard)
      // open by their TypeId — no asset_ref needed; the loader resolves the
      // entity. This is why the chip never has to defer on an unresolved path.
      const editor = editorForType(resolved.type);
      if (editor) {
        return AssetDocPointer.forTypeId(editor, new TypeId(resolved.type, resolved.id)).toDockPointer();
      }
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
}

interface ContextEntityChipProps {
  /** TypeId from one of an entity's two context buckets
   *  (``sharedContextEntities`` or ``privateContextEntities``). */
  typeId: TypeId;
  inside?: { type: string; id: string };
  onClick?: () => void;
  projectId?: string | null;
  title?: string;
  size?: 'chip' | 'inline';
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

export function ContextEntityChip({ typeId, inside, onClick, projectId, title, size }: ContextEntityChipProps) {
  // Resolve the display name; navigation is owned by the single ``EntityChip``.
  // Asset types navigate by TypeId (the loader resolves the entity), so there's
  // no asset_ref to fetch and no deferral/prewarm dance — the chip just renders.
  // Generic context chips can point at any entity type; the SDK hook's recursive
  // entity generic has no concrete type here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, notFound } = useEntity<AnyEntity>(typeId);
  // ``notFound`` is a terminal 404 — the target has no local row (e.g. a
  // dangling/unmaterialized context reference). Render a muted, non-navigable
  // chip; the SDK's negative cache keeps us from re-fetching every render.
  const resolvedName = data?.displayName ?? (notFound ? `${typeId.type} (unavailable)` : typeId.toString());

  return (
    <EntityChip
      entity={{ typeId, type: typeId.type, id: typeId.id, name: resolvedName }}
      inside={inside}
      onClick={onClick}
      projectId={projectId}
      title={title}
      size={size}
      muted={notFound}
    />
  );
}
