import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@src/hooks/use-toast';

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
  /** Error from initial load, or null */
  loadError: Error | null;
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
  const { toast } = useToast();

  const [content, setContentState] = useState('');
  const [remoteContent, setRemoteContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
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

    const load = async () => {
      try {
        const text = await fsRef.read();
        if (cancelled) return;
        setRemoteContent(text);
        setContentState(text);
        setLoaded(true);
      } catch (err) {
        if (cancelled) return;
        // Recovery branch: orphan entity row pointing at a missing file, or
        // file deleted out-of-band. The editor must never surface a hard
        // "Not Found" — verify exists, and if not, create an empty file,
        // toast a warning, and continue with empty content. The next save
        // (autosave on first edit) writes real content.
        const canRecover = typeof fsRef.exists === 'function' && typeof fsRef.create === 'function';
        if (!canRecover) {
          setLoadError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        try {
          const exists = await fsRef.exists!();
          if (cancelled) return;
          if (exists) {
            // Different failure (perms, network) — surface to the existing
            // error path so the editor can show Retry.
            setLoadError(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          await fsRef.create!();
          if (cancelled) return;
          console.warn('[useFSRefContent] recovered missing file:', fsRef.path);
          toast({
            title: 'Missing file was created',
            description: fsRef.path,
            variant: 'default',
          });
          setRemoteContent('');
          setContentState('');
          setLoaded(true);
        } catch (recoveryErr) {
          if (cancelled) return;
          setLoadError(recoveryErr instanceof Error ? recoveryErr : new Error(String(recoveryErr)));
        }
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [fsRef, reloadTrigger, toast]);

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
    isLoading: !loaded && loadError === null,
    loadError,
    save,
    reload,
  };
}
