/**
 * WS → app-bus bridge: `topic_msg` frames arriving from the backend are fed
 * into the app EventBus via `deliver` — same envelope, same id, `origin`
 * preserved (`local_server`). One-way; the app→backend direction is deferred
 * until the first real subscriber needs it (docs/flow-events.md, phase 1).
 */
import { ConnectionManager, type TopicMsg } from '../websocket';
import { EventBus } from './EventBus';

let started = false;

/** Idempotent; call once where the WS client boots. */
export function startTopicBridge(): void {
  if (started) return;
  started = true;
  ConnectionManager.getInstance().on('on_topic_msg', (msg: TopicMsg) => {
    if (msg?.event?.topic) EventBus.deliver(msg.event);
  });
}
