/**
 * One run: what was asked, what came out, and the raw record underneath.
 *
 * Outputs lead. The single worst thing about the old artifact view was that a
 * generated HTML report — a thing whose entire purpose is to be read — was
 * shown as escaped markup in a 340px `<pre>`. Here a renderable file renders,
 * in a pane wide enough for it.
 */
import { useCallback, useEffect, useState } from 'react';
import apiClient from '@sdk/client';
import { formatBytes } from '@src/utils/format-bytes';
import { timeSince } from '@src/utils/duration';
import type { RunSummary } from './RunRow';

interface ArtifactFile {
  name: string;
  direction: 'input' | 'output';
  size: number;
  previewable: boolean;
  renderable: boolean;
  path: string;
}

interface Execution {
  key: string;
  label: string;
  seq: number;
  node: string;
  process_id?: string | null;
  files: ArtifactFile[];
}

interface RunDetailData extends RunSummary {
  instruction: string;
  workdir: string;
  worker_type: string;
  executions: Execution[];
}

interface ArtifactContent {
  name: string;
  size: number;
  path: string;
  text: string;
  renderable: boolean;
}

export function RunDetail({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunDetailData | null>(null);
  const [openFile, setOpenFile] = useState<{ key: string; name: string } | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [asSource, setAsSource] = useState(false);

  useEffect(() => {
    setRun(null);
    setOpenFile(null);
    setContent(null);
    let alive = true;
    void (async () => {
      try {
        const data = (await apiClient.get(`/runs/${runId}`)) as RunDetailData | null;
        if (!alive || !data) return;
        setRun(data);
        // Open the most interesting output straight away — a run's product is
        // why you clicked it, and one more click to see it is one too many.
        const best = pickHeadline(data.executions);
        if (best) setOpenFile(best);
      } catch {
        /* the header still renders from the list row */
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId]);

  const show = useCallback(
    async (key: string, name: string) => {
      setContent(null);
      setAsSource(false);
      const q = `key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`;
      try {
        setContent((await apiClient.get(`/runs/${runId}/artifact?${q}`)) as ArtifactContent);
      } catch (e) {
        setContent({
          name, size: 0, path: '', renderable: false,
          text: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [runId],
  );

  useEffect(() => {
    if (openFile) void show(openFile.key, openFile.name);
  }, [openFile, show]);

  if (!run) return <p className="runs-empty pad">loading…</p>;

  const outputs = run.executions.flatMap((ex) =>
    ex.files.filter((f) => f.direction === 'output').map((f) => ({ ex, f })),
  );
  const inputs = run.executions.flatMap((ex) =>
    ex.files.filter((f) => f.direction === 'input').map((f) => ({ ex, f })),
  );

  return (
    <div className="run-detail">
      <header>
        <h2>
          <span className={`g b-${run.badge}`}>{run.badge}</span>
          {run.name || run.id.slice(0, 8)}
        </h2>
        <div className="meta">
          {run.agent && <span className="chip agent">{run.agent}</span>}
          {run.worker_type && <span className="chip">{run.worker_type}</span>}
          <span>{timeSince(run.started_at)}</span>
          {typeof run.cost_usd === 'number' && run.cost_usd > 0 && (
            <span>${run.cost_usd.toFixed(3)}</span>
          )}
        </div>
        {run.start_failure && <p className="run-fail">{run.start_failure}</p>}
      </header>

      <section className="files">
        <h3>Output {outputs.length > 0 && <span className="muted">{outputs.length}</span>}</h3>
        {outputs.length === 0 ? (
          <p className="muted">
            This run wrote no files. Runs launched outside a flow only produce artifacts
            when the agent is told where to write them.
          </p>
        ) : (
          <ul className="filelist">
            {outputs.map(({ ex, f }) => (
              <li key={`${ex.key}/${f.name}`}>
                <button
                  className={isOpen(openFile, ex.key, f.name) ? 'on' : ''}
                  disabled={!f.previewable}
                  title={f.path}
                  onClick={() => setOpenFile({ key: ex.key, name: f.name })}
                >
                  <span className="fn">{f.name}</span>
                  {ex.label !== 'run' && <span className="chip">{ex.label}</span>}
                  <span className="sz">{formatBytes(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {content && (
        <section className="viewer">
          <div className="viewer-bar">
            <span className="fn">{content.name}</span>
            {content.renderable && (
              <button className="lnk" onClick={() => setAsSource((s) => !s)}>
                {asSource ? 'rendered' : 'source'}
              </button>
            )}
            <span className="muted path" title={content.path}>
              {content.path}
            </span>
          </div>
          {content.renderable && !asSource ? (
            // Sandboxed: an artifact is agent-generated content, so it renders
            // with no script execution and no same-origin access to the app.
            <iframe
              className="viewer-frame"
              title={content.name}
              sandbox=""
              srcDoc={content.text}
            />
          ) : (
            <pre className="viewer-src">{content.text}</pre>
          )}
        </section>
      )}

      <details className="raw">
        <summary>What it was asked ({inputs.length} input file{inputs.length === 1 ? '' : 's'})</summary>
        {run.instruction && <pre className="viewer-src">{run.instruction}</pre>}
        <ul className="filelist">
          {inputs.map(({ ex, f }) => (
            <li key={`${ex.key}/${f.name}`}>
              <button disabled={!f.previewable} title={f.path}
                      onClick={() => setOpenFile({ key: ex.key, name: f.name })}>
                <span className="fn">{f.name}</span>
                <span className="sz">{formatBytes(f.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function isOpen(open: { key: string; name: string } | null, key: string, name: string): boolean {
  return !!open && open.key === key && open.name === name;
}

/** The file a person most likely wants: a rendered document beats raw data,
 *  and a later execution beats an earlier one. */
function pickHeadline(executions: Execution[]): { key: string; name: string } | null {
  const outputs = executions
    .flatMap((ex) => ex.files.filter((f) => f.direction === 'output').map((f) => ({ ex, f })))
    .filter(({ f }) => f.previewable);
  if (!outputs.length) return null;
  const best =
    [...outputs].reverse().find(({ f }) => f.renderable) ?? outputs[outputs.length - 1];
  return { key: best.ex.key, name: best.f.name };
}
