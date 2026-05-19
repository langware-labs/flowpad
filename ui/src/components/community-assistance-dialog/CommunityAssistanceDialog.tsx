import { apiClient, createProjectConversation } from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useToast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface CommunityAssistanceDialogProps {
  open: boolean;
  onClose: () => void;
}

const FLOWPAD_ASSISTANT_UNAME = 'flowpad_assistant';

const EXAMPLES: string[] = [
  'Triage my inbox and draft replies',
  'Research a competitor and send a brief',
  'Turn a transcript into action items',
  'Generate weekly LinkedIn posts from my notes',
  'Daily news summary on…',
  'Qualify these sales leads',
  'Extract data from PDFs / invoices',
  'Watch a topic and alert me',
  'How to set up Claude Code?',
  'How to migrate from Lovable',
  'I need bug fixing',
];

const PLACEHOLDER =
  "Describe what you want done — what should the agent automate, " +
  'research, summarize, or fix? The more context the better.';

async function findFlowpadAssistantProjectId(): Promise<string | null> {
  try {
    const rows = await apiClient.get<Array<{ id?: string; uname?: string | null }>>(
      '/graph/project?include_system=true',
    );
    const match = (rows ?? []).find((p) => p.uname === FLOWPAD_ASSISTANT_UNAME);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export function CommunityAssistanceDialog({ open, onClose }: CommunityAssistanceDialogProps) {
  const { navigation } = useDockNavigation();
  const { toast } = useToast();
  const ensureCloudLogin = useCloudLoginGate();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setMessage('');
      setBusy(false);
      // Defer focus until the dialog mount/animation completes.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  const canSend = !!message.trim() && !busy;

  const handleSend = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      // Posting the first message routes through the hub-backed
      // append-conversation action, which the backend gates on cloud login.
      // Run the OAuth flow first so a logged-out user is taken through
      // sign-in and the send resumes on the same click.
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        toast({ title: 'Sign in required', description: gate.error });
        return;
      }
      const projectId = await findFlowpadAssistantProjectId();
      if (!projectId) {
        toast({
          title: 'Flowpad Assistant unavailable',
          description: 'The Flowpad Assistant project is not registered on this instance.',
          variant: 'destructive',
        });
        return;
      }

      // Use a short slice of the question as the conversation title so the
      // tab and sidebar list show something descriptive.
      const trimmed = message.trim();
      const title = trimmed.length > 60 ? `${trimmed.slice(0, 60).trimEnd()}…` : trimmed;

      const conv = await createProjectConversation({
        project_id: projectId,
        participants: [],
        title,
      });

      try {
        await sendReply({ conversationId: conv.conversation_id }, message.trim());
      } catch (err) {
        // Non-fatal: still navigate to the conversation so the user can see
        // their context and retry sending. Surface the error.
        console.error('[CommunityAssistanceDialog] failed to post first message', err);
        toast({
          title: 'Could not post your message',
          description: err instanceof Error ? err.message : 'Please try again from the conversation view.',
        });
      }

      navigation.openDock(DockPointer.forConversation(conv.conversation_id));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg" data-testid="community-assistance-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            What do you need help with?
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Send a question to the Flowpad Assistant project. A new conversation will open with your
            message as the starting point.
          </p>

          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={busy}
                onClick={() => setMessage(ex)}
                className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={PLACEHOLDER}
            rows={6}
            disabled={busy}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="community-assistance-input"
          />
          <p className="text-[11px] text-muted-foreground/80">⌘/Ctrl + Enter to send</p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
          >
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
