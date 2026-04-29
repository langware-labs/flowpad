import { useMemo } from 'react';
import { ExternalLink, FileText, FolderOpen, MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Minimal shape we need to render an entity as a clickable label. Covers the
 * common cases (Project, Task, Conversation) without forcing the caller to
 * import the full entity type.
 */
export interface EntityLabelEntity {
  /** TypeId or string like `project-<id>`. */
  typeId?: TypeId | { type: string; id: string } | null;
  /** Convenience — when typeId isn't handy, pass type/id explicitly. */
  type?: string;
  id?: string | null;
  /** Display string. Falls back to id if missing. */
  name?: string | null;
  /** Optional Lucide icon override. We pick a sensible default by entity.type otherwise. */
  icon?: LucideIcon;
}

interface EntityLabelProps {
  /** The entity to render (the "A" in /dock/A/<id>/B/<id>). */
  entity: EntityLabelEntity;
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

const DEFAULT_ICON_BY_TYPE: Record<string, LucideIcon> = {
  project: FolderOpen,
  task: FileText,
  conversation: MessageSquare,
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
};
const DEFAULT_STYLE =
  'border border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground';

function resolveTypeAndId(entity: EntityLabelEntity): { type: string; id: string } | null {
  if (entity.typeId) {
    if (typeof (entity.typeId as TypeId).toString === 'function' && 'type' in (entity.typeId as TypeId)) {
      const tid = entity.typeId as TypeId;
      if (tid.type && tid.id) return { type: tid.type, id: String(tid.id) };
    }
    const raw = entity.typeId as { type?: string; id?: string };
    if (raw.type && raw.id) return { type: raw.type, id: raw.id };
  }
  if (entity.type && entity.id) return { type: entity.type, id: String(entity.id) };
  return null;
}

/**
 * Generic clickable chip that renders any entity (Project, Task, …) as a
 * pill with an icon + name. Clicking it navigates to the canonical
 * "this entity inside the surrounding entity" dock URL — e.g. an
 * `<EntityLabel entity={project} inside={conversation} />` rendered inside
 * a Conversation view jumps to `/dock/project/<id>/conversation/<id>`.
 *
 * When `inside` is omitted it falls back to the bare entity URL.
 */
export function EntityLabel({ entity, inside, onClick, title, size = 'chip' }: EntityLabelProps) {
  const { navigation } = useDockNavigation();
  const resolved = resolveTypeAndId(entity);
  const Icon = entity.icon ?? (resolved ? DEFAULT_ICON_BY_TYPE[resolved.type] : undefined) ?? ExternalLink;
  const label = entity.name ?? (resolved?.id ?? '(unnamed)');
  const typeStyle = (resolved && STYLE_BY_TYPE[resolved.type]) ?? DEFAULT_STYLE;
  // "Open in project" / "Open in task" — uses the entity's *type*, not its
  // display name, so the tooltip stays predictable across all chips of the
  // same kind. Caller can still override via the `title` prop.
  const tooltip = title ?? (resolved ? `Open in ${resolved.type}` : `Open ${label}`);

  const handleClick = useMemo(() => {
    return () => {
      if (onClick) {
        onClick();
        return;
      }
      if (!resolved) return;
      const pointer = buildDockPointer(resolved, inside);
      if (pointer) navigation.openDock(pointer);
    };
  }, [onClick, resolved, inside, navigation]);

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
 * Centralised here so `EntityLabel` itself stays declarative.
 */
function buildDockPointer(
  resolved: { type: string; id: string },
  inside: { type: string; id: string } | undefined,
): DockPointer | null {
  switch (resolved.type) {
    case 'project':
      return DockPointer.forProject(resolved.id, inside?.type === 'conversation' ? { conversationId: inside.id } : undefined);
    case 'task':
      return DockPointer.forTasks(resolved.id, inside?.type === 'conversation' ? { conversationId: inside.id } : undefined);
    default:
      return null;
  }
}
