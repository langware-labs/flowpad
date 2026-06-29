import { Button } from '@src/components/ui/button';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { AlertCircle } from 'lucide-react';
import { ActivityIndicator } from './ActivityIndicator';

export interface IndexRecommendedBannerProps {
  lastIndexedAt: string;
  types: string[];
  onComplete: () => void;
}

export function IndexRecommendedBanner({ lastIndexedAt, types, onComplete }: IndexRecommendedBannerProps) {
  const { indexTypes, currentActivity, busy } = useSystemTools();

  const indexing = currentActivity === 'index';

  async function startIndexing() {
    await indexTypes(types);
    onComplete();
  }

  if (indexing) {
    return (
      <div className="shrink-0 rounded-lg border bg-muted/50 px-4 py-2">
        <ActivityIndicator variant="list" types={types} />
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 rounded-lg border bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/20">
      <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
      <span className="text-muted-foreground">
        Last updated {formatTimeAgo(lastIndexedAt) ?? 'a while ago'} — results may be outdated.
      </span>
      <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-amber-700 hover:text-amber-900 dark:text-amber-400" disabled={busy} onClick={() => void startIndexing()}>
        Refresh now →
      </Button>
    </div>
  );
}
