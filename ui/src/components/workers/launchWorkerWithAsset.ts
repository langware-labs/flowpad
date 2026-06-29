import { AgenticProcess } from '@sdk';
import type { WorkerType } from '@src/components/workers/worker-types';

/**
 * The single seam behind every asset-editor worker toolbar (Discuss-doc,
 * Skill-test): open an interactive worker tab seeded with a doc/skill as
 * context.
 *
 * Context is supplied by reference, not a private symlink: the worker boots in a
 * project whose tree already contains the asset (a doc is readable by path; an
 * installed skill is discovered by name), and the seed prompt names it. This is
 * deliberate — `embeddedAssets.attach` is a post-spawn action that lands *after*
 * an interactive worker's visible auto-start, too late for the driver's
 * `--add-dir` set (see `skill-eval-analysis.ts`). Genuinely materializing the
 * asset before boot would need the backend to accept embedded-asset refs on
 * `createProcess`; until then, by-reference is both what works and what every
 * one of these toolbars did before consolidation.
 */
export async function launchWorkerWithAsset(opts: {
  workerType: WorkerType;
  /** Launch instruction naming the asset. Pre-filled (not auto-submitted) unless `stage`. */
  seedPrompt?: string;
  /**
   * Stage the prompt on the queue with draining disabled instead of pre-filling
   * it as the launch instruction — the worker boots idle and the author sends it
   * by hand (skill-test semantics). Closes the drain window: disable-then-enqueue
   * keeps the queue empty until it's set, so nothing can auto-fire.
   */
  stage?: boolean;
  /** Provenance string for a staged enqueue (e.g. 'skill-test'). */
  enqueueSource?: string;
  /** Project to run in; defaults to the active project inside `openTab`. */
  project?: { id?: string; fs_storage_mount_path?: string | null } | null;
}): Promise<AgenticProcess> {
  const { workerType, seedPrompt, stage, enqueueSource = 'ui', project } = opts;

  if (stage) {
    // Boot idle (no launch prompt — that would auto-run), then stage the starter.
    const proc = await AgenticProcess.openTab(workerType, undefined, project);
    if (seedPrompt) {
      await proc.setQueueEnabled(false);
      await proc.enqueue(seedPrompt, enqueueSource);
    }
    return proc;
  }

  // Pre-fill the seed prompt as the launch instruction (deterministic boot).
  return AgenticProcess.openTab(workerType, seedPrompt, project);
}
