import { CollaborationSpace, getOrCreateLocalMemberId } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useToast } from '@src/hooks/use-toast';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LogIn, Plus, Users } from 'lucide-react';
import { useState } from 'react';

interface StartSpaceDialogProps {
  open: boolean;
  onClose: () => void;
  defaultName?: string;
}

type Tab = 'create' | 'join';

export function StartSpaceDialog({ open, onClose, defaultName }: StartSpaceDialogProps) {
  const [tab, setTab] = useState<Tab>('create');
  const [hostName, setHostName] = useState(defaultName ?? '');
  const [joinCode, setJoinCode] = useState('');
  const [joinName, setJoinName] = useState(defaultName ?? '');
  const [busy, setBusy] = useState(false);
  const { navigation } = useDockNavigation();
  const { toast } = useToast();

  const canCreate = !!hostName.trim() && !busy;
  const normalizedCode = joinCode.trim().toUpperCase();
  const canJoin = !!normalizedCode && !!joinName.trim() && !busy;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const space = await CollaborationSpace.create(hostName.trim());
      toast({ title: 'Space created', description: `Share code ${space.session_code} to invite.` });
      navigation.openCollaborationSpace(space.id);
      onClose();
    } catch (err) {
      console.error('[StartSpaceDialog] create failed', err);
      toast({ title: 'Could not create space', description: String((err as Error).message ?? err) });
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    if (!canJoin) return;
    setBusy(true);
    try {
      const resolved = await CollaborationSpace.resolveByCode(normalizedCode);
      if (!resolved) {
        toast({ title: 'Space not found', description: `No active space matches "${normalizedCode}".` });
        return;
      }
      const memberId = getOrCreateLocalMemberId();
      try {
        const sp = new CollaborationSpace({
          id: resolved.collaboration_space_id,
          type: 'collaboration_space',
        } as any);
        await sp.join(memberId, joinName.trim());
      } catch (err) {
        console.warn('[StartSpaceDialog] join call failed (continuing)', err);
      }
      navigation.openCollaborationSpace(resolved.collaboration_space_id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Start a space
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 border-b pb-2">
          <button
            onClick={() => setTab('create')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
              tab === 'create' ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <Plus className="h-3.5 w-3.5" /> Create new
          </button>
          <button
            onClick={() => setTab('join')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
              tab === 'join' ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <LogIn className="h-3.5 w-3.5" /> Join existing
          </button>
        </div>

        {tab === 'create' ? (
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Your display name</label>
              <Input
                placeholder="e.g. Alex"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate();
                }}
                autoFocus
              />
            </div>
            <Button className="w-full" onClick={() => void handleCreate()} disabled={!canCreate}>
              {busy ? 'Creating…' : 'Create space'}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              You become the host — you decide what gets shared into the space.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Space code</label>
              <Input
                placeholder="XKCD-J3F2"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleJoin();
                }}
                className="text-center font-mono text-lg tracking-widest"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Your display name</label>
              <Input
                placeholder="e.g. Alex"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleJoin();
                }}
              />
            </div>
            <Button className="w-full" onClick={() => void handleJoin()} disabled={!canJoin}>
              {busy ? 'Joining…' : 'Join space'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
