import { useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, File as FileIcon, MessageSquarePlus, Paperclip, Send, Smile, Trash2, X } from 'lucide-react';
import type { AssetDescriptor, FlowMessage } from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { AssetPickerPopover } from '@src/components/asset-manager/AssetPickerPopover';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from './constants';
import { AssetRefChips } from './AttachMenu';
import { EmojiPicker } from './EmojiPicker';
import { PromptComposerDialog, type QueuedPrompt } from './PromptComposerDialog';
import { AttachmentActionsRow, PromptAttachmentPreview, useAttachmentActions } from './attachment-actions';
import { useLocalUser } from './useLocalUser';
import { discardDraftFlowMessage } from './flow-message-drafts';
import { imageFilesFromClipboardData, isImageFile } from '@src/utils/clipboard-image';
import { annotateImageFiles } from '@src/components/image-annotator/annotate-files';
import { Trans, useLingui } from '@lingui/react/macro';

interface MessageComposerProps {
  /** Conversation to append to. Falls back to the draft's `conversation_id`. */
  conversationId?: string;
  disabled?: boolean;
  /** Live-session composer: every send is stamped with this session id (the
   *  backend appends the snapshot-carrier attachment). Set by LiveSessionView;
   *  the plain conversation composer leaves it unset. */
  liveSessionId?: string;
  /** Fires after a successful send (fresh reply OR draft promoted to a reply). */
  onSent?: () => void;
  /** Optional queued prompt provided by per-message Add-prompt chips. */
  queuedPrompt?: QueuedPrompt | null;
  /** Update / clear the externally-queued prompt. */
  onQueuedPromptChange?: (prompt: QueuedPrompt | null) => void;
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
}

