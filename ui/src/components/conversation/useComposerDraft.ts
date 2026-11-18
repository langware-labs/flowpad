import { useEffect, useRef } from 'react';
import type { FlowMessage } from '@sdk';
import {
  isEmptyDraft,
  loadComposerDraft,
  putComposerDraft,
  type ComposerDraft,
  type ComposerDraftKey,
} from './flow-message-drafts';

/** How long typing rests before a draft is stored. */
export const SAVE_DEBOUNCE_MS = 400;

const fileIds = new WeakMap<File, number>();
let nextFileId = 0;
const fileId = (file: File) => fileIds.get(file) ?? (fileIds.set(file, ++nextFileId), nextFileId);

/** What a draft is, as one comparable value: two states with the same signature store the same row. */
const signatureOf = (d: ComposerDraft) =>
  JSON.stringify([
    d.text,
    d.files.map(fileId),
    d.assetRefs.map((a) => a.typeid),
    d.replyToId,
    d.taskIt,
    d.promptCall,
    d.promptText,
  ]);

/** An empty composer: what is held right after a send. */
const EMPTY_SIGNATURE = signatureOf({
  text: '',
  files: [],
  assetRefs: [],
  replyToId: null,
  taskIt: false,
  promptCall: false,
  promptText: '',
});

/**
 * A composer's stored draft: the message being written, kept as a draft `FlowMessage` so it is there
 * when the conversation is opened again.
 *
 * The composer goes on holding what is typed (`held`); this stores it as it changes, and hands the
 * stored draft back once (`restore`) when the composer mounts. `key` null = this composer keeps no draft.
 * It is fixed for the composer's life — a composer of another conversation or thread is another mount.
 */
export function useComposerDraft(
  key: ComposerDraftKey | null,
  held: ComposerDraft,
  restore: (saved: ComposerDraft) => void,
) {
  // Which composer it is never changes; the thread's root may arrive after the composer mounts.
  const keyRef = useRef(key);
  keyRef.current = key;
  const heldRef = useRef(held);
  heldRef.current = held;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const state = useRef({
    loaded: false,
    row: null as FlowMessage | null,
    stored: new Set<File>(),
    savedSignature: signatureOf(held),
    writing: Promise.resolve(),
    timer: null as ReturnType<typeof setTimeout> | null,
  }).current;

  // One write at a time, each storing what the composer holds when its turn comes.
  const save = () => {
    const target = keyRef.current;
    if (!target) return state.writing;
    state.writing = state.writing.then(async () => {
      const draft = heldRef.current;
      const signature = signatureOf(draft);
      if (signature === state.savedSignature) return;
      try {
        state.row = await putComposerDraft(target, draft, state.stored);
        state.stored = new Set(state.row ? draft.files : []);
        state.savedSignature = signature;
      } catch (err) {
        // Not stored: the next change tries again, and a send reports it.
        console.error('[composer-draft] save failed', err);
      }
    });
    return state.writing;
  };
  const cancelTimer = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };

  useEffect(() => {
    const target = keyRef.current;
    if (!target) return;
    let live = true;
    let restored = false;
    void loadComposerDraft(target)
      .then((found) => {
        if (!live || !found) return;
        state.row = found.row;
        // Typed before the stored draft arrived: what is typed stays, and is what gets stored.
        if (!isEmptyDraft(heldRef.current)) return;
        state.stored = new Set(found.draft.files);
        state.savedSignature = signatureOf(found.draft);
        restoreRef.current(found.draft);
        restored = true;
      })
      .catch((err) => console.error('[composer-draft] load failed', err))
      .finally(() => {
        state.loaded = true;
        // Not after a restore: the composer still holds its empty box until it renders what was
        // handed back, and storing THAT would delete the draft just restored.
        if (live && !restored) void save();
      });
    // The window is going away: store what is held now, without waiting for the pause in typing.
    const storeNow = () => {
      cancelTimer();
      if (state.loaded) void save();
    };
    window.addEventListener('pagehide', storeNow);
    return () => {
      live = false;
      window.removeEventListener('pagehide', storeNow);
      // Leaving mid-typing: the same.
      storeNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signature = signatureOf(held);
  useEffect(() => {
    if (!keyRef.current || !state.loaded || signature === state.savedSignature) return;
    state.timer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
    return cancelTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return {
    /** Store what the composer holds now and answer its row — null when it could not be stored. */
    flush: async (): Promise<FlowMessage | null> => {
      cancelTimer();
      await save();
      return signatureOf(heldRef.current) === state.savedSignature ? state.row : null;
    },
    /** The row was sent: it is a message now, and the composer starts from nothing. */
    sent: () => {
      state.row = null;
      state.stored = new Set();
      state.savedSignature = EMPTY_SIGNATURE;
    },
  };
}
