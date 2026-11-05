import { useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  askForHelp,
  type AskForHelpResult,
  ConversationParticipant,
  type HelpOrigin,
  type HelpRequestRow,
  type HelpRecipient,
  helpRecipients,
  type HelpRecipients,
  normalizeEmail,
  TypeId,
} from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { errorMessage } from '@src/lib/error-message';
import { connectionManager } from '@sdk/websocket';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { animateMinimizeToProcessChip } from '@src/lib/minimize-to-element';
import { useDiagnoseRunStore } from '@src/components/diagnose/diagnose-run-store';
import {
  AttachFilesButton,
  PickedFileList,
  useAnnotatedImagePaste,
  usePickedFiles,
} from '@src/components/conversation/FileAttachmentPicker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { DockPointer } from '@src/navigation/DockPointer';
import { navigateTo, notify, useDiagnoseErrorStore } from '@src/notifications';
import { guardCloudAction } from '@src/services/privacy-guard';
import type { VibeTaskRow } from '@src/hooks/use-my-vibe-tasks';
import { HelpRequestList, useHelpRequests } from './MyHelpRequests';

export interface AskForHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the person is — lists the request with it, and finds the project's own desk. */
  projectId: string | null;
  /** The session on screen — what the diagnostic is told the person was in (never attached). */
  sessionTypeId?: TypeId | null;
  origin: HelpOrigin;
  /** Asked from a desk's own page: that desk, preselected. */
  desk?: HelpRecipient | null;
  /** Shown above the form, e.g. why the guides could not load. */
  note?: string | null;
  onAsked?: (result: AskForHelpResult) => void;
  /** My open help requests here — one already asked of the picked person is offered instead. */
  openTasks?: VibeTaskRow[];
  /** Open that request's conversation instead of asking again. */
  onOpenExisting?: (row: VibeTaskRow) => void;
  /** Filled in when the dialog opens — a surface that knows what went wrong says it (still editable). */
  initialTitle?: string;
  initialNotes?: string;
  initialFiles?: File[];
  initialPerson?: ConversationParticipant | null;
  /** A diagnosis already taken: "Send diagnostic" sends this one instead of running a new one. */
  diagnosisId?: string | null;
}

/**
 * Ask for help — the ONE dialog every surface opens (docs/collab/ask-for-help.md).
 *
 * Ask a person (a task they are assigned, discussed in a conversation) or a desk (a ticket). With
 * no person picked, the nearest desk is preselected, so someone with nobody to ask can still ask.
 * Submit is one call: the request is written on this machine and the dialog closes; reaching the
 * hub happens after, and its state shows on the conversation, not here. The dialog cannot be
 * dismissed only while that write runs — closing then would lose what was typed.
 *
 * Two ways through. "Ask" sends now, the diagnostic following in the background. "Check first" runs
 * the Diagnose window on what was written; when it finishes the dialog comes back with that
 * diagnosis, for the person to read and then send (`diagnosisId`).
 *
 * Test ids keep their ``vibe-assign-*`` names: the dialog grew out of the Vibe one.
 */
