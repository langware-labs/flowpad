import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Check, Copy, ExternalLink, FolderOpen } from 'lucide-react';
import { copyToClipboard, FSRef, TypeId } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * "What exactly am I looking at" — the details behind the last breadcrumb.
 *
 * This is where the asset editor's header row went. That row showed the file's
 * real name, its parent directory, a copy-path button and a reveal-in-Finder
 * glyph, all of which duplicated the bar sitting directly above it. Only the
 * PATH was genuinely unique, and a path belongs behind the address, not beside
 * it — which is where a browser keeps it too.
 *
 * Rendered only for a file-backed dock. A conversation, a process or a list has
 * no path, and the crumb stays plain text.
 */
export function CrumbDetailsPopover({
  label,
  filename,
  path,
  children,
}: {
  label: string;
  /** Real basename, with extension — `label` is the display name, which drops it. */
  filename: string | null | undefined;
  path: string;
  children: React.ReactNode;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void copyToClipboard(path);
    // `copyToClipboard` only alerts on FAILURE, so success needs its own signal.
    // The repo's idiom is a 1.5s check-mark (see version-popover).
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [path]);

  const parentDir = path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '') || path;

  const openInFiles = useCallback(() => {
    navigation.openDock(DockPointer.forExplorer(parentDir));
  }, [navigation, parentDir]);

  // Reveal through the compute node the path actually belongs to, so it keeps
  // working for an asset on a remote node; `localComputeNodeId` is null there,
  // which is what hides the button. Same gate the editors' own reveals use.
  const fsRef = new FSRef(path, new TypeId('compute_node', '@local'));
  const canReveal = !!fsRef.localComputeNodeId;

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-96 p-3" data-testid="top-nav-crumb-details">
        <div className="truncate text-sm font-medium text-foreground" title={filename || label}>
          {filename || label}
        </div>

        <button
          type="button"
          onClick={copy}
          title={t`Copy path`}
          aria-label={t`Copy path`}
          data-testid="top-nav-crumb-copy-path"
          className="mt-1.5 flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span className="min-w-0 flex-1 truncate">{path}</span>
          {copied ? (
            <Check className="h-3 w-3 shrink-0 text-green-500" />
          ) : (
            <Copy className="h-3 w-3 shrink-0" />
          )}
        </button>

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
              onClick={() => void fsRef.open({ select: true })}
              data-testid="top-nav-crumb-reveal"
              className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t`Reveal in Finder`}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
