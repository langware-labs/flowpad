import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import Editor, { loader } from '@monaco-editor/react';
import { ChevronDown, ChevronUp, RotateCw, SquareTerminal } from 'lucide-react';
import { useTheme } from 'next-themes';
import { DEPLOYMENT_TIMELINE_TAG, type Deployment, type DeploymentProcess } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';
import { ensureShikiMonaco, monacoTheme } from '@src/components/code-editor/shikiMonaco';
import { SnippetView } from '@src/components/code-editor/SnippetView';
import { SidecarShellTerminal } from '@src/components/terminal/interactive-terminal/SidecarShellTerminal';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';

type Tab = 'console' | 'code';

/** Whether the panel is folded away — a viewer's layout, not what is shown, so not in the URL. */
const MINIMIZED_KEY = 'deployment-process-panel-minimized';
const SAVE_DEBOUNCE_MS = 500;
/** How often the header re-reads the process when nothing announced a change (a Ctrl-C in the terminal). */
const PROCESS_REREAD_MS = 5000;

function readMinimized(): boolean {
  try {
    return localStorage.getItem(MINIMIZED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** The process, read again when the deployment announces it moved, and every few seconds. */
function useDeploymentProcess(deployment: Deployment) {
  const [process, setProcess] = useState<DeploymentProcess | null>(null);
  const reload = useCallback(async () => {
    try {
      setProcess(await deployment.process());
    } catch {
      setProcess(null);
    }
  }, [deployment]);
  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), PROCESS_REREAD_MS);
    return () => clearInterval(id);
  }, [reload]);
  useOnTag(
    DEPLOYMENT_TIMELINE_TAG,
    (event) => {
      if ((event.data as { deployment_id?: string } | undefined)?.deployment_id === deployment.id) void reload();
    },
    { target: `deployment:${deployment.id}` },
  );
  return { process, reload };
}

/**
 * A local deployment's process, under its thread: the terminal its Python file runs in — its live
 * stdio, keyboard included — and the file itself, editable, with Restart to run the edit. Folds away
 * to its header.
 */
