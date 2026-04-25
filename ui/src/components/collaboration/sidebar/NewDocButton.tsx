import { Markdown, Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { InputDialog } from '@src/components/ui/input-dialog';
import { useToast } from '@src/hooks/use-toast';
import { Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { RoomTab } from '../RoomTabs';

interface Props {
  projectId: string | null;
  onCreated?: () => void;
  /** When provided, the freshly created doc is opened as a room tab. */
  onOpenTab?: (tab: RoomTab) => void;
}

/**
 * Compact "+ New doc" button meant to live in the DOCS category header row of
 * the collaboration sidebar. Self-contained dialog state + toast.
 */
export function NewDocButton({ projectId, onCreated, onOpenTab }: Props) {
  const { toast } = useToast();
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
        // Single round-trip: backend Entity.save → MarkdownRecord.upsert_main_ref
        // writes the file iff missing and returns the entity (asset_ref set,
        // entity row in cache). DocsCategory's useEntitiesQuery sees it instantly.
        const md = await Markdown.createInProject(project, trimmed);
        toast({ title: 'Doc created' });
        onCreated?.();
        if (md.asset_ref) {
          onOpenTab?.({
            key: `markdown:${md.asset_ref}`,
            type: 'markdown',
            title: trimmed,
            asset_ref: md.asset_ref,
          });
        }
      } catch (err) {
        console.error('[NewDocButton] create failed:', err);
        toast({ title: 'Failed to create doc', variant: 'destructive' });
      }
    },
    [project, toast, onCreated, onOpenTab],
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
