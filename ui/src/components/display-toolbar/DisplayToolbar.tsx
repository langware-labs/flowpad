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
  /** The viewer being displayed — fills the area below the strip. */
  children: ReactNode;
}

/**
 * Chrome over the vibe display: a toolbar strip (per-type on the left, the
 * generic toolbar right-aligned) above the shown viewer. Dumb — it knows only
 * the resolved `externalUrl` and the caller-supplied `perType` node; the
 * kind→{externalUrl, perType} mapping lives in `display-descriptors`.
 */
export function DisplayToolbar({ externalUrl, onOpenInTab, perType, onAnnotate, children }: DisplayToolbarProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b bg-muted/30 px-2">
        <div className="flex items-center gap-2">{perType}</div>
        <GenericDisplayToolbar
          externalUrl={externalUrl}
          onOpenInTab={onOpenInTab}
          onAnnotate={onAnnotate ? () => contentRef.current && onAnnotate(contentRef.current) : undefined}
        />
      </div>
      <div ref={contentRef} className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
