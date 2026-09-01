import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ExternalLink, Eye, FileText, Lock, Plus, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { notify } from '@src/notifications';
import type { APIEntity, AnyEntity } from '@sdk';
import { Skill, Spec, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useChipPrewarm } from '@src/navigation/useChipPrewarm';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ICON_BY_TYPE } from '../conversation/EntityChip';
import { useReconcileContext } from '../conversation/useReconcileContext';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * Single-entity context panel. Renders the entity's merged shared+private
 * context as a labelled bordered table — same look as the conversation
 * panel's Shared Context section, so users moving between surfaces see one
 * consistent design.
 *
 * Visual primitives (Row / RowAction / ContextTable / SectionHeader /
 * EmptyHint) are inlined here so this component stays embeddable without
 * importing anything conversation-specific. A future refactor can extract
 * these to a shared module and have ConversationContextPanel re-import.
 */
interface EntityContextPanelProps {
  /** Entity whose buckets we render. AgenticProcess in the current call
   *  site (interactive terminal); the prop is typed broadly so the panel
   *  is reusable for any entity. */
  entity: AnyEntity;
}

type CreateKind = 'spec' | 'skill';

interface ProjectScopedEntity {
  project_id?: string | null;
}

/** Title-case the type slug for the per-row "Type" label. */
function humanType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/** Canonical dock pointer for a chip's click target. Mirrors the helper at
 *  ConversationContextPanel.tsx:84 but inlined so this component stays free
 *  of conversation-specific deps. */
function dockPointerFor(typeId: TypeId, assetRef?: string | null): DockPointer | null {
  switch (typeId.type) {
    case 'project':
      return DockPointer.forProject(typeId.id);
    case 'task':
      return DockPointer.forTasks(typeId.id);
    case 'spec':
      return DockPointer.forSpec(typeId.id);
    case 'conversation':
      return DockPointer.forConversation(typeId.id);
    case 'skill':
    case 'agent':
    case 'markdown':
      return DockPointer.forAssetEditor(typeId.type, assetRef ?? typeId.id);
    default:
      try {
        return DockPointer.fromUrl(typeId.type, typeId.id);
      } catch {
        return null;
      }
  }
}

