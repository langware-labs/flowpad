import apiClient from '@sdk/client';
import { ConnectionManager, PrefKey, isOk, type CliResult, type TypeId } from '@sdk';
import { useFileWatch } from '@sdk/react/hooks';
import { usePreference } from '@src/hooks/use-preference';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import Editor, { loader } from '@monaco-editor/react';
import type { editor as monacoEditor, MarkerSeverity } from 'monaco-editor';
import { ensureShikiMonaco, monacoTheme } from './shikiMonaco';
import { useLingui } from '@lingui/react/macro';
import { CircleAlert, CircleCheck, Import, ListStart, Play, Square } from 'lucide-react';
import { useTheme } from 'next-themes';
import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The snippet view (`flow show snippet`): a code file whose `%% flowpad:<region>`
 * markers split it into hidden (imports) / init / snippet. Only the snippet
 * region shows by default; the toolbar reveals the others (remembered prefs).
 *
 * Deliberately a renderer only. Reading regions, writing one back, checking and
 * running the file are the backend's (`flow_sdk/core/snippet.py`, `/api/v1/snippet/*`),
 * proven there by unit tests — nothing here decides what a region is or what a
 * problem is. The check's problems come back in FILE lines; this view only maps
 * them onto the region that holds each line.
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

/** One problem `/api/v1/snippet/check` found, in FILE lines, 1-based columns, end exclusive. */
export interface SnippetDiagnostic {
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  severity: 'error' | 'warning';
  kind: 'syntax' | 'name' | 'import' | 'check';
  message: string;
}

/** The region holding file line `line`, and the line within it — `null` for a marker line. */
export function regionLine(regions: SnippetRegionView[], line: number): { index: number; line: number } | null {
  for (const r of regions) {
    const last = r.line + Math.max(r.shown.split('\n').length, 1) - 1;
    if (line >= r.line && line <= last) return { index: r.index, line: line - r.line + 1 };
  }
  return null;
}

/** The run's answer, and whether THIS view stopped it. A stop is a fact the
 *  view knows — it pressed the button — not something to infer from the answer:
 *  reading "any detail means stopped" labelled every failed run "stopped", since
 *  the backend writes a sentence for every run that does not succeed. */
type SnippetOutcome = CliResult & { stopped: boolean };

/** Elapsed run time as the clock shows it: tenths under a minute, then m:ss. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(ms, 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The clock beside Stop: how long the run in flight has been going. */
function RunClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(tick);
  }, []);
  return (
    <span className="ml-1 font-mono text-xs tabular-nums text-muted-foreground" data-testid="snippet-clock">
      {formatElapsed(now - since)}
    </span>
  );
}

/** The one caller of the stop route: the button and the unmount both go through here. */
const stopRun = (runId: string) => apiClient.post<{ stopped?: boolean }>('/api/v1/snippet/stop', { run_id: runId });

const LINE_HEIGHT = 19;
/** The owner name the check's markers are set under (one set per region editor). */
const MARKER_OWNER = 'flowpad-snippet-check';
type SetModelMarkers = (model: monacoEditor.ITextModel, owner: string, markers: monacoEditor.IMarkerData[]) => void;
const SAVE_DEBOUNCE_MS = 500;

interface SnippetViewProps {
  /** Absolute machine path of the snippet file. */
  path: string;
  /** The same file as the editor addresses it — what the file watch names. */
  watch?: { typeid: TypeId; path: string };
  /** Monaco language id. */
  language: string;
  /** The file's current text (fs cache); a change that isn't ours reloads the regions. */
  revision: string;
  readOnly?: boolean;
  /** The file is not (or no longer) a snippet — the host falls back to the raw editor. */
  onNotSnippet: () => void;
  /** The file was read or written; `text` is the whole file now on disk, for the host's raw copy. */
  onSynced: (text: string) => void;
  /** Who runs this file, when not this view: a long-lived process the host owns (a deployment's
   *  loop). Its button replaces Run/Stop — the edit is saved first, then `run` — and there is no
   *  console here: the host shows the process's own. */
  runner?: { label: string; run: () => Promise<void> };
}

