import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { chartFormatOf, dataContext, type Chart, type FSRef } from '@sdk';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { convertChartToExcalidraw } from './convertToExcalidraw';
import { parseSequence, sequenceToMermaid } from './sequenceToMermaid';

const ExcalidrawChartView = lazy(() => import('./ExcalidrawChartView'));
const SequenceChartView = lazy(() => import('./SequenceChartView'));
const MermaidChartView = lazy(() => import('./MermaidChartView'));

/**
 * The chart editor: one asset type, three drawings. CHART.md's `format` picks the
 * view — `excalidraw` (board.json), `sequence` (chart.json) or `mermaid` (the block
 * in CHART.md). Sequence and mermaid charts can be converted to an Excalidraw board.
 */
export function ChartAssetEditor({ fsRef, chart }: { fsRef: FSRef; chart?: Chart }) {
  const { t } = useLingui();
  // Our own convert is shown at once; the row catches up when the indexer re-reads CHART.md.
  const [converted, setConverted] = useState(false);
  const format = converted ? 'excalidraw' : chartFormatOf(chart?.format);
  const session = chart?.session;
  const [converting, setConverting] = useState(false);
  const mermaidSource = useRef('');
  const projectId = dataContext.projectTypeId?.id ?? undefined;

  const onMermaidSource = useCallback((source: string) => {
    mermaidSource.current = source;
  }, []);

  const convert = useCallback(async () => {
    setConverting(true);
    try {
      const mermaid =
        format === 'sequence'
          ? sequenceToMermaid(parseSequence(await fsRef.child('chart.json').readIfExists()))
          : mermaidSource.current;
      await convertChartToExcalidraw(fsRef, chart, mermaid);
      setConverted(true);
      notify.success({ title: t`Converted to an Excalidraw board` });
    } catch (err) {
      notify.error({
        title: t`Could not convert the chart`,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setConverting(false);
    }
  }, [format, fsRef, chart, t]);

  const fallback = (
    <div data-testid="chart-loading" className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="me-2 h-4 w-4 animate-spin" />
      <Trans>Loading chart…</Trans>
    </div>
  );

  const convertButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={converting}
      onClick={() => void convert()}
      data-testid="chart-convert-excalidraw"
    >
      <Trans>Convert to Excalidraw</Trans>
    </Button>
  );

  return (
    <div className="h-full min-h-0" data-testid="chart-editor" data-format={format}>
      <Suspense fallback={fallback}>
        {format === 'sequence' ? (
          <SequenceChartView
            fsRef={fsRef}
            chart={chart}
            session={session}
            projectId={projectId}
            actions={convertButton}
          />
        ) : format === 'mermaid' ? (
          <MermaidChartView fsRef={fsRef} chart={chart} actions={convertButton} onSource={onMermaidSource} />
        ) : (
          <ExcalidrawChartView fsRef={fsRef} chart={chart} />
        )}
      </Suspense>
    </div>
  );
}

export default ChartAssetEditor;
