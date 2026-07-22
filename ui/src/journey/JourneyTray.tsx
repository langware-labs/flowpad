import { Check, Circle, CircleDot, Play, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { groupSteps, useBusyRun, type JourneyStep, type UseJourneyResult } from './use-journey';

const INDIGO = '#5b5bf0';
const AMBER = '#f6a723';

const POSITION_KEY = 'flowpad.journey.tray.position';
const MARGIN = 8;

interface TrayPos {
  x: number;
  y: number;
}

function loadPosition(): TrayPos | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as TrayPos;
    return typeof p.x === 'number' && typeof p.y === 'number' ? p : null;
  } catch {
    return null;
  }
}

function clampToViewport(p: TrayPos, el: HTMLElement | null): TrayPos {
  if (typeof window === 'undefined') return p;
  const w = el?.offsetWidth ?? 320;
  const h = el?.offsetHeight ?? 200;
  return {
    x: Math.max(MARGIN, Math.min(p.x, window.innerWidth - w - MARGIN)),
    y: Math.max(MARGIN, Math.min(p.y, window.innerHeight - h - MARGIN)),
  };
}

/** The journey badge's on-screen rect — the minimize target. */
function badgeRect(): DOMRect | null {
  return (
    document.querySelector('[data-testid="journey-badge"]')?.getBoundingClientRect() ?? null
  );
}

/**
 * The journey tray: a NON-MODAL popover (never a focus-trapping Dialog — the
 * page highlights the steps drive must persist, so we cannot steal focus/scroll).
 * Defaults to bottom-left near the badge, and is DRAGGABLE by its header (same
 * pointer-capture pattern as the floating assistant chat, FloatingChatWindow);
 * the position persists in localStorage.
 *
 * Shown purely because `?journeyId=` is in the URL, so it survives reload and
 * every navigation. Closing MINIMIZES: the tray scales into the journey badge
 * in the left rail (which keeps pulsing while a journey is in progress), so
 * the way back is shown, not told.
 */
