import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { LifeBuoy, Paperclip, Stethoscope, X } from 'lucide-react';
import {
  askForHelp,
  type AskForHelpRequest,
  type AskForHelpResult,
  ConversationParticipant,
  type HelpContextItem,
  type HelpOrigin,
  type HelpRecipient,
  helpRecipients,
  type HelpRecipients,
  helpRequestPreview,
  normalizeEmail,
  TypeId,
} from '@sdk';
import { connectionManager } from '@sdk/websocket';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { ContentReviewDialog } from '@src/components/conversation/asset-review/ContentReviewDialog';
import {
  AttachFilesButton,
  PickedFileList,
  useAnnotatedImagePaste,
  usePickedFiles,
} from '@src/components/conversation/FileAttachmentPicker';
import { HelpdeskLoadDialog } from '@src/components/helpdesk/HelpdeskLoadDialog';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Textarea } from '@src/components/ui/textarea';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import type { VibeTaskRow } from '@src/hooks/use-my-vibe-tasks';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { navigateTo, notify } from '@src/notifications';
import { guardCloudAction } from '@src/services/privacy-guard';
import { describesAProblem } from './describes-a-problem';

/** A small toggle pill: Diagnosis, Context. */
const PILL = 'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground';

export interface AskForHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the person is — lists the request with it, and finds the project's own desk. */
  projectId: string | null;
  /** The session on screen — what the context says the person was in. */
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
  /** A diagnosis already taken: it is the one attached, nothing is diagnosed again. */
  diagnosisId?: string | null;
}

