import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { BookMarked, ListPlus, Pencil, Plus } from 'lucide-react';
import { Prompt, type AgenticProcess, type IEntity } from '@sdk';
import type { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { BrowseableMenu, useMenuDialogs } from '@src/components/ui/browseable-menu';
import { groupRoot } from '@src/components/browseable-tree/adapters/groupRoot';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { useGroupTreeRefresh } from '@src/hooks/useGroupTreeRefresh';
import { renderIconValue } from '@src/lib/icon-value';
import { PromptEditDialog } from './PromptEditDialog';

const PROMPT_LEAF_TYPES = ['prompt'];

export const PROMPT_LIBRARY_NAMESPACE = 'prompt-library';

/**
 * PromptLibraryMenu — the "open prompt library" popover next to the Queue in
 * the terminal bottom ribbon (docs/prompt-library.md).
 *
 * Pure composition, zero folder/queue logic: folders come ENTIRELY from the
 * generic entities-groups layer (`groupRoot` — create/rename/delete/drag at
 * every level), prompt→queue is one SDK call (`prompt.enqueueTo(process)`),
 * and add/edit rides `PromptEditDialog` with the generic pickers.
 */
export interface PromptLibraryMenuProps {
  process: AgenticProcess;
  projectId?: string | null;
  /** The ribbon button (or any trigger). */
  trigger: ReactNode;
}

export const PromptLibraryMenu: React.FC<PromptLibraryMenuProps> = ({ process, projectId = null, trigger }) => {
  const { t } = useLingui();
  const { requestName, confirm, dialogs } = useMenuDialogs();
  const [editState, setEditState] = useState<{ prompt?: Prompt; groupId: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [activePointer, setActivePointer] = useState<DockPointer | null>(null);

  // On each open, highlight the last-used prompt (by last_used_at, falling
  // back to updated_date). Purely visual: BrowseableTree expands its ancestor
  // chain and marks the row selected — no navigation.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Prompt.lastUsedForProject(projectId).then((prompt) => {
      if (cancelled) return;
      setActivePointer(
        prompt ? AssetDocPointer.forEntity({ type: Prompt.type, typeId: prompt.typeId }).toDockPointer() : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const handle = useMemo(
    () =>
      groupRoot({
        namespace: PROMPT_LIBRARY_NAMESPACE,
        label: t`Prompt Library`,
        rootIcon: <BookMarked className="h-4 w-4" />,
        leafTypes: [Prompt.type],
        projectId,
        requestName,
        confirm,
        onSelectLeaf: (entity: IEntity) => {
          // click = enqueue (picker semantics); the queue panel reflects it.
          void (entity as Prompt).enqueueTo(process);
        },
        leafToBrowseable: (entity: IEntity) => {
          const prompt = entity as Prompt;
          return {
            label: prompt.name || '(untitled)',
            icon: renderIconValue(prompt.icon ?? 'BookMarked', { color: prompt.color }),
            pointer: AssetDocPointer.forEntity({ type: Prompt.type, typeId: prompt.typeId }).toDockPointer(),
            toolbar: [
              {
                id: `enqueue:${prompt.id}`,
                icon: <ListPlus />,
                label: t`Add to queue`,
                run: () => (prompt as Prompt).enqueueTo(process),
              },
              {
                id: `edit:${prompt.id}`,
                icon: <Pencil />,
                label: t`Edit prompt`,
                run: () => setEditState({ prompt, groupId: prompt.group_id ?? null }),
                showBusyIndicator: false,
              },
            ],
          };
        },
        extraContainerToolbar: (groupId) => [
          {
            id: `new-prompt:${groupId ?? 'root'}`,
            icon: <Plus />,
            label: t`New prompt`,
            run: () => setEditState({ groupId }),
            showBusyIndicator: false,
          },
        ],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [process?.id, projectId, requestName, confirm],
  );

  // Reactivity only: cross-client group/prompt changes re-fetch the tree.
  useGroupTreeRefresh(handle.root.id, PROMPT_LEAF_TYPES);

  return (
    <>
      <BrowseableMenu
        trigger={trigger}
        roots={[handle.root]}
        onNavigate={handle.onNavigate}
        open={open}
        onOpenChange={setOpen}
        // First layer open by default (even when empty); expansion persists.
        persistKey="flowpad.promptLibrary.expanded"
        defaultExpandedIds={[handle.root.id]}
        activePointer={activePointer}
        emptyState={<p className="p-3 text-center text-xs text-muted-foreground"><Trans>No prompts yet — create one below.</Trans></p>}
      />
      <PromptEditDialog
        open={editState !== null}
        onOpenChange={(open) => {
          if (!open) setEditState(null);
        }}
        prompt={editState?.prompt ?? null}
        groupId={editState?.groupId ?? null}
        projectId={projectId}
        onSaved={() => refreshNode(handle.root.id)}
      />
      {dialogs}
    </>
  );
};
