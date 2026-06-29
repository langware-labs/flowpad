import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DiffContent } from '@src/components/code-editor/DiffContent';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { MarkdownReviewDiff } from './MarkdownReviewDiff';

interface AssetDiffTabsProps {
  /** Markdown bodies (frontmatter stripped) for the word-level Review tab. */
  oldBody: string;
  newBody: string;
  /** Unified diff for the Monaco Code tab. */
  diff: string;
  loading?: boolean;
  error?: string | null;
  /** Copy for the "no changes" placeholder in each tab. */
  emptyLabel?: string;
}

/**
 * The Review (word-level markdown) + Code (Monaco unified) diff tabs shared by
 * every asset-diff modal — revision comparison and improvement results alike.
 * Pure render: the caller fetches the two sides however it sources them.
 */
export function AssetDiffTabs({
  oldBody,
  newBody,
  diff,
  loading,
  error,
  emptyLabel,
}: AssetDiffTabsProps) {
  const { t } = useLingui();
  const resolvedEmptyLabel = emptyLabel ?? t`No differences from the current version.`;

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm"><Trans>Loading comparison…</Trans></span>
        </div>
      </div>
    );
  }
  if (error) {
    return <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-destructive">{error}</div>;
  }

  const empty = <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">{resolvedEmptyLabel}</div>;

  return (
    <Tabs defaultValue="review" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="w-fit shrink-0">
        <TabsTrigger value="review" data-testid="compare-tab-review"><Trans>Review</Trans></TabsTrigger>
        <TabsTrigger value="code" data-testid="compare-tab-code"><Trans>Code diff</Trans></TabsTrigger>
      </TabsList>
      <TabsContent value="review" className="mt-2 min-h-0 flex-1 overflow-hidden rounded-md border">
        {oldBody === newBody ? empty : <MarkdownReviewDiff oldContent={oldBody} newContent={newBody} />}
      </TabsContent>
      <TabsContent value="code" className="mt-2 min-h-0 flex-1 overflow-auto rounded-md border">
        {diff ? <DiffContent diffString={diff} /> : empty}
      </TabsContent>
    </Tabs>
  );
}
