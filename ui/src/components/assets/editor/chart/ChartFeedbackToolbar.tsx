import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Paperclip, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AgenticProcess, dataManager, Dataset, TypeId, type Chart, type DatasetRow } from '@sdk';
import { Button } from '@src/components/ui/button';
import { readFileAsDataUrl } from './chartDoc';

/**
 * Click-to-comment feedback on a chart — the React port of the chartit skill's
 * `assets/feedback-toolbar.js`. A comment is a typed row of `chartit.feedback`
 * in the chart's project; Submit hands every open comment to the session that
 * builds the chart (CHART.md `session`) in one prompt, then marks them submitted.
 */

export const FEEDBACK_KIND = 'chartit.feedback';

interface FeedbackInput {
  chart: string;
  session?: string;
  target?: string;
  text: string;
  screenshot?: string;
  status: 'open' | 'submitted' | 'addressed';
  created: string;
}

type FeedbackRow = DatasetRow & { input: FeedbackInput };

interface ChartFeedbackToolbarProps {
  chart: Chart;
  /** The project whose chartit.feedback dataset holds the comments. */
  projectId?: string;
  /** The agentic process id comments are submitted to; none → Submit only marks them submitted. */
  session?: string;
  /** The picked element id ('' = the whole chart). */
  target: string;
  onTargetChange: (target: string) => void;
  /** Human label for an element id. */
  labelOf: (target: string) => string;
  /** Element ids that carry an open comment — the view marks them. */
  onCommented?: (targets: Set<string>) => void;
  /** Whether the panel is open; the view opens it when an element is picked. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChartFeedbackToolbar({
  chart,
  projectId,
  session,
  target,
  onTargetChange,
  labelOf,
  onCommented,
  open,
  onOpenChange,
}: ChartFeedbackToolbarProps) {
  const { t } = useLingui();
  const chartRef = chart.typeId.toString();
  const [dataset, setDataset] = useState<Dataset | null>(null);
  // Why feedback is off: '' = no dataset, else the lookup error; translated at render.
  const [offReason, setOffReason] = useState<string | null>(null);
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [text, setText] = useState('');
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Read through a ref: the dataset is looked up once per project, not again per chart.
  const chartRefRef = useRef(chartRef);
  chartRefRef.current = chartRef;

  const refresh = useCallback(async (ds: Dataset) => {
    const found = await ds.query({
      match: { 'input.chart': chartRefRef.current },
      order_by: { 'input.created': 'asc' },
    });
    setRows(found.rows as FeedbackRow[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const [ds] = await Dataset.forKind(FEEDBACK_KIND, projectId);
        if (cancelled) return;
        if (!ds) {
          setOffReason('');
          return;
        }
        setDataset(ds);
        unsubscribe = ds.onRowsChanged(() => void refresh(ds));
      } catch (err) {
        if (!cancelled) setOffReason(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [projectId, refresh]);

  useEffect(() => {
    if (dataset) void refresh(dataset);
  }, [dataset, chartRef, refresh]);

  const openRows = useMemo(() => rows.filter((r) => r.input.status === 'open'), [rows]);
  useEffect(() => {
    onCommented?.(new Set(openRows.map((r) => r.input.target).filter((x): x is string => !!x)));
  }, [openRows, onCommented]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const save = async () => {
    if (!dataset || (!text.trim() && !image)) return;
    const input: FeedbackInput = {
      chart: chartRef,
      text: text.trim() || '(image)',
      status: 'open',
      created: new Date().toISOString(),
      ...(session ? { session } : {}),
      ...(target ? { target } : {}),
      ...(image ? { screenshot: image } : {}),
    };
    setBusy(true);
    setMessage(null);
    try {
      await dataset.append([{ key: `${chart.name ?? 'chart'}-${Date.now().toString(36)}`, input }]);
      setText('');
      setImage('');
    } catch (err) {
      setMessage(t`Not saved: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!dataset || !openRows.length) return;
    setBusy(true);
    setMessage(null);
    try {
      // The session hears first: if marking fails, the comments stay open and Submit can run again.
      if (session) {
        const lines = openRows.map(
          (r) =>
            `- ${labelOf(r.input.target ?? '')}: ${r.input.text.slice(0, 160)}${r.input.screenshot ? ' [image]' : ''}`,
        );
        const prompt =
          `Feedback submitted on chart "${chart.name}" — ${openRows.length} comment(s).\n` +
          `Read them as typed rows (chartit skill, "Reading feedback"): the chart-feedback dataset, ` +
          `match input.chart = ${chartRef} and input.status = submitted.\n` +
          lines.join('\n');
        const proc = await dataManager.getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, session));
        if (!proc) throw new Error(t`session ${session} not found`);
        await proc.enqueue(prompt, 'chartit');
      }
      await dataset.putMany(
        openRows.map((r) => ({ key: r.key, input: { ...r.input, status: 'submitted' } })),
        { expected: Object.fromEntries(openRows.map((r) => [r.key, r.version])) },
      );
      setMessage(
        session
          ? t`${openRows.length} comment(s) sent to the session that builds this chart.`
          : t`${openRows.length} comment(s) saved as submitted — the chart has no session, so nothing was sent.`,
      );
      onOpenChange(true);
    } catch (err) {
      setMessage(t`Not submitted: ${err instanceof Error ? err.message : String(err)}`);
      onOpenChange(true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: FeedbackRow) => {
    if (!dataset) return;
    await dataset.deleteRow(row.key, row.version ? { expected: row.version } : {});
  };

  const disabled = !dataset;
  const reason =
    offReason === null
      ? null
      : offReason
        ? t`Feedback is off: ${offReason}`
        : t`Feedback is off: this project has no chart-feedback dataset (chartit.feedback).`;

  return (
    <>
      <div
        role="toolbar"
        aria-label={t`Chart feedback`}
        data-testid="chart-feedback-toolbar"
        className="pointer-events-auto absolute bottom-4 left-1/2 flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-2 rounded-full border bg-popover py-1.5 pe-1.5 ps-3 text-sm shadow-lg"
      >
        <span className="text-[10px] font-extrabold tracking-widest text-primary">
          <Trans>CHART</Trans>
        </span>
        {reason ? (
          <span className="truncate text-xs text-muted-foreground" data-testid="chart-feedback-reason">
            {reason}
          </span>
        ) : (
          <span className="max-w-[280px] truncate font-semibold" data-testid="chart-feedback-where">
            {labelOf(target)}{' '}
            <small className="font-normal text-muted-foreground">
              {target ? <Trans>· picked</Trans> : <Trans>· click an element to pick it</Trans>}
            </small>
          </span>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="rounded-full"
          disabled={disabled}
          onClick={() => onOpenChange(!open)}
          data-testid="chart-feedback-open"
        >
          <MessageSquare className="h-4 w-4" />
          <Trans>Feedback</Trans>
          {openRows.length > 0 && (
            <span className="ms-1 rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
              {openRows.length}
            </span>
          )}
        </Button>
        {openRows.length > 0 && (
          <Button
            size="sm"
            className="rounded-full"
            disabled={busy}
            onClick={() => void submit()}
            data-testid="chart-feedback-submit"
          >
            <Trans>Submit ({openRows.length})</Trans>
          </Button>
        )}
      </div>
      {open && !disabled && (
        <aside
          className="absolute bottom-20 end-4 top-4 z-10 w-[min(360px,calc(100%-32px))] overflow-auto rounded-xl border bg-popover p-3.5 shadow-xl"
          data-testid="chart-feedback-panel"
          aria-label={t`Feedback`}
        >
          <Button
            size="icon"
            variant="secondary"
            className="absolute end-2.5 top-2.5 h-8 w-8"
            onClick={() => onOpenChange(false)}
            aria-label={t`Close`}
            title={t`Close (Esc)`}
            data-testid="chart-feedback-close"
          >
            <X className="h-4 w-4" />
          </Button>
          <h4 className="mb-2 me-10 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            <Trans>Feedback</Trans>
          </h4>
          <span className="mb-2 inline-block rounded-full bg-muted px-2.5 py-0.5 text-xs font-bold">
            {labelOf(target)}
          </span>
          <p className="mb-2 text-xs text-muted-foreground">
            <Trans>Click any box or arrow in the chart to change what this comment is about.</Trans>
          </p>
          <textarea
            autoFocus
            className="block min-h-24 w-full rounded-md border bg-muted p-2.5 text-sm"
            placeholder={t`What should change? (paste an image here too)`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
              if (file) {
                e.preventDefault();
                void readFileAsDataUrl(file).then(setImage);
              }
            }}
            data-testid="chart-feedback-text"
          />
          {image && (
            <img className="mt-2 block max-h-36 max-w-full rounded border" src={image} alt={t`attached image`} />
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
              <Paperclip className="h-4 w-4" />
              {image ? <Trans>Replace image</Trans> : <Trans>Attach image</Trans>}
            </Button>
            {image && (
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => setImage('')}
                aria-label={t`Remove the image`}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            <Button
              size="sm"
              className="ms-auto"
              disabled={busy || (!text.trim() && !image)}
              onClick={() => void save()}
              data-testid="chart-feedback-save"
            >
              <Trans>Save</Trans>
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFileAsDataUrl(file).then(setImage);
            }}
          />
          {message && (
            <div className="mt-2 rounded-md bg-muted p-2 text-sm" data-testid="chart-feedback-message">
              {message}
            </div>
          )}
          {rows.length > 0 && (
            <>
              <h4 className="mb-1 mt-3.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                <Trans>Saved ({rows.length})</Trans>
              </h4>
              {rows.map((row) => (
                <div key={row.key} className="border-t py-2 text-sm" data-testid="chart-feedback-row">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <button
                      type="button"
                      className="font-semibold text-foreground"
                      onClick={() => onTargetChange(row.input.target ?? '')}
                    >
                      {labelOf(row.input.target ?? '')}
                    </button>
                    <span>{row.input.status}</span>
                    {row.input.status === 'open' && (
                      <button
                        type="button"
                        className="ms-auto px-1.5"
                        onClick={() => void remove(row)}
                        aria-label={t`Delete`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <div>{row.input.text}</div>
                  {row.input.screenshot && (
                    <img className="mt-2 block max-h-36 max-w-full rounded border" src={row.input.screenshot} alt="" />
                  )}
                </div>
              ))}
            </>
          )}
        </aside>
      )}
    </>
  );
}
