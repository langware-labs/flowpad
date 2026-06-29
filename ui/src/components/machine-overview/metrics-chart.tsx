import { useAgentContext } from '@src/contexts/agent-context';
import { ActionInfo } from '@sdk';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export interface MetricsChartHandle {
  refresh: () => Promise<void>;
}
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface MetricEntry {
  timestamp: string;
  cpu_used_pct: number;
  cpu_count: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

interface ChartDataPoint {
  time: string;
  fullTime: string;
  cpu: number;
  memory: number;
}

interface MetricsChartProps {
  fetchOnMount?: boolean;
  isPaused?: boolean;
}

export const MetricsChart = forwardRef<MetricsChartHandle, MetricsChartProps>(
  ({ fetchOnMount = true, isPaused = false }, ref) => {
    const { computeNode } = useAgentContext();
    const { t } = useLingui();
    const [metrics, setMetrics] = useState<MetricEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchMetrics = useCallback(async () => {
      if (!computeNode?.id) return;

      // Skip fetch if sandbox is paused or in error state - E2B API will timeout
      if (isPaused) {
        setError(t`Sandbox is unavailable. Resume or recreate to view metrics.`);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const actionInfo = new ActionInfo('ops/metrics', 'compute_node', computeNode.id, 'POST');
        const response = await fetch(actionInfo.fullActionUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch metrics: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.data) {
          setMetrics(data.data);
        } else if (data.message) {
          setError(data.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t`Failed to fetch metrics`);
      } finally {
        setIsLoading(false);
      }
    }, [computeNode?.id, isPaused]);

    // Expose refresh function to parent via ref
    useImperativeHandle(ref, () => ({
      refresh: fetchMetrics,
    }));

    useEffect(() => {
      if (fetchOnMount) {
        void fetchMetrics();
      }
    }, [fetchMetrics, fetchOnMount]);

    // Transform metrics for chart
    const chartData: ChartDataPoint[] = metrics.map((m) => {
      const memoryPct = m.mem_total > 0 ? (m.mem_used / m.mem_total) * 100 : 0;
      const date = new Date(m.timestamp);
      return {
        time: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        fullTime: date.toLocaleString(),
        cpu: Math.round(m.cpu_used_pct * 100) / 100,
        memory: Math.round(memoryPct * 100) / 100,
      };
    });

    // Check if any values exceed 80% threshold
    const hasHighCpu = metrics.some((m) => m.cpu_used_pct >= 80);
    const hasHighMemory = metrics.some((m) => m.mem_total > 0 && (m.mem_used / m.mem_total) * 100 >= 80);

    return (
      <div className="flex h-full flex-col p-4">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h3 className="text-sm font-semibold"><Trans>Sandbox Metrics</Trans></h3>
            {(hasHighCpu || hasHighMemory) && (
              <div className="flex items-center gap-2 text-xs text-orange-500">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-orange-500" />
                {hasHighCpu && hasHighMemory
                  ? <Trans>High CPU & Memory usage detected</Trans>
                  : hasHighCpu
                    ? <Trans>High CPU usage detected</Trans>
                    : <Trans>High Memory usage detected</Trans>}
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        {error ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-red-500">{error}</p>
              <p className="mt-1 text-xs"><Trans>Use the refresh button in the toolbar to retry</Trans></p>
            </div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            {isLoading ? <Trans>Loading metrics...</Trans> : <Trans>No metrics data available</Trans>}
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-4">
            {/* CPU Chart */}
            <div className="flex-1 rounded-lg border bg-card p-4">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground"><Trans>CPU Usage (%)</Trans></h4>
              <ResponsiveContainer width="100%" height={150} minWidth={1} minHeight={1}>
                <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                    labelFormatter={(label: string, payload: readonly { payload?: ChartDataPoint }[]) =>
                      payload?.[0]?.payload?.fullTime || label
                    }
                    formatter={(value: number) => [`${value.toFixed(1)}%`, t`CPU`]}
                  />
                  <ReferenceLine
                    y={80}
                    stroke="#f97316"
                    strokeDasharray="5 5"
                    label={{
                      value: '80%',
                      position: 'right',
                      fill: '#f97316',
                      fontSize: 10,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="cpu"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Memory Chart */}
            <div className="flex-1 rounded-lg border bg-card p-4">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground"><Trans>Memory Usage (%)</Trans></h4>
              <ResponsiveContainer width="100%" height={150} minWidth={1} minHeight={1}>
                <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                    labelFormatter={(label: string, payload: readonly { payload?: ChartDataPoint }[]) =>
                      payload?.[0]?.payload?.fullTime || label
                    }
                    formatter={(value: number) => [`${value.toFixed(1)}%`, t`Memory`]}
                  />
                  <ReferenceLine
                    y={80}
                    stroke="#f97316"
                    strokeDasharray="5 5"
                    label={{
                      value: '80%',
                      position: 'right',
                      fill: '#f97316',
                      fontSize: 10,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="memory"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Legend */}
            <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <div className="h-2 w-4 rounded bg-blue-500" />
                <span><Trans>CPU</Trans></span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-4 rounded bg-green-500" />
                <span><Trans>Memory</Trans></span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-0.5 w-4 border-t-2 border-dashed border-orange-500" />
                <span><Trans>80% Alert Threshold</Trans></span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
);

MetricsChart.displayName = 'MetricsChart';
