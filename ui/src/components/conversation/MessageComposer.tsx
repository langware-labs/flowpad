import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Boxes, File as FileIcon, MessagesSquare, MonitorPlay, Paperclip, Send, Smile, Trash2, X } from 'lucide-react';
import type { AssetDescriptor, FlowMessage } from '@sdk';
import type { TaskableMessage } from '@sdk/entities/task';
import { sendReply, sendToChannel } from '@sdk/entities/notifications';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { AssetManagerPopover } from '@src/components/asset-manager/AssetManagerPopover';
import { MAX_FILE_SIZE_LABEL } from './constants';
import { AssetRefChips, useAssetRefSelection } from './AttachMenu';
import { mergePickedFiles } from './FileAttachmentPicker';
import { EmojiPicker } from './EmojiPicker';
import { buildSessionStartExtras, type SessionHost } from './session-start';
import { useLocalUser } from './useLocalUser';
import { TaskItIcon, taskItHint } from './task-it';
import { useScrollToLatest } from './LatestScroll';
import { discardDraftFlowMessage } from './flow-message-drafts';
import { imageFilesFromClipboardData, isImageFile } from '@src/utils/clipboard-image';
import { annotateImageFiles } from '@src/components/image-annotator/annotate-files';
import { Trans, useLingui } from '@lingui/react/macro';

interface MessageComposerProps {
  /** Conversation to append to. Falls back to the draft's `conversation_id`. */
  conversationId?: string;
  disabled?: boolean;
  /** Overrides the reply placeholder. Used when the composer is gated, so the
   *  box explains why instead of inviting a reply that goes nowhere. */
  placeholder?: string;
  /** When set, this conversation caches a cloud thread and Send pushes the
   *  reply back into that channel instead of the hub. */
  channel?: string;
  /** Agent scope required by channel reply authorization. */
  agentId?: string;
  /** Fires when a channel send is accepted (dispatched, not delivered). */
  onChannelSent?: (text: string) => void;
  /** Live-session composer: every send is a follow-up turn stamped with this
   *  session id (the backend appends the snapshot-carrier attachment). Set by
   *  LiveSessionView; the plain conversation composer leaves it unset. */
  liveSessionId?: string;
  /** The participant whose machine a prompt runs on. When set (with
   *  `onStartLiveSession`), the composer offers the live-session icon. Null = plain chat box. */
  sessionHost?: SessionHost | null;
  /** The live-session icon: open the conversation's live session (starting one
   *  if none is open) — the caller navigates to it. */
  onStartLiveSession?: () => void;
  /** `terminal`: the live-session view's input — a mono prompt line (`❯`) whose
   *  sends run on the other machine. */
  variant?: 'chat' | 'terminal';
  /** Put the cursor in the box on mount (the session view waiting for a prompt). */
  autoFocus?: boolean;
  /** Fires after a successful send (fresh reply OR draft promoted to a reply). */
  onSent?: () => void;
  /**
   * Draft mode. When set, this composer edits an existing local-only draft
   * `FlowMessage` (e.g. a headless agent-drafted reply): it auto-saves edits,
   * renders as a "Draft" bubble with a Discard action, and on Send discards
   * the draft then ships through the same `sendReply` path as a fresh reply.
   * When omitted, it's the regular bottom-of-conversation reply box.
   */
  draft?: FlowMessage | null;
  /** Draft mode only — fires after a successful discard. */
  onAfterDiscard?: () => void;
  /** A channel send can carry files (`ChannelSpec.accepts_attachments`): the paperclip is live. */
  channelAcceptsFiles?: boolean;
  /** The message the next send answers (it quotes it and joins its thread); `inThread` when the
   *  channel's replies only thread. */
  replyTo?: { id: string; sender: string; text: string; inThread?: boolean } | null;
  /** Dismiss the reply banner (and fires after a send that answered it). */
  onClearReply?: () => void;
  /** The thread this composer writes into (a `?thread=` view). A send with no explicit `replyTo`
   *  lands in it: `rootId` joins a native thread without quoting; `answerId` answers a channel
   *  thread's newest message, which is how an email/Slack reply finds its thread. */
  threadTarget?: { title: string; rootId?: string | null; answerId?: string | null } | null;
  /** "Task it" on send: when set, the composer offers a toggle; a send with it on hands the sent
   *  message here (the same call the bubble's Task it makes). Plain conversation sends only. */
  onTaskIt?: (sent: TaskableMessage) => void;
}

