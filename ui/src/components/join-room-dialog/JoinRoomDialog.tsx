import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { CollaborationRoom } from '@sdk';
import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';

interface JoinRoomDialogProps {
  open: boolean;
  onClose: () => void;
  hostName?: string;
  draftPrompt: string;
  onStart: (hostName: string, prompt: string, roomName: string) => Promise<void> | void;
}

export function JoinRoomDialog({ open, onClose, hostName, draftPrompt, onStart }: JoinRoomDialogProps) {
  const [name, setName] = useState(hostName ?? '');
  const [roomName, setRoomName] = useState('');
  const [roomNameEdited, setRoomNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset + prefill when the dialog reopens.
  useEffect(() => {
    if (!open) return;
    setName(hostName ?? '');
    setRoomName(CollaborationRoom.defaultName(hostName?.trim() || 'Anonymous'));
    setRoomNameEdited(false);
  }, [open, hostName]);

  // When the display name changes and the user hasn't manually edited the
  // room name, keep the room-name prefill in sync.
  useEffect(() => {
    if (roomNameEdited) return;
    setRoomName(CollaborationRoom.defaultName(name.trim() || 'Anonymous'));
  }, [name, roomNameEdited]);

  const promptTrimmed = draftPrompt.trim();
  const canStart = !!name.trim() && !busy;

  const handleStart = async () => {
    if (!canStart) return;
    setBusy(true);
    try {
      const finalName =
        roomName.trim() || CollaborationRoom.defaultName(name.trim());
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
            Start collaboration room
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted-foreground">
            You're about to open a room on this project. You can invite others with the share
            code that'll appear in the header once the room starts.
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

          {/* Room name — prefilled, user can override */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Room name</label>
            <Input
              placeholder="e.g. Retry logic review"
              value={roomName}
              onChange={(e) => {
                setRoomName(e.target.value);
                setRoomNameEdited(true);
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
