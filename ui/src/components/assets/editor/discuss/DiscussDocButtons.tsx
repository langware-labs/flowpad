import { useCallback, useState } from 'react';
import { type FSRef } from '@sdk';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';
import { launchWorkerWithAsset } from '@src/components/workers/launchWorkerWithAsset';
import type { WorkerType } from '@src/components/workers/worker-types';

interface Props {
  /** FSRef of the doc the user is currently editing. */
  fsRef: FSRef;
}

/**
 * Header-toolbar buttons that spawn a new worker tab pre-seeded with a
 * "discuss this doc" prompt. Renders the shared `WorkerToolbar` (last-used
 * worker up front, the rest behind a chevron; all three in Dev view) so it
 * matches every other worker-launch surface.
 */
export function DiscussDocButtons({ fsRef }: Props) {
  const [starting, setStarting] = useState(false);

  const handleLaunch = useCallback(
    async (workerType: WorkerType) => {
      setStarting(true);
      try {
        // FSRef.path is the VFS sub-path (no leading slash). Normalize for
        // the human-facing prompt so the worker sees an absolute path.
        const absPath = fsRef.path.startsWith('/') ? fsRef.path : `/${fsRef.path}`;
        await launchWorkerWithAsset({
          workerType,
          seedPrompt: `Lets discuss ${absPath}, Do not take any actions yet`,
        });
      } catch (err) {
        console.error('[DiscussDocButtons] launch failed', err);
      } finally {
        setStarting(false);
      }
    },
    [fsRef.path],
  );

  return <WorkerToolbar onLaunch={handleLaunch} starting={starting} testIdPrefix="discuss-doc" />;
}