/**
 * Ask for help — the ONE dialog every surface opens. One screen, then it is just a conversation:
 * what is wrong (a pasted image attaches), Diagnosis / Context with Review (``ContentReviewDialog``
 * of exactly what would be attached), and Send to — the help desk (removable) and people. Nobody: a
 * private conversation that stays here, and the button reads Diagnose instead of Diagnose and Send.
 * The title is the server's (``_ticket_title`` of the text).
 *
 * The request is a conversation with ONE ``help_request`` message; its context rides as ordinary files.
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
  const [text, setText] = useState('');
  const [runDiagnosis, setRunDiagnosis] = useState(true);
  const [shareContext, setShareContext] = useState(true);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [review, setReview] = useState<HelpContextItem[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [picked, setPicked] = useState<ConversationParticipant[]>(initialPerson ? [initialPerson] : []);
  const [recipients, setRecipients] = useState<HelpRecipients | null>(null);
  const [deskId, setDeskId] = useState<string | null>(desk?.desk_project_id ?? null);
  const [deskOn, setDeskOn] = useState(true);
  const [showDesk, setShowDesk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request per dialog: a resubmit after a lost answer is the SAME request, never a second.
  const conversationId = useRef<string>(crypto.randomUUID());
  const picker = usePickedFiles({ enabled: true, disabled: busy });
  const handlePaste = useAnnotatedImagePaste(picker.addFiles, { enabled: !busy, setText });

  const { addFiles } = picker;
  useEffect(() => {
    if (initialFiles?.length) addFiles(initialFiles);
  }, [initialFiles, addFiles]);

  useEffect(() => {
    if (!open) return;
    setText([initialTitle, initialNotes].filter(Boolean).join('\n\n'));
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
  const deskChoice: HelpRecipient | null =
    desks.length || recipients?.default_state === 'unknown'
      ? { kind: 'desk', desk_project_id: deskId, name: desks.find((d) => d.desk_project_id === deskId)?.name ?? null }
      : null;
  const people: HelpRecipient[] = picked.map((p) => ({
    kind: 'person',
    email: p.email ?? null,
    user_id: p.user_id ?? null,
    name: p.name ?? null,
  }));
  const chosen = [...(deskOn && deskChoice ? [deskChoice] : []), ...people];
  const pickedEmail = normalizeEmail(picked[0]?.email);
  const alreadyAsked = pickedEmail
    ? openTasks.find((row) => normalizeEmail(row.task.assignee) === pickedEmail)
    : undefined;

  const request = (): AskForHelpRequest => ({
    conversation_id: conversationId.current,
    recipients: chosen,
    text: text.trim(),
    project_id: projectId,
    origin,
    diagnose: runDiagnosis && !diagnosisId,
    // The diagnosis is `flow diagnose`'s agent (minutes, reads the report), not the generic quick checks.
    purpose: 'repair',
    diagnosis_id: diagnosisId,
    share_context: shareContext,
    left_out: leftOut,
    send: 'when_diagnosed',
    process: sessionTypeId ? sessionTypeId.toString() : null,
    connection_id: connectionManager.id,
  });

  const openReview = async () => {
    setReviewing(true);
    try {
      const preview = await helpRequestPreview({ ...request(), left_out: [] });
      setReview(preview.items);
    } catch (e: unknown) {
      notify.error({ title: t`Could not collect the context`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setReviewing(false);
    }
  };

  const submit = async () => {
    if (!text.trim() || busy) return;
    if (chosen.length && !guardCloudAction('share')) return;
    setBusy(true);
    setError(null);
    try {
      const result = await askForHelp(request(), picker.files);
      const openIt = { label: t`Open`, href: DockPointer.forConversation(result.conversation_id).toUrl() };
      onOpenChange(false);
      onAsked?.(result);
      // The conversation is where the request lives from now on.
      navigateTo(DockPointer.forConversation(result.conversation_id).toUrl());
      if (result.delivery.failure?.kind === 'signed_out') {
        const gate = await ensureCloudLogin();
        if (!gate.ok) {
          notify.warning({
            id: `ask:${result.conversation_id}`,
            title: t`Saved — it will send after you sign in`,
            actions: [{ label: t`Sign in`, command: 'cloud.signin' }, openIt],
            forceToast: true,
          });
        }
      }
    } catch (e: unknown) {
      const message = errorMessage(e, t`Your request could not be saved.`);
      setError(message);
      notify.error({ title: t`Could not ask for help`, message, forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  const holdWhileBusy = (event: Event) => {
    if (busy) event.preventDefault();
  };
  const sendLabel = chosen.length ? t`Diagnose and Send` : t`Diagnose`;

  return (
    <>
      <Dialog open={open && !showDesk} onOpenChange={(next) => (!busy || next) && onOpenChange(next)}>
        <DialogContent
          className={cn('max-w-lg', picker.dragging && 'border-primary ring-1 ring-primary')}
          data-testid="ask-for-help-dialog"
          {...picker.dragProps}
          onEscapeKeyDown={holdWhileBusy}
          onInteractOutside={holdWhileBusy}
        >
          <DialogHeader>
            <DialogTitle>{t`Ask for help`}</DialogTitle>
            <DialogDescription className="sr-only">{t`What is wrong, what to attach, and who gets it`}</DialogDescription>
          </DialogHeader>

          {note && (
            <p className="rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{note}</p>
          )}

          <div className="flex flex-col gap-3" data-testid="ask-for-help-form">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={handlePaste}
              placeholder={t`What went wrong? What did you expect, and what did you already try? Paste a screenshot to attach it.`}
              rows={4}
              className="resize-none"
              autoFocus
              disabled={busy}
              data-testid="vibe-assign-notes"
            />
            {text.trim() && !describesAProblem(text) && (
              <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="ask-for-help-short-hint">
                <Trans>A few words about what went wrong help us look in the right place.</Trans>
              </p>
            )}
            <PickedFileList
              files={picker.files}
              rejected={picker.rejected}
              disabled={busy}
              onRemoveAt={picker.removeAt}
            />

            <div className="flex flex-wrap items-center gap-1.5">
              <label
                className={PILL}
                title={diagnosisId ? t`The one you already took` : t`Checks this computer when you send`}
              >
                <Stethoscope className="h-3 w-3" />
                {t`Diagnosis`}
                <input
                  type="checkbox"
                  checked={runDiagnosis}
                  onChange={(e) => setRunDiagnosis(e.target.checked)}
                  disabled={busy}
                  data-testid="ask-for-help-run-diagnosis"
                />
              </label>
              <label className={PILL} title={t`Your screen, session and diagnosis`}>
                <Paperclip className="h-3 w-3" />
                {t`Context`}
                <input
                  type="checkbox"
                  checked={shareContext}
                  onChange={(e) => setShareContext(e.target.checked)}
                  disabled={busy}
                  data-testid="ask-for-help-share-context"
                />
              </label>
              <button
                type="button"
                className="text-xs text-primary underline"
                onClick={() => void openReview()}
                disabled={reviewing || busy}
                data-testid="ask-for-help-review-content"
              >
                {reviewing ? t`Collecting…` : t`Review`}
              </button>
              <AttachFilesButton
                inputId={picker.inputId}
                onFiles={picker.addFiles}
                disabled={busy}
                title={t`Attach files or a screenshot`}
                testId="vibe-assign-attach"
              />
            </div>

            <div className="flex flex-col gap-1.5" data-testid="ask-for-help-send-to">
              <span className="text-xs text-muted-foreground">{t`Send to`}</span>
              {deskChoice && deskOn && (
                <div className="flex flex-wrap gap-1.5" data-testid="ask-for-help-desks">
                  {(desks.length ? desks : [deskChoice]).map((d) => (
                    <span
                      key={d.desk_project_id ?? 'nearest'}
                      className={cn(
                        'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
                        d.desk_project_id === deskId
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setDeskId(d.desk_project_id ?? null)}
                        data-testid={`ask-for-help-desk-${d.desk_project_id}`}
                      >
                        {d.desk_project_id === deskId ? '✓ ' : ''}
                        {d.name ?? t`Help desk`}
                      </button>
                      {d.desk_project_id === deskId && (
                        <button
                          type="button"
                          onClick={() => setDeskOn(false)}
                          aria-label={t`Remove the help desk`}
                          data-testid="ask-for-help-desk-remove"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {deskChoice && !deskOn && (
                <button
                  type="button"
                  className="self-start text-xs text-primary underline"
                  onClick={() => setDeskOn(true)}
                  data-testid="ask-for-help-desk-add"
                >
                  {t`Ask the help desk too`}
                </button>
              )}
              <ContactPicker
                value={picked}
                onChange={setPicked}
                placeholder={t`Add people — pick a person or type an email`}
                testId="vibe-assign-person"
              />
              {alreadyAsked && onOpenExisting && (
                <p
                  className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
                  data-testid="vibe-assign-already-asked"
                >
                  {t`You already asked ${picked[0]?.name || picked[0]?.email}: "${alreadyAsked.task.title}".`}{' '}
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
              {!chosen.length && (
                <p className="text-xs text-muted-foreground" data-testid="ask-for-help-private">
                  {t`Nobody picked: it stays a private conversation on this computer, with the diagnosis.`}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t`Asked before? Your open requests are in the help desk.`}</span>
              <button
                type="button"
                onClick={() => setShowDesk(true)}
                className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] text-violet-600 transition-colors hover:bg-accent hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
                title={t`Open the help desk`}
                aria-label={t`Help desk`}
                data-testid="ask-for-help-helpdesk-button"
              >
                <LifeBuoy className="h-3.5 w-3.5" />
                {t`Help desk`}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-foreground">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t`Cancel`}
            </Button>
            <Button onClick={() => void submit()} disabled={busy || !text.trim()} data-testid="vibe-assign-submit">
              {busy ? t`Diagnosing…` : sendLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {review && (
        <ContentReviewDialog
          open={!!review}
          onClose={() => setReview(null)}
          items={review}
          leftOut={leftOut}
          onLeftOutChange={setLeftOut}
          onShare={() => setShareContext(true)}
        />
      )}

      <HelpdeskLoadDialog
        open={showDesk}
        onClose={() => {
          setShowDesk(false);
          onOpenChange(false);
        }}
        onNoPortal={() => setShowDesk(false)}
      />
    </>
  );
}
