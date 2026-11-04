import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Trans, useLingui } from '@lingui/react/macro';
import { Maximize2, Minimize2 } from 'lucide-react';

import { Button } from './button';
import { DialogClose, DialogPortal, DialogTitle } from './dialog';

/** The button that opens a FullScreenView: an icon and a label, clear enough to find in a toolbar. */
export function FullScreenButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useLingui();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      // A toolbar's buttons act on mouse-down; keep the editor's selection when this one is pressed.
      onMouseDown={(e) => e.preventDefault()}
      title={t`Full screen (Esc to exit)`}
      data-testid="full-screen-open"
      className={`h-7 shrink-0 gap-1.5 px-2 ${className ?? ''}`}
    >
      <Maximize2 className="h-4 w-4" aria-hidden />
      <Trans>Full screen</Trans>
    </Button>
  );
}

interface FullScreenViewProps {
  open: boolean;
  onExit: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Any content over the whole window: a header (icon, title, Exit) and the content filling the rest.
 * Esc exits too. It knows nothing about what it shows — the caller passes its own content.
 */
export function FullScreenView({ open, onExit, title, subtitle, icon, children }: FullScreenViewProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onExit()}>
      <DialogPortal>
        <DialogPrimitive.Content
          className="fixed inset-0 isolate z-50 flex flex-col bg-background focus:outline-none"
          data-testid="full-screen-view"
          aria-describedby={undefined}
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3">
            {icon}
            <div className="flex min-w-0 flex-col">
              <DialogTitle className="truncate text-sm">{title}</DialogTitle>
              {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
            </div>
            <DialogClose asChild>
              <Button variant="outline" size="sm" className="ms-auto shrink-0 gap-1.5" data-testid="full-screen-exit">
                <Minimize2 className="h-4 w-4" aria-hidden />
                <Trans>Exit full screen</Trans>
                <kbd className="ms-1 rounded border border-border px-1 text-[10px] text-muted-foreground">Esc</kbd>
              </Button>
            </DialogClose>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}
