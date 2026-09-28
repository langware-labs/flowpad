import { FlowData, FlowElementTypes } from '@sdk';

/**
 * Drop each optimistic user echo that a LIVE observation of the same turn has
 * since superseded.
 *
 * On send, `AgenticProcess.prompt()` echoes the user's text into the stream as
 * a placeholder (`FlowData.isOptimisticEcho`) — it carries no transcript id, so
 * it can never be reconciled by id with the persisted row. The SDK retires it
 * only on a history load, by pairing on content. That was enough while no live
 * stream carried the genuine user turn: Claude's stdout never echoes it (only
 * `isMeta` framework injections) and the PTY observe path skips it.
 *
 * Copilot's stdout DOES echo `user.message`, so its live stream carries a real
 * USER_MESSAGE row for the turn the client already echoed — and with no history
 * load until the turn ends, both rows render ("You" twice) until a reload.
 *
 * Rule (the history retire, applied to live rows): an observed, non-meta
 * USER_MESSAGE with the same text retires the OLDEST still-pending echo that
 * ARRIVED before it. One-for-one and ordered, so sending "hi" twice keeps the
 * second echo until its own observed row arrives — an earlier "hi" can never
 * retire it.
 *
 * Order is ARRIVAL order (`arrival`, i.e. `FlowDataStream.ownItems`), never the
 * rendered `items` order: `items` is sorted by timestamp, and the echo is
 * stamped with the browser clock while the observed row carries the worker's —
 * two clocks, so the observed copy can sort BEFORE its own echo. Arrival is
 * causal: the echo is ingested before the prompt request is even sent.
 *
 * Returns `items` itself when nothing is retired, so snapshot identity holds.
 */
export function retireObservedEchoes<T extends FlowData>(
  items: readonly T[],
  arrival: readonly FlowData[] = items,
): T[] {
  const pending = new Map<string, FlowData[]>();
  let retired: Set<FlowData> | null = null;
  for (const item of arrival) {
    if (item.elementType !== FlowElementTypes.USER_MESSAGE) continue;
    const text = typeof item.content === 'string' ? item.content.trim() : '';
    if (!text) continue;
    if (item.isOptimisticEcho) {
      const queue = pending.get(text);
      if (queue) queue.push(item);
      else pending.set(text, [item]);
      continue;
    }
    // A framework injection (skill body, command expansion) is not the user's turn.
    if (item.attributes['is-meta'] === 'true') continue;
    const echo = pending.get(text)?.shift();
    if (!echo) continue;
    retired ??= new Set();
    retired.add(echo);
  }
  if (!retired) return items as T[];
  return items.filter((item) => !retired.has(item));
}