export function JourneyTray({ state }: { state: UseJourneyResult }) {
  const { t } = useLingui();
  const { journey, journal, steps, currentStep, cursorIndex, refresh } = state;
  const { navigation } = useDockNavigation();
  const { busy, run } = useBusyRun(refresh);
  const doneIds = useMemo(
    () => new Set((journal?.entries ?? []).map((e) => e.node_id)),
    [journal?.entries],
  );

  // ── position: default bottom-left; user-dragged position persists ──
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<TrayPos | null>(() => loadPosition());
  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
    } catch {
      // ignore quota / private mode
    }
  }, [pos]);
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampToViewport(p, containerRef.current) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── drag by the header (pointer capture, FloatingChatWindow pattern) ──
  const dragRef = useRef<{ pointerId: number; offX: number; offY: number } | null>(null);
  const onHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, offX: e.clientX - rect.x, offY: e.clientY - rect.y };
  }, []);
  const onHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPos(clampToViewport({ x: e.clientX - drag.offX, y: e.clientY - drag.offY }, containerRef.current));
  }, []);
  const onHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // ── minimize: scale into the badge, then clear the URL param ──
  const [minimizeTransform, setMinimizeTransform] = useState<string | null>(null);
  const minimize = useCallback(() => {
    const el = containerRef.current;
    const badge = badgeRect();
    if (!el || !badge) {
      navigation.closeJourney();
      return;
    }
    const win = el.getBoundingClientRect();
    const dx = badge.x + badge.width / 2 - (win.x + win.width / 2);
    const dy = badge.y + badge.height / 2 - (win.y + win.height / 2);
    const s = Math.max(0.05, Math.min(badge.width / win.width, badge.height / win.height));
    setMinimizeTransform(`translate(${dx}px, ${dy}px) scale(${s})`);
    window.setTimeout(() => {
      setMinimizeTransform(null);
      navigation.closeJourney();
    }, 220);
  }, [navigation]);

  if (!journey) return null;

  const complete = journal?.status === 'complete';
  const stepsLeft = journal?.steps_left ?? steps.length;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={journey.name}
      data-testid="journey-tray"
      className={cn(
        'fixed z-50 flex w-80 max-w-[calc(100vw-5rem)] flex-col',
        'rounded-lg border border-border bg-popover text-popover-foreground shadow-xl',
        !pos && 'bottom-4 left-16',
      )}
      style={{
        borderTopColor: INDIGO,
        borderTopWidth: 2,
        ...(pos ? { left: pos.x, top: pos.y } : {}),
        ...(minimizeTransform
          ? { transform: minimizeTransform, opacity: 0.2, transition: 'transform 200ms ease-in, opacity 200ms ease-in' }
          : {}),
      }}
    >
      <div
        className="flex cursor-grab select-none items-start justify-between gap-2 border-b border-border px-3 py-2.5 active:cursor-grabbing"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        data-testid="journey-tray-drag-handle"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" style={{ color: INDIGO }}>
            {journey.name}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="journey-tray-steps-left">
            {complete ? <Trans>Completed 🎉</Trans> : <Trans>{stepsLeft} steps left</Trans>}
          </p>
        </div>
        <button
          type="button"
          aria-label={t`Minimize to the journey icon`}
          title={t`Minimize to the journey icon`}
          onClick={minimize}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="journey-tray-close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain p-2">
        {groupSteps(steps).map((section) => {
          const isDone = (i: number) =>
            complete || doneIds.has(steps[i].node_id) || (cursorIndex >= 0 && i < cursorIndex);
          const renderStep = (step: JourneyStep, i: number, indent: boolean) => {
            const done = isDone(i);
            const current = !complete && i === cursorIndex;
            return (
              <li
                key={step.node_id}
                data-current={current || undefined}
                className={cn(
                  'flex items-start gap-2 rounded px-2 py-1.5 text-xs',
                  current && 'bg-muted/60',
                  indent && 'ml-4',
                )}
              >
                <span className="mt-0.5 shrink-0">
                  {done ? (
                    <Check className="h-3.5 w-3.5" style={{ color: INDIGO }} aria-hidden />
                  ) : current ? (
                    <CircleDot className="h-3.5 w-3.5" style={{ color: AMBER }} aria-hidden />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'truncate',
                      current ? 'font-medium text-foreground' : done ? 'text-muted-foreground' : 'text-foreground/80',
                    )}
                  >
                    {step.name}
                  </p>
                  {current && step.status_line && (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{step.status_line}</p>
                  )}
                </div>
              </li>
            );
          };

          if (section.group === null) {
            return section.indices.map((i) => renderStep(steps[i], i, false));
          }
          const groupDone = section.indices.every(isDone);
          const groupCurrent = !complete && section.indices.includes(cursorIndex);
          return (
            <li key={`group:${section.group}:${section.indices[0]}`} data-group={section.group}>
              <div className="flex items-center gap-2 px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide">
                <span className="shrink-0">
                  {groupDone ? (
                    <Check className="h-3 w-3" style={{ color: INDIGO }} aria-hidden />
                  ) : (
                    <CircleDot
                      className={cn('h-3 w-3', !groupCurrent && 'text-muted-foreground')}
                      style={groupCurrent ? { color: AMBER } : undefined}
                      aria-hidden
                    />
                  )}
                </span>
                <span className={groupCurrent ? 'text-foreground' : 'text-muted-foreground'}>{section.group}</span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {section.indices.map((i) => renderStep(steps[i], i, true))}
              </ul>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
        {!journal && (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => run(() => journey.launch())}
            className="h-7 gap-1.5 px-3 text-xs text-white hover:brightness-110"
            style={{ backgroundColor: INDIGO }}
            data-testid="journey-tray-start"
          >
            <Play className="h-3 w-3" />
            <Trans>Start</Trans>
          </Button>
        )}
        {journal && !complete && currentStep && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => run(() => journey.advance(currentStep.node_id, 'done'))}
              className="h-7 px-3 text-xs text-white hover:brightness-110"
              style={{ backgroundColor: INDIGO }}
              data-testid="journey-tray-continue"
            >
              <Trans>Continue</Trans>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => journey.advance(currentStep.node_id, 'skipped'))}
              className="h-7 px-3 text-xs"
              data-testid="journey-tray-skip"
            >
              <Trans>Skip</Trans>
            </Button>
          </>
        )}
        <div className="flex-1" />
        {journal && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            title={t`Restart this journey`}
            onClick={() => run(() => journey.restart())}
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            data-testid="journey-tray-restart"
          >
            <RotateCcw className="h-3 w-3" />
            <Trans>Restart</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
