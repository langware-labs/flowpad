import { ReactNode } from 'react';
import { GenericDisplayToolbar } from './GenericDisplayToolbar';

interface DisplayToolbarProps {
  /** Right-aligned generic "open externally" target for the shown item. */
  externalUrl?: string;
  /** Per-type toolbar content (left), e.g. the webapp port/health strip.
   *  Omit for types with no bespoke toolbar. */
  perType?: ReactNode;
  /** The viewer being displayed — fills the area below the strip. */
  children: ReactNode;
}

/**
 * Chrome over the vibe display: a toolbar strip (per-type on the left, the
 * generic toolbar right-aligned) above the shown viewer. Dumb — it knows only
 * the resolved `externalUrl` and the caller-supplied `perType` node; the
 * kind→{externalUrl, perType} mapping lives in `display-descriptors`.
 */
export function DisplayToolbar({ externalUrl, perType, children }: DisplayToolbarProps) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b bg-muted/30 px-2">
        <div className="flex items-center gap-2">{perType}</div>
        <GenericDisplayToolbar externalUrl={externalUrl} />
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
