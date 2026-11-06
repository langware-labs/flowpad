import { useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
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
  type HelpSend,
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

type Step = 1 | 2 | 3;

/**
 * Ask for help — the ONE dialog every surface opens. Three cards, then it is just a conversation:
 *
 * 1. What is wrong — one box. The Help desk chip (the footer's, moved here) opens the help desk.
 * 2. Diagnosis & context — Run diagnosis, Share context, and Review content: the message review
 *    (``ContentReviewDialog``) of exactly what would be attached.
 * 3. Who gets it — the title (written for you), the help desk (removable), people. Nobody: a private
 *    conversation that stays here. Review before sending keeps it here until Share.
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
  const [step, setStep] = useState<Step>(1);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
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
  const [busy, setBusy] = useState<HelpSend | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One request per dialog: a resubmit after a lost answer is the SAME request, never a second.
  const conversationId = useRef<string>(crypto.randomUUID());
  const picker = usePickedFiles({ enabled: true, disabled: !!busy });
  const handlePaste = useAnnotatedImagePaste(picker.addFiles, { enabled: !busy, setText });

  const { addFiles } = picker;
  useEffect(() => {
    if (initialFiles?.length) addFiles(initialFiles);
  }, [initialFiles, addFiles]);

  useEffect(() => {
    if (!open) return;
    setStep(1);
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

  const request = (send: HelpSend): AskForHelpRequest => ({
    conversation_id: conversationId.current,
    recipients: chosen,
    title: title.trim(),
    text: text.trim(),
    project_id: projectId,
    origin,
    diagnose: runDiagnosis && !diagnosisId,
    diagnosis_id: diagnosisId,
    share_context: shareContext,
    left_out: leftOut,
    send,
    process: sessionTypeId ? sessionTypeId.toString() : null,
    connection_id: connectionManager.id,
  });

  const toCard3 = () => {
    setStep(3);
    // The title is written for the person (a small, fast model; the first line when none answers).
    void helpRequestPreview({ ...request('when_diagnosed'), diagnose: false })
      .then((p) => setTitle((current) => current || p.title))
      .catch(() => setTitle((current) => current || text.trim().split('\n')[0].slice(0, 80)));
  };

  const openReview = async () => {
    setReviewing(true);
    try {
      const preview = await helpRequestPreview({ ...request('when_diagnosed'), left_out: [] });
      setReview(preview.items);
    } catch (e: unknown) {
      notify.error({ title: t`Could not collect the context`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setReviewing(false);
    }
  };

  const submit = async (send: HelpSend) => {
    if (!text.trim() || busy) return;
    if (send === 'when_diagnosed' && chosen.length && !guardCloudAction('share')) return;
    setBusy(send);
    setError(null);
    try {
      const result = await askForHelp(request(send), picker.files);
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
      setBusy(null);
    }
  };

  const holdWhileBusy = (event: Event) => {
    if (busy) event.preventDefault();
  };
  const steps = [t`What is wrong`, t`Diagnosis & context`, t`Who gets it`];

  return (
    <>
      <Dialog open={open && !showDesk} onOpenChange={(next) => (!busy || next) && onOpenChange(next)}>
        <DialogContent
          className="max-w-lg"
          data-testid="ask-for-help-dialog"
          data-step={step}
          onEscapeKeyDown={holdWhileBusy}
          onInteractOutside={holdWhileBusy}
        >
          <DialogHeader>
            <DialogTitle>{t`Ask for help`}</DialogTitle>
            <DialogDescription className="sr-only">{steps[step - 1]}</DialogDescription>
          </DialogHeader>

          <ol className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="ask-for-help-steps">
            {steps.map((label, i) => (
              <li key={label} className={cn('flex items-center gap-1.5', i + 1 === step && 'font-medium text-foreground')}>
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full border text-[10px]',
                    i + 1 <= step && 'border-primary bg-primary/10 text-primary',
                  )}
                >
                  {i + 1}
                </span>
                {label}
                {i < 2 && <span className="h-px w-4 bg-border" />}
              </li>
            ))}
          </ol>

          {note && (
            <p className="rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{note}</p>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-3" data-testid="ask-for-help-card-what">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={handlePaste}
                placeholder={t`What went wrong? What did you expect, and what did you already try?`}
                rows={5}
                className="resize-none"
                autoFocus
                data-testid="vibe-assign-notes"
              />
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
          )}

          {step === 2 && (
            <div className="flex flex-col gap-2" data-testid="ask-for-help-card-context">
              <label className="flex items-center gap-3 rounded-md border px-3 py-2.5">
                <Stethoscope className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{diagnosisId ? t`Attach the diagnosis` : t`Run diagnosis`}</span>
                  <span className="block text-xs text-muted-foreground">
                    {diagnosisId ? t`The one you already took` : t`Checks this computer when you send`}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={runDiagnosis}
                  onChange={(e) => setRunDiagnosis(e.target.checked)}
                  data-testid="ask-for-help-run-diagnosis"
                />
              </label>
              <label className="flex items-center gap-3 rounded-md border px-3 py-2.5">
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{t`Share context`}</span>
                  <span className="block text-xs text-muted-foreground">{t`Your screen, session and diagnosis`}</span>
                </span>
                <button
                  type="button"
                  className="rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-xs"
                  onClick={(e) => {
                    e.preventDefault();
                    void openReview();
                  }}
                  disabled={reviewing}
                  data-testid="ask-for-help-review-content"
                >
                  {reviewing ? t`Collecting…` : t`Review content`}
                </button>
                <input
                  type="checkbox"
                  checked={shareContext}
                  onChange={(e) => setShareContext(e.target.checked)}
                  data-testid="ask-for-help-share-context"
                />
              </label>
              <PickedFileList
                files={picker.files}
                rejected={picker.rejected}
                disabled={!!busy}
                onRemoveAt={picker.removeAt}
              />
              <div>
                <AttachFilesButton
                  inputId={picker.inputId}
                  onFiles={picker.addFiles}
                  disabled={!!busy}
                  title={t`Attach files or a screenshot`}
                  testId="vibe-assign-attach"
                />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-3" data-testid="ask-for-help-card-who">
              <div className="rounded-md border p-2 text-sm">
                <span className="text-xs text-muted-foreground">{t`Title`}</span>
                <div data-testid="ask-for-help-title">{title || '…'}</div>
              </div>
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
          )}

          {error && (
            <p className="rounded border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-foreground">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-2">
            {step === 1 ? (
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busy}>
                {t`Cancel`}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setStep((s) => (s - 1) as Step)}
                disabled={!!busy}
                data-testid="ask-for-help-back"
              >
                {t`Back`}
              </Button>
            )}
            {step === 1 && (
              <Button onClick={() => setStep(2)} disabled={!text.trim()} data-testid="ask-for-help-next">
                {t`Next`}
              </Button>
            )}
            {step === 2 && (
              <Button onClick={toCard3} data-testid="ask-for-help-next">
                {t`Next`}
              </Button>
            )}
            {step === 3 && (
              <span className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void submit('review_first')}
                  disabled={!!busy}
                  data-testid="ask-for-help-review-first"
                >
                  {busy === 'review_first' ? t`Saving…` : t`Review before sending`}
                </Button>
                <Button
                  onClick={() => void submit('when_diagnosed')}
                  disabled={!!busy}
                  data-testid="vibe-assign-submit"
                >
                  {busy === 'when_diagnosed'
                    ? t`Diagnosing…`
                    : chosen.length
                      ? t`Send once diagnosed`
                      : t`Save`}
                </Button>
              </span>
            )}
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
