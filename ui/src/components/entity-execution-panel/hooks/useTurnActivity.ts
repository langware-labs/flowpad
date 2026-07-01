import { AgenticProcess, TypeId, WorkerStatus, isWorkerRunning, type FlowData } from '@sdk';
import { useEffect, useMemo, useState } from 'react';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDerivedWorkerStatus } from './useDerivedWorkerStatus';

// Keep the "working" state up through brief WS lulls / a mistimed idle read so
// the indicator doesn't blink between, say, a tool result and the next token.
const HOLD_MS = 1200;

/** Parse a FlowData ISO timestamp to epoch ms (NaN-safe). */
function tsToMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** Timestamp of the most recent user message in the stream — "the current turn
 *  started at". Falls back to null so the caller can use `Date.now()`. */
function lastTurnStart(process: AgenticProcess): number | null {
  const items = process.flowDataStream.items as FlowData[];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const role = it.attributes?.role as string | undefined;
    if (it.elementType === 'user-message' || (it.elementType === 'chat' && role === 'user')) {
      return tsToMs(it.timestamp);
    }
  }
  return null;
}

export interface TurnActivity {
  /** True while a turn is in flight — thinking, running a tool, or the lull
   *  between tools. Idle/complete/awaiting → false. */
  active: boolean;
  /** Epoch ms the current turn started (for an elapsed clock); null when idle. */
  startedAt: number | null;
  /** Live worker status (drives the phase label). */
  status: WorkerStatus | null;
}

/**
 * Reliable "the agent is working" signal for the chat, plus when the current
 * turn started. ORs three independent sources so it lights up across transports
 * and delivery paths:
 *
 *  1. `process.isPrompting` — a streaming `prompt()` is in flight. Brackets the
 *     actual request lifecycle, so it's correct even when the transcript arrives
 *     as a post-hoc WS batch (no live deltas to derive from).
 *  2. stream-derived worker status ({@link useDerivedWorkerStatus}) — stays in a
 *     running state across the whole turn (thinking → each tool → the WAITING
 *     lulls between tools) for a LIVE-streaming headless turn.
 *  3. the CANONICAL watched entity's `worker_status` — the loader-prop process
 *     and the entity-cache instance are different objects (InteractiveTerminal:
 *     `propProcess` vs `useEntity`), and only the cached one gets WS broadcasts;
 *     for a visible/PTY chat the backend re-serializes `worker_status` mid-turn,
 *     so reflecting the watched entity catches those turns.
 *
 * A short trailing hold ({@link HOLD_MS}) smooths transient gaps so the indicator
 * doesn't blink off between phases.
 */
export function useTurnActivity(process: AgenticProcess | null): TurnActivity {
  // (3) Canonical watched instance — WS keeps its worker_status live.
  const typeId = useMemo(
    () => (process ? new TypeId(AgenticProcess.type, process.id) : null),
    [process?.id],
  );
  const { data: live } = useEntity<AgenticProcess>(typeId, { watch: true });
  const reflected = live ?? process;

  // (2) Live stream-derived status (also drives the phase label).
  const derived = useDerivedWorkerStatus(process);

  // (1) prompt() in-flight latch (fires on the acting/prop instance).
  const [prompting, setPrompting] = useState(() => process?.isPrompting ?? false);
  useEffect(() => {
    if (!process) {
      setPrompting(false);
      return;
    }
    setPrompting(process.isPrompting);
    const onChange = () => setPrompting(process.isPrompting);
    process.on('prompting-change', onChange);
    return () => {
      process.off('prompting-change', onChange);
    };
  }, [process]);

  const reflectedStatus = reflected?.workerStatus as WorkerStatus | undefined;
  const status = derived ?? reflectedStatus ?? null;
  const running =
    prompting ||
    (!!derived && isWorkerRunning(derived)) ||
    (!!reflectedStatus && isWorkerRunning(reflectedStatus));

  const [active, setActive] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Debounced-off: on → immediate, off → after HOLD_MS (cancelled if it flips
  // back on within the window).
  useEffect(() => {
    if (running) {
      setActive(true);
      return;
    }
    const t = setTimeout(() => setActive(false), HOLD_MS);
    return () => clearTimeout(t);
  }, [running]);

  // Anchor the clock at the turn's first user message the first time we go
  // active (handles mounting mid-turn); clear it when the turn ends.
  useEffect(() => {
    if (active) {
      setStartedAt((prev) => prev ?? (process ? lastTurnStart(process) ?? Date.now() : Date.now()));
    } else {
      setStartedAt(null);
    }
  }, [active, process]);

  return { active, startedAt, status };
}
