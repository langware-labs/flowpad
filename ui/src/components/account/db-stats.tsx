import { systemTools, DatabaseStats } from '@sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Database, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

interface DbStatsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DbStatsDialog({ open, onOpenChange }: DbStatsDialogProps) {
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStats = async () => {
    setLoading(true);
    try {
      setStats(await systemTools.getStats());
    } catch (error) {
      console.error('Failed to fetch database stats:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void fetchStats();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            Database Stats
            <button
              onClick={() => void fetchStats()}
              className="ml-auto text-muted-foreground hover:text-foreground"
              title="Refresh stats"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </DialogTitle>
        </DialogHeader>

        {loading && !stats ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
        ) : stats ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border p-3 text-center">
                <div className="text-lg font-semibold">{formatBytes(stats.file_size_bytes)}</div>
                <div className="text-xs text-muted-foreground">File Size</div>
              </div>
              <div className="rounded-md border p-3 text-center">
                <div className="text-lg font-semibold">{stats.total_entities.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Entities</div>
              </div>
              <div className="rounded-md border p-3 text-center">
                <div className="text-lg font-semibold">{stats.total_relationships.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Relations</div>
              </div>
            </div>

            {stats.entity_types.length > 0 && (
              <div className="rounded-md border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Type</th>
                      <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.entity_types.map((et) => (
                      <tr key={et.type} className="border-b last:border-0">
                        <td className="px-3 py-1 font-mono">{et.type}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{et.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">Failed to load stats</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
