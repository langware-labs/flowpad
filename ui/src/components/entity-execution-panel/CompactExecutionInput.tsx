import { cn } from '@src/lib/utils';
import { imageFilesFromClipboardData } from '@src/utils/clipboard-image';
import { AttachFilesButton, PickedFileList, usePickedFiles } from '@src/components/conversation/FileAttachmentPicker';
import { Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { caretOnFirstLine, caretOnLastLine, type InputHistory } from '@src/hooks/use-input-history';
import { PromptHistoryList } from './PromptHistoryList';
import { readDraft, writeDraft } from './composer-drafts';

interface CompactExecutionInputProps {
  onSend: (text: string, files?: File[]) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Optional node rendered between the textarea and the Send button (e.g. a status indicator). */
  statusSlot?: ReactNode;
  /** When true, the agent is mid-turn: show a Stop button; sends enqueue. */
  running?: boolean;
  /** Interrupt the in-flight turn. Presentational only — the pane owns the logic. */
  onStop?: () => void | Promise<void>;
  /** Drop the container's top border + background so it nests inside another ribbon. */
  bare?: boolean;
  /** Optional node rendered at the start of the row (e.g. a mode pill). */
  leadingSlot?: ReactNode;
  /** Shift+Tab handler (e.g. toggle plan mode). Intercepted before the textarea. */
  onShiftTab?: () => void;
  /**
   * Handle pasted image files (upload to the process input dir, open the Files
   * side tab, etc). Returns one reference line per uploaded image — these are
   * inserted into the composer at the caret so they ride along with the next
   * send, mirroring the PTY paste behaviour. Omit to leave paste as plain text.
   */
  onPasteImages?: (files: File[]) => Promise<string[] | void> | string[] | void;
  /**
   * Opt-in attachments mode: a "+" picker button, drag-and-drop onto the
   * composer, and file chips. Picked files are held locally and handed to
   * onSend — the owner uploads them (there may be no process yet to upload
   * into) and rides the reference lines along with the prompt.
   */
  allowAttachments?: boolean;
  /**
   * Prompt-history navigation (ArrowUp/Down at the first/last line browses;
   * a list of past prompts renders under the textarea while browsing when
   * there is more than one entry). The owner holds the `useInputHistory`
   * instance so it can seed from the transcript and record sends.
   */
  history?: InputHistory;
  /**
   * When a send happens while `running` (it will be enqueued), animate a
   * ghost of the composed text shrinking into the queue chip (rendered in
   * `leadingSlot` with data-testid="entity-execution-queue-chip") so the user
   * sees where the prompt went. Skipped under prefers-reduced-motion.
   */
  animateEnqueue?: boolean;
  /**
   * Keep the unsent draft across unmount/remount and across a reload, for the
   * lifetime of this browser tab (see `composer-drafts.ts`). On by default:
   * navigating away from a half-typed prompt and losing it is never the wanted
   * behaviour. Pass false for a composer that must always open empty.
   */
  saveDraft?: boolean;
  /**
   * Which conversation the draft belongs to — a process id, or a surface
   * identity for a panel that may not have a process yet. Without it there is
   * nothing to tell two composers apart, so persistence stays inert rather
   * than risk one chat's draft appearing in another.
   */
  draftScope?: string;
}

/**
 * Textarea + send/stop input for the chat surfaces. Deliberately minimal — no
 * tools panel, codebase connectors, or login flows; file attachments are
 * opt-in via `allowAttachments`. Enter sends; Shift+Enter inserts a newline;
 * Cmd/Ctrl+Enter also sends; Escape stops the in-flight turn. While
 * `running`, a Stop button appears and sends enqueue.
 *
 * The composer owns its draft: given a `draftScope` it stores the text as it is
 * typed and restores it on mount, so navigating away and returning — or
 * reloading the tab — does not lose an unsent prompt.
 */
export function CompactExecutionInput({
  onSend,
  disabled = false,
  placeholder,
  className,
  statusSlot,
  running = false,
  onStop,
  bare = false,
  onPasteImages,
  allowAttachments = false,
  leadingSlot,
  onShiftTab,
  history,
  animateEnqueue = false,
  saveDraft = true,
  draftScope,
}: CompactExecutionInputProps) {
  const { t } = useLingui();
  const scope = saveDraft ? draftScope : undefined;
  const [value, setValue] = useState(() => readDraft(scope));
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Persist as the text changes, NOT on unmount: a reload runs no React
  // cleanup, so a draft saved only on the way out would survive navigation and
  // still be lost to F5 — the case this exists for. Keeping it in one effect
  // also leaves all five setValue call sites (typing, paste splice, history
  // browsing) untouched.
  //
  // The scope-swap frame renders the NEW scope with the OLD value, so it must
  // adopt rather than write — otherwise one conversation's text lands under
  // another's key. The outgoing text is already stored: it was written when it
  // was typed.
  //
  // One exception, and it is why the check is `undefined` and not "changed":
  // a scope arriving from undefined is this composer's own identity RESOLVING
  // (the owning panel looks its process up asynchronously), not a move to
  // another conversation. The text on screen belongs to this chat, so it is
  // carried over instead of being wiped by an empty stored draft. Any
  // defined -> defined change IS a real switch and adopts.
  const prevScope = useRef(scope);
  useEffect(() => {
    if (prevScope.current !== scope) {
      const identityResolved = prevScope.current === undefined;
      prevScope.current = scope;
      if (identityResolved && value !== '') {
        writeDraft(scope, value);
        return;
      }
      setValue(readDraft(scope));
      return;
    }
    writeDraft(scope, value);
  }, [scope, value]);

  const picker = usePickedFiles({ enabled: allowAttachments, disabled });

  // Autosize the textarea up to ~200px. Keep overflow hidden until the content
  // genuinely exceeds the cap — otherwise the border-box border leaves a ~2px
  // overflow and the browser shows a spurious vertical scrollbar.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const full = ta.scrollHeight;
    ta.style.height = `${Math.min(full, 200)}px`;
    ta.style.overflowY = full > 200 ? 'auto' : 'hidden';
  }, [value]);

  // Ghost animation: clone the composed text over the textarea and CSS-shrink
  // it into the queue chip so the user sees where the queued prompt went.
  const runEnqueueAnimation = useCallback((text: string) => {
    if (typeof window === 'undefined') return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reducedMotion?.matches) return;
    const ta = taRef.current;
    const target =
      rootRef.current?.querySelector('[data-testid="entity-execution-queue-chip"]') ??
      rootRef.current?.querySelector('[data-queue-chip-anchor]');
    if (!ta || !target) return;
    const from = ta.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.textContent = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    ghost.setAttribute('data-testid', 'entity-execution-enqueue-ghost');
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      maxHeight: `${from.height}px`,
      overflow: 'hidden',
      padding: '8px 12px',
      borderRadius: '12px',
      border: '1px solid var(--border, rgba(127,127,127,0.4))',
      background: 'var(--background, transparent)',
      fontSize: '13px',
      opacity: '0.9',
      zIndex: '9999',
      pointerEvents: 'none',
      transformOrigin: 'left center',
      transition: 'transform 260ms ease-in, opacity 260ms ease-in',
      willChange: 'transform, opacity',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(ghost);
    const remove = () => ghost.remove();
    ghost.addEventListener('transitionend', remove, { once: true });
    // Lifecycle guard, not a wait: remove the ghost even if transitionend
    // never fires (e.g. the tab is backgrounded mid-animation).
    window.setTimeout(remove, 600);
    requestAnimationFrame(() => {
      const dx = to.left + to.width / 2 - from.left;
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      ghost.style.transform = `translate(${dx}px, ${dy}px) scale(0.05)`;
      ghost.style.opacity = '0.2';
    });
  }, []);

  // A files-only send is valid — the ref lines ARE the prompt (files can only
  // be non-empty when allowAttachments is on; every add path is gated).
  const canSend = !!value.trim() || picker.files.length > 0;

  const send = useCallback(async () => {
    if (!canSend || disabled) return;
    const text = value.trim();
    const files = picker.files;
    setValue('');
    picker.clear();
    history?.exitBrowsing();
    if (running && animateEnqueue && text) runEnqueueAnimation(text);
    await onSend(text, files);
  }, [canSend, value, picker, disabled, onSend, history, running, animateEnqueue, runEnqueueAnimation]);

  // Image paste: hand the image files to the owner (upload + open Files tab),
  // then splice the returned reference line(s) into the textarea at the caret.
  // Non-image pastes fall through to the browser's default text paste.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteImages || disabled) return;
      const images = imageFilesFromClipboardData(e.clipboardData, new Date(), { prefix: 'screenshot' });
      if (images.length === 0) return;
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart ?? value.length;
      const end = ta.selectionEnd ?? start;
      void Promise.resolve(onPasteImages(images)).then((refs) => {
        const insert = refs && refs.length > 0 ? refs.join('\n') : null;
        if (insert !== null) {
          setValue((prev) => `${prev.slice(0, start)}${insert}${prev.slice(end)}`);
        }
        // Always hand focus back to the composer — the annotate dialog and the
        // Files drawer opening drop focus to <body>, even on cancel/empty refs.
        requestAnimationFrame(() => {
          const node = taRef.current;
          if (!node) return;
          const caret = start + (insert?.length ?? 0);
          node.focus();
          node.selectionStart = caret;
          node.selectionEnd = caret;
        });
      });
    },
    [onPasteImages, disabled, value],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (onShiftTab && e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        onShiftTab();
        return;
      }
      if (e.key === 'Escape') {
        // Escape = stop while a turn is running; otherwise it exits history
        // browsing and restores the stashed draft.
        if (running && onStop) {
          e.preventDefault();
          void onStop();
          return;
        }
        if (history?.browsing) {
          e.preventDefault();
          setValue(history.exitBrowsing());
        }
        return;
      }
      if (history && e.key === 'ArrowUp') {
        if (caretOnFirstLine(e.currentTarget)) {
          e.preventDefault();
          setValue(history.navigateUp(value));
        }
        return;
      }
      if (history && e.key === 'ArrowDown') {
        if (caretOnLastLine(e.currentTarget) && history.browsing) {
          e.preventDefault();
          setValue(history.navigateDown(value));
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && (!e.nativeEvent.isComposing || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    },
    [onShiftTab, running, onStop, history, value, send],
  );

  const showStop = running && !!onStop;
  // PromptHistoryList itself owns the "only with more than one prompt" rule.
  const showHistoryList = !!history && history.browsing;

  return (
    <div
      ref={rootRef}
      {...picker.dragProps}
      className={cn(
        'flex flex-shrink-0 flex-col gap-1.5',
        !bare && 'border-t bg-background px-3 py-2.5',
        picker.dragging && 'rounded-xl ring-1 ring-primary',
        className,
      )}
    >
      <PickedFileList
        files={picker.files}
        rejected={picker.rejected}
        disabled={disabled}
        onRemoveAt={picker.removeAt}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder ?? t`Message the agent…`}
        rows={1}
        aria-label={t`Message the agent`}
        className="min-h-[48px] w-full resize-none overflow-y-hidden rounded-xl border bg-background px-4 py-3 text-[15px] outline-none transition-colors focus:border-primary disabled:opacity-50"
        data-testid="entity-execution-input"
      />
      {showHistoryList && (
        <PromptHistoryList
          entries={history.entries}
          index={history.index}
          onPick={(i) => setValue(history.select(i))}
        />
      )}
      <div className="flex min-h-8 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5" data-queue-chip-anchor>
          {allowAttachments && (
            <AttachFilesButton
              inputId={picker.inputId}
              onFiles={picker.addFiles}
              disabled={disabled}
              title={t`Attach files`}
              testId="entity-execution-attach"
            />
          )}
          {leadingSlot}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          {statusSlot}
          {/* While running, Send stays available for non-empty drafts (it
              enqueues); Stop sits beside it. */}
          {(!showStop || canSend) && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                void send();
              }}
              disabled={disabled || !canSend}
              title={showStop ? t`Queue message` : t`Send`}
              aria-label={showStop ? t`Queue message` : t`Send message`}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-primary"
              data-testid="entity-execution-send"
            >
              <Send className="h-3.5 w-3.5 rtl:-scale-x-100" />
            </button>
          )}
          {showStop && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                void onStop?.();
              }}
              title={t`Stop generating`}
              aria-label={t`Stop generating`}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
              data-testid="entity-execution-stop"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
