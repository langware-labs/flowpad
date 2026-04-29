import {
  Conversation,
  ConversationParticipant,
  createProjectConversation,
} from '@sdk';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { Button } from '@src/components/ui/button';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { MessageSquarePlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewConversationDialog({ open, onClose }: NewConversationDialogProps) {
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { projects = [] } = useProjects();

  const [projectId, setProjectId] = useState<string>('');
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the project picker to the current project on open.
  useEffect(() => {
    if (!open) return;
    setParticipants([]);
    setError(null);
    setProjectId(ctx.project?.id ?? projects[0]?.id ?? '');
  }, [open, ctx.project?.id, projects]);

  // Slack-style placeholder: "<my name>, <participant1>, ..."
  const myLabel = ctx.user?.name || ctx.user?.email || 'You';
  const placeholderTitle = useMemo(() => {
    if (participants.length === 0) return 'New conversation';
    const others = participants.map((p) => p.name || p.email).join(', ');
    return `${myLabel}, ${others}`;
  }, [participants, myLabel]);

  const canCreate = !!projectId && !busy;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createProjectConversation({
        project_id: projectId,
        participants,
      });
      navigation.openDock(
        DockPointer.forProject(result.project_id, { conversationId: result.conversation_id }),
      );
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create conversation';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md" data-testid="new-conversation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="h-5 w-5 text-primary" />
            {placeholderTitle}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          {/* Project */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Project
            </label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id ?? ''}>
                    {p.name || p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Participants */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Participants
            </label>
            <ContactPicker
              value={participants}
              onChange={setParticipants}
              excludeUserId={ctx.user?.id}
              enabled={open}
              testId="participant-input"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Re-export for type completeness
export type { Conversation };