export function SnippetView({ path, watch, language, revision, readOnly, onNotSnippet, onSynced, runner }: SnippetViewProps) {
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
  // When the run in flight started — the clock beside Stop counts from it.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [result, setResult] = useState<SnippetOutcome | null>(null);
  // What the check says about the file on disk — null until the first answer.
  const [problems, setProblems] = useState<SnippetDiagnostic[] | null>(null);
  // Only the newest check's answer counts: a slow check of an older text must not
  // overwrite the answer for the text on screen.
  const checkSeqRef = useRef(0);
  // The run in flight, by the id the backend knows it by — what Stop names.
  const runIdRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);
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

  const loadedRef = useRef(false);

  /** Ask what would stop the file as it is on disk now (after a read or a save). */
  const check = useCallback(async () => {
    const seq = ++checkSeqRef.current;
    try {
      const res = await apiClient.post<{ diagnostics?: SnippetDiagnostic[] }>('/api/v1/snippet/check', {
        path,
        timeout_seconds: timeoutSeconds,
      });
      if (seq === checkSeqRef.current) setProblems(res?.diagnostics ?? []);
    } catch {
      // A check that could not be asked says nothing about the file: keep the last answer.
    }
  }, [path, timeoutSeconds]);

  const load = useCallback(async () => {
    let res: SnippetRead;
    try {
      res = await apiClient.post<SnippetRead>('/api/v1/snippet/read', { path });
    } catch (reason) {
      // Never a spinner forever: before the first read the raw editor takes the
      // file (it can show it without this route); after it, keep the view.
      if (loadedRef.current) setNotice(errorMessage(reason, t`Could not read the snippet`));
      else onNotSnippet();
      return;
    }
    if (!res?.regions) {
      if (res?.error_code === 'NOT_A_SNIPPET') onNotSnippet();
      else setReadError(res?.error_code ?? t`Could not read the snippet`);
      return;
    }
    loadedRef.current = true;
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
    void check();
  }, [path, onNotSnippet, synced, check, t]);

  useEffect(() => {
    if (revision !== syncedRef.current) void load();
  }, [load, revision]);

  // Someone else (the agent) wrote the file: re-read it. Our own saves come
  // back here too, and read as unchanged.
  useFileWatch(watch?.typeid, watch?.path, () => void load());

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
            void check();
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
    [path, synced, load, check, t],
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
    // One run at a time: clicks landing before the button turns into Stop would
    // each start a process, and Stop only knows the last.
    if (runIdRef.current) return;
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    stopRequestedRef.current = false;
    // A new run starts on a clean console: the last run's output is gone the moment Run is
    // clicked, not when the new answer lands (a long run would otherwise show stale output).
    setResult(null);
    setNotice('');
    setStartedAt(Date.now());
    setRunning(true);
    try {
      // Run what is on screen: flush unsaved edits first.
      const flushing = [...pendingRef.current.keys()].map((index) => {
        const region = regions?.find((r) => r.index === index);
        return region ? save(region) : null;
      });
      await Promise.all([...flushing, ...inflightRef.current]);
      // The connection id ends the run if this tab closes mid-run (no unmount runs then).
      const answer = await apiClient.post<CliResult>('/api/v1/snippet/run', {
        path,
        timeout_seconds: timeoutSeconds,
        run_id: runId,
        connection_id: ConnectionManager.getInstance().id,
      });
      // A run that finished cleanly as Stop landed was not stopped.
      setResult({ ...answer, stopped: stopRequestedRef.current && !isOk(answer) });
    } catch (reason) {
      setNotice(errorMessage(reason, t`Could not run the snippet`));
    } finally {
      runIdRef.current = null;
      setStartedAt(null);
      setRunning(false);
    }
  }, [path, regions, save, timeoutSeconds, t]);

  /** The host's runner: what is on screen is saved first, then the host runs it. */
  const runByHost = useCallback(async () => {
    if (!runner) return;
    setStartedAt(Date.now());
    setRunning(true);
    try {
      const flushing = [...pendingRef.current.keys()].map((index) => {
        const region = regions?.find((r) => r.index === index);
        return region ? save(region) : null;
      });
      await Promise.all([...flushing, ...inflightRef.current]);
      await runner.run();
    } catch (reason) {
      setNotice(errorMessage(reason, t`Could not run the snippet`));
    } finally {
      setStartedAt(null);
      setRunning(false);
    }
  }, [runner, regions, save, t]);

  /** Kill the run in flight; it then answers with what it printed so far. */
  const stop = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    stopRequestedRef.current = true;
    try {
      await stopRun(runId);
    } catch (reason) {
      setNotice(errorMessage(reason, t`Could not stop the snippet`));
    }
  }, [t]);

  useEffect(
    () => () => {
      pendingRef.current.forEach((handle) => clearTimeout(handle));
      // Leaving the view must not leave its run going.
      const runId = runIdRef.current;
      if (runId) stopRun(runId).catch(() => undefined);
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
  const markersOf = (index: number) =>
    (problems ?? []).flatMap((d) => {
      const at = regionLine(regions, d.line);
      if (!at || at.index !== index) return [];
      const end = regionLine(regions, d.end_line);
      return [{ ...d, line: at.line, end_line: end?.index === index ? end.line : at.line }];
    });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="snippet-view">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {runner ? (
          <Button size="sm" onClick={() => void runByHost()} disabled={running} data-testid="snippet-run">
            <Play className="mr-1 h-3.5 w-3.5" />
            {runner.label}
          </Button>
        ) : running ? (
          <Button size="sm" variant="destructive" onClick={() => void stop()} data-testid="snippet-stop">
            <Square className="mr-1 h-3.5 w-3.5" />
            {t`Stop`}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void run()} data-testid="snippet-run">
            <Play className="mr-1 h-3.5 w-3.5" />
            {t`Run`}
          </Button>
        )}
        {startedAt !== null && <RunClock since={startedAt} />}
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
        {problems &&
          (problems.length === 0 ? (
            <span className="ml-2 flex items-center gap-1 text-xs text-muted-foreground" data-testid="snippet-check">
              <CircleCheck className="h-3.5 w-3.5" />
              {t`checks pass`}
            </span>
          ) : (
            <span
              className="ml-2 flex items-center gap-1 text-xs text-destructive"
              data-testid="snippet-check"
              title={problems.map((d) => `${d.line}:${d.col} ${d.message}`).join('\n')}
            >
              <CircleAlert className="h-3.5 w-3.5" />
              {problems.length === 1 ? t`1 problem` : t`${problems.length} problems`}
            </span>
          ))}
        {error && <span className="ml-2 text-xs text-destructive">{error}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visible.map((region) => (
          <div key={`${generation}-${region.index}`} data-testid={`snippet-region-${region.kind}`} className="border-b">
            {label[region.kind] && <div className="px-3 pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label[region.kind]}</div>}
            <RegionEditor
              region={region}
              language={language}
              theme={monacoTheme(resolvedTheme)}
              readOnly={readOnly}
              markers={markersOf(region.index)}
              onChange={(value) => onEdit(region, value)}
            />
          </div>
        ))}

        {result && (
          <div className="p-3 font-mono text-xs" data-testid="snippet-console">
            {result.stdout && <pre className="whitespace-pre-wrap" data-testid="snippet-stdout">{result.stdout}</pre>}
            {result.stderr && <pre className="whitespace-pre-wrap text-destructive" data-testid="snippet-stderr">{result.stderr}</pre>}
            <div className="mt-1 text-muted-foreground" data-testid="snippet-status">
              {result.timed_out
                ? t`timed out after ${timeoutSeconds}s — killed`
                : result.stopped
                  ? t`stopped — killed after ${(result.duration_s ?? 0).toFixed(2)}s`
                  : result.returncode == null
                    ? // Never started: no such file, no runner for it. The answer says which.
                      result.detail || t`did not run`
                    : t`exit ${result.returncode} · ${(result.duration_s ?? 0).toFixed(2)}s`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One region's editor, as tall as its content. Sized from Monaco's own content
 * height, which follows every keystroke: a height computed from the line count
 * at render time lagged until the next save, and a new line pushed the first one
 * out of sight meanwhile.
 */
function RegionEditor({
  region,
  language,
  theme,
  readOnly,
  markers,
  onChange,
}: {
  region: SnippetRegionView;
  language: string;
  theme: string;
  readOnly?: boolean;
  /** This region's problems, in the region's own lines. */
  markers: SnippetDiagnostic[];
  onChange: (value: string | undefined) => void;
}) {
  const [height, setHeight] = useState(() => Math.max(region.shown.split('\n').length, 1) * LINE_HEIGHT + 8);
  const [mounted, setMounted] = useState<{ editor: monacoEditor.IStandaloneCodeEditor; setMarkers: SetModelMarkers } | null>(null);
  const onMount = useCallback((editor: monacoEditor.IStandaloneCodeEditor, monaco: { editor: { setModelMarkers: SetModelMarkers } }) => {
    const fit = () => setHeight(editor.getContentHeight());
    editor.onDidContentSizeChange(fit);
    fit();
    setMounted({ editor, setMarkers: monaco.editor.setModelMarkers });
  }, []);
  useEffect(() => {
    const model = mounted?.editor.getModel();
    if (!mounted || !model) return;
    mounted.setMarkers(
      model,
      MARKER_OWNER,
      markers.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.col,
        endLineNumber: d.end_line,
        endColumn: d.end_col,
        message: d.message,
        severity: (d.severity === 'error' ? 8 : 4) as MarkerSeverity, // monaco.MarkerSeverity.Error / .Warning
      })),
    );
  }, [mounted, markers]);
  return (
    <Editor
      height={height}
      language={language}
      defaultValue={region.shown}
      onChange={onChange}
      onMount={onMount}
      theme={theme}
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
  );
}
