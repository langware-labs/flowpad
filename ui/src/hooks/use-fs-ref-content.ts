import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Default compare-normalizer: identity. Module-level so the `dirty` memo's
 *  deps stay stable (a fresh inline closure would defeat the memo). */
const IDENTITY = (s: string) => s;

/**
 * Minimal file I/O abstraction — passed to useFSRefContent.
 * Callers construct this with the appropriate fsManager closures.
 */
export interface FsRef {
  /** Human-readable path for display/logging */
  path: string;
  /** Read file content as string */
  read(): Promise<string>;
  /** Write string content to disk */
  write(content: string): Promise<void>;
  /** True when a file currently exists at this path. Optional — used by the editor's missing-file recovery branch. */
  exists?(): Promise<boolean>;
  /** Recovery primitive — create an empty file at this path. Optional — used when ``exists()`` returns false on initial load. */
  create?(content?: string): Promise<void>;
}

export interface FsRefContentState {
  /** Current in-memory content */
  content: string;
  /** Update in-memory content (does not save to disk) */
  setContent: (content: string) => void;
  /** True when loaded content differs from last-saved content */
  dirty: boolean;
  /** True while a save is in-flight */
  saving: boolean;
  /** Timestamp of last successful save, or null if never saved this session */
  lastSync: Date | null;
  /** True while performing initial load */
  isLoading: boolean;
  /** Error from initial load (perms, network, etc.), or null. Mutually exclusive with isMissing. */
  loadError: Error | null;
  /** True when the file does not exist on disk. Editor should render a re-create prompt instead of the loadError path. */
  isMissing: boolean;
  /** Create an empty file at this path (clears isMissing and enters the editor with empty content). No-op when fsRef.create is not available. */
  recreate: () => Promise<void>;
  /** Trigger a save immediately */
  save: () => Promise<void>;
  /** Reload content from disk (discards unsaved changes) */
  reload: () => void;
}

interface Options {
  autoSave?: boolean;
  autoSaveMs?: number;
  /**
   * Optional canonicalizer for the dirty comparison. Content whose normalized
   * form equals the on-disk normalized form is NOT dirty — so reformatting the
   * save would re-normalize away (e.g. a rich editor that re-serializes the
   * loaded content on mount) never marks a phantom edit. Defaults to identity.
   */
  normalize?: (content: string) => string;
}

/**
 * Generic hook for loading, editing, and saving a file via FsRef.
 *
 * State machine:
 *   loading → loaded (clean) → dirty → saving → clean
 *           ↘ loadError
 *
 * Save coalescing: if save() is called while a save is in-flight,
 * a pendingSave flag is set. The in-flight save will trigger another
 * save immediately after completing — content is never lost.
 *
 * Autosave: debounced — timer resets on every content change.
 * Only starts after initial load completes.
 */
export function useFSRefContent(fsRef: FsRef | null, options?: Options): FsRefContentState {
  const autoSave = options?.autoSave ?? true;
  const autoSaveMs = options?.autoSaveMs ?? 3000;
  const normalize = options?.normalize ?? IDENTITY;

  const [content, setContentState] = useState('');
  const [remoteContent, setRemoteContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [isMissing, setIsMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  // Refs for stable access inside async callbacks — avoids stale closure issues
  const contentRef = useRef(content);
  contentRef.current = content;

  // FsRef objects are cheap value wrappers re-minted on nearly every render
  // (AssetEditorRouter rebuilds `new FSRef(...)`, entity `.doc` getters return a
  // fresh FrontMatterFsRef each access). Keying the load effect on the object
  // identity therefore re-fires it on every render — during a backend scan's WS
  // progress flood that means a reload per frame, blanking the editor to a
  // spinner ("flicker"). Key on the STABLE path string instead and read the live
  // ref inside the effect (same pattern as useAgentTraceDoc).
  const fsRefRef = useRef(fsRef);
  fsRefRef.current = fsRef;
  const path = fsRef?.path ?? null;

  const savingRef = useRef(false);       // authoritative saving flag (no closure staleness)
  const pendingSaveRef = useRef(false);  // another save was requested while one was in-flight
  const saveRef = useRef<() => Promise<void>>(() => Promise.resolve()); // always current save fn

  // Memoized so `remoteContent` (changes only on load/save) isn't re-normalized
  // on every keystroke-driven render — recomputes only when an input changes.
  const dirty = useMemo(
    () => loaded && normalize(content) !== normalize(remoteContent),
    [loaded, content, remoteContent, normalize],
  );

  // ── Load ──────────────────────────────────────────────────────────────────
  // Keyed on `path` (stable string) + `reloadTrigger`, NOT the fsRef object —
  // see fsRefRef note above. Reads the live `fsRefRef.current` so the closure
  // always uses the current fsManager binding even though the effect didn't
  // re-run for an identity-only change.
  useEffect(() => {
    const fsRef = fsRefRef.current;
    if (!fsRef) return;
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setIsMissing(false);

    const load = async () => {
      try {
        const text = await fsRef.read();
        if (cancelled) return;
        setRemoteContent(text);
        setContentState(text);
        setLoaded(true);
      } catch (err) {
        if (cancelled) return;
        // Distinguish "file does not exist" (→ isMissing, editor offers
        // Re-create) from any other read failure (→ loadError, editor offers
        // Retry). Auto-creation removed: the user should opt in.
        if (typeof fsRef.exists === 'function') {
          try {
            const exists = await fsRef.exists();
            if (cancelled) return;
            if (!exists) {
              setIsMissing(true);
              return;
            }
          } catch {
            // exists() failed — fall through to loadError below.
          }
        }
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadTrigger]);

  // ── Re-create (missing-file recovery) ────────────────────────────────────
  const recreate = useCallback(async () => {
    if (!fsRef || typeof fsRef.create !== 'function') return;
    try {
      await fsRef.create();
      setRemoteContent('');
      setContentState('');
      setIsMissing(false);
      setLoaded(true);
    } catch (err) {
      setIsMissing(false);
      setLoadError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [fsRef]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!fsRef) return;
    if (savingRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const contentToSave = contentRef.current; // snapshot content at save time
    try {
      await fsRef.write(contentToSave);
      setRemoteContent(contentToSave);
      setLastSync(new Date());
    } catch (err) {
      console.error('[useFSRefContent] Save failed:', err);
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void saveRef.current(); // re-save with whatever content changed during the in-flight save
      }
    }
  }, [fsRef]);

  saveRef.current = save;

  // ── setContent ────────────────────────────────────────────────────────────
  const setContent = useCallback((newContent: string) => {
    setContentState(newContent);
  }, []);

  // ── Reload ────────────────────────────────────────────────────────────────
  const reload = useCallback(() => {
    setReloadTrigger((n) => n + 1);
  }, []);

  // ── Debounced autosave ────────────────────────────────────────────────────
  // Uses setTimeout (not setInterval) — the cleanup cancels the previous timer
  // on every content change, so only the last change in a burst triggers a save.
  useEffect(() => {
    if (!loaded || !autoSave || !dirty) return;
    const timer = setTimeout(() => {
      void saveRef.current();
    }, autoSaveMs);
    return () => clearTimeout(timer);
  }, [loaded, autoSave, autoSaveMs, dirty, content]);

  return {
    content,
    setContent,
    dirty,
    saving,
    lastSync,
    isLoading: !loaded && loadError === null && !isMissing,
    loadError,
    isMissing,
    recreate,
    save,
    reload,
  };
}
