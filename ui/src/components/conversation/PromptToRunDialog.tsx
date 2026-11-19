import type { ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';

export type DialogPart = { kind: 'text'; text: string } | { kind: 'image'; url: string; filename: string };

/** The "Prompt to run" window: the whole prompt, and under it the answers its reader may give. */
export function PromptToRunDialog({
  open,
  onOpenChange,
  parts,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parts: DialogPart[];
  footer?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>Prompt to run</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-auto">
          {parts.length === 0 && (
            <p className="text-sm italic text-muted-foreground">
              <Trans>(prompt content unavailable)</Trans>
            </p>
          )}
          {parts.map((part, i) =>
            part.kind === 'image' ? (
              <img
                key={i}
                src={part.url}
                alt={part.filename}
                className="max-h-[50vh] max-w-full rounded-md border border-border object-contain"
              />
            ) : (
              <pre
                key={i}
                className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground"
              >
                {part.text}
              </pre>
            ),
          )}
        </div>
        {footer && <div className="flex justify-end gap-2">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
