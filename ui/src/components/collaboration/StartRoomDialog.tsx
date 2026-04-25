import { CollaborationRoom, dataContext, getOrCreateLocalMemberId, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useToast } from '@src/hooks/use-toast';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LogIn, Plus, Users } from 'lucide-react';
import { useState } from 'react';

interface StartRoomDialogProps {
  open: boolean;
  onClose: () => void;
  defaultName?: string;
}

type Tab = 'create' | 'join';

export function StartRoomDialog({ open, onClose, defaultName }: StartRoomDialogProps) {
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
      const currentProject = dataContext.project;
      if (!currentProject?.id) {
        toast({
          title: 'No project selected',
          description: 'Open a project before starting a collaboration.',
        });
        return;
      }
      const room = await CollaborationRoom.create({
        projectId: currentProject.id,
        hostName: hostName.trim(),
      });
      toast({
        title: 'Room started',
        description: currentProject.session_code
          ? `Share code ${currentProject.session_code} to invite.`
          : undefined,
      });
      navigation.openProject(currentProject.id, { roomId: room.id });
      onClose();
    } catch (err) {
      console.error('[StartRoomDialog] create failed', err);
      toast({ title: 'Could not start room', description: String((err as Error).message ?? err) });
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    if (!canJoin) return;
    setBusy(true);
    try {
      const resolved = await Project.resolveByCode(normalizedCode);
      if (!resolved) {
        toast({ title: 'Project not found', description: `No project matches "${normalizedCode}".` });
        return;
      }
      const memberId = getOrCreateLocalMemberId();
      try {
        const proj =
          Project.getByIdFromCache<Project>(resolved.project_id) ??
          (await Project.getById<Project>(resolved.project_id));
        await proj?.joinCollaboration(memberId, joinName.trim());
      } catch (err) {
        console.warn('[StartRoomDialog] join call failed (continuing)', err);
      }
      navigation.openProject(resolved.project_id);
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
            Start a collaboration
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
              {busy ? 'Creating…' : 'Start room'}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              You become the host — you decide what gets shared into the room.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Join code</label>
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
              {busy ? 'Joining…' : 'Join'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
