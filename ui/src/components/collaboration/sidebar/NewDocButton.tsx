import { Markdown, Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { InputDialog } from '@src/components/ui/input-dialog';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { RoomTab } from '../RoomTabs';

interface Props {
  projectId: string | null;
  /** When provided, the freshly created doc is opened as a RoomTab in the room view. */
  onOpenTab?: (tab: RoomTab) => void;
}

/**
 * Compact "+ New doc" button meant to live in the DOCS category header row of
 * the collaboration sidebar. Creates the Markdown via Entity.save(); when
 * ``onOpenTab`` is provided (room view) the new doc opens as a RoomTab —
 * otherwise it navigates to the standalone asset editor.
 */
export function NewDocButton({ projectId, onOpenTab }: Props) {
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const handleCreate = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || !project) return;
      try {
        const md = await Markdown.createInProject(project, trimmed);
        notify.success({ title: 'Doc created' });
        if (md.asset_ref) {
          if (onOpenTab) {
            onOpenTab({
              key: `markdown:${md.id}`,
              type: 'markdown',
              title: trimmed,
              asset_ref: md.asset_ref,
            });
          } else {
            navigation.openDock(DockPointer.forAssetEditor('markdown', md.asset_ref));
          }
        }
      } catch (err) {
        console.error('[NewDocButton] create failed:', err);
        notify.error({ title: 'Failed to create doc' });
      }
    },
    [project, navigation, onOpenTab],
  );

  if (!projectId) return null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="New doc"
        aria-label="New doc"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <InputDialog
        open={open}
        onOpenChange={setOpen}
        title="New doc"
        description=".claude/docs/ under this project"
        placeholder="doc name"
        confirmLabel="Create"
        onConfirm={(name) => void handleCreate(name)}
      />
    </>
  );
}
