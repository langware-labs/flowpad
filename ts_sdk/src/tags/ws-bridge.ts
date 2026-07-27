/**
 * WS → app-bus bridge: `tag_msg` frames arriving from the backend are fed
 * into the app EventBus via `deliver` — same envelope, same id, `origin`
 * preserved (`local_server`). One-way; the app→backend direction is deferred
 * until the first real subscriber needs it (docs/flow-events.md, phase 1).
 */
import { ConnectionManager, type TagMsg } from '../websocket';
import { EventBus } from './EventBus';

let started = false;

/** Idempotent; call once where the WS client boots. */
export function startTagBridge(): void {
  if (started) return;
  started = true;
  ConnectionManager.getInstance().on('on_tag_msg', (msg: TagMsg) => {
    if (!msg?.event?.tag) return;
    // debug-level: visible only with verbose console — the phase-1 drill probe.
    console.debug('[tags] delivered', msg.event.tag, msg.event.id, msg.event.ctx?.origin);
    EventBus.deliver(msg.event);
  });
}
