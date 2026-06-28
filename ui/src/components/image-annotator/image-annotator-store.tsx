/**
 * Imperative, promise-based host for the image annotator — mirrors the
 * input-prompt-modal pattern (module-level store + singleton mounted at the app
 * root). Any capture surface can do:
 *
 *   const result = await annotateImage(file);  // File (possibly annotated) or original
 *
 * On Save the annotated PNG is also written back to the system clipboard, so the
 * user's clipboard matches what was attached (WhatsApp-style). Clipboard failure
 * never blocks the attach.
 */
import { useSyncExternalStore } from 'react';
import { notify } from '@src/notifications';
import { ImageAnnotator } from './ImageAnnotator';

interface AnnotatorState {
  open: boolean;
  file: File | null;
  resolve: ((result: File) => void) | null;
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

function settle(result: File) {
  const resolve = state.resolve;
  state = { open: false, file: null, resolve: null };
  emit();
  resolve?.(result);
}

/**
 * Open the annotator for `file` and resolve once the user saves or dismisses.
 * Resolves with the flattened PNG on Save, or the original `file` if dismissed.
 */
export function annotateImage(file: File): Promise<File> {
  // A second call while one is open would orphan the first promise — settle it
  // with its own original so nothing hangs.
  if (state.open) state.resolve?.(state.file!);
  return new Promise<File>((resolve) => {
    state = { open: true, file, resolve };
    emit();
  });
}

// DEV-only test hook (mirrors WhiteboardAssetEditor's window.__whiteboardApi):
// lets a browser-driven check open the annotator without staging a real capture.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__annotateImage = annotateImage;
}

async function writeImageToClipboard(file: File): Promise<void> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
  } catch {
    // Clipboard write can fail (permissions / focus) — surface, never block.
    notify.error({ title: 'Clipboard not updated', message: 'The annotated image was attached but could not be copied to the clipboard.' });
  }
}

export function ImageAnnotatorRoot() {
  const { open, file } = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <ImageAnnotator
      open={open}
      file={file}
      onSave={(annotated) => {
        void writeImageToClipboard(annotated);
        settle(annotated);
      }}
      onCancel={() => {
        // Dismissed without saving → original passes through unchanged.
        if (file) settle(file);
      }}
    />
  );
}
