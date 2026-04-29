import { getOrCreateLocalMemberId, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useToast } from '@src/hooks/use-toast';
import { LogIn } from 'lucide-react';
import { useState } from 'react';

interface JoinConversationDialogProps {
  open: boolean;
  onClose: () => void;
  defaultName?: string;
}

/**
 * Join an existing project's conversation by pasting the project's share code.
 * Resolves the code → project, registers the local member on the project, and
 * navigates into the project view (where the user picks a conversation tab).
 */
export function JoinConversationDialog({ open, onClose, defaultName }: JoinConversationDialogProps) {
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState(defaultName ?? '');
  const [busy, setBusy] = useState(false);
  const { navigation } = useDockNavigation();
  const { toast } = useToast();

  const normalizedCode = code.trim().toUpperCase();
  const canJoin = !!normalizedCode && !!displayName.trim() && !busy;

  const handleJoin = async () => {
    if (!canJoin) return;
    setBusy(true);
    try {
      const resolved = await Project.resolveByCode(normalizedCode);
      if (!resolved) {
        toast({
          title: 'Project not found',
          description: `No project matches code "${normalizedCode}".`,
        });
        return;
      }
      const memberId = getOrCreateLocalMemberId();
      try {
        const proj =
          Project.getByIdFromCache<Project>(resolved.project_id) ??
          (await Project.getById<Project>(resolved.project_id));
        await proj?.joinCollaboration(memberId, displayName.trim());
      } catch (err) {
        console.warn('[JoinConversationDialog] join call failed (continuing)', err);
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
            <LogIn className="h-5 w-5 text-green-600" />
            Join a conversation
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Project code</label>
            <Input
              placeholder="XKCD-J3F2"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleJoin();
              }}
              className="font-mono tracking-widest text-center text-lg"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Your display name</label>
            <Input
              placeholder="e.g. Alex"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleJoin();
              }}
            />
          </div>
          <Button
            className="w-full bg-green-600 text-white hover:bg-green-700 transition-colors"
            onClick={() => void handleJoin()}
            disabled={!canJoin}
          >
            {busy ? 'Joining…' : 'Join conversation'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
