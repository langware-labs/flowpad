import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Chart, FSRef } from '@sdk';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { mermaidRenderer } from '@src/components/milkdown-editor/plugins/fence-render/renderers/mermaid';
import type { FenceRenderContext } from '@src/components/milkdown-editor/plugins/fence-render/registry';
import { extractMermaidBlock, readChartDocument, replaceMermaidSource, writeChartMermaid } from './chartDoc';
import { ChartHeading } from './ChartHeading';

/**
 * A `mermaid` chart: its source IS the mermaid block in CHART.md. A text pane edits it
 * (debounced write-back into the block); the diagram beside it is drawn by the same
 * renderer markdown fences use, keeping the last good diagram on a parse error.
 */

const DEBOUNCE_MS = 750;
const NOTE = '_The mermaid source of this chart — edit it here or in the chart editor._';

interface MermaidChartViewProps {
  fsRef: FSRef;
  chart?: Chart;
  actions?: React.ReactNode;
  /** Reports the current source upward (for "Convert to Excalidraw"). */
  onSource?: (source: string) => void;
}

export function MermaidChartView({ fsRef, chart, actions, onSource }: MermaidChartViewProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const docRef = useMemo(() => fsRef.child('CHART.md'), [fsRef]);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWritten = useRef<string | null>(null);

  const { folderName, dirPath } = useMemo(() => {
    const parts = (fsRef.path || '').split('/').filter(Boolean);
    const tail = parts.pop() || 'chart';
    return { folderName: tail, dirPath: parts.length ? '/' + parts.join('/') : '' };
  }, [fsRef]);

  useEffect(() => {
    let cancelled = false;
    void readChartDocument(docRef, chart)
      .then((doc) => {
        if (cancelled) return;
        const text = extractMermaidBlock(doc.body);
        lastWritten.current = text;
        setSource(text);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setSource('');
      });
    return () => {
      cancelled = true;
    };
  }, [docRef, chart]);

  useEffect(() => {
    if (source !== null) onSource?.(source);
  }, [source, onSource]);

  // Render: a parse failure keeps the last good diagram and shows the error beside it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || source === null) return;
    let cancelled = false;
    // The mermaid renderer reads only the theme and the id prefix; this host is not a markdown document.
    const ctx = {
      theme: resolvedTheme === 'dark' ? 'dark' : 'light',
      blockId: 'chart-mermaid',
      editable: false,
    } as FenceRenderContext;
    void Promise.resolve(mermaidRenderer.render(source, host, ctx))
      .then(() => !cancelled && setError(null))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [source, resolvedTheme]);

  const persist = useCallback(
    async (text: string) => {
      if (text === lastWritten.current) return;
      lastWritten.current = text;
      await writeChartMermaid(docRef, chart, text, NOTE, undefined, replaceMermaidSource);
    },
    [docRef, chart],
  );

  const onEdit = (text: string) => {
    setSource(text);
    chart?.markEdit();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persist(text).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  if (source === null) {
    return (
      <div
        data-testid="chart-loading"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        <RefreshCw className="me-2 h-4 w-4 animate-spin" />
        <Trans>Loading chart…</Trans>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chart-mermaid">
      <AssetEditorHeader
        fileName={folderName}
        dirPath={dirPath}
        onOpenExternal={() => void fsRef.open()}
        onRevealInFinder={() => void fsRef.open({ select: true })}
        actions={actions}
      />
      <header className="border-b px-4 py-3">
        <ChartHeading title={chart?.name || folderName} description={chart?.description} />
      </header>
      <div className="flex min-h-0 flex-1">
        <textarea
          className="w-2/5 min-w-[240px] resize-none border-e bg-muted/40 p-3 font-mono text-sm"
          spellCheck={false}
          aria-label={t`Mermaid source`}
          placeholder={'sequenceDiagram\n  A->>B: hello'}
          value={source}
          onChange={(e) => onEdit(e.target.value)}
          data-testid="chart-mermaid-source"
        />
        <div className="relative min-w-0 flex-1 overflow-auto p-4">
          {error && (
            <div
              className="mb-2 rounded-md border border-destructive bg-destructive/10 px-2 py-1 text-xs"
              data-testid="chart-error"
            >
              {error}
            </div>
          )}
          <div
            ref={hostRef}
            className="flex justify-center [&_svg]:h-auto [&_svg]:w-full"
            data-testid="chart-mermaid-diagram"
          />
        </div>
      </div>
    </div>
  );
}

export default MermaidChartView;
