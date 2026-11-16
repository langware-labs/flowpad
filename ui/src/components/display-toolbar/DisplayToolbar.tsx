import { createContext, ReactNode, useContext, useRef } from 'react';
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
  /**
   * The viewer below draws its own address bar (a web page, an app). Instead of a
   * second strip stacked over it, the generic actions are handed to that bar
   * through `useDisplayChromeSlot()` — one row per view.
   */
  viewerOwnsBar?: boolean;
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
  viewerOwnsBar = false,
  children,
}: DisplayToolbarProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const generic = (
    <GenericDisplayToolbar
      externalUrl={externalUrl}
      onOpenInTab={onOpenInTab}
      onAnnotate={onAnnotate ? () => contentRef.current && onAnnotate(contentRef.current) : undefined}
      historySlot={historySlot}
    />
  );
  const showStrip = !hideStrip && !viewerOwnsBar;

  return (
    <div className="flex h-full w-full flex-col">
      {/* Conditional STRIP, unconditional wrapper: the viewer below keeps its
          slot (and the dirty editor its buffer) either way. Not the `hidden`
          attribute — Tailwind's `.flex` utility outranks preflight's
          `[hidden]{display:none}` in the cascade, so that never hid anything. */}
      {showStrip && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b bg-muted/30 px-2">
          <div className="flex items-center gap-2">{perType}</div>
          {generic}
        </div>
      )}
      <div ref={contentRef} className="relative min-h-0 flex-1">
        <DisplayChromeSlot.Provider value={!hideStrip && viewerOwnsBar ? generic : null}>{children}</DisplayChromeSlot.Provider>
      </div>
    </div>
  );
}

const DisplayChromeSlot = createContext<ReactNode>(null);

/** The display's generic actions (history, annotate) for a viewer that draws its
 *  own bar; null outside a display or when the display strip is shown. */
export function useDisplayChromeSlot(): ReactNode {
  return useContext(DisplayChromeSlot);
}