export function DeploymentProcessPanel({ deployment }: { deployment: Deployment }) {
  const { t } = useLingui();
  const { process, reload } = useDeploymentProcess(deployment);
  const [tab, setTab] = useState<Tab>('console');
  const [minimized, setMinimized] = useState(readMinimized);
  const [restarting, setRestarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const toggle = () => {
    setMinimized((was) => {
      try {
        localStorage.setItem(MINIMIZED_KEY, String(!was));
      } catch {
        /* a private window keeps it for this view only */
      }
      return !was;
    });
  };

  const restart = async () => {
    setRestarting(true);
    setNotice(null);
    try {
      await deployment.restart();
      setTab('console');
      await reload();
    } catch (err) {
      setNotice(errorMessage(err, t`Could not restart`));
    } finally {
      setRestarting(false);
    }
  };

  const running = process?.pid != null;
  return (
    <section
      className={cn('flex min-h-0 flex-col border-t', minimized ? 'shrink-0' : 'h-[45%]')}
      aria-label={t`Process`}
      data-testid="deployment-process-panel"
      data-minimized={minimized || undefined}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-4">
        <SquareTerminal className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-[13px] font-semibold">
          <Trans>Process</Trans>
        </h3>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10.5px] font-medium',
            running ? 'bg-green-500/15 text-green-700 dark:text-green-400' : 'bg-muted text-muted-foreground',
          )}
          data-testid="deployment-process-state"
        >
          {running ? <Trans>Running · pid {process?.pid}</Trans> : <Trans>Stopped</Trans>}
        </span>
        {!minimized && (
          <div className="ms-2 flex rounded-md border p-0.5 text-[12px]" role="tablist">
            {(['console', 'code'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={tab === v}
                onClick={() => setTab(v)}
                className={cn('rounded px-2.5 py-0.5', tab === v ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
                data-testid={`deployment-process-tab-${v}`}
              >
                {v === 'console' ? <Trans>Console</Trans> : <Trans>Code</Trans>}
              </button>
            ))}
          </div>
        )}
        <div className="ms-auto flex items-center gap-1">
          {notice && <span className="text-[11.5px] text-destructive">{notice}</span>}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => void restart()}
            disabled={restarting || !process?.serving}
            data-testid="deployment-process-restart"
          >
            <RotateCw className={cn('h-3.5 w-3.5', restarting && 'animate-spin')} />
            <Trans>Restart</Trans>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={toggle}
            aria-label={minimized ? t`Show the process` : t`Minimize the process`}
            aria-expanded={!minimized}
            data-testid="deployment-process-toggle"
          >
            {minimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </header>
      {!minimized && (
        <div className="min-h-0 flex-1">
          {tab === 'console' ? (
            process?.shell_id ? (
              <SidecarShellTerminal key={process.shell_id} shellId={process.shell_id} active className="h-full" />
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                <Trans>Not started yet — its terminal appears when the deployment first runs.</Trans>
              </p>
            )
          ) : (
            <DeploymentCode deployment={deployment} onRestart={restart} />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The file the deployment runs, as the code snippet it is (``deployment_loop``): the loop shown, its
 * imports and the line that runs it folded away. Saved as it is edited; its Restart runs the edit —
 * the file is the deployment's process, not a run of this view. A file that is no longer a snippet
 * (its markers removed) opens as plain code.
 */
function DeploymentCode({ deployment, onRestart }: { deployment: Deployment; onRestart: () => Promise<void> }) {
  const { t } = useLingui();
  const [code, setCode] = useState<{ file: string; text: string } | null>(null);
  const [plain, setPlain] = useState(false);
  useEffect(() => {
    let alive = true;
    void deployment.code().then((read) => alive && read && setCode(read));
    return () => {
      alive = false;
    };
  }, [deployment]);
  if (!code) return null;
  if (plain) return <DeploymentCodeEditor deployment={deployment} />;
  return (
    <div className="h-full min-h-0" data-testid="deployment-process-code">
      <SnippetView
        path={code.file}
        language="python"
        revision={code.text}
        onNotSnippet={() => setPlain(true)}
        onSynced={(text) => setCode((was) => (was ? { ...was, text } : was))}
        runner={{ label: t`Restart`, run: onRestart }}
      />
    </div>
  );
}

/** The file as plain code — for one that is not a snippet. Saved as it is edited. */
function DeploymentCodeEditor({ deployment }: { deployment: Deployment }) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const [text, setText] = useState<string | null>(null);
  const [file, setFile] = useState('');
  const [themed, setThemed] = useState(false);
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    void deployment.code().then((code) => {
      if (!alive || !code) return;
      setText(code.text);
      setFile(code.file);
    });
    void loader
      .init()
      .then((monaco) => ensureShikiMonaco(monaco, 'python'))
      .then(() => alive && setThemed(true));
    return () => {
      alive = false;
    };
  }, [deployment]);

  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  const onChange = (value: string | undefined) => {
    if (pending.current) clearTimeout(pending.current);
    setState('saving');
    pending.current = setTimeout(() => {
      deployment
        .saveCode(value ?? '')
        .then(() => setState('saved'))
        .catch(() => setState('error'));
    }, SAVE_DEBOUNCE_MS);
  };

  if (text === null || !themed) return null;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="deployment-process-code-plain">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-4 text-[11px] text-muted-foreground">
        <span className="truncate font-mono">{file}</span>
        <span className="ms-auto" data-testid="deployment-process-code-state">
          {state === 'saving' ? t`Saving…` : state === 'error' ? t`Not saved` : t`Saved — Restart runs it`}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language="python"
          defaultValue={text}
          onChange={onChange}
          theme={monacoTheme(resolvedTheme)}
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderLineHighlight: 'none',
            padding: { top: 6, bottom: 6 },
          }}
        />
      </div>
    </div>
  );
}
