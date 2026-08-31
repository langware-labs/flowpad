import { ReactNode, useRef } from 'react';
import { GenericDisplayToolbar } from './GenericDisplayToolbar';

interface DisplayToolbarProps {
  /** Right-aligned "open externally" target (webapps — a real external URL). */
  externalUrl?: string;
  /** Right-aligned "open in a new tab" action (entities/files — in-app dock
   *  navigation). Takes precedence over `externalUrl`. */
  onOpenInTab?: () => void;
  /** Per-type toolbar content (left), e.g. the webapp port/health strip.
   *  Omit for types with no bespoke toolbar. */
  perType?: ReactNode;
  /** Generic annotate action for the active display content area. */
  onAnnotate?: (target: HTMLElement) => void;
  /** Right-aligned control rendered NEXT TO the open-in-window icon — the
   *  display-history popover. */
  historySlot?: ReactNode;
  /**
   * Render the strip as hidden while keeping this wrapper in the tree.
   *
   * The vibe workspace is the same mounted host in both view modes — that is what
   * lets a dirty editor survive a Standard⇄Vibe toggle instead of remounting and
   * dropping the buffer. Conditionally wrapping the viewer in a toolbar would break
   * exactly that, so the wrapper is unconditional and only the strip comes and goes.
   */
  hideStrip?: boolean;
  /** The viewer being displayed — fills the area below the strip. */
  children: ReactNode;
}

/**
 * Chrome over the vibe display: a toolbar strip (per-type on the left, the
 * generic toolbar right-aligned) above the shown viewer. Dumb — it knows only
 * the resolved `externalUrl` and the caller-supplied `perType` node; the
 * kind→{externalUrl, perType} mapping lives in `display-descriptors`.
 */
export function DisplayToolbar({
  externalUrl,
  onOpenInTab,
  perType,
  onAnnotate,
  historySlot,
  hideStrip = false,
  children,
}: DisplayToolbarProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full w-full flex-col">
      <div hidden={hideStrip} className="flex h-9 shrink-0 items-center justify-between gap-1 border-b bg-muted/30 px-2">
        <div className="flex items-center gap-2">{perType}</div>
        <GenericDisplayToolbar
          externalUrl={externalUrl}
          onOpenInTab={onOpenInTab}
          onAnnotate={onAnnotate ? () => contentRef.current && onAnnotate(contentRef.current) : undefined}
          historySlot={historySlot}
        />
      </div>
      <div ref={contentRef} className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
