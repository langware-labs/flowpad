import { FSRef, UsageReport } from '@sdk';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { formatDuration, formatNumber } from '@src/components/lens-viewer/shared/format-utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useUsageReportDoc, type UsageReportData, type UsageSessionRow } from './useUsageReportDoc';

interface UsageReportAssetEditorProps {
  fsRef: FSRef;
  report: UsageReport;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded border border-border bg-muted/40 px-3 py-2">
      <span className="text-lg font-semibold text-foreground">{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function BreakdownTable({
  title,
  cols,
  rows,
}: {
  title: string;
  cols: [string, string];
  rows: [string, string][];
}) {
  if (!rows.length) return null;
  return (
    <div className="min-w-0 flex-1">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="font-medium">{cols[0]}</th>
            <th className="w-16 text-right font-medium">{cols[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-border/50">
              <td className="truncate py-0.5 pr-2 text-foreground" title={k}>{k}</td>
              <td className="py-0.5 text-right tabular-nums text-muted-foreground">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTable({ data }: { data: UsageReportData }) {
  const { navigation } = useDockNavigation();
  const rows = [...data.sessions].sort((a, b) => b.cost_usd - a.cost_usd);
  if (!rows.length) return null;

  const open = (s: UsageSessionRow) => {
    // URL-first drill-down into the raw transcript / call-stack lens.
    navigation.openDock(DockPointer.forLensTranscript('claude', s.session_id));
  };

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Sessions ({rows.length})
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="font-medium">session</th>
            <th className="w-16 text-right font-medium">cost</th>
            <th className="w-16 text-right font-medium">time</th>
            <th className="w-14 text-right font-medium">prompts</th>
            <th className="w-12 text-right font-medium">skills</th>
            <th className="w-12 text-right font-medium">agents</th>
            <th className="w-12 text-right font-medium">errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.session_id}
              className="cursor-pointer border-t border-border/50 hover:bg-muted/60"
              title={`Open transcript · ${s.project || s.cwd}`}
              onClick={() => open(s)}
            >
              <td className="truncate py-1 pr-2 text-primary hover:underline">
                {s.title || s.session_id.slice(0, 8)}
              </td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">${s.cost_usd.toFixed(2)}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{formatDuration(s.duration_ms)}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{s.prompt_count}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{s.skills.length}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{s.agents.length}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{s.tool_failures || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * UsageReport viewer: headline stat tiles, token split + breakdown tables, then a
 * per-session drill-down table whose rows deep-link the raw transcript/call-stack
 * lens (URL-first via `navigation.openDock`).
 */
export function UsageReportAssetEditor({ fsRef, report }: UsageReportAssetEditorProps) {
  const { data, error, loading } = useUsageReportDoc(fsRef);

  const fileName = fsRef.path.split('/').pop() ?? 'report.json';
  const dirPath = fsRef.path.slice(0, -fileName.length - 1);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="usage-report-editor">
      <AssetEditorHeader fileName={report.name || fileName} dirPath={dirPath} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && <p className="text-sm text-muted-foreground">Loading report…</p>}
        {error && <p className="text-sm text-destructive">Failed to load report: {error}</p>}
        {data && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="cost" value={`$${(data.total_cost_usd ?? 0).toFixed(2)}`} />
              <StatTile label="sessions" value={String(data.session_count ?? 0)} />
              <StatTile label="active" value={formatDuration(data.total_duration_ms)} />
              <StatTile label="tokens" value={formatNumber(data.total_tokens)} />
            </div>

            <div className="flex flex-wrap gap-6">
              <BreakdownTable
                title="Tokens"
                cols={['dimension', 'tokens']}
                rows={[
                  ['input', formatNumber(data.input_tokens)],
                  ['output', formatNumber(data.output_tokens)],
                  ['cache read', formatNumber(data.cache_read_tokens)],
                  ['cache write', formatNumber(data.cache_creation_tokens)],
                  ['cache hit rate', `${Math.round((data.cache_hit_rate ?? 0) * 100)}%`],
                ]}
              />
              <BreakdownTable
                title="Top skills"
                cols={['skill', 'uses']}
                rows={data.top_skills.map((s) => [s.name, String(s.count)])}
              />
              <BreakdownTable
                title="Agents"
                cols={['agent', 'spawns']}
                rows={data.top_agents.map((a) => [a.type, String(a.count)])}
              />
              <BreakdownTable
                title="Top tools"
                cols={['tool', 'calls']}
                rows={data.top_tools.map((t) => [t.name, String(t.count)])}
              />
              <BreakdownTable
                title="Models"
                cols={['model', 'cost']}
                rows={data.models.map((m) => [m.model, `$${m.cost_usd.toFixed(2)}`])}
              />
            </div>

            {data.sample_prompts.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Sample prompts
                </h3>
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {data.sample_prompts.map((p, i) => (
                    <li key={i} className="truncate" title={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            <SessionsTable data={data} />
          </div>
        )}
      </div>
    </div>
  );
}
