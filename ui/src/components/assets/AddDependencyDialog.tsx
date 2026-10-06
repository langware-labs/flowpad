import React, { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import type { DependencyKind } from '@src/hooks/use-project-dependencies';
import { DependencyKindChips, useDependencySources, type DependencySource } from './dependency-sources';

interface AddDependencyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Run a source as the chosen kind. Owned by the host — each source needs
   *  something that outlives this dialog (a picker, the compute node, the git
   *  wizard), and this dialog closes the moment a tile is clicked. */
  onPick: (source: DependencySource, kind: DependencyKind) => void;
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
      {/* Wraps rather than truncates — see the DesktopTile label in
          QuickCreatePanel; these are the same source labels. */}
      <span className="line-clamp-2 max-w-[88px] text-balance break-words px-1 text-center text-[11px] font-medium leading-tight">
        {label}
      </span>
    </button>
  );
}

/**
 * AddDependencyDialog — the "+" flow for project dependencies, offering the
 * same sources as the create-new surface's tiles (they share
 * `useDependencySources`), required or optional.
 */
export function AddDependencyDialog({ open, onOpenChange, onPick }: AddDependencyDialogProps): React.ReactElement {
  const [kind, setKind] = useState<DependencyKind>('required');
  const sources = useDependencySources();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="add-dependency-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add dependency</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Point this project at another folder, repository or hub project it expects in its context.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-center gap-3 py-2">
          {sources.map((source) => (
            <SourceTile
              key={source.key}
              Icon={source.Icon}
              label={source.label}
              testId={source.testId}
              onClick={() => {
                onOpenChange(false);
                onPick(source.key, kind);
              }}
            />
          ))}
        </div>
        <div className="flex items-center justify-center">
          <DependencyKindChips kind={kind} onChange={setKind} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
