/**
 * Imperative, promise-based host for the image annotator — mirrors the
 * input-prompt-modal pattern (module-level store + singleton mounted at the app
 * root). Any capture surface can do:
 *
 *   const result = await annotateImage(file);  // { file, caption } on Save, null on Cancel
 *
 * The caption is the text the user typed under the image (WhatsApp-style) — it is
 * NOT the text drawn on the image; each surface decides where it goes (the
 * message body, a prompt line, a terminal note).
 *
 * On Save the annotated PNG is also written back to the system clipboard, so the
 * user's clipboard matches what was attached (WhatsApp-style). Clipboard failure
 * never blocks the attach. Cancel resolves `null` — the capture is aborted
 * entirely (the image is NOT attached and the caller does nothing further).
 */
import { t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { notify } from '@src/notifications';
import { ImageAnnotator } from './ImageAnnotator';

/** What a saved annotation hands back: the image to attach and the caption typed under it. */
export interface AnnotationResult {
  file: File;
  caption: string;
}

export interface AnnotateImageOptions {
  submitLabel?: ReactNode;
  /** Prefills the caption — e.g. text that came on the clipboard with the image. */
  initialCaption?: string;
  onSubmit?: (file: File, caption: string) => Promise<void> | void;
}

interface AnnotatorState extends AnnotateImageOptions {
  open: boolean;
  file: File | null;
  resolve: ((result: AnnotationResult | null) => void) | null;
}

let state: AnnotatorState = { open: false, file: null, resolve: null };
/** What had focus when the annotator opened — where it goes back on close. Kept outside `state`:
 *  `settle` clears that before the dialog's close handler runs. */
let returnFocus: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): AnnotatorState {
  return state;
}

function settle(result: AnnotationResult | null) {
  const resolve = state.resolve;
  state = { open: false, file: null, resolve: null };
  emit();
  resolve?.(result);
}

/**
 * Open the annotator for `file` and resolve once the user saves or dismisses.
 * Resolves with the flattened PNG (or the untouched original) and the caption on
 * Save, or `null` on Cancel (abort).
 */
export function annotateImage(file: File, options: AnnotateImageOptions = {}): Promise<AnnotationResult | null> {
  // A second call while one is open would orphan the first promise — cancel it
  // (resolve null) so nothing hangs.
  if (state.open) state.resolve?.(null);
  return new Promise<AnnotationResult | null>((resolve) => {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state = { open: true, file, resolve, ...options };
    emit();
  });
}

// DEV-only test hook (mirrors WhiteboardAssetEditor's window.__whiteboardApi):
// lets a browser-driven check open the annotator without staging a real capture.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__annotateImage = annotateImage;
}

async function writeImageToClipboard(blob: Promise<Blob>): Promise<void> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
    // ClipboardItem accepts a Promise<Blob>; navigator.clipboard.write is invoked
    // synchronously by the caller (inside the Save gesture), so the write keeps
    // its user activation while the blob is still being produced.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch {
    // Clipboard write can fail (permissions / focus) — surface, never block.
    notify.error({
      title: t`Clipboard not updated`,
      message: t`The annotated image was attached but could not be copied to the clipboard.`,
    });
  }
}

export function ImageAnnotatorRoot() {
  const { open, file, submitLabel, initialCaption, onSubmit } = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <ImageAnnotator
      open={open}
      file={file}
      submitLabel={submitLabel}
      initialCaption={initialCaption}
      onClipboard={(blob) => void writeImageToClipboard(blob)}
      onCloseAutoFocus={(e) => {
        // Radix returns focus only to a dialog trigger, and this one is opened imperatively —
        // focus fell to <body>. Hand it back to whatever had it (the reply box a paste came from).
        e.preventDefault();
        const el = returnFocus;
        returnFocus = null;
        if (el?.isConnected) el.focus();
      }}
      onSave={(annotated, caption) => {
        if (!onSubmit) {
          settle({ file: annotated, caption });
          return;
        }
        void Promise.resolve(onSubmit(annotated, caption))
          .then(() => settle({ file: annotated, caption }))
          .catch((err) => {
            notify.error({
              title: t`Annotation not submitted`,
              message: err instanceof Error ? err.message : String(err),
            });
            settle(null);
          });
      }}
      onCancel={() => {
        // Dismissed without saving → abort: resolve null so the capture is
        // dropped entirely (image not attached, caller does nothing further).
        settle(null);
      }}
    />
  );
}
