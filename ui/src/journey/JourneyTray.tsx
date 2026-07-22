import { Check, Circle, CircleDot, KeyRound, Link2, Play, RotateCcw, Type, Wrench, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Confetti from 'react-confetti';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { animateMinimizeToElement } from '@src/lib/minimize-to-element';
import { markJourneyDismissed } from './journey-dismissed';
import { JourneyStepLive } from './JourneyStepLive';
import { groupSteps, useBusyRun, type JourneyStep, type UseJourneyResult } from './use-journey';
import type { JourneyManagerView } from './useJourneyManager';

/** One lit act button per step — label/icon follow the act kind. */
function ActButtonContent({ kind }: { kind: string }) {
  if (kind === 'setup_capability')
    return (
      <>
        <Wrench className="h-3 w-3" />
        <Trans>Set up</Trans>
      </>
    );
  if (kind === 'oauth_connect')
    return (
      <>
        <Link2 className="h-3 w-3" />
        <Trans>Connect</Trans>
      </>
    );
  if (kind === 'device_login')
    return (
      <>
        <KeyRound className="h-3 w-3" />
        <Trans>Log in</Trans>
      </>
    );
  return (
    <>
      <Type className="h-3 w-3" />
      <Trans>Fill text</Trans>
    </>
  );
}

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

function savePosition(p: TrayPos): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(p));
  } catch {
    // ignore quota / private mode
  }
}

function clampToViewport(p: TrayPos, size: { w: number; h: number }): TrayPos {
  return {
    x: Math.max(MARGIN, Math.min(p.x, window.innerWidth - size.w - MARGIN)),
    y: Math.max(MARGIN, Math.min(p.y, window.innerHeight - size.h - MARGIN)),
  };
}

function elementSize(el: HTMLElement | null): { w: number; h: number } {
  return { w: el?.offsetWidth ?? 320, h: el?.offsetHeight ?? 200 };
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
export function JourneyTray({ state, view }: { state: UseJourneyResult; view?: JourneyManagerView }) {
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
    const onResize = () =>
      setPos((p) => (p ? clampToViewport(p, elementSize(containerRef.current)) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── drag by the header (pointer capture, FloatingChatWindow pattern) ──
  // Size is measured ONCE at drag start (it doesn't change mid-drag) so the
  // move handler never reads layout — a read there would force a reflow per
  // tick against the style write it just made. Persist on settle, not per move.
  const dragRef = useRef<{ pointerId: number; offX: number; offY: number; w: number; h: number } | null>(null);
  const onHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    if (!el || !rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      offX: e.clientX - rect.x,
      offY: e.clientY - rect.y,
      w: rect.width,
      h: rect.height,
    };
  }, []);
  const onHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPos(clampToViewport({ x: e.clientX - drag.offX, y: e.clientY - drag.offY }, drag));
  }, []);
  const onHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    // Persist BEFORE releasing capture — release can throw on an already-gone
    // pointer, and the settle write must not be lost to that.
    setPos((p) => {
      if (p) savePosition(p);
      return p;
    });
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released — nothing to undo
    }
  }, []);

  // ── minimize: fly into the badge (shared genie helper), then clear the URL ──
  const minimize = useCallback(() => {
    animateMinimizeToElement(
      containerRef.current,
      document.querySelector<HTMLElement>('[data-minimize-anchor="journey-badge"]'),
    );
    // The explicit close is journey-domain state: without it the auto-launch
    // load-redirect re-enters the journey on the very next home load.
    markJourneyDismissed();
    navigation.closeJourney();
  }, [navigation]);

  // ── the finale, IN PLACE: completing the last step flips the journal to
  // `complete` and the celebration happens right here — confetti bursting from
  // the steps panel on whatever screen the user is on, never a page swap.
  const [celebration, setCelebration] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Track (journal, status) pairs: the burst fires when THE journal being
  // watched transitions into `complete` — status alone misses a fresh run
  // completing while an older complete journal was the last thing displayed.
  const prevJournalRef = useRef<{ id?: string; status?: string }>({ id: journal?.id, status: journal?.status });
  useEffect(() => {
    const prev = prevJournalRef.current;
    prevJournalRef.current = { id: journal?.id, status: journal?.status };
    const completedNow =
      journal?.status === 'complete' && prev.id === journal.id && prev.status && prev.status !== 'complete';
    if (!completedNow) return;
    const rect = containerRef.current?.getBoundingClientRect();
    setCelebration(
      rect
        ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        : { x: window.innerWidth / 2 - 160, y: window.innerHeight / 2 - 100, w: 320, h: 200 },
    );
    const timer = window.setTimeout(() => setCelebration(null), 6000);
    return () => window.clearTimeout(timer);
  }, [journal?.id, journal?.status]);

  if (!journey || typeof document === 'undefined') return null;

  const complete = journal?.status === 'complete';
  const stepsLeft = journal?.steps_left ?? steps.length;

  // Portal to document.body (the FloatingChatWindow pattern): the left rail is
  // also z-50, and inside the app tree the rail comes later in the DOM — a tie
  // the rail wins, so a tray dragged near it slid UNDERNEATH and its header
  // stopped receiving pointer events ("it's not moving, it's covered").
  return createPortal(
    <>
    {celebration && (
      <div className="pointer-events-none fixed inset-0 z-[120]" data-testid="journey-confetti">
        <Confetti
          width={window.innerWidth}
          height={window.innerHeight}
          recycle={false}
          numberOfPieces={420}
          gravity={0.25}
          initialVelocityY={14}
          confettiSource={{ x: celebration.x, y: celebration.y, w: celebration.w, h: celebration.h }}
        />
      </div>
    )}
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
                  {current && step.act && <JourneyStepLive act={step.act} />}
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
            {/* The step's own act comes FIRST and replaces Continue while it is
                pending: one lit button at a time, so the tray always shows a
                single obvious next move ("Fill text" → then "Next"). */}
            {view?.actPending ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={view.doAct}
                className="h-7 gap-1.5 px-3 text-xs text-white hover:brightness-110 animate-pulse"
                style={{ backgroundColor: INDIGO }}
                data-testid="journey-tray-act"
              >
                <ActButtonContent kind={currentStep.act?.kind ?? 'fill'} />
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => run(() => journey.advance(currentStep.node_id, 'done'))}
                className={cn(
                  'h-7 px-3 text-xs text-white hover:brightness-110',
                  // A `manual` await keeps Next dark until its signal lands, then
                  // lights it — the step's completion is visible, not guessed.
                  currentStep.await?.manual && !view?.armed && 'opacity-60',
                  currentStep.await?.manual && view?.armed && 'animate-pulse',
                )}
                style={{ backgroundColor: INDIGO }}
                data-testid="journey-tray-continue"
              >
                {currentStep.await?.manual ? <Trans>Next</Trans> : <Trans>Continue</Trans>}
              </Button>
            )}
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
    </>,
    document.body,
  );
}
