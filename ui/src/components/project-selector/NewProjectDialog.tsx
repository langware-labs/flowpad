import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { FolderOpen, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills the parent folder input. */
  defaultParentFolder?: string;
  /**
   * Whether the project is rooted in a folder on a filesystem. Desk: true — a
   * project IS a directory, so the parent folder is required. Hub: false — a
   * hub project is a pure entity with no folder behind it, so the field is
   * dropped entirely and the name alone can create (leaving it in made Create
   * permanently disabled there, since nothing could ever fill it).
   */
  withFolder?: boolean;
  /** When provided, renders a Browse button that calls this and writes the picked path. */
  onPickFolder?: () => Promise<string | null>;
  /** Async callback invoked on submit. `parentFolder` is '' when `withFolder` is
   *  false. Throwing keeps the dialog open and toasts the error. */
  onCreate: (name: string, parentFolder: string) => Promise<void>;
}

export function NewProjectDialog({
  open,
  onOpenChange,
  defaultParentFolder = '',
  withFolder = true,
  onPickFolder,
  onCreate,
}: NewProjectDialogProps) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const [parent, setParent] = useState(defaultParentFolder);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setParent(defaultParentFolder);
      setIsSubmitting(false);
    }
  }, [open, defaultParentFolder]);

  const canCreate = !!name.trim() && (!withFolder || !!parent.trim()) && !isSubmitting;

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setIsSubmitting(true);
    try {
      await onCreate(name.trim(), withFolder ? parent.trim() : '');
      onOpenChange(false);
    } catch (err) {
      notify.error({
        title: err instanceof Error ? err.message : t`Failed to create project`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [canCreate, name, parent, withFolder, onCreate, onOpenChange]);

  const handleBrowse = useCallback(async () => {
    if (!onPickFolder) return;
    const picked = await onPickFolder();
    if (picked) setParent(picked);
  }, [onPickFolder]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>New project</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            placeholder={t`Project name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) void handleCreate();
            }}
          />
          {withFolder && (
            <div className="flex gap-2">
              <Input
                placeholder={t`Project folder`}
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                className="flex-1 font-mono text-xs"
                spellCheck={false}
              />
              {onPickFolder && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void handleBrowse()}
                  title={t`Browse…`}
                  type="button"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate}>
            {isSubmitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NewProjectDialog;