const SAVE_DEBOUNCE_MS = 400;

/** Ceiling for the auto-growing composer (~10 lines of text). Past this the
 *  textarea scrolls instead of eating the conversation above it. */
const MAX_COMPOSER_HEIGHT_PX = 240;

/** The flat icon buttons of the attach row (file, asset, emoji, live session). */
const ICON_BUTTON_CLASS =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PendingFileChip({ file, disabled, onRemove }: { file: File; disabled?: boolean; onRemove: () => void }) {
  const { t } = useLingui();
  const image = isImageFile(file);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!image || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, image]);

  // Image rows show a thumbnail (or a fallback icon while the object URL warms
  // up); non-image rows show a small inline icon. The name/size and the remove
  // button are identical for both — only the leading visual and spacing vary.
  return (
    <li
      className={`flex items-center gap-2 rounded border border-input bg-muted/40 text-xs ${
        image ? 'p-1.5' : 'px-2 py-1'
      }`}
    >
      {image ? (
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-background">
          {previewUrl ? (
            <img src={previewUrl} alt={file.name} className="h-full w-full object-contain" />
          ) : (
            <FileIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
      ) : (
        <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <div className={`flex min-w-0 flex-1 ${image ? 'flex-col gap-0.5' : 'items-center gap-2'}`}>
        <span className="flex-1 truncate text-foreground" title={file.name}>
          {file.name}
        </span>
        <span className="shrink-0 text-muted-foreground">{formatSize(file.size)}</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title={t`Remove attachment`}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:pointer-events-none"
      >
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}

/**
 * The single conversation composer. Two modes share one implementation
 * (attach File / Asset / Repo, the session-start toggle, and the `sendReply`
 * send path): the regular reply box, and — when `draft` is supplied — an
 * editable draft bubble. This is the one place the conversation attaches assets, so a
 * feature added here (e.g. Attach Repo) reaches every send surface.
 */
export function MessageComposer({
  conversationId,
  disabled,
  placeholder,
  channel,
  agentId,
  onChannelSent,
  liveSessionId,
  sessionHost,
  onStartLiveSession,
  variant = 'chat',
  autoFocus = false,
  onSent,
  draft,
  onAfterDiscard,
  channelAcceptsFiles = false,
  replyTo = null,
  onClearReply,
  threadTarget = null,
  onTaskIt,
}: MessageComposerProps) {
  const { t } = useLingui();
  const ensureCloudLogin = useCloudLoginGate();
  const { localUser } = useLocalUser();
  const scrollToLatest = useScrollToLatest();
  const isDraftMode = !!draft;
  const effectiveConversationId = conversationId ?? draft?.conversation_id ?? undefined;

  const [text, setText] = useState(draft?.text ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [assetRefs, setAssetRefs] = useState<AssetDescriptor[]>([]);
  // "Task it" on send: the next send also becomes a task. One send's worth — resets after it.
  const [taskItOn, setTaskItOn] = useState(false);
  const [sending, setSending] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // The session-start control lives on the plain conversation composer only:
  // inside a session view every send is already a turn of that session.
  const canStartSession = !!sessionHost && !!onStartLiveSession && !liveSessionId && !isDraftMode;
  const terminal = variant === 'terminal';
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);
  const isBusy = sending || discarding;
  const isDisabled = disabled || isBusy;
  // A channel carries files only when its spec says so — offering the paperclip anywhere else would
  // invite an attachment the channel refuses. Assets are Flowpad's own: never through a channel.
  const attachmentsDisabled = isDisabled || (!!channel && !channelAcceptsFiles);
  const assetsDisabled = isDisabled || !!channel;

  // Auto-grow the composer to fit what's been typed so far — wrapped lines
  // count, not just explicit newlines — up to MAX_COMPOSER_HEIGHT_PX, after
  // which it scrolls. Height must be reset to 'auto' first so scrollHeight
  // reports the content height rather than the current (larger) box.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
  }, [text, isDraftMode]);

  // Draft auto-save: persist edits into the FlowMessage so a reload doesn't
  // lose them. No-op outside draft mode.
  const lastSavedRef = useRef(draft?.text ?? '');
  useEffect(() => {
    if (!draft) return;
    if (text === lastSavedRef.current) return;
    const handle = setTimeout(() => {
      if (text === lastSavedRef.current) return;
      draft.text = text;
      lastSavedRef.current = text;
      void draft.save().catch((err) => {
        console.error('[MessageComposer] draft auto-save failed', err);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text, draft]);

  // A send asked for in the same update as the text/files it sends: `send` reads
  // both from its render, so it must run in the render that already has them.
  const [sendQueued, setSendQueued] = useState(false);

  // Paste, drop and the picker all land here. Images go through the annotator
  // first (markup + caption); `initialCaption` prefills the caption with text
  // that came on the clipboard. The caption IS the message: with nothing typed
  // yet it is sent straight away with the image (WhatsApp-style); otherwise it
  // is inserted at the caret, `caret` captured before the dialog took focus.
  const addFiles = async (
    incoming: FileList | File[] | null,
    { initialCaption, caret }: { initialCaption?: string; caret?: { start: number; end: number } } = {},
  ): Promise<void> => {
    if (!incoming) return;
    // Offer markup on captured images before attaching. Size cap is applied
    // after annotation since the flattened PNG may be larger than the original.
    const { files: annotated, caption } = await annotateImageFiles(Array.from(incoming), { initialCaption });
    if (annotated.length === 0) return; // markup cancelled → do nothing
    // Size is a property of each file alone, so what gets rejected is known up front; the
    // functional update still merges into the LATEST selection (dedup against it).
    const { rejectedNames: tooBig } = mergePickedFiles([], annotated);
    setFiles((prev) => mergePickedFiles(prev, annotated).files);
    setError(
      tooBig.length === 0
        ? null
        : tooBig.length === 1
          ? t`"${tooBig[0]}" is over ${MAX_FILE_SIZE_LABEL} and was not attached.`
          : t`${tooBig.length} files over ${MAX_FILE_SIZE_LABEL} were not attached: ${tooBig.join(', ')}.`,
    );
    const nothingTyped = !(textareaRef.current?.value ?? text).trim();
    if (caption && nothingTyped && !isDraftMode && !isDisabled && tooBig.length < annotated.length) {
      setText(caption);
      setSendQueued(true);
      return;
    }
    if (caption) {
      insertAtCaret(caption, caret);
      return;
    }
    // Back to the text: the annotator dialog took focus and hands it to <body> on close, so
    // whatever attached the file — paste, drop, the picker — the next keystroke goes to the reply.
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  // Put `insert` at the caret — or over `range`, a selection captured before a dialog took
  // focus — then restore the caret just after it so typing continues without re-clicking.
  // With no textarea mounted it appends.
  const insertAtCaret = (insert: string, range?: { start: number; end: number }) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setText((prev) => prev + insert);
      return;
    }
    const value = textarea.value;
    const start = range?.start ?? textarea.selectionStart ?? value.length;
    const end = range?.end ?? textarea.selectionEnd ?? start;
    setText(`${value.slice(0, start)}${insert}${value.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + insert.length;
    });
  };

  const assetSelection = useAssetRefSelection(assetRefs, setAssetRefs);

  const send = async () => {
    if (isBusy) return;
    const trimmed = text.trim();
    if (!trimmed && files.length === 0 && assetRefs.length === 0) {
      return;
    }
    // Inside a session view every send is a prompt: it rides as a PROMPT
    // attachment (the host's gate keys on it; the backend synthesizes the body).
    const isPromptSend = !!trimmed && !!liveSessionId;
    const messageBody = isPromptSend ? '' : trimmed;
    const outgoingFiles = isPromptSend ? undefined : files.length > 0 ? files : undefined;
    const extras: NonNullable<Parameters<typeof sendReply>[3]> = isPromptSend
      ? buildSessionStartExtras({
          text: trimmed,
          files,
          sessionId: liveSessionId ?? null,
        })
      : {};
    // Assets (skill/agent/markdown/spec) ride as assetReferences.
    if (assetSelection.selectedTypeIds.length > 0) {
      extras.assetReferences = assetSelection.selectedTypeIds;
    }
    // The message this send answers: the one the user picked, else the thread this view writes into.
    const answering = replyTo?.id || threadTarget?.answerId || null;
    setSending(true);
    setError(null);

    try {
      // Both sends are conversation-scoped; `sendReply` itself throws on a
      // missing id, so this hoists that same failure ahead of the branch and
      // lets both calls take a real string.
      if (!effectiveConversationId) {
        throw new Error('sendReply requires a conversationId');
      }
      if (channel) {
        // A channel reply never touches the hub, so it must not drag the user
        // through a Flowpad-Cloud login to send an email. Branch on the CALL
        // only — an early return here would have to restate the cleanup below,
        // and the first version of it restated one quarter of it.
        await sendToChannel(effectiveConversationId, messageBody, agentId, {
          replyToId: answering,
          files: files.length > 0 ? files : undefined,
        });
        onChannelSent?.(messageBody || files.map((f) => f.name).join(', '));
        if (replyTo) onClearReply?.();
      } else {
        // Cloud reply needs an authenticated hub token; otherwise the hub POST
        // 401s and the send fails silently. Route through OAuth first.
        const gate = await ensureCloudLogin();
        if (!gate.ok) {
          setError(gate.error);
          if (isDraftMode) notify.error({ title: gate.error });
          return;
        }
        if (draft?.remote_worker_session_id) {
          // A session reply held for review: promote the ROW (backend
          // `send-draft`), so its prompt_completion attachment and session id
          // travel with it and it lands in the guest's session view. Discard +
          // resend would strip both and drop the text into the thread.
          if (draft.text !== text) {
            draft.text = text;
            await draft.save();
          }
          await draft.sendDraft();
        } else {
          // Draft promotion: discard the local-only draft, then send through the
          // SAME reply pipeline as a fresh send. Single code path beats forking
          // the upload/push plumbing for drafts.
          if (draft) await discardDraftFlowMessage(draft);
          if (!isPromptSend) {
            if (answering) extras.replyToId = answering;
            else if (threadTarget?.rootId) extras.threadRootId = threadTarget.rootId;
          }
          const sent = await sendReply(
            { conversationId: effectiveConversationId },
            messageBody,
            outgoingFiles,
            Object.keys(extras).length > 0 ? extras : undefined,
          );
          if (replyTo) onClearReply?.();
          if (taskItOn && sent.id) {
            onTaskIt?.({
              id: sent.id,
              text: messageBody,
              conversation_id: effectiveConversationId,
              sender_name: localUser?.name ?? null,
            });
          }
        }
      }
      if (!isDraftMode) {
        setText('');
        setFiles([]);
        setAssetRefs([]);
        setTaskItOn(false);
      }
      // Your own send always brings you to the latest, even if you had scrolled up.
      scrollToLatest?.();
      if (!channel) onSent?.();
    } catch (err: unknown) {
      console.error('[MessageComposer] send failed', err);
      setError(err instanceof Error ? err.message : t`Failed to send reply.`);
      if (isDraftMode) notify.error({ title: t`Failed to send draft` });
    } finally {
      setSending(false);
    }
  };

  // The box is disabled while sending, which drops its focus. Once the send settles (and the box
  // is enabled again — hence an effect, after the commit), hand focus back so the next message or a
  // retry is typed straight away. A draft bubble goes away on send, so it is skipped.
  const wasSending = useRef(false);
  useEffect(() => {
    // Only from <body>: if focus moved elsewhere during a slow send, leave it there.
    const dropped = document.activeElement === document.body;
    if (wasSending.current && !sending && !isDraftMode && dropped) textareaRef.current?.focus();
    wasSending.current = sending;
  }, [sending, isDraftMode]);

  const handleSend = () => void send();

  useEffect(() => {
    if (!sendQueued) return;
    setSendQueued(false);
    void send();
    // `send` is this render's — the one holding the queued text and files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendQueued]);

  const handleDiscard = async () => {
    if (!draft || isBusy) return;
    if (!window.confirm(t`Discard this draft?`)) return;
    setDiscarding(true);
    try {
      await discardDraftFlowMessage(draft);
      onAfterDiscard?.();
    } catch (err: unknown) {
      console.error('[MessageComposer] discard failed', err);
      notify.error({ title: t`Failed to discard draft` });
    } finally {
      setDiscarding(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isDisabled) setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!isDisabled) void addFiles(e.dataTransfer.files);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isDisabled) return;
    const pastedImages = imageFilesFromClipboardData(e.clipboardData);
    if (pastedImages.length === 0) return;

    e.preventDefault();

    // Capture everything off the (pooled) event synchronously — the annotator
    // popup is awaited below and `e` is unusable after the first await. Text
    // that came with the image prefills the caption; if the markup is
    // cancelled, nothing lands — not even that text.
    const textarea = e.currentTarget;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    await addFiles(pastedImages, { initialCaption: e.clipboardData.getData('text/plain'), caret: { start, end } });
  };

  const canSend = (!!text.trim() || files.length > 0 || assetRefs.length > 0) && !isDisabled;

  // ── Shared building blocks (identical in both modes) ────────────────────

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="sr-only"
      disabled={attachmentsDisabled}
      onChange={(e) => {
        void addFiles(e.target.files);
        e.target.value = '';
      }}
    />
  );

  /** File / Asset / Repo — flat buttons, each opening a self-contained surface
   *  (no nested popovers). This is the attach row both modes render. */
  const attachButtons = (
    <>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={attachmentsDisabled}
        title={t`Attach files`}
        data-testid="attach-file-button"
        className={ICON_BUTTON_CLASS}
      >
        <Paperclip className="h-3.5 w-3.5" />
      </button>
      <AssetManagerPopover
        trigger={
          <button
            type="button"
            disabled={assetsDisabled}
            title={t`Attach an asset (skill, agent, doc, spec)`}
            data-testid="attach-asset-button"
            className={ICON_BUTTON_CLASS}
          >
            <Boxes className="h-3.5 w-3.5" />
          </button>
        }
        {...assetSelection}
        side="top"
        searchPlaceholder={t`Search assets…`}
      />
      <EmojiPicker
        side="top"
        onPick={insertAtCaret}
        trigger={
          <button
            type="button"
            disabled={isDisabled}
            title={t`Insert emoji`}
            data-testid="insert-emoji-button"
            className={ICON_BUTTON_CLASS}
          >
            <Smile className="h-3.5 w-3.5" />
          </button>
        }
      />
    </>
  );

  /** The live-session icon: opens the conversation's live session (starting one when none is
   *  open) — the turns are typed in the session view, never in this box. */
  const hostName = sessionHost?.name?.trim() || t`the other participant`;
  const sessionToggle = canStartSession ? (
    <button
      type="button"
      onClick={() => onStartLiveSession?.()}
      disabled={isDisabled}
      title={
        sessionHost?.hasOpenSession
          ? t`Open the live session on ${hostName}'s machine`
          : t`Start a live session on ${hostName}'s machine`
      }
      data-testid="composer-session-toggle"
      className={cn(
        ICON_BUTTON_CLASS,
        sessionHost?.hasOpenSession && 'text-emerald-700 hover:text-emerald-700 dark:text-emerald-300',
      )}
    >
      <MonitorPlay className="h-3.5 w-3.5" />
    </button>
  ) : null;

  // Offered on the plain reply box only: a channel send returns no message id, a prompt is a run.
  const canTaskIt = !!onTaskIt && !channel && !isDraftMode && !liveSessionId;
  const taskItToggle = canTaskIt ? (
    <button
      type="button"
      onClick={() => setTaskItOn((on) => !on)}
      disabled={isDisabled}
      aria-pressed={taskItOn}
      title={taskItOn ? t`This message will also become a task` : taskItHint()}
      data-testid="composer-task-it"
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs transition-colors disabled:opacity-40',
        taskItOn
          ? 'border border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <TaskItIcon className="h-3.5 w-3.5" />
      {taskItOn && <Trans>Task</Trans>}
    </button>
  ) : null;

  const sendButton = (
    <button
      type="button"
      onClick={handleSend}
      disabled={!canSend}
      title={t`Send`}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
    >
      <Send className="h-3.5 w-3.5 rtl:-scale-x-100" />
    </button>
  );

  const chipLists = (
    <>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <PendingFileChip key={`${f.name}-${i}`} file={f} disabled={isDisabled} onRemove={() => removeFile(i)} />
          ))}
        </ul>
      )}
      <AssetRefChips assetRefs={assetRefs} onChange={setAssetRefs} disabled={isDisabled} />
    </>
  );

  // ── Draft mode: editable "Draft" bubble with Discard + Send ─────────────

  if (isDraftMode) {
    const senderName = draft?.sender_name?.trim() || (localUser?.name ?? 'You');
    const initial = (senderName.trim()[0] ?? '?').toUpperCase();
    return (
      <div className="flex gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-xs font-semibold text-white">
          {initial}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border border-dashed border-border bg-muted/20 p-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{senderName}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Trans>Draft</Trans>
            </span>
          </div>

          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              'flex flex-col gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 transition-colors focus-within:border-primary/50',
              dragging && 'border-primary bg-primary/5',
            )}
          >
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(e) => void handlePaste(e)}
              placeholder={dragging ? t`Drop files here` : t`Edit your draft…`}
              rows={2}
              disabled={isDisabled}
              className="min-h-[2.5rem] w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="flex items-center gap-1.5">
              {attachButtons}
              <div className="ms-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleDiscard()}
                  disabled={isDisabled}
                  title={t`Discard draft`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                {sendButton}
              </div>
            </div>
          </div>

          {chipLists}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {hiddenFileInput}
        </div>
      </div>
    );
  }

  // ── Regular reply box ───────────────────────────────────────────────────

  return (
    <div className="space-y-1.5">
      {!replyTo && threadTarget && (
        <div
          className="flex items-center gap-2 rounded border-s-2 border-primary/40 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
          data-testid="composer-thread-banner"
        >
          <MessagesSquare className="h-3 w-3 shrink-0" />
          <span className="line-clamp-1 break-words">
            <Trans>In thread</Trans> · {threadTarget.title || t`Thread`}
          </span>
        </div>
      )}
      {replyTo && (
        <div
          className="flex items-start gap-2 rounded border-s-2 border-primary/60 bg-muted/40 px-2 py-1 text-xs"
          data-testid="composer-reply-banner"
        >
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-primary/80">
              {replyTo.inThread ? t`Replying in the thread of ${replyTo.sender}` : t`Replying to ${replyTo.sender}`}
            </span>
            <span className="line-clamp-1 break-words text-muted-foreground">{replyTo.text || t`(a file)`}</span>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            title={t`Cancel reply`}
            aria-label={t`Cancel reply`}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-variant={variant}
        className={cn(
          'flex items-end gap-2 rounded-md border px-2 py-1.5 transition-colors',
          terminal
            ? 'border-emerald-500/40 bg-zinc-950 font-mono text-zinc-100 focus-within:border-emerald-400/70'
            : 'border-border bg-background focus-within:border-primary/50',
          dragging && 'border-primary bg-primary/5',
        )}
      >
        <div className="flex shrink-0 items-center gap-1.5 self-end pb-0.5">
          {attachButtons}
          {sessionToggle}
        </div>
        {terminal && (
          <span className="select-none self-center text-sm text-emerald-400" aria-hidden>
            ❯
          </span>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(e) => void handlePaste(e)}
          placeholder={dragging ? t`Drop files here` : (placeholder ?? t`Reply to sender…`)}
          rows={1}
          disabled={isDisabled}
          data-testid={terminal ? 'live-session-input' : undefined}
          className={cn(
            'min-h-[1.5rem] flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50',
            terminal
              ? 'font-mono text-zinc-100 placeholder:text-zinc-500'
              : 'text-foreground placeholder:text-muted-foreground',
          )}
        />
        {taskItToggle}
        {sendButton}
      </div>

      {chipLists}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {hiddenFileInput}
    </div>
  );
}
