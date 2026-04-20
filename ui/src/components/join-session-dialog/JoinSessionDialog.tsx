import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { CollaborationSession } from '@sdk';
import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';

interface JoinSessionDialogProps {
  open: boolean;
  onClose: () => void;
  hostName?: string;
  draftPrompt: string;
  onStart: (hostName: string, prompt: string, sessionName: string) => Promise<void> | void;
}

export function JoinSessionDialog({ open, onClose, hostName, draftPrompt, onStart }: JoinSessionDialogProps) {
  const [name, setName] = useState(hostName ?? '');
  const [sessionName, setSessionName] = useState('');
  const [sessionNameEdited, setSessionNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset + prefill when the dialog reopens.
  useEffect(() => {
    if (!open) return;
    setName(hostName ?? '');
    setSessionName(CollaborationSession.defaultName(hostName?.trim() || 'Anonymous'));
    setSessionNameEdited(false);
  }, [open, hostName]);

  // When the display name changes and the user hasn't manually edited the
  // session name, keep the session-name prefill in sync.
  useEffect(() => {
    if (sessionNameEdited) return;
    setSessionName(CollaborationSession.defaultName(name.trim() || 'Anonymous'));
  }, [name, sessionNameEdited]);

  const promptTrimmed = draftPrompt.trim();
  const canStart = !!name.trim() && !busy;

  const handleStart = async () => {
    if (!canStart) return;
    setBusy(true);
    try {
      const finalName =
        sessionName.trim() || CollaborationSession.defaultName(name.trim());
      await onStart(name.trim(), promptTrimmed, finalName);
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
            You're about to open a meeting on this project. You can invite others with the share
            code that'll appear in the header once the session starts.
          </p>

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

          {/* Session name — prefilled, user can override */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Session name</label>
            <Input
              placeholder="e.g. Retry logic review"
              value={sessionName}
              onChange={(e) => {
                setSessionName(e.target.value);
                setSessionNameEdited(true);
              }}
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
