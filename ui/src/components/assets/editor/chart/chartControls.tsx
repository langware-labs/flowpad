import { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus, WandSparkles, X } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Trans, useLingui } from '@lingui/react/macro';

/** One element's change request, before it goes to the chart's Changes list. */
export interface ChartChangeRequest {
  /** What the request is about — `<id> · <label>`, or the whole chart. */
  quote: string;
  instruction: string;
  runNow: boolean;
}

/** What a chart view gets to ask for changes: the request handler and the numbers already queued. */
export interface ChartChanges {
  request: (change: ChartChangeRequest) => void;
  /** Queued change numbers by the quote they are on. */
  marks: Map<string, number[]>;
}

/** The quote a change on an element carries: the id the worker finds it by, and its name. */
export const elementQuote = (id: string, label: string) => `${id} · ${label}`;

/** Zoom out · Fit · Zoom in, floating on the canvas corner. */
export function ZoomControls({ onFit, onIn, onOut }: { onFit: () => void; onIn: () => void; onOut: () => void }) {
  const { t } = useLingui();
  const btn = 'flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--surface-2)]';
  return (
    <div
      className="absolute end-3 top-3 z-[2] flex items-center gap-0.5 rounded-lg border p-0.5 shadow-sm"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline-strong)', color: 'var(--text-secondary)' }}
      data-testid="chart-zoom"
    >
      <button type="button" className={btn} onClick={onOut} aria-label={t`Zoom out`} data-testid="chart-zoom-out">
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium hover:bg-[var(--surface-2)]"
        onClick={onFit}
        data-testid="chart-zoom-fit"
      >
        <Maximize className="h-3.5 w-3.5" />
        <Trans>Fit</Trans>
      </button>
      <button type="button" className={btn} onClick={onIn} aria-label={t`Zoom in`} data-testid="chart-zoom-in">
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * "Change this" on a picked element: what to change, then Add (queue it in the chart's Changes
 * tab) or Add & run (queue and run the context worker now) — the same flow as a doc's wand.
 */
export function ChartChangeBox({
  label,
  at,
  onSubmit,
  onClose,
}: {
  label: string;
  /** Client coordinates to sit next to. */
  at: { x: number; y: number };
  onSubmit: (instruction: string, runNow: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = (runNow: boolean) => {
    if (!text.trim()) return;
    onSubmit(text.trim(), runNow);
  };
  return (
    <div
      className="fixed z-20 w-[320px] rounded-xl border p-3 shadow-xl"
      style={{
        left: Math.max(8, Math.min(at.x, window.innerWidth - 336)),
        top: Math.max(8, Math.min(at.y, window.innerHeight - 200)),
        background: 'var(--surface-1, hsl(var(--popover)))',
        borderColor: 'var(--hairline-strong, hsl(var(--border)))',
        color: 'var(--text-primary, hsl(var(--foreground)))',
      }}
      data-testid="chart-change-box"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        <WandSparkles className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate">
          <Trans>Change</Trans> <b style={{ color: 'var(--text-primary)' }}>{label}</b>
        </span>
        <button type="button" onClick={onClose} aria-label={t`Close`}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(true);
        }}
        rows={3}
        placeholder={t`What should change here?`}
        className="w-full resize-none rounded-md border bg-transparent p-2 text-[13px] outline-none"
        style={{ borderColor: 'var(--hairline-strong)' }}
        data-testid="chart-change-text"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md border px-2.5 py-1 text-[12px] font-medium"
          style={{ borderColor: 'var(--hairline-strong)' }}
          onClick={() => send(false)}
          data-testid="chart-change-add"
        >
          <Trans>Add</Trans>
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1 text-[12px] font-semibold text-white"
          style={{ background: 'var(--focus, hsl(var(--primary)))' }}
          onClick={() => send(true)}
          data-testid="chart-change-run"
        >
          <Trans>Add & run</Trans>
        </button>
      </div>
    </div>
  );
}

/** The numbered marks of the changes queued on one element. */
export function Marks({ ns, x, y }: { ns?: number[]; x: number; y: number }) {
  if (!ns?.length) return null;
  return (
    <g data-testid="chart-change-mark">
      {ns.map((n, i) => (
        <g key={n}>
          <circle cx={x + i * 20} cy={y} r={9} fill="var(--focus)" stroke="var(--surface-1)" strokeWidth={2} />
          <text className="num" x={x + i * 20} y={y + 0.5}>
            {n}
          </text>
        </g>
      ))}
    </g>
  );
}

/** "Change chart": a request on the whole chart, not one element. */
export function ChangeWholeChart({ changes }: { changes: ChartChanges }) {
  const { t } = useLingui();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <Button size="sm" variant="outline" onClick={(e) => setAt({ x: e.clientX - 300, y: e.clientY + 16 })} data-testid="chart-change-whole">
        <WandSparkles className="me-1.5 h-3.5 w-3.5" />
        <Trans>Change chart</Trans>
      </Button>
      {at && (
        <ChartChangeBox
          label={t`the whole chart`}
          at={at}
          onClose={() => setAt(null)}
          onSubmit={(instruction, runNow) => {
            changes.request({ quote: t`the whole chart`, instruction, runNow });
            setAt(null);
          }}
        />
      )}
    </>
  );
}
