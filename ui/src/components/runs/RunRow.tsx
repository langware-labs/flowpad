/**
 * One run, as a line you can read.
 *
 * The old flow-runs list identified a run by an 8-char id prefix plus event
 * counts — you had to already know the timestamp to find the one you wanted.
 * A row here says who ran, what was asked, and how it went.
 */
import { timeSince } from '@src/utils/duration';

export interface RunSummary {
  id: string;
  name: string;
  prompt: string;
  /** The lifecycle badge the backend computed (`_badge`). Typed loosely on
   *  purpose — the row renders any value, and GLYPH/CSS fall back. */
  badge: string;
  status: string;
  started_at: string;
  updated_at: string;
  agent: string;
  flow_run_id: string | null;
  flow_id: string | null;
  node_id: string | null;
  deployment_id: string | null;
  session_id: string | null;
  start_failure: string | null;
  cost_usd?: number | null;
}

const GLYPH: Record<string, string> = {
  running: '▶',
  done: '✓',
  failed: '✗',
  queued: '·',
};

/** The name carries the flow prefix for flow-spawned runs; strip it so the
 *  eye lands on what actually ran, and show the flow as its own chip. */
function titleOf(run: RunSummary): { title: string; flow?: string } {
  const match = /^Flow ([^:]+):\s*(.*)$/.exec(run.name || '');
  if (match) return { flow: match[1], title: match[2] || run.name };
  return { title: run.name || run.prompt || run.id.slice(0, 8) };
}

export function RunRow({
  run,
  active,
  onSelect,
}: {
  run: RunSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const { title, flow } = titleOf(run);
  return (
    <li className={`run-row b-${run.badge}${active ? ' on' : ''}`}>
      <button onClick={onSelect} title={run.prompt || title}>
        <span className="g">{GLYPH[run.badge] ?? '·'}</span>
        <span className="t">{title}</span>
        {run.agent && <span className="chip agent">{run.agent}</span>}
        {flow && <span className="chip flow">{flow}</span>}
        <span className="when">{timeSince(run.started_at, '')}</span>
      </button>
      {run.start_failure && <p className="run-fail">{run.start_failure}</p>}
    </li>
  );
}
