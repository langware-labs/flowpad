import { useClaudeContext } from '@src/hooks/use-claude-context';
import { useCostOverview } from '@src/hooks/use-cost-overview';
import { getTodayKey } from '@src/components/cost-dashboard/constants';
import { cn } from '@src/lib/utils';
import { pctBg, pctColor, srcColor } from '@src/lib/pct-color';
import { Trans, useLingui } from '@lingui/react/macro';
import { RefreshCw, X } from 'lucide-react';
import type {
  ClaudeContextAgent,
  ClaudeContextCategory,
  ClaudeContextData,
  ClaudeContextMemoryFile,
  ClaudeContextMcpTool,
  ClaudeContextSkill,
} from '@sdk';

// ─── sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {children}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function TokenBar({ pct, label, tokens }: { pct: number; label: string; tokens: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 truncate text-[12px] text-foreground/80">{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', pctBg(pct))}
          style={{ width: `${Math.max(pct, 0.5)}%` }}
        />
      </div>
      <span className={cn('w-10 text-right font-mono text-[11px] font-medium', pctColor(pct))}>
        {pct}%
      </span>
      <span className="w-14 text-right font-mono text-[11px] text-muted-foreground">{tokens}</span>
    </div>
  );
}

function BigUsageRing({ pct }: { pct: number }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const filled = (pct / 100) * circ;
  const col = pct >= 85 ? '#ef4444' : pct >= 70 ? '#f97316' : pct >= 50 ? '#eab308' : '#10b981';
  return (
    <svg width="130" height="130" viewBox="0 0 130 130">
      <circle cx="65" cy="65" r={r} fill="none" strokeWidth="10" className="stroke-muted" />
      <circle
        cx="65"
        cy="65"
        r={r}
        fill="none"
        strokeWidth="10"
        stroke={col}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circ}`}
        transform="rotate(-90 65 65)"
        style={{ transition: 'stroke-dasharray 0.5s ease' }}
      />
      <text x="65" y="60" textAnchor="middle" className="fill-foreground" fontSize="22" fontWeight="bold">
        {pct}%
      </text>
      <text x="65" y="78" textAnchor="middle" className="fill-muted-foreground" fontSize="11">
        <Trans>used</Trans>
      </text>
    </svg>
  );
}

// ─── Category palette ─────────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  'system prompt':    'text-violet-400',
  'system tools':     'text-blue-400',
  'mcp tools':        'text-cyan-400',
  'custom agents':    'text-teal-400',
  'memory files':     'text-emerald-400',
  'skills':           'text-yellow-400',
  'messages':         'text-slate-300',
  'free space':       'text-muted-foreground',
  'autocompact buffer': 'text-orange-400',
};

// ─── Main viewer ─────────────────────────────────────────────────────────────

export function ClaudeContextViewer({ sessionId, onClose }: { sessionId?: string | null; onClose?: () => void }) {
  const { t } = useLingui();
  const { data, isLoading, refetch } = useClaudeContext(sessionId);
  const { data: costOverview } = useCostOverview({ autoFetch: true });

  const todayKey = getTodayKey();
  const todayCost = costOverview?.by_day?.[todayKey]?.total_cost_usd ?? null;

  const sessionTitle = data?.session_title ?? (sessionId ? null : 'Empty context');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span className="text-sm font-semibold"><Trans>Claude Code — Context Window</Trans></span>
        {data && (
          <span className="font-mono text-[11px] text-muted-foreground">{data.model}</span>
        )}
        {sessionTitle && (
          <span className="truncate text-[11px] text-muted-foreground/70" title={sessionTitle}>
            {sessionTitle}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={refetch}
            disabled={isLoading}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
            {isLoading ? t`Fetching…` : t`Refresh`}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="flex items-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t`Close`}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        {!data && !isLoading && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
              <p className="font-medium"><Trans>No context data</Trans></p>
              <p className="mt-1 text-xs"><Trans>Ensure the claude CLI is installed and authenticated.</Trans></p>
            </div>
          </div>
        )}

        {!data && isLoading && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
              <RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin" />
              <p><Trans>Running /context…</Trans></p>
              <p className="mt-1 text-xs text-muted-foreground/60"><Trans>Takes ~4 seconds</Trans></p>
            </div>
          </div>
        )}

        {data && <Dashboard data={data} todayCost={todayCost} />}
      </div>
    </div>
  );
}

// ─── Dashboard layout ─────────────────────────────────────────────────────────

function Dashboard({
  data,
  todayCost,
}: {
  data: ClaudeContextData;
  todayCost: number | null;
}) {
  const { t } = useLingui();
  // Group MCP tools by server
  const mcpByServer = data.mcp_tools.reduce<Record<string, ClaudeContextMcpTool[]>>((acc, t) => {
    (acc[t.server] ??= []).push(t);
    return acc;
  }, {});

  // Group skills by source
  const skillsBySource = data.skills.reduce<Record<string, ClaudeContextSkill[]>>((acc, s) => {
    const src = s.source === 'undefined' ? t`Built-in` : s.source;
    (acc[src] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-[auto_1fr]">
      {/* ── Left column: ring + rate limits ── */}
      <div className="flex flex-col items-center gap-4 lg:w-52">
        {/* Ring */}
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <BigUsageRing pct={data.tokens_pct} />
          <div className="mt-2 text-center">
            <p className="font-mono text-sm font-semibold text-foreground">
              {data.tokens_used_str} / {data.tokens_total_str}
            </p>
            <p className="text-[11px] text-muted-foreground"><Trans>context tokens</Trans></p>
          </div>
        </div>

        {/* Today's cost */}
        {todayCost !== null && (
          <div className="w-full rounded-xl border bg-card p-3 shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              <Trans>Today's cost</Trans>
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-foreground">
              ${todayCost.toFixed(4)}
            </p>
          </div>
        )}
      </div>

      {/* ── Right column: breakdowns ── */}
      <div className="flex flex-col gap-5 min-w-0">
        {/* Context breakdown */}
        {data.estimated_usage_by_category.length > 0 && (
          <Card title={t`Context breakdown`}>
            <div className="flex flex-col gap-2">
              {data.estimated_usage_by_category.map((row) => (
                <TokenBar
                  key={row.category}
                  label={row.category}
                  pct={row.percentage_float ?? 0}
                  tokens={row.tokens}
                />
              ))}
            </div>
          </Card>
        )}

        {/* MCP tools */}
        {Object.keys(mcpByServer).length > 0 && (
          <Card title={t`MCP tools`}>
            <div className="flex flex-col gap-3">
              {Object.entries(mcpByServer).map(([server, tools]) => {
                const total = tools.reduce((s, t) => s + t.tokens_int, 0);
                return (
                  <div key={server}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-[12px] font-medium text-cyan-400">{server}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {tools.length} tools · {fmtTok(total)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 pl-3 lg:grid-cols-3">
                      {tools.map((t) => (
                        <div key={t.tool} className="flex items-center justify-between gap-1">
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {t.tool.split('__').at(-1)}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                            {t.tokens}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Custom agents */}
        {data.custom_agents.length > 0 && (
          <Card title={t`Custom agents`}>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {data.custom_agents.map((a: ClaudeContextAgent) => (
                <AgentRow key={a.agent_type} agent={a} />
              ))}
            </div>
          </Card>
        )}

        {/* Memory files */}
        {data.memory_files.length > 0 && (
          <Card title={t`Memory files`}>
            <div className="flex flex-col gap-1">
              {data.memory_files.map((f: ClaudeContextMemoryFile) => (
                <div key={f.path} className="flex items-center gap-2 text-[12px]">
                  <span className="w-16 shrink-0 text-emerald-400">{f.type}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={f.path}>
                    {f.path.split('/').at(-1)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                    {f.tokens}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Skills */}
        {Object.keys(skillsBySource).length > 0 && (
          <Card title={t`Skills`}>
            <div className="flex flex-col gap-3">
              {Object.entries(skillsBySource).map(([src, skills]) => {
                const total = skills.reduce((s, sk) => s + sk.tokens_int, 0);
                return (
                  <div key={src}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className={cn('text-[12px] font-medium', srcColor(src))}>{src}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {skills.length} · {fmtTok(total)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 pl-3 lg:grid-cols-3">
                      {skills.map((sk: ClaudeContextSkill) => (
                        <div key={sk.skill} className="flex items-center justify-between gap-1">
                          <span className="truncate text-[11px] text-muted-foreground">{sk.skill}</span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                            {sk.tokens}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <SectionHeader>{title}</SectionHeader>
      {children}
    </div>
  );
}

function AgentRow({ agent }: { agent: ClaudeContextAgent }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={cn('w-14 shrink-0 text-[10px]', srcColor(agent.source))}>{agent.source}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{agent.agent_type}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{agent.tokens}</span>
    </div>
  );
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
