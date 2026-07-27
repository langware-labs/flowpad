import React, { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import type { ContextFolderScope } from '@src/hooks/use-project-context-folders';
import {
  ContextFolderScopeChips,
  useContextFolderSources,
  type ContextFolderSource,
} from './context-folder-sources';

interface AddContextFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Run a source at the chosen scope. Owned by the host — each source needs
   *  something that outlives this dialog (a picker, the compute node, the git
   *  wizard), and this dialog closes the moment a tile is clicked. */
  onPick: (source: ContextFolderSource, scope: ContextFolderScope) => void;
}

/** A desktop-icon-style source tile (icon above a small label), mirroring the
 *  home grid's tile grammar. */
function SourceTile({
  Icon,
  label,
  onClick,
  testId,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-8 w-8" />
      <span className="max-w-[88px] truncate text-[11px] font-medium leading-none">{label}</span>
    </button>
  );
}

/**
 * AddContextFolderDialog — the "+" flow for project context folders, offering
 * the same sources as the create-new surface's folder tiles (they share
 * `useContextFolderSources`), scoped private or shared.
 */
export function AddContextFolderDialog({
  open,
  onOpenChange,
  onPick,
}: AddContextFolderDialogProps): React.ReactElement {
  const [scope, setScope] = useState<ContextFolderScope>('private');
  const sources = useContextFolderSources();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="add-context-folder-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add context folder</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Include another folder in this project's context.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center gap-3 py-2">
          {sources.map((source) => (
            <SourceTile
              key={source.key}
              Icon={source.Icon}
              label={source.label}
              testId={source.testId}
              onClick={() => {
                onOpenChange(false);
                onPick(source.key, scope);
              }}
            />
          ))}
        </div>
        <div className="flex items-center justify-center">
          <ContextFolderScopeChips scope={scope} onChange={setScope} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
