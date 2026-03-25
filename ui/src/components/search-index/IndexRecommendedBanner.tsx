import { Button } from '@src/components/ui/button';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';

function hoursAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'less than an hour ago';
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export interface IndexRecommendedBannerProps {
  lastIndexedAt: string;
  types: string[];
  onComplete: () => void;
}

export function IndexRecommendedBanner({ lastIndexedAt, types, onComplete }: IndexRecommendedBannerProps) {
  const { indexTypes, currentActivity, activityProgress, busy } = useSystemTools();

  const indexing = currentActivity === 'index';
  const progress = indexing ? activityProgress : null;

  async function startIndexing() {
    await indexTypes(types);
    onComplete();
  }

  if (!progress) {
    return (
      <div className="flex shrink-0 items-center gap-2 rounded-lg border bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/20">
        <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
        <span className="text-muted-foreground">
          Last updated {hoursAgo(lastIndexedAt)} — results may be outdated.
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-amber-700 hover:text-amber-900 dark:text-amber-400" disabled={busy} onClick={() => void startIndexing()}>
          Refresh now →
        </Button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/50 px-4 py-2 text-sm">
      {types.map((t) => {
        const isDone = progress.done.includes(t);
        const isCurrent = progress.current === t;
        return (
          <span key={t} className="flex items-center gap-1">
            {isDone ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            ) : isCurrent ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : (
              <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
            )}
            <span className={isDone ? 'text-muted-foreground line-through' : isCurrent ? 'font-medium' : 'text-muted-foreground/60'}>
              {t}
            </span>
          </span>
        );
      })}
    </div>
  );
}
