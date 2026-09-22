import apiClient from '@sdk/client';
import { PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import Editor, { loader } from '@monaco-editor/react';
import { ensureShikiMonaco, monacoTheme } from './shikiMonaco';
import { useLingui } from '@lingui/react/macro';
import { Import, ListStart, Play } from 'lucide-react';
import { useTheme } from 'next-themes';
import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The snippet view (`flow show snippet`): a code file whose `%% flowpad:<region>`
 * markers split it into hidden (imports) / init / snippet. Only the snippet
 * region shows by default; the toolbar reveals the others (remembered prefs).
 *
 * Deliberately a renderer only. Reading regions, writing one back and running
 * the file are the backend's (`flow_sdk/core/snippet.py`, `/api/v1/snippet/*`),
 * proven there by unit tests — nothing here decides what a region is.
 */

interface SnippetRegionView {
  index: number;
  kind: 'hidden' | 'init' | 'snippet';
  shown: string;
  /** File line the region's text starts on, so numbers match a traceback. */
  line: number;
}

interface SnippetRead {
  regions?: SnippetRegionView[];
  /** The whole file as it is on disk. */
  text?: string;
  error_code?: string;
}

interface SnippetRunResult {
  returncode: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_s: number;
}

const LINE_HEIGHT = 19;
const SAVE_DEBOUNCE_MS = 500;

interface SnippetViewProps {
  /** Absolute machine path of the snippet file. */
  path: string;
  /** Monaco language id. */
  language: string;
  /** The file's current text (fs cache); a change that isn't ours reloads the regions. */
  revision: string;
  readOnly?: boolean;
  /** The file is not (or no longer) a snippet — the host falls back to the raw editor. */
  onNotSnippet: () => void;
  /** The file was read or written; `text` is the whole file now on disk, for the host's raw copy. */
  onSynced: (text: string) => void;
}

export function SnippetView({ path, language, revision, readOnly, onNotSnippet, onSynced }: SnippetViewProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const [showInit, setShowInit] = usePreference<boolean>(PrefKey.SNIPPET_SHOW_INIT);
  const [showImports, setShowImports] = usePreference<boolean>(PrefKey.SNIPPET_SHOW_IMPORTS);
  const [timeoutSeconds] = usePreference<number>(PrefKey.SNIPPET_RUN_TIMEOUT);

  const [regions, setRegions] = useState<SnippetRegionView[] | null>(null);
  // Bumped only when the file changed under us (not by our own save), to remount
  // the editors with the new text without fighting the cursor on every keystroke.
  const [generation, setGeneration] = useState(0);
  // Two kinds of message: `readError` is the file's state, owned by `load` (set
  // and cleared on every read); `notice` reports something that HAPPENED (a
  // refused save, a failed request) and survives the re-reads that follow it.
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const error = readError || notice;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SnippetRunResult | null>(null);
  // Editors mount only once the shared shiki themes exist (see shikiMonaco.ts).
  const [themed, setThemed] = useState(false);

  useEffect(() => {
    let alive = true;
    void loader
      .init()
      .then((monaco) => ensureShikiMonaco(monaco, language))
      .then(() => alive && setThemed(true));
    return () => {
      alive = false;
    };
  }, [language]);

  const localRef = useRef<Map<number, string>>(new Map());
  // What each region was on disk when last loaded or saved: sent as `base`, so
  // a save made against text the agent has since changed is refused, not applied.
  const baseRef = useRef<Map<number, string>>(new Map());
  const pendingRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // Saves on the wire. A reload landing mid-save reads the file BEFORE our
  // write, and remounting on it would flash the old text over what was typed.
  const inflightRef = useRef<Set<Promise<unknown>>>(new Set());
  // The file text we last read or wrote. Handing it to the host comes back as a
  // new `revision`; that one is ours, so it must not trigger another read.
  const syncedRef = useRef<string | null>(null);

  const synced = useCallback(
    (text: string | undefined) => {
      if (typeof text !== 'string') return;
      syncedRef.current = text;
      onSynced(text);
    },
    [onSynced],
  );

  const load = useCallback(async () => {
    const res = await apiClient.post<SnippetRead>('/api/v1/snippet/read', { path });
    if (!res?.regions) {
      if (res?.error_code === 'NOT_A_SNIPPET') onNotSnippet();
      else setReadError(res?.error_code ?? t`Could not read the snippet`);
      return;
    }
    setReadError('');
    synced(res.text);
    const changed = res.regions.some((r) => (localRef.current.get(r.index) ?? null) !== r.shown);
    if (changed && pendingRef.current.size === 0 && inflightRef.current.size === 0) {
      const fresh = new Map(res.regions.map((r) => [r.index, r.shown]));
      localRef.current = fresh;
      baseRef.current = new Map(fresh);
      setGeneration((g) => g + 1);
    }
    setRegions(res.regions);
  }, [path, onNotSnippet, synced, t]);

  useEffect(() => {
    if (revision !== syncedRef.current) void load();
  }, [load, revision]);

  const save = useCallback(
    (region: SnippetRegionView) => {
      // Clear, not just forget: a Run flushes a region early, and its debounce
      // timer would otherwise still fire and save it a second time.
      clearTimeout(pendingRef.current.get(region.index));
      pendingRef.current.delete(region.index);
      const shown = localRef.current.get(region.index) ?? '';
      const inflight = inflightRef.current;
      const request: Promise<unknown> = apiClient
        .post<SnippetRead>('/api/v1/snippet/save', {
          path,
          index: region.index,
          kind: region.kind,
          shown,
          base: baseRef.current.get(region.index),
        })
        .then((read) => {
          // Settled BEFORE acting on the answer: a STALE answer reloads, and that
          // reload must not see this save as still on the wire (it would skip
          // the remount and leave the refused text on screen).
          inflight.delete(request);
          if (read?.regions) {
            setNotice('');
            baseRef.current.set(region.index, read.regions[region.index]?.shown ?? shown);
            setRegions(read.regions);
            synced(read.text);
          } else {
            // STALE: the file changed under us (the agent edited it). Take theirs —
            // writing ours would erase their change. The notice is set AFTER the
            // reload, which clears errors, so the user learns why their text went.
            setNotice(
              read?.error_code === 'STALE' ? t`The file changed outside the editor — reloaded it.` : (read?.error_code ?? ''),
            );
            localRef.current = new Map();
            void load();
          }
        })
        .catch((reason: unknown) => {
          inflight.delete(request);
          setNotice(errorMessage(reason, t`Could not save the snippet`));
        });
      inflight.add(request);
      return request;
    },
    [path, synced, load, t],
  );

  const onEdit = useCallback(
    (region: SnippetRegionView, value: string | undefined) => {
      localRef.current.set(region.index, value ?? '');
      clearTimeout(pendingRef.current.get(region.index));
      pendingRef.current.set(
        region.index,
        setTimeout(() => void save(region), SAVE_DEBOUNCE_MS),
      );
    },
    [save],
  );

  const run = useCallback(async () => {
    setRunning(true);
    try {
      // Run what is on screen: flush unsaved edits first.
      const flushing = [...pendingRef.current.keys()].map((index) => {
        const region = regions?.find((r) => r.index === index);
        return region ? save(region) : null;
      });
      await Promise.all([...flushing, ...inflightRef.current]);
      setResult(await apiClient.post<SnippetRunResult>('/api/v1/snippet/run', { path, timeout_seconds: timeoutSeconds }));
    } catch (reason) {
      setNotice(errorMessage(reason, t`Could not run the snippet`));
    } finally {
      setRunning(false);
    }
  }, [path, regions, save, timeoutSeconds, t]);

  useEffect(
    () => () => {
      pendingRef.current.forEach((handle) => clearTimeout(handle));
    },
    [],
  );

  if (!regions || !themed) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="snippet-view">
        {error || <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      </div>
    );
  }

  const visible = regions.filter((r) => r.kind === 'snippet' || (r.kind === 'init' ? showInit : showImports));
  const has = (kind: SnippetRegionView['kind']) => regions.some((r) => r.kind === kind);
  const label = { hidden: t`imports`, init: t`init`, snippet: '' };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="snippet-view">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Button size="sm" onClick={() => void run()} disabled={running} data-testid="snippet-run">
          <Play className="mr-1 h-3.5 w-3.5" />
          {running ? t`Running…` : t`Run`}
        </Button>
        {has('init') && (
          <Button variant={showInit ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowInit(!showInit)} data-testid="snippet-toggle-init">
            <ListStart className="mr-1 h-3.5 w-3.5" />
            {showInit ? t`Hide init` : t`Show init`}
          </Button>
        )}
        {has('hidden') && (
          <Button variant={showImports ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowImports(!showImports)} data-testid="snippet-toggle-imports">
            <Import className="mr-1 h-3.5 w-3.5" />
            {showImports ? t`Hide imports` : t`Show imports`}
          </Button>
        )}
        {error && <span className="ml-2 text-xs text-destructive">{error}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visible.map((region) => {
          const text = localRef.current.get(region.index) ?? region.shown;
          const lines = Math.max(text.split('\n').length, 1);
          return (
            <div key={`${generation}-${region.index}`} data-testid={`snippet-region-${region.kind}`} className="border-b">
              {label[region.kind] && <div className="px-3 pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label[region.kind]}</div>}
              <Editor
                height={lines * LINE_HEIGHT + 8}
                language={language}
                defaultValue={region.shown}
                onChange={(value) => onEdit(region, value)}
                theme={monacoTheme(resolvedTheme)}
                options={{
                  readOnly,
                  fontSize: 14,
                  lineHeight: LINE_HEIGHT,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  lineNumbers: (n: number) => String(n + region.line - 1),
                  folding: false,
                  glyphMargin: false,
                  renderLineHighlight: 'none',
                  scrollbar: { vertical: 'hidden', alwaysConsumeMouseWheel: false },
                  padding: { top: 4, bottom: 4 },
                }}
              />
            </div>
          );
        })}

        {result && (
          <div className="p-3 font-mono text-xs" data-testid="snippet-console">
            {result.stdout && <pre className="whitespace-pre-wrap" data-testid="snippet-stdout">{result.stdout}</pre>}
            {result.stderr && <pre className="whitespace-pre-wrap text-destructive" data-testid="snippet-stderr">{result.stderr}</pre>}
            <div className="mt-1 text-muted-foreground" data-testid="snippet-status">
              {result.timed_out
                ? t`timed out after ${timeoutSeconds}s — killed`
                : result.returncode === null
                  ? t`did not run`
                  : t`exit ${result.returncode} · ${result.duration_s.toFixed(2)}s`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
