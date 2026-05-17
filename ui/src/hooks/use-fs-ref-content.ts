import { useCallback, useEffect, useRef, useState } from 'react';

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

  const savingRef = useRef(false);       // authoritative saving flag (no closure staleness)
  const pendingSaveRef = useRef(false);  // another save was requested while one was in-flight
  const saveRef = useRef<() => Promise<void>>(() => Promise.resolve()); // always current save fn

  const dirty = loaded && content !== remoteContent;

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
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
  }, [fsRef, reloadTrigger]);

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
