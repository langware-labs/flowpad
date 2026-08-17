/**
 * Imperative, promise-based host for the image annotator — mirrors the
 * input-prompt-modal pattern (module-level store + singleton mounted at the app
 * root). Any capture surface can do:
 *
 *   const result = await annotateImage(file);  // annotated File on Save, null on Cancel
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

interface AnnotateImageOptions {
  submitLabel?: ReactNode;
  onSubmit?: (file: File) => Promise<void> | void;
}

interface AnnotatorState {
  open: boolean;
  file: File | null;
  resolve: ((result: File | null) => void) | null;
  submitLabel?: ReactNode;
  onSubmit?: (file: File) => Promise<void> | void;
}

let state: AnnotatorState = { open: false, file: null, resolve: null };
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

function settle(result: File | null) {
  const resolve = state.resolve;
  state = { open: false, file: null, resolve: null };
  emit();
  resolve?.(result);
}

/**
 * Open the annotator for `file` and resolve once the user saves or dismisses.
 * Resolves with the flattened PNG on Save, or `null` on Cancel (abort).
 */
export function annotateImage(file: File, options: AnnotateImageOptions = {}): Promise<File | null> {
  // A second call while one is open would orphan the first promise — cancel it
  // (resolve null) so nothing hangs.
  if (state.open) state.resolve?.(null);
  return new Promise<File | null>((resolve) => {
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
  const { open, file, submitLabel, onSubmit } = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <ImageAnnotator
      open={open}
      file={file}
      submitLabel={submitLabel}
      onClipboard={(blob) => void writeImageToClipboard(blob)}
      onSave={(annotated) => {
        if (!onSubmit) {
          settle(annotated);
          return;
        }
        void Promise.resolve(onSubmit(annotated))
          .then(() => settle(annotated))
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