export function AskForHelpDialog({
  open,
  onOpenChange,
  projectId,
  sessionTypeId = null,
  origin,
  desk = null,
  note = null,
  onAsked,
  openTasks = [],
  onOpenExisting,
  initialTitle = '',
  initialNotes = '',
  initialFiles,
  initialPerson = null,
  diagnosisId = null,
}: AskForHelpDialogProps) {
  const { t } = useLingui();
  const ensureCloudLogin = useCloudLoginGate();
  const [picked, setPicked] = useState<ConversationParticipant[]>(initialPerson ? [initialPerson] : []);
  const [recipients, setRecipients] = useState<HelpRecipients | null>(null);
  const [deskId, setDeskId] = useState<string | null>(desk?.desk_project_id ?? null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [sendDiagnostic, setSendDiagnostic] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request per dialog: a resubmit after a lost answer is the SAME request, never a second.
  const conversationId = useRef<string>(crypto.randomUUID());
  const picker = usePickedFiles({ enabled: true, disabled: busy });
  const handlePaste = useAnnotatedImagePaste(picker.addFiles, { enabled: !busy, setText: setNotes });
  const diagnoseRunning = useDiagnoseRunStore((s) => s.running);
  const requests = useHelpRequests(open);
  const myOpenRequests = requests.filter((row) => row.status === 'open');
  const openRequest = (row: HelpRequestRow) => {
    onOpenChange(false);
    navigateTo(DockPointer.forConversation(row.conversation_id).toUrl());
  };

  const { addFiles } = picker;
  useEffect(() => {
    if (initialFiles?.length) addFiles(initialFiles);
  }, [initialFiles, addFiles]);

  useEffect(() => {
    if (!open || (!initialTitle && !initialNotes)) return;
    setTitle(initialTitle);
    setNotes(initialNotes);
  }, [open, initialTitle, initialNotes]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void helpRecipients(projectId)
      .catch((): HelpRecipients => ({ desks: [], default_state: 'unknown' }))
      .then((r) => {
        if (!live) return;
        setRecipients(r);
        setDeskId((current) => current ?? desk?.desk_project_id ?? r.desks[0]?.desk_project_id ?? null);
      });
    return () => {
      live = false;
    };
  }, [open, projectId, desk?.desk_project_id]);

  const desks = useMemo(() => {
    const list = recipients?.desks ?? [];
    return desk && !list.some((d) => d.desk_project_id === desk.desk_project_id) ? [desk, ...list] : list;
  }, [recipients, desk]);
  const person = picked[0] ?? null;
  // Same asker, same person, same project: the request already open with them. Asking again is
  // still allowed — this only offers the way back to it.
  const pickedEmail = normalizeEmail(person?.email);
  const alreadyAsked = pickedEmail
    ? openTasks.find((row) => normalizeEmail(row.task.assignee) === pickedEmail)
    : undefined;
  const recipient: HelpRecipient | null = person
    ? { kind: 'person', email: person.email ?? null, user_id: person.user_id ?? null, name: person.name ?? null }
    : desks.length || recipients?.default_state === 'unknown'
      ? { kind: 'desk', desk_project_id: deskId, name: desks.find((d) => d.desk_project_id === deskId)?.name ?? null }
      : null;
  const what = title.trim() || notes.trim();
  const canSubmit = !!recipient && !!what && !busy;

  const submit = async () => {
    if (!canSubmit || !recipient) return;
    if (!guardCloudAction('share')) return;
    setBusy(true);
    setError(null);
    try {
      const result = await askForHelp(
        {
          conversation_id: conversationId.current,
          recipient,
          title: title.trim(),
          text: [title.trim(), notes.trim()].filter(Boolean).join('\n\n'),
          project_id: projectId,
          origin,
          diagnose: sendDiagnostic && !diagnosisId,
          diagnosis_id: sendDiagnostic ? diagnosisId : null,
          process: sessionTypeId ? sessionTypeId.toString() : null,
          connection_id: connectionManager.id,
        },
        picker.files,
      );
      const to = recipient.name || recipient.email || t`the help desk`;
      const openIt = { label: t`Open`, href: DockPointer.forConversation(result.conversation_id).toUrl() };
      // The diagnosis runs on in the background: fly the dialog into the footer's process chip,
      // where its activity shows — that is where the person finds it.
      if (result.diagnosing) animateMinimizeToProcessChip(contentRef.current);
      onOpenChange(false);
      onAsked?.(result);
      if (result.delivery.failure?.kind === 'signed_out') {
        // Saved; it goes once they sign in. Offer it on the same click, and say so if they don't.
        const gate = await ensureCloudLogin();
        if (!gate.ok) {
          notify.warning({
            id: `ask:${result.conversation_id}`,
            title: t`Saved — it will send after you sign in`,
            actions: [{ label: t`Sign in`, command: 'cloud.signin' }, openIt],
            forceToast: true,
          });
        }
        return;
      }
      notify.success({
        id: `ask:${result.conversation_id}`,
        title: t`Sent to ${to}`,
        ...(result.diagnosing ? { message: t`The diagnostic follows when it is ready.` } : {}),
        actions: [openIt],
      });
    } catch (e: unknown) {
      const message = errorMessage(e, t`Your request could not be saved.`);
      setError(message);
      notify.error({ title: t`Could not ask for help`, message, forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  // "Check first": run the Diagnose window on what was written. The request waits in the run, and
  // comes back here when it finishes.
  const checkFirst = () => {
    if (!what) return;
    useDiagnoseRunStore
      .getState()
      .start([title.trim(), notes.trim()].filter(Boolean).join('\n\n'), picker.files, null, {
        title: title.trim(),
        notes: notes.trim(),
        files: picker.files,
        person,
        desk: recipient?.kind === 'desk' ? recipient : null,
        origin,
        projectId,
        sessionTypeId,
      });
    useDiagnoseErrorStore.getState().watch();
    onOpenChange(false);
  };

  // While the request is being written, closing would throw away what was typed.
  const holdWhileBusy = (event: Event) => {
    if (busy) event.preventDefault();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!busy || next) && onOpenChange(next)}>
      <DialogContent
        ref={contentRef}
        className="max-w-lg"
        data-testid="ask-for-help-dialog"
        onEscapeKeyDown={holdWhileBusy}
        onInteractOutside={holdWhileBusy}
      >
        <DialogHeader>
          <DialogTitle>{t`Ask for help`}</DialogTitle>
          <DialogDescription>
            {person
              ? t`Creates a task, assigns it to them, and sends them a message with the details.`
              : t`Sends your question to a help desk — a person picks it up.`}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn('flex flex-col gap-3', picker.dragging && 'rounded-md ring-1 ring-primary')}
          {...picker.dragProps}
        >
          {note && (
            <p className="rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{note}</p>
          )}

          {myOpenRequests.length > 0 && (
            <div className="rounded border border-border" data-testid="ask-for-help-my-requests">
              <div className="px-2 pt-1.5 text-xs font-medium text-muted-foreground">{t`Your open requests`}</div>
              <div className="max-h-32 overflow-y-auto p-1">
                <HelpRequestList rows={myOpenRequests} onOpen={openRequest} />
              </div>
            </div>
          )}

          {!person && desks.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="ask-for-help-desks">
              {desks.map((d) => (
                <button
                  key={d.desk_project_id ?? 'nearest'}
                  type="button"
                  onClick={() => setDeskId(d.desk_project_id ?? null)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs',
                    d.desk_project_id === deskId
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground',
                  )}
                  data-testid={`ask-for-help-desk-${d.desk_project_id}`}
                >
                  {d.name ?? t`Help desk`}
                </button>
              ))}
            </div>
          )}
          {!person && recipients?.default_state === 'not_configured' && desks.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid="ask-for-help-no-desk">
              {t`This hub has no help desk — pick a person to ask.`}
            </p>
          )}

          <ContactPicker
            value={picked}
            onChange={setPicked}
            max={1}
            placeholder={desks.length ? t`Or pick a person, or type an email` : t`Pick a person or type an email`}
            testId="vibe-assign-person"
          />

          {alreadyAsked && onOpenExisting && (
            <p
              className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
              data-testid="vibe-assign-already-asked"
            >
              {t`You already asked ${person?.name || person?.email}: "${alreadyAsked.task.title}".`}{' '}
              <button
                type="button"
                className="text-primary underline"
                onClick={() => onOpenExisting(alreadyAsked)}
                data-testid="vibe-assign-open-existing"
              >
                {t`Open that conversation`}
              </button>
            </p>
          )}

          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t`What do you need help with?`}
            data-testid="vibe-assign-title"
          />

          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onPaste={handlePaste}
            placeholder={t`What happened, what you expected, what you already tried (optional)`}
            rows={4}
            className="resize-none"
            data-testid="vibe-assign-notes"
          />

          <PickedFileList
            files={picker.files}
            rejected={picker.rejected}
            disabled={busy}
            onRemoveAt={picker.removeAt}
          />

          <div className="flex items-center gap-2">
            <AttachFilesButton
              inputId={picker.inputId}
              onFiles={picker.addFiles}
              disabled={busy}
              title={t`Attach files or a screenshot (or paste one into the details)`}
              testId="vibe-assign-attach"
            />
            <label
              className="flex items-center gap-2 text-sm text-muted-foreground"
              title={
                diagnosisId
                  ? t`Sends the diagnosis you checked, with what was on your screen and your session's last turns.`
                  : t`Checks this machine's Flowpad (its health, the hub, recent errors in its logs) in the background and sends what it finds after your request, with what is on your screen and your session's last turns.`
              }
            >
              <input
                type="checkbox"
                checked={sendDiagnostic}
                onChange={(e) => setSendDiagnostic(e.target.checked)}
                disabled={busy}
                data-testid="ask-for-help-send-diagnostic"
              />
              {t`Send diagnostic (includes your screen and session)`}
            </label>
          </div>

          {error && (
            <p className="rounded border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-foreground">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t`Cancel`}
          </Button>
          {!diagnosisId && (
            <Button
              variant="outline"
              onClick={checkFirst}
              disabled={!what || busy || diagnoseRunning}
              title={t`Run a diagnosis first and read it. Nothing is sent until you choose to.`}
              data-testid="ask-for-help-check-first"
            >
              {t`Check first`}
            </Button>
          )}
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="vibe-assign-submit">
            {busy ? t`Saving…` : t`Ask`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
