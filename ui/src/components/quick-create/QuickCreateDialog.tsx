import { dataContext } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useToast } from '@src/hooks/use-toast';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderTree } from './FolderTree';
import { QuickCreateToolbar } from './QuickCreateToolbar';
import { getDescriptor } from './registry';
import { useProjectSnapshot } from './useProjectSnapshot';

interface QuickCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Descriptor `type` (e.g. 'skill', 'agent'). Ignored when null. */
  type: string | null;
}

export function QuickCreateDialog({ open, onOpenChange, type }: QuickCreateDialogProps) {
  const descriptor = type ? getDescriptor(type) : undefined;
  const { toast } = useToast();
  const { navigation } = useDockNavigation();
  const { project } = useProject();
  const { restore, commit } = useProjectSnapshot(open);

  const [name, setName] = useState('');
  const [folderVfsPath, setFolderVfsPath] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Reset form whenever the dialog opens for a new type
  useEffect(() => {
    if (open) {
      setName('');
      setFolderVfsPath(descriptor?.defaultFolder ?? null);
      setIsSubmitting(false);
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [open, descriptor?.defaultFolder]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        void restore();
      }
      onOpenChange(next);
    },
    [onOpenChange, restore],
  );

  const handleCreate = useCallback(async () => {
    if (!descriptor || !name.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await descriptor.create({
        project: dataContext.project ?? null,
        name,
        folderVfsPath: folderVfsPath ?? descriptor.defaultFolder,
      });
      toast({ title: res.toastTitle });
      commit();
      if (res.pointer) navigation.openDock(res.pointer);
      onOpenChange(false);
    } catch (err) {
      console.error('[QuickCreateDialog] Create failed:', err);
      toast({ title: 'Failed to create', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  }, [descriptor, name, folderVfsPath, isSubmitting, toast, commit, navigation, onOpenChange]);

  if (!descriptor) return null;
  const Icon = descriptor.Icon;
  const canCreate = !!name.trim() && !isSubmitting;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              New {descriptor.label}
            </DialogTitle>
            <DialogDescription>
              Create a new {descriptor.label.toLowerCase()} in the selected project.
            </DialogDescription>
          </DialogHeader>

          <QuickCreateToolbar project={project ?? null} onOpenProjectPicker={() => setProjectPickerOpen(true)} />

          <div className="flex flex-col gap-3 pt-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
              <Input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`New ${descriptor.label.toLowerCase()} name`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) void handleCreate();
                }}
                autoFocus
              />
            </div>

            {descriptor.allowFolderSelection && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Folder{' '}
                  {folderVfsPath && (
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground/80">/{folderVfsPath}</span>
                  )}
                </label>
                <FolderTree
                  project={project ?? null}
                  defaultFolder={descriptor.defaultFolder}
                  value={folderVfsPath}
                  onChange={setFolderVfsPath}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!canCreate}>
              {isSubmitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OpenProjectComponent open={projectPickerOpen} onOpenChange={setProjectPickerOpen} />
    </>
  );
}
