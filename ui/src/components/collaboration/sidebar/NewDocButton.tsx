import { MarkdownAsset, Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { InputDialog } from '@src/components/ui/input-dialog';
import { useToast } from '@src/hooks/use-toast';
import { Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface Props {
  projectId: string | null;
  onCreated?: () => void;
}

/**
 * Compact "+ New doc" button meant to live in the DOCS category header row of
 * the collaboration sidebar. Self-contained dialog state + toast.
 */
export function NewDocButton({ projectId, onCreated }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const handleCreate = useCallback(
    async (name: string) => {
      if (!name.trim() || !project) return;
      try {
        await MarkdownAsset.createInProject(project, name, '.claude/docs');
        toast({ title: 'Doc created' });
        onCreated?.();
      } catch (err) {
        console.error('[NewDocButton] create failed:', err);
        toast({ title: 'Failed to create doc', variant: 'destructive' });
      }
    },
    [project, toast, onCreated],
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
