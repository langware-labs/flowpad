import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ExternalLink, FolderOpen } from 'lucide-react';
import { FSRef, TypeId } from '@sdk';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { CopyPathButton } from './CopyPathButton';

/**
 * "What exactly am I looking at" — the details behind the last breadcrumb.
 *
 * This is where the asset editor's header row went. That row showed the file's
 * real name, its parent directory, a copy-path button and a reveal-in-Finder
 * glyph, all of which duplicated the bar sitting directly above it. Only the
 * PATH was genuinely unique, and a path belongs behind the address, not beside
 * it — which is where a browser keeps it too.
 *
 * Rendered only for a file- or folder-backed dock. A conversation, a process or
 * a list has no path, and the crumb stays plain text.
 *
 * Opens on HOVER, like the project crumb's card beside it — the two are the
 * same kind of affordance and must not need different gestures. A click opens
 * it too, for touch and for anyone who reaches for it that way.
 */
export function CrumbDetailsPopover({
  label,
  filename,
  path,
  directory = false,
  children,
}: {
  label: string;
  /** Real basename, with extension — `label` is the display name, which drops it. */
  filename: string | null | undefined;
  path: string;
  /** The path IS a folder (a Files dock). "Open in Files" then opens it rather
   *  than its parent, and the OS reveal opens it rather than selecting it. */
  directory?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);

  const parentDir = path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '') || path;
  const filesTarget = directory ? path : parentDir;

  const openInFiles = useCallback(() => {
    navigation.openDock(DockPointer.forExplorer(filesTarget));
  }, [navigation, filesTarget]);

  // Reveal through the compute node the path actually belongs to, so it keeps
  // working for an asset on a remote node; `localComputeNodeId` is null there,
  // which is what hides the button. Same gate the editors' own reveals use.
  const fsRef = new FSRef(path, new TypeId('compute_node', '@local'));
  const canReveal = !!fsRef.localComputeNodeId;

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild onClick={() => setOpen(true)}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-96 p-3" data-testid="top-nav-crumb-details">
        <div className="truncate text-sm font-medium text-foreground" title={filename || label}>
          {filename || label}
        </div>

        <CopyPathButton path={path} testId="top-nav-crumb-copy-path" className="mt-1.5 w-full" />

        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            onClick={openInFiles}
            data-testid="top-nav-crumb-open-files"
            className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t`Open in Files`}
          </button>
          {canReveal && (
            <button
              type="button"
              onClick={() => void fsRef.open(directory ? undefined : { select: true })}
              data-testid="top-nav-crumb-reveal"
              className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t`Reveal in Finder`}
            </button>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
