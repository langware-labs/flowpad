import { DocumentDraft, type AssetDocument, type DocumentRef, type DocumentValue } from '@sdk/fs/AssetDocument';
import { usePrimaryContentPending } from '@sdk/react/primary-content';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

export interface MarkdownContentState {
  fields: Record<string, string>;
  typedFields: Record<string, DocumentValue>;
  hasFields: boolean;
  body: string;
  bodyStartLine: number;
  setField: (key: string, value: DocumentValue) => void;
  setBody: (body: string) => void;
  dropField: (key: string) => void;
  dirty: boolean;
  saving: boolean;
  lastSync: Date | null;
  isLoading: boolean;
  loadError: Error | null;
  saveError: Error | null;
  conflict: boolean;
  metadataError: string | null;
  currentDocument: AssetDocument | null;
  inspectCurrent: () => Promise<void>;
  isMissing: boolean;
  recreate: () => Promise<void>;
  save: () => Promise<boolean>;
  reload: () => void;
}

function isConflict(error: unknown): boolean {
  const e = error as { response?: { status?: number }; status?: number; code?: string };
  return e?.response?.status === 409 || e?.status === 409 || e?.code === 'stale_document';
}

/** A structured document draft; all YAML parsing and writing belongs to the backend. */
export function useMarkdownContent(
  fsRef: DocumentRef | null,
  options?: { autoSave?: boolean; autoSaveMs?: number; reloadKey?: string | number },
): MarkdownContentState {
  const [generation, redraw] = useReducer((n: number) => n + 1, 0);
  const [reloadTrigger, reload] = useReducer((n: number) => n + 1, 0);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [currentDocument, setCurrentDocument] = useState<AssetDocument | null>(null);
  const [conflict, setConflict] = useState(false);
  const [isMissing, setMissing] = useState(false);
  const [loading, setLoading] = useState(!!fsRef);
  const [saving, setSaving] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const draft = useRef<DocumentDraft | null>(null);
  const ref = useRef(fsRef);
  ref.current = fsRef;
  const saveBlocked = useRef(false);
  const inFlight = useRef(false);
  const pendingSave = useRef(false);
  const epoch = useRef(0);
  const identity = fsRef?.vpath ?? fsRef?.path ?? null;
  const previousLoad = useRef({ identity, reloadTrigger });
  const reloadKey = options?.reloadKey;

  useEffect(() => () => { ++epoch.current; }, []);

  useEffect(() => {
    const previous = previousLoad.current;
    const explicit = identity !== previous.identity || reloadTrigger !== previous.reloadTrigger;
    previousLoad.current = { identity, reloadTrigger };
    if (!explicit && (draft.current?.dirty || inFlight.current || saveBlocked.current)) return;
    const token = ++epoch.current;
    draft.current = null;
    saveBlocked.current = false;
    inFlight.current = false;
    pendingSave.current = false;
    setSaving(false);
    setConflict(false);
    setCurrentDocument(null);
    setSaveError(null);
    setLoadError(null);
    setMissing(false);
    setLastSync(null);
    const target = ref.current;
    setLoading(!!target);
    if (!target) return;
    void target.readDocument().then((document) => {
      if (epoch.current !== token) return;
      draft.current = new DocumentDraft(document);
    }).catch(async (error: unknown) => {
      if (epoch.current !== token) return;
      const missing = target.exists ? !(await target.exists().catch(() => true)) : false;
      if (epoch.current !== token) return;
      setMissing(missing);
      if (!missing) setLoadError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (epoch.current === token) { setLoading(false); redraw(); }
    });
  }, [identity, reloadTrigger, reloadKey]);

  const saveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const save = useCallback(async () => {
    const target = ref.current;
    const current = draft.current;
    if (!target || target.readOnly || !current || saveBlocked.current) return false;
    if (!current.dirty) return true;
    if (inFlight.current) { pendingSave.current = true; return false; }
    const token = epoch.current;
    const submitted = current.snapshot();
    inFlight.current = true;
    setSaving(true);
    try {
      const saved = await target.updateDocument(current.patch());
      if (token !== epoch.current) return false;
      current.accept(saved, submitted);
      setLastSync(new Date());
      setSaveError(null);
      return true;
    } catch (error) {
      if (token !== epoch.current) return false;
      // Any failure pauses automatic saving; a stale revision must never be retried.
      saveBlocked.current = true;
      setConflict(isConflict(error));
      setSaveError(error instanceof Error ? error : new Error(String(error)));
      return false;
    } finally {
      if (token === epoch.current) {
        inFlight.current = false;
        setSaving(false);
        redraw();
        if (pendingSave.current) { pendingSave.current = false; void saveRef.current(); }
      }
    }
  }, []);
  saveRef.current = save;

  const setBody = useCallback((body: string) => {
    if (!draft.current || ref.current?.readOnly) return;
    draft.current.body = body;
    redraw();
  }, []);
  const setField = useCallback((key: string, value: DocumentValue) => {
    if (!draft.current || ref.current?.readOnly) return;
    draft.current.fields[key] = value;
    redraw();
  }, []);
  const dropField = useCallback((key: string) => {
    if (!draft.current || ref.current?.readOnly) return;
    delete draft.current.fields[key];
    redraw();
  }, []);
  const inspectCurrent = useCallback(async () => {
    const token = epoch.current;
    try {
      const document = await ref.current?.readDocument();
      if (epoch.current === token && document) setCurrentDocument(document);
    } catch (error) {
      if (epoch.current === token) setSaveError(error instanceof Error ? error : new Error(String(error)));
    }
  }, []);
  const recreate = useCallback(async () => {
    try { await ref.current?.create?.(); reload(); }
    catch (error) { setLoadError(error instanceof Error ? error : new Error(String(error))); }
  }, []);

  const dirty = draft.current?.dirty ?? false;
  const autoSave = options?.autoSave ?? true;
  const autoSaveMs = options?.autoSaveMs ?? 3000;
  useEffect(() => {
    if (!autoSave || !dirty || saveBlocked.current) return;
    const timer = setTimeout(() => { void saveRef.current(); }, autoSaveMs);
    return () => clearTimeout(timer);
  }, [autoSave, autoSaveMs, dirty, generation]);
  usePrimaryContentPending(loading);

  const current = draft.current;
  // Text inputs only expose scalars; structured metadata survives in the typed draft.
  const fields = Object.fromEntries(Object.entries(current?.fields ?? {}).filter(([, value]) =>
    value === null || typeof value !== 'object',
  ).map(([key, value]) => [key, value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    fields, typedFields: current?.fields ?? {}, hasFields: Object.keys(current?.fields ?? {}).length > 0,
    body: current?.body ?? '', bodyStartLine: current?.document.body_start_line ?? 1,
    setBody, setField, dropField, dirty, saving, lastSync, isLoading: loading, loadError,
    saveError, conflict, currentDocument, inspectCurrent, metadataError: current?.document.metadata_error ?? null,
    isMissing, recreate, save, reload,
  };
}