const SAVE_DEBOUNCE_MS = 400;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PendingFileChip({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled?: boolean;
  onRemove: () => void;
}) {
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
 * (attach File / Asset / Repo, prompt suggestion, and the `sendReply` send
 * path): the regular reply box, and — when `draft` is supplied — an editable
 * draft bubble. This is the one place the conversation attaches assets, so a
 * feature added here (e.g. Attach Repo) reaches every send surface.
 */
export function MessageComposer({
  conversationId,
  disabled,
  liveSessionId,
  onSent,
  queuedPrompt,
  onQueuedPromptChange,
  draft,
  onAfterDiscard,
}: MessageComposerProps) {
  const { t } = useLingui();
  const ensureCloudLogin = useCloudLoginGate();
  const { localUser } = useLocalUser();
  const isDraftMode = !!draft;
  const effectiveConversationId = conversationId ?? draft?.conversation_id ?? undefined;

  const [text, setText] = useState(draft?.text ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [assetRefs, setAssetRefs] = useState<AssetDescriptor[]>([]);
  const [localPrompt, setLocalPrompt] = useState<QueuedPrompt | null>(null);
  const [showPromptDialog, setShowPromptDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // "Suggest prompt" is the legacy relay affordance (attach a prompt for the
  // other user to approve). In a live session the composer text IS the prompt
  // that runs on the host, so the button is redundant — hide it there.
  const canAddPrompt = !!effectiveConversationId && !liveSessionId;
  const isBusy = sending || discarding;
  const isDisabled = disabled || isBusy;

  const activePrompt = queuedPrompt ?? localPrompt;
  const setActivePrompt = (p: QueuedPrompt | null) => {
    if (onQueuedPromptChange) onQueuedPromptChange(p);
    else setLocalPrompt(p);
  };

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

  // Synthesise PROMPT-shaped attachments so the preview reuses
  // PromptAttachmentPreview (legacy shape is fine — the send path mints the
  // real Prompt entity server-side).
  const queuedPromptAttachments: Attachment[] = useMemo(() => {
    if (!activePrompt) return [];
    const list: Attachment[] = [];
    if (activePrompt.text) {
      list.push({ attachment_type: AttachmentType.PROMPT, data: activePrompt.text });
    }
    for (const f of activePrompt.files) {
      list.push({ attachment_type: AttachmentType.PROMPT, data: `prompt/${f.name}` });
    }
    return list;
  }, [activePrompt]);

  // Composer-preview actions (Edit only — no FlowMessage exists yet).
  const { actions: composerActions } = useAttachmentActions({
    fm: null,
    isFromOther: false,
    isComposerPreview: true,
    handlers: { edit: () => setShowPromptDialog(true) },
  });

  // Returns how many files survived (0 when every image's markup was cancelled),
  // so paste can decide whether to also insert accompanying text.
  const addFiles = async (incoming: FileList | File[] | null): Promise<number> => {
    if (!incoming) return 0;
    // Offer markup on captured images before attaching. Size cap is applied
    // after annotation since the flattened PNG may be larger than the original.
    const annotated = await annotateImageFiles(Array.from(incoming));
    if (annotated.length === 0) return 0; // markup cancelled → do nothing
    const tooBig: string[] = [];
    setFiles((prev) => {
      const next = [...prev];
      for (const f of annotated) {
        if (f.size > MAX_FILE_SIZE_BYTES) {
          tooBig.push(f.name);
          continue;
        }
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      return next;
    });
    setError(
      tooBig.length === 0
        ? null
        : tooBig.length === 1
          ? t`"${tooBig[0]}" is over ${MAX_FILE_SIZE_LABEL} and was not attached.`
          : t`${tooBig.length} files over ${MAX_FILE_SIZE_LABEL} were not attached: ${tooBig.join(', ')}.`,
    );
    return annotated.length;
  };

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  // Insert the picked emoji at the textarea caret (or append when unfocused),
  // then restore the caret just after the inserted glyph so the user can keep
  // typing without re-clicking the field.
  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setText((prev) => prev + emoji);
      return;
    }
    const start = textarea.selectionStart ?? text.length;
    const end = textarea.selectionEnd ?? start;
    const next = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const caret = start + emoji.length;
      textarea.selectionStart = caret;
      textarea.selectionEnd = caret;
    });
  };

  const addAssetRef = (d: AssetDescriptor) =>
    setAssetRefs((prev) => (prev.some((a) => a.typeid === d.typeid && a.source === d.source) ? prev : [...prev, d]));

  const buildExtras = (effectivePrompt: QueuedPrompt | null): Parameters<typeof sendReply>[3] | undefined => {
    const extras: NonNullable<Parameters<typeof sendReply>[3]> = {};
    if (effectivePrompt) {
      if (effectivePrompt.text) extras.promptText = effectivePrompt.text;
      if (effectivePrompt.files.length > 0) extras.promptFiles = effectivePrompt.files;
    }
    // Assets (skill/agent/markdown/spec) ride as assetReferences.
    const refs = assetRefs.map((a) => a.typeid);
    if (refs.length > 0) extras.assetReferences = refs;
    if (liveSessionId) extras.remoteWorkerSessionId = liveSessionId;
    return Object.keys(extras).length > 0 ? extras : undefined;
  };

  const send = async (effectivePrompt: QueuedPrompt | null) => {
    if (isBusy) return;
    const trimmed = text.trim();
    if (!trimmed && !effectivePrompt && files.length === 0 && assetRefs.length === 0) {
      return;
    }
    // Live session: the typed text IS the prompt that runs on the host, so it
    // must ride as a PROMPT attachment (not a plain message body) — otherwise
    // the host's execute gate (`_is_prompt_attachment`) never fires and
    // build_merged_prompt is empty. Route the textarea text through the prompt
    // path and send an empty body (the backend synthesizes the placeholder).
    const liveSessionPrompt: QueuedPrompt | null =
      liveSessionId && trimmed && !effectivePrompt ? { text: trimmed, files: files } : null;
    const outgoingPrompt = liveSessionPrompt ?? effectivePrompt;
    const messageBody = liveSessionPrompt ? '' : trimmed;
    const outgoingFiles = liveSessionPrompt ? undefined : files.length > 0 ? files : undefined;
    setSending(true);
    setError(null);
    try {
      // Cloud reply needs an authenticated hub token; otherwise the hub POST
      // 401s and the send fails silently. Route through OAuth first.
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        setError(gate.error);
        if (isDraftMode) notify.error({ title: gate.error });
        return;
      }
      // Draft promotion: discard the local-only draft, then send through the
      // SAME reply pipeline as a fresh send. Single code path beats forking
      // the upload/push plumbing for drafts.
      if (draft) await discardDraftFlowMessage(draft);
      await sendReply(
        { conversationId: effectiveConversationId },
        messageBody,
        outgoingFiles,
        buildExtras(outgoingPrompt),
      );
      if (!isDraftMode) {
        setText('');
        setFiles([]);
        setAssetRefs([]);
        setActivePrompt(null);
      }
      onSent?.();
    } catch (err: unknown) {
      console.error('[MessageComposer] send failed', err);
      setError(err instanceof Error ? err.message : t`Failed to send reply.`);
      if (isDraftMode) notify.error({ title: t`Failed to send draft` });
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => void send(activePrompt);

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
    // popup is awaited below and `e` is unusable after the first await.
    const pastedText = e.clipboardData.getData('text/plain');
    const textarea = e.currentTarget;
    const value = textarea.value;
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? start;

    // If the markup is cancelled, do nothing at all — not even the text paste.
    const added = await addFiles(pastedImages);
    if (added === 0 || !pastedText) return;

    setText(`${value.slice(0, start)}${pastedText}${value.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.selectionStart = start + pastedText.length;
      textarea.selectionEnd = start + pastedText.length;
    });
  };

  const canSend =
    (!!text.trim() || !!activePrompt || files.length > 0 || assetRefs.length > 0) && !isDisabled;

  // ── Shared building blocks (identical in both modes) ────────────────────

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="sr-only"
      disabled={isDisabled}
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
        disabled={isDisabled}
        title={t`Attach files`}
        data-testid="attach-file-button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <Paperclip className="h-3.5 w-3.5" />
      </button>
      <AssetPickerPopover
        trigger={
          <button
            type="button"
            disabled={isDisabled}
            title={t`Attach an asset (skill, agent, doc, spec)`}
            data-testid="attach-asset-button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Boxes className="h-3.5 w-3.5" />
          </button>
        }
        onPick={addAssetRef}
        filter={() => true}
        side="top"
        searchPlaceholder={t`Search assets…`}
      />
      <EmojiPicker
        side="top"
        onPick={insertEmoji}
        trigger={
          <button
            type="button"
            disabled={isDisabled}
            title={t`Insert emoji`}
            data-testid="insert-emoji-button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Smile className="h-3.5 w-3.5" />
          </button>
        }
      />
    </>
  );

  const promptButton = canAddPrompt ? (
    <button
      type="button"
      onClick={() => setShowPromptDialog(true)}
      disabled={isDisabled}
      title={activePrompt ? t`Edit attached prompt` : t`Suggest a prompt for the other user to approve`}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-40',
        activePrompt
          ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300'
          : 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
      )}
    >
      <MessageSquarePlus className="h-3 w-3" />
      {activePrompt ? <Trans>Edit prompt</Trans> : <Trans>Suggest prompt</Trans>}
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
      <Send className="h-3.5 w-3.5" />
    </button>
  );

  const chipLists = (
    <>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <PendingFileChip
              key={`${f.name}-${i}`}
              file={f}
              disabled={isDisabled}
              onRemove={() => removeFile(i)}
            />
          ))}
        </ul>
      )}
      <AssetRefChips assetRefs={assetRefs} onChange={setAssetRefs} disabled={isDisabled} />
    </>
  );

  const promptPreview =
    canAddPrompt && activePrompt ? (
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <AttachmentActionsRow
            actions={composerActions}
            preview={
              <PromptAttachmentPreview
                attachments={queuedPromptAttachments}
                pendingFiles={activePrompt.files}
              />
            }
          />
        </div>
        <button
          type="button"
          onClick={() => setActivePrompt(null)}
          title={t`Remove queued prompt`}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    ) : null;

  const promptDialog = canAddPrompt ? (
    <PromptComposerDialog
      open={showPromptDialog}
      onClose={() => setShowPromptDialog(false)}
      initial={activePrompt}
      onQueue={(p) => setActivePrompt(p)}
      onQueueAndSend={(p) => {
        setActivePrompt(p);
        void send(p);
      }}
    />
  ) : null;

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
              rows={Math.max(2, Math.min(10, text.split('\n').length + 1))}
              disabled={isDisabled}
              className="min-h-[2.5rem] w-full resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="flex items-center gap-1.5">
              {attachButtons}
              {promptButton}
              <div className="ml-auto flex items-center gap-1.5">
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

          {promptPreview}
          {chipLists}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {hiddenFileInput}
          {promptDialog}
        </div>
      </div>
    );
  }

  // ── Regular reply box ───────────────────────────────────────────────────

  return (
    <div className="space-y-1.5">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex items-end gap-2 rounded-md border border-border bg-background px-2 py-1.5 transition-colors focus-within:border-primary/50',
          dragging && 'border-primary bg-primary/5',
        )}
      >
        <div className="flex shrink-0 items-center gap-1.5 self-end pb-0.5">{attachButtons}</div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(e) => void handlePaste(e)}
          placeholder={dragging ? t`Drop files here` : t`Reply to sender…`}
          rows={1}
          disabled={isDisabled}
          className="min-h-[1.5rem] flex-1 resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
        {promptButton}
        {sendButton}
      </div>

      {promptPreview}
      {chipLists}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {hiddenFileInput}
      {promptDialog}
    </div>
  );
}