export function EntityContextPanel({ entity }: EntityContextPanelProps) {
  const { t } = useLingui();

  // Prune context refs gone both locally and on the hub (backend-gated to
  // local-origin holders). Fires once per entity.
  useReconcileContext(entity);

  // Two buckets, two sections — matches the conversation panel's Shared /
  // Private split exactly.
  const sharedRows = useMemo(() => entity.sharedContextEntities ?? [], [entity.sharedContextEntities]);
  const privateRows = useMemo(() => entity.privateContextEntities ?? [], [entity.privateContextEntities]);

  const [menuOpen, setMenuOpen] = useState(false);
  // When a menu item is picked the header swaps into a tiny inline title
  // input, scoped to that creation flow. MCP-friendly — no window.prompt.
  const [pending, setPending] = useState<CreateKind | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [adding, setAdding] = useState(false);

  const openCreate = (kind: CreateKind) => {
    setMenuOpen(false);
    setPending(kind);
    setTitleDraft('');
  };

  const cancelCreate = () => {
    setPending(null);
    setTitleDraft('');
  };

  const projectScopeIds = useMemo(() => {
    const projectId = (entity as ProjectScopedEntity).project_id ?? null;
    return projectId ? [new TypeId('project', projectId)] : [];
  }, [entity]);

  const { navigation } = useDockNavigation();
  const prewarm = useChipPrewarm();

  /**
   * Chip click → optionally pre-warm the BE self-heal, then navigate. When
   * the parent entity harvested a path for this typeid (file-backed types:
   * plan, markdown, skill, etc.), `prewarm` fires a GET with `?hint_path=`
   * so a not-yet-indexed row exists by the time the dock view loads.
   */
  const openChip = async (typeId: TypeId, assetRef: string | null | undefined) => {
    const sidecar = entity.getContextEntryData(typeId);
    const hintPath = typeof sidecar?.path === 'string' ? sidecar.path : undefined;
    await prewarm(typeId, hintPath);
    const ptr = dockPointerFor(typeId, assetRef);
    if (ptr) navigation.openDock(ptr);
  };

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const kind = pending;
    const trimmed = titleDraft.trim();
    if (!kind || !trimmed || adding) return;
    setAdding(true);
    const ownerTypeId = entity.typeId.toString();
    try {
      if (kind === 'spec') {
        const spec = new Spec({
          title: trimmed,
          content: '',
          shared_context_entities: [ownerTypeId],
        } as Partial<Spec>);
        await spec.save(projectScopeIds);
        if (spec.id) {
          await entity.shareContextEntities(new TypeId(Spec.type, spec.id));
          notify.success({ title: t`Plan created` });
          navigation.openDock(DockPointer.forSpec(spec.id));
        }
      } else {
        const skill = new Skill({
          name: trimmed,
          shared_context_entities: [ownerTypeId],
        } as Partial<Skill>);
        await skill.save(projectScopeIds);
        if (skill.id) {
          await entity.shareContextEntities(new TypeId(Skill.type, skill.id));
          notify.success({ title: t`Skill created` });
          if (skill.asset_ref) {
            navigation.openDock(DockPointer.forAssetEditor('skill', skill.asset_ref));
          }
        }
      }
      setPending(null);
      setTitleDraft('');
    } catch (err) {
      console.error(`[EntityContextPanel] add-${kind} failed`, err);
      notify.error({ title: `Failed to create ${kind}` });
    } finally {
      setAdding(false);
    }
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelCreate();
    }
  };

  // Embeddable — no h-full / overflow / outer padding. Host owns sizing.
  // Section structure mirrors ConversationContextPanel verbatim: a "Shared
  // Context" section (Users icon) above a "Private Context" section (Lock
  // icon). The "+ Add" affordance sits at the bottom of the Private section,
  // exactly where the conversation panel puts it.
  return (
    <div className="space-y-4" data-testid="entity-context-panel">
      <div>
        <SectionHeader title={t`Shared Context`} icon={Users} />
        {sharedRows.length === 0 ? (
          <EmptyHint text={t`Nothing shared on this process.`} />
        ) : (
          <ContextTable>
            {sharedRows.map((typeId) => (
              <ContextRow
                key={typeId.toString()}
                typeId={typeId}
                onOpen={(assetRef) => {
                  void openChip(typeId, assetRef);
                }}
              />
            ))}
          </ContextTable>
        )}
      </div>

      <div>
        <SectionHeader title={t`Private Context`} icon={Lock} />
        {privateRows.length === 0 ? (
          <EmptyHint text={t`Nothing in private context yet.`} />
        ) : (
          <ContextTable>
            {privateRows.map((typeId) => (
              <ContextRow
                key={typeId.toString()}
                typeId={typeId}
                onOpen={(assetRef) => {
                  void openChip(typeId, assetRef);
                }}
              />
            ))}
          </ContextTable>
        )}
        <div className="relative mt-2">
          {pending ? (
            <form
              className="flex items-center gap-1 rounded-md border border-border bg-background p-1"
              onSubmit={handleSubmit}
              data-testid="entity-context-panel-title-form"
            >
              <input
                type="text"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={onInputKey}
                disabled={adding}
                placeholder={pending === 'spec' ? t`Plan title…` : t`Skill name…`}
                className="min-w-0 flex-1 rounded bg-background px-2 py-1 text-[11px] text-foreground outline-none"
                data-testid="entity-context-panel-title-input"
              />
              <button
                type="submit"
                disabled={adding || !titleDraft.trim()}
                className="rounded px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-300"
                data-testid="entity-context-panel-title-submit"
              >
                {adding ? t`Adding…` : t`Add`}
              </button>
              <button
                type="button"
                onClick={cancelCreate}
                disabled={adding}
                className="rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                data-testid="entity-context-panel-title-cancel"
              >
                <Trans>Cancel</Trans>
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                disabled={adding}
                title={t`Attach a plan or skill`}
                aria-label={t`Attach a plan or skill`}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-background px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/5 hover:text-emerald-700 disabled:opacity-50 dark:hover:text-emerald-300"
                data-testid="entity-context-panel-add"
              >
                <Plus className="h-3.5 w-3.5" />
                <Trans>Add</Trans>
              </button>
              {menuOpen && (
                <div
                  className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-border bg-popover p-1 text-xs shadow-md"
                  data-testid="entity-context-panel-add-menu"
                >
                  <button
                    type="button"
                    onClick={() => openCreate('spec')}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-foreground transition-colors hover:bg-muted"
                    data-testid="entity-context-panel-add-spec"
                  >
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    <Trans>Plan</Trans>
                  </button>
                  <button
                    type="button"
                    onClick={() => openCreate('skill')}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-foreground transition-colors hover:bg-muted"
                    data-testid="entity-context-panel-add-skill"
                  >
                    <Sparkles className="h-3 w-3 text-muted-foreground" />
                    <Trans>Skill</Trans>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Local visual primitives — match ConversationContextPanel's Shared section
// look (Row + RowAction + ContextTable + SectionHeader + EmptyHint). Kept
// inline for now; extract to a shared module when a third surface needs
// them.
// ─────────────────────────────────────────────────────────────────────────

function SectionHeader({ title, icon: Icon }: { title: string; icon?: LucideIcon }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      {Icon && <Icon className="h-3 w-3 text-foreground" aria-hidden="true" />}
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">{title}</span>
    </div>
  );
}

function ContextTable({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border rounded border border-border bg-background">{children}</div>;
}

interface RowShellProps {
  icon: LucideIcon;
  type: string;
  name: string;
  /** Click on the icon/type/name area. Used by the conversation panel for
   *  bubble-highlight; here we wire it to the same dock-open as the action. */
  onFocus?: () => void;
  focusTitle?: string;
  children: React.ReactNode;
}

function RowShell({ icon: Icon, type, name, onFocus, focusTitle, children }: RowShellProps) {
  const clickable = !!onFocus;
  const focusInner = (
    <>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{type}</span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={name}>
        {name}
      </span>
    </>
  );
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] transition-colors">
      {clickable ? (
        <button
          type="button"
          onClick={onFocus}
          title={focusTitle}
          aria-label={focusTitle ?? `Reveal ${type}: ${name}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-start transition-colors hover:bg-muted/40"
        >
          {focusInner}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{focusInner}</div>
      )}
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

function RowAction({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-border px-2 py-2 text-center text-[11px] italic text-muted-foreground/70">
      {text}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Row for one context TypeId — resolves entity name via useEntity, picks
// the right icon by TypeId.type, and renders the "View / Open" action.
// ─────────────────────────────────────────────────────────────────────────

function ContextRow({ typeId, onOpen }: { typeId: TypeId; onOpen: (assetRef?: string | null) => void }) {
  const { t } = useLingui();
  const { data: entity } = useEntity(typeId);
  const name = entity?.displayName ?? typeId.id;
  const assetRef = (entity as unknown as { asset_ref?: string | null })?.asset_ref ?? undefined;
  const Icon = ICON_BY_TYPE[typeId.type] ?? ExternalLink;
  const isSpec = typeId.type === Spec.type;
  const primaryLabel = isSpec ? t`View` : t`Open`;
  const primaryIcon = isSpec ? <Eye className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />;
  return (
    <RowShell
      icon={Icon}
      type={humanType(typeId.type)}
      name={name}
      onFocus={() => onOpen(assetRef)}
      focusTitle={`${primaryLabel} ${humanType(typeId.type)}: ${name}`}
    >
      <RowAction onClick={() => onOpen(assetRef)} title={`${primaryLabel} ${humanType(typeId.type)}: ${name}`}>
        {primaryIcon}
        {primaryLabel}
      </RowAction>
    </RowShell>
  );
}
