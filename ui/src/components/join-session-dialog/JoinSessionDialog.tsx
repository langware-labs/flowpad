import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';

interface JoinSessionDialogProps {
  open: boolean;
  onClose: () => void;
  hostName?: string;
  draftPrompt: string;
  onStart: (hostName: string, prompt: string) => Promise<void> | void;
}

export function JoinSessionDialog({ open, onClose, hostName, draftPrompt, onStart }: JoinSessionDialogProps) {
  const [name, setName] = useState(hostName ?? '');
  const [busy, setBusy] = useState(false);

  // Keep name in sync when the dialog reopens with a new host name
  useEffect(() => {
    if (open) setName(hostName ?? '');
  }, [open, hostName]);

  const promptTrimmed = draftPrompt.trim();
  const canStart = !!name.trim() && !busy;

  const handleStart = async () => {
    if (!canStart) return;
    setBusy(true);
    try {
      await onStart(name.trim(), promptTrimmed);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-green-600" />
            Start collaborative session
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted-foreground">
            A space is a persistent room you meet in to assist and get assisted. If you typed a
            prompt above, it opens the first agentic process bound to this space. Otherwise the
            space opens empty and you can share tabs into it later.
          </p>

          {/* Prompt preview (optional) */}
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">First prompt (optional)</p>
            {promptTrimmed ? (
              <p className="whitespace-pre-wrap text-sm text-foreground">{promptTrimmed}</p>
            ) : (
              <p className="text-sm italic text-muted-foreground">
                No prompt — space will open empty.
              </p>
            )}
          </div>

          {/* Host name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Your display name</label>
            <Input
              placeholder="e.g. Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleStart();
              }}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="gap-1.5 bg-green-600 text-white hover:bg-green-700"
            onClick={() => void handleStart()}
            disabled={!canStart}
          >
            <Users className="h-4 w-4" />
            {busy ? 'Starting…' : 'Start'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
