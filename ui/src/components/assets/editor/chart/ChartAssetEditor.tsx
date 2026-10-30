import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { chartFormatOf, dataContext, isUnknownChartFormat, type Chart, type FSRef } from '@sdk';
import { Button } from '@src/components/ui/button';
import { EditorWithSidePanel } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { useDocChanges } from '@src/components/assets/editor/changes/useDocChanges';
import { useDocChangeList } from '@src/components/assets/editor/changes/use-doc-changes-store';
import { ChangeWholeChart, type ChartChanges } from './chartControls';
import { notify } from '@src/notifications';
import { convertChartToExcalidraw } from './convertToExcalidraw';
import { parseSequence, sequenceToMermaid } from './sequenceToMermaid';

const ExcalidrawChartView = lazy(() => import('./ExcalidrawChartView'));
const SequenceChartView = lazy(() => import('./SequenceChartView'));
const MermaidChartView = lazy(() => import('./MermaidChartView'));
const C4ChartView = lazy(() => import('./C4ChartView'));

/**
 * The chart editor: one asset type, one view per format. CHART.md's `format` picks the
 * view — `excalidraw` (board.json), `sequence` (chart.json), `c4` (c4.json) or `mermaid`
 * (the block in CHART.md). Sequence and mermaid charts can be converted to an Excalidraw board. A format this build does not know says so instead of opening as a board.
 *
 * Every chart has a Changes side tab, the same one a doc has: pick an element (or the whole chart),
 * say what to change, and Execute hands the list to the chart's context worker, which edits the
 * chart's source file; the view re-reads it when the run ends.
 */

const SOURCE_FILE = { sequence: 'chart.json', c4: 'c4.json', excalidraw: 'board.json', mermaid: 'CHART.md' } as const;
export function ChartAssetEditor({ fsRef, chart }: { fsRef: FSRef; chart?: Chart }) {
  const { t } = useLingui();
  // Our own convert is shown at once; the row catches up when the indexer re-reads CHART.md.
  const [converted, setConverted] = useState(false);
  const format = converted ? 'excalidraw' : chartFormatOf(chart?.format);
  const [converting, setConverting] = useState(false);
  const mermaidSource = useRef('');
  const projectId = dataContext.projectTypeId?.id ?? undefined;

  const doc = chart?.typeId ? chart.typeId.toString() : null;
  const [reloadKey, setReloadKey] = useState(0);
  const reread = useCallback(() => setReloadKey((k) => k + 1), []);
  const { changesTab, onRequestChange } = useDocChanges(
    doc,
    chart?.name ?? '',
    `${fsRef.path}/${SOURCE_FILE[format]}`,
    reread,
    'chart',
  );
  const list = useDocChangeList(doc);
  const changes = useMemo<ChartChanges | undefined>(() => {
    if (!onRequestChange) return undefined;
    const marks = new Map<string, number[]>();
    list.changes.forEach((c, i) => marks.set(c.quote, [...(marks.get(c.quote) ?? []), i + 1]));
    return {
      marks,
      request: ({ quote, instruction, runNow }) => onRequestChange({ quote, from: 0, to: 0, instruction }, { runNow }),
    };
  }, [onRequestChange, list.changes]);

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
      <EditorWithSidePanel target={doc} extraTabs={changesTab ? [changesTab] : []}>
      <Suspense fallback={fallback} key={reloadKey}>
        {!converted && isUnknownChartFormat(chart?.format) ? (
          <div
            data-testid="chart-unknown-format"
            className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
          >
            <Trans>This chart is a “{chart?.format}” chart, which needs a newer Flowpad to open.</Trans>
          </div>
        ) : format === 'sequence' ? (
          <SequenceChartView fsRef={fsRef} chart={chart} projectId={projectId} actions={convertButton} changes={changes} />
        ) : format === 'c4' ? (
          <C4ChartView fsRef={fsRef} chart={chart} projectId={projectId} changes={changes} />
        ) : format === 'mermaid' ? (
          <MermaidChartView
            fsRef={fsRef}
            chart={chart}
            actions={
              <>
                {changes && <ChangeWholeChart changes={changes} />}
                {convertButton}
              </>
            }
            onSource={onMermaidSource}
          />
        ) : (
          <ExcalidrawChartView fsRef={fsRef} chart={chart} />
        )}
      </Suspense>
      </EditorWithSidePanel>
    </div>
  );
}

export default ChartAssetEditor;
