import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ConversationParticipant, Task, type TaskAssignOptions, TypeId } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { loadSessionTranscript } from '@src/hooks/share-sources';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { notify } from '@src/notifications';
import { guardCloudAction } from '@src/services/privacy-guard';

interface VibeAssignTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project the task belongs to — the current vibe project. */
  projectId: string | null;
  /** Active vibe session, the transcript's source. Null before a session starts
   *  (the dialog still works; the transcript option is simply not offered). */
  sessionTypeId: TypeId | null;
  onAssigned?: (taskId: string) => void;
}

/**
 * "Ask someone for help" from the vibe workspace: pick a person, say what you
 * need, and hand it over. The commit path is a TASK, not a conversation — one
 * `Task` created in this project and assigned, so it lands on the other
 * person's board the way an assigned issue does.
 *
 * Deliberately three fields: who, what (title), and the detail (notes → the
 * task body, which also becomes the invitation email's message so the mail is
 * worth reading). The transcript rides as an attachment when the user opts in,
 * using the same loader the share/collaborate paths use.
 */
export function VibeAssignTaskDialog({
  open,
  onOpenChange,
  projectId,
  sessionTypeId,
  onAssigned,
}: VibeAssignTaskDialogProps) {
  const { t } = useLingui();
  const ensureCloudLogin = useCloudLoginGate();
  const [picked, setPicked] = useState<ConversationParticipant[]>([]);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [attachTranscript, setAttachTranscript] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const person = picked[0] ?? null;
  const canSubmit = !!person && !!title.trim() && !busy;

  /** The session transcript, or nothing. Never blocks the assign — a missing
   *  transcript downgrades to a warning, exactly like the share path. */
  const collectTranscript = async (): Promise<TaskAssignOptions['transcript']> => {
    if (!attachTranscript || !sessionTypeId) return undefined;
    const { files, sessionId, attached, failureReason } = await loadSessionTranscript(sessionTypeId);
    if (!attached) {
      notify.warning({
        title: t`Transcript not attached`,
        message: failureReason ?? t`The session transcript could not be read.`,
      });
      return undefined;
    }
    return { files, sessionId };
  };

  const submit = async () => {
    if (!canSubmit || !person) return;
    // Assignment puts the task on the hub — blocked in Local privacy mode, the
    // same gate every share surface uses (the backend re-enforces with a 403).
    if (!guardCloudAction('share')) return;
    setBusy(true);
    setError(null);
    try {
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        setError(gate.error);
        return;
      }
      const task = await new Task({
        title: title.trim(),
        description: notes.trim() || undefined,
        ...(projectId ? { project_id: projectId } : {}),
      }).save();

      // The notification message must stand on its own: the title IS the issue,
      // so it leads even when the (optional) notes are empty — otherwise the
      // recipient gets a bare chip with no text.
      const message = [title.trim(), notes.trim()].filter(Boolean).join('\n\n');

      await task.assign(person, {
        message,
        transcript: await collectTranscript(),
        ensureCloudLogin,
      });

      notify.success({
        title: t`Task assigned`,
        message: t`${person.name || person.email} now has "${task.title}".`,
      });
      onAssigned?.(task.id);
      onOpenChange(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The button renders this only while open, so every field starts fresh on
  // reopen — no manual reset needed.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t`Ask someone for help`}</DialogTitle>
          <DialogDescription>
            {t`Creates a task, assigns it to them, and sends them a message with the details.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* One owner per task — `max={1}` is the picker's single-select form.
              Members, contacts, and a free-form email all resolve here. */}
          <ContactPicker
            value={picked}
            onChange={setPicked}
            max={1}
            placeholder={t`Pick a person or type an email`}
            testId="vibe-assign-person"
          />

          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t`What do you need help with?`}
            data-testid="vibe-assign-title"
          />

          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t`Any detail that helps (optional)`}
            rows={4}
            className="resize-none"
            data-testid="vibe-assign-notes"
          />

          {sessionTypeId && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={attachTranscript}
                onChange={(e) => setAttachTranscript(e.target.checked)}
              />
              {t`Attach this session's transcript`}
            </label>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t`Cancel`}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="vibe-assign-submit">
            {busy ? t`Assigning…` : t`Assign`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
