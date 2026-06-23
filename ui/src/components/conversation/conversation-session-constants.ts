/** The CLI worker vendors a conversation session can launch. Canonical home is
 *  now `workers/worker-types` (the list is cross-cutting, not conversation-only);
 *  re-exported here so existing conversation-layer imports keep working. */
export { LAUNCHABLE_WORKERS, type WorkerType } from '@src/components/workers/worker-types';
